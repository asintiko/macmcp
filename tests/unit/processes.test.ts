import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProgram, runProgramChecked, truncateMiddle, which } from '../../src/core/exec.js';
import { type ManagedProcess, OutputBuffer, ProcessManager, resolveShell } from '../../src/core/processes.js';

describe('OutputBuffer', () => {
  it('reads from a cursor across streams', () => {
    const buffer = new OutputBuffer(1000);
    buffer.append('stdout', 'hello ');
    buffer.append('stderr', 'oops ');
    buffer.append('stdout', 'world');
    expect(buffer.length).toBe(16);
    expect(buffer.read(0)).toEqual({ text: 'hello oops world', from: 0, next: 16, dropped: 0 });
    expect(buffer.read(8).text).toBe('ps world');
    expect(buffer.read(0, 'stdout').text).toBe('hello world');
    expect(buffer.read(0, 'stderr').text).toBe('oops ');
    expect(buffer.read(16)).toEqual({ text: '', from: 16, next: 16, dropped: 0 });
    expect(buffer.read(99).text).toBe('');
  });

  it('drops the oldest output beyond the limit and reports it', () => {
    const buffer = new OutputBuffer(10);
    buffer.append('stdout', 'aaaaa');
    buffer.append('stdout', 'bbbbb');
    buffer.append('stdout', 'ccccc');
    const slice = buffer.read(0);
    expect(slice.text).toBe('bbbbbccccc');
    expect(slice).toMatchObject({ from: 5, next: 15, dropped: 5 });
    buffer.append('stdout', 'x'.repeat(25));
    expect(buffer.read(0).text).toBe('x'.repeat(10));
    expect(buffer.length).toBe(40);
  });
});

describe('exec helpers', () => {
  it('collects output and exit status', async () => {
    const result = await runProgram('/bin/sh', ['-c', 'echo out; echo err >&2; exit 3']);
    expect(result).toMatchObject({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });

  it('passes input on stdin', async () => {
    const result = await runProgram('/bin/sh', ['-c', 'cat'], { input: 'piped' });
    expect(result.stdout).toBe('piped');
  });

  it('kills on timeout', async () => {
    const result = await runProgram('/bin/sh', ['-c', 'sleep 5'], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });

  it('reports missing programs as DEPENDENCY_MISSING', async () => {
    await expect(runProgram('/nonexistent/program', [])).rejects.toMatchObject({ code: 'DEPENDENCY_MISSING' });
  });

  it('runProgramChecked turns failures into ToolErrors', async () => {
    await expect(runProgramChecked('/bin/sh', ['-c', 'echo bad >&2; exit 2'], { what: 'thing' })).rejects.toMatchObject({
      code: 'FAILED',
      message: expect.stringContaining('thing failed (exit 2): bad'),
    });
    await expect(runProgramChecked('/bin/sh', ['-c', 'sleep 5'], { timeoutMs: 50 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('finds executables on PATH', async () => {
    expect(await which('sh')).toMatch(/\/sh$/);
    expect(await which('definitely-not-a-real-command-xyz')).toBeUndefined();
    expect(await which('/bin/sh')).toBe('/bin/sh');
  });

  it('truncates the middle of long text', () => {
    expect(truncateMiddle('short', 100)).toEqual({ text: 'short', truncated: 0 });
    const long = `${'a'.repeat(500)}${'b'.repeat(500)}`;
    const cut = truncateMiddle(long, 100);
    expect(cut.truncated).toBe(900);
    expect(cut.text.startsWith('a'.repeat(30))).toBe(true);
    expect(cut.text.endsWith('b'.repeat(70))).toBe(true);
    expect(cut.text).toContain('[900 characters truncated]');
  });
});

describe('ProcessManager', () => {
  let dir: string;
  let manager: ProcessManager;
  const shell = resolveShell(undefined, process.env);

  const start = (command: string, extra: { stdin?: string; keepStdinOpen?: boolean } = {}): ManagedProcess =>
    manager.start({ command, plan: { file: shell, args: ['-c', command], sandboxed: false }, cwd: dir, env: process.env, ...extra });

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-proc-')));
    manager = new ProcessManager({ maxRunning: 4, maxFinished: 3 });
  });
  afterAll(async () => {
    await manager.stopAll(200);
    await rm(dir, { recursive: true, force: true });
  });

  it('runs a command to completion and records output and exit code', async () => {
    const proc = start('echo one; echo two >&2; pwd; exit 7');
    expect(await proc.wait(5000)).toBe(true);
    expect(proc.status).toBe('exited');
    expect(proc.exitCode).toBe(7);
    expect(proc.output.read(0, 'stdout').text).toBe(`one\n${dir}\n`);
    expect(proc.output.read(0, 'stderr').text).toBe('two\n');
    expect(proc.info()).toMatchObject({ process_id: proc.id, status: 'exited', exit_code: 7, sandboxed: false, cwd: dir });
  });

  it('wait() returns false while the process is still running', async () => {
    const proc = start('sleep 3');
    expect(await proc.wait(100)).toBe(false);
    expect(proc.status).toBe('running');
    await proc.stop('SIGTERM', 1000);
    expect(proc.status).toBe('killed');
    expect(proc.signal).toBe('SIGTERM');
  });

  it('wakes waiters as soon as output arrives', async () => {
    const proc = start('sleep 0.2; echo ready; sleep 3');
    const started = Date.now();
    await proc.waitForActivity(0, 5000);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(proc.output.read(0).text).toBe('ready\n');
    await proc.stop('SIGKILL', 500);
  });

  it('stops the whole process tree', async () => {
    const marker = path.join(dir, 'child.pid');
    const proc = start(`(sleep 30 & echo $! > ${marker}; wait)`);
    await proc.waitForActivity(0, 500);
    await new Promise((r) => setTimeout(r, 300));
    const childPid = Number((await readFile(marker, 'utf8')).trim());
    expect(childPid).toBeGreaterThan(0);
    await proc.stop('SIGTERM', 2000);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const proc = start('trap "" TERM; echo armed; while :; do sleep 0.1; done');
    await proc.waitForActivity(0, 3000);
    await proc.stop('SIGTERM', 300);
    expect(proc.status).toBe('killed');
    expect(proc.signal).toBe('SIGKILL');
  });

  it('feeds stdin to a process that keeps it open', async () => {
    const proc = start('while read line; do echo "got:$line"; [ "$line" = quit ] && exit 0; done', { keepStdinOpen: true });
    proc.write('hello\n');
    await proc.waitForActivity(0, 3000);
    expect(proc.output.read(0).text).toBe('got:hello\n');
    proc.write('quit\n');
    expect(await proc.wait(3000)).toBe(true);
    expect(() => proc.write('late\n')).toThrow(/not running/);
  });

  it('closes stdin by default so readers see end-of-file', async () => {
    const proc = start('cat; echo done', { stdin: 'from-stdin\n' });
    expect(await proc.wait(3000)).toBe(true);
    expect(proc.output.read(0).text).toBe('from-stdin\ndone\n');
  });

  it('finishes even if a background child keeps the output pipes open', async () => {
    const proc = start('sleep 4 & echo started');
    expect(await proc.wait(2500)).toBe(true);
    expect(proc.exitCode).toBe(0);
    proc.kill('SIGKILL');
  });

  it('reports a start failure instead of throwing', async () => {
    const proc = manager.start({
      command: 'nope',
      plan: { file: '/nonexistent/shell', args: [], sandboxed: false },
      cwd: dir,
      env: process.env,
    });
    expect(await proc.wait(3000)).toBe(true);
    expect(proc.exitCode).toBe(127);
    expect(proc.output.read(0).text).toContain('Failed to start process');
  });

  it('limits running processes, forgets old finished ones, and rejects unknown ids', async () => {
    const limited = new ProcessManager({ maxRunning: 2, maxFinished: 2 });
    const run = (command: string): ManagedProcess =>
      limited.start({ command, plan: { file: shell, args: ['-c', command], sandboxed: false }, cwd: dir, env: process.env });
    const a = run('sleep 5');
    const b = run('sleep 5');
    expect(() => run('true')).toThrow(/Too many running processes/);
    await Promise.all([a.stop('SIGKILL', 500), b.stop('SIGKILL', 500)]);
    const c = run('true');
    await c.wait(3000);
    const d = run('true');
    await d.wait(3000);
    const ids = limited.list().map((p) => p.process_id);
    expect(ids).not.toContain(a.id);
    expect(ids).toContain(d.id);
    expect(ids.length).toBeLessThanOrEqual(3);
    expect(() => limited.get('p999')).toThrow(/Unknown process_id/);
    expect(limited.runningCount).toBe(0);
  });
});
