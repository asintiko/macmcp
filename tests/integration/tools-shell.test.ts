import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { which } from '../../src/core/exec.js';
import type { PermissionMode } from '../../src/core/permissions.js';
import { createHarness, type Harness } from '../helpers/harness.js';

const onMac = process.platform === 'darwin';

describe.each<PermissionMode>(['full', 'project'])('shell tools (%s mode)', (mode) => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ mode });
    await mkdir(path.join(h.projectDir, 'sub'));
    await writeFile(path.join(h.outsideDir, 'secret.txt'), 'outside-secret');
  });
  afterAll(async () => {
    await h.close();
  });

  it('runs a command and reports exit code, stdout and stderr', async () => {
    const ok = await h.call('run_command', { command: 'echo out; echo err >&2' });
    expect(ok.isError).toBe(false);
    expect(ok.text).toMatch(/^Exit code 0 after \d+ms\n--- stdout ---\nout\n--- stderr ---\nerr$/);
    expect(ok.data).toMatchObject({ status: 'exited', exit_code: 0, signal: null, sandboxed: mode === 'project' && onMac });

    const failed = await h.call('run_command', { command: 'exit 3' });
    expect(failed.isError).toBe(false);
    expect(failed.text).toMatch(/^Exit code 3 after .*\n\(no output\)$/);
    expect(failed.data).toMatchObject({ exit_code: 3 });
  });

  it('honours cwd, env, stdin and shell', async () => {
    const result = await h.call('run_command', { command: 'pwd; echo "$GREETING"; cat', cwd: 'sub', env: ['GREETING=hello world'], stdin: 'from stdin', shell: 'sh' });
    expect(result.text).toContain(`${path.join(h.projectDir, 'sub')}\nhello world\nfrom stdin`);
    const absolute = await h.call('run_command', { command: 'pwd', cwd: path.join(h.projectDir, 'sub') });
    expect(absolute.text).toContain(path.join(h.projectDir, 'sub'));
  });

  it('rejects bad arguments with clear errors', async () => {
    expect((await h.call('run_command', { command: 'pwd', cwd: 'missing-dir' })).text).toContain('Error [NOT_FOUND]: Directory does not exist');
    expect((await h.call('run_command', { command: 'pwd', env: ['not valid'] })).text).toContain('Error [INVALID_ARGUMENT]: Invalid environment entry');
    expect((await h.call('run_command', { command: '' })).isError).toBe(true);
  });

  it('truncates long output in the middle', async () => {
    const result = await h.call('run_command', { command: 'i=0; while [ $i -lt 400 ]; do echo "line-$i-padding-padding-padding"; i=$((i+1)); done', max_output_chars: 1000 });
    expect(result.text).toContain('line-0-');
    expect(result.text).toContain('line-399-');
    expect(result.text).toMatch(/\[\d+ characters truncated\]/);
    expect(result.data?.['output_truncated_chars']).toBeGreaterThan(5000);
  });

  it('hands a slow command over to the background instead of killing it', async () => {
    const started = await h.call('run_command', { command: 'echo first; sleep 2; echo second', timeout_seconds: 1 });
    expect(started.isError).toBe(false);
    expect(started.text).toMatch(/^Still running after 1\.0s; the command continues in the background as process_id "p\d+"\./);
    expect(started.text).toContain('first');
    const id = started.data?.['process_id'] as string;
    expect(started.data).toMatchObject({ status: 'running', exit_code: null });

    const rest = await h.call('read_process_output', { process_id: id, wait_seconds: 15 });
    expect(rest.text).toContain('second');
    expect(rest.text).not.toContain('first');
    const final = await h.call('read_process_output', { process_id: id, wait_seconds: 10 });
    expect(final.text).toMatch(/exit code 0/);
    expect(final.data).toMatchObject({ status: 'exited', exit_code: 0 });
    const all = await h.call('read_process_output', { process_id: id, from_start: true, wait_seconds: 0 });
    expect(all.text).toContain('first\nsecond');
  });

  it('runs scripts in several languages with arguments', async () => {
    const bash = await h.call('run_script', { language: 'bash', code: 'set -eu\necho "args: $# $1 $2"\n', args: ['one', 'two words'] });
    expect(bash.text).toContain('args: 2 one two words');

    const node = await h.call('run_script', { language: 'node', code: "const os = require('node:os');\nconsole.log(JSON.stringify({ sum: 6 * 7, argv: process.argv.slice(2) }));", args: ['x'] });
    expect(node.text).toContain('{"sum":42,"argv":["x"]}');
    const esm = await h.call('run_script', { language: 'node', code: "import { basename } from 'node:path';\nconsole.log(basename('/a/b.txt'));" });
    expect(esm.text).toContain('b.txt');

    if (await which('python3')) {
      const python = await h.call('run_script', { language: 'python', code: 'import sys, json\nprint(json.dumps({"n": 6 * 7, "stdin": sys.stdin.read()}))', stdin: 'data' });
      expect(python.text).toContain('{"n": 42, "stdin": "data"}');
    }
    const failing = await h.call('run_script', { language: 'sh', code: 'echo before; exit 9' });
    expect(failing.text).toMatch(/^Exit code 9/);
  });

  it('reports a missing interpreter', async () => {
    const custom = await h.call('run_script', { language: 'bash', code: 'echo hi', interpreter: '/nonexistent/interp --flag' });
    expect(custom.text).toMatch(/Exit code 127|Failed to start process|No such file/);
    if (!(await which('swift'))) {
      expect((await h.call('run_script', { language: 'swift', code: 'print(1)' })).text).toContain('Error [DEPENDENCY_MISSING]: Interpreter not found on PATH: swift');
    }
  });

  it('manages background processes: start, list, read, write, stop', async () => {
    const started = await h.call('start_process', {
      command: 'echo ready; while read line; do echo "got:$line"; done',
      name: 'echo loop',
      wait_seconds: 1,
    });
    expect(started.text).toMatch(/^Started process_id "p\d+" \(pid \d+\): running/);
    expect(started.text).toContain('ready');
    const id = started.data?.['process_id'] as string;

    const listed = await h.call('list_processes', { running_only: true });
    expect(listed.text).toContain('echo loop');
    expect((listed.data?.['processes'] as { process_id: string }[]).map((p) => p.process_id)).toContain(id);

    const wrote = await h.call('write_process_input', { process_id: id, input: 'hello' });
    expect(wrote.text).toContain('got:hello');
    const none = await h.call('read_process_output', { process_id: id, wait_seconds: 0 });
    expect(none.text).toContain('(no new output)');

    const stopped = await h.call('stop_process', { process_id: id, signal: 'INT', grace_seconds: 2 });
    expect(stopped.text).toMatch(/^Stopped "p\d+": (killed by SIG(INT|KILL)|exit code \d+)/);
    expect(stopped.data?.['status']).not.toBe('running');
    expect((await h.call('stop_process', { process_id: id })).text).toMatch(/^Already finished/);
    expect((await h.call('write_process_input', { process_id: id, input: 'x' })).text).toContain('Error [CONFLICT]');
    expect((await h.call('read_process_output', { process_id: 'p9999' })).text).toContain('Error [NOT_FOUND]: Unknown process_id');
  });

  it('closes stdin on request so the process can finish', async () => {
    const started = await h.call('start_process', { command: 'cat; echo eof-seen', wait_seconds: 0 });
    const id = started.data?.['process_id'] as string;
    const closed = await h.call('write_process_input', { process_id: id, input: 'last line', close_stdin: true, wait_seconds: 5 });
    expect(closed.text).toContain('last line');
    const done = await h.call('read_process_output', { process_id: id, from_start: true, wait_seconds: 0 });
    expect(done.text).toContain('eof-seen');
  });

  if (mode === 'full') {
    it('lists and signals system processes', async () => {
      const sleeper = await h.call('start_process', { command: 'exec sleep 61', wait_seconds: 0 });
      const pid = sleeper.data?.['pid'] as number;
      const listed = await h.call('list_system_processes', { filter: 'sleep 61', sort_by: 'pid' });
      expect(listed.isError).toBe(false);
      expect((listed.data?.['processes'] as { pid: number }[]).map((p) => p.pid)).toContain(pid);

      expect((await h.call('kill_process', { pid })).text).toBe(`Sent SIGTERM to pid ${pid}.`);
      const after = await h.call('read_process_output', { process_id: sleeper.data?.['process_id'], wait_seconds: 10 });
      expect(after.data).toMatchObject({ status: 'killed', signal: 'SIGTERM' });

      expect((await h.call('kill_process', { pid: process.pid })).text).toContain('Error [PERMISSION_DENIED]');
      expect((await h.call('kill_process', { pid: 3_999_999 })).text).toContain('Error [NOT_FOUND]: No process with pid');
    });

    it('can work outside the project directory', async () => {
      const result = await h.call('run_command', { command: 'cat secret.txt', cwd: h.outsideDir });
      expect(result.text).toContain('outside-secret');
    });
  } else {
    it('keeps system-wide process tools out of reach', async () => {
      expect((await h.call('list_system_processes')).text).toContain('Error [PERMISSION_DENIED]: list_system_processes requires Full System Access');
      expect((await h.call('kill_process', { pid: 4242 })).text).toContain('Error [PERMISSION_DENIED]');
    });

    it('refuses a working directory outside the project', async () => {
      const result = await h.call('run_command', { command: 'pwd', cwd: h.outsideDir });
      expect(result.text).toContain('Error [OUTSIDE_PROJECT]');
      expect((await h.call('start_process', { command: 'pwd', cwd: '..' })).text).toContain('Error [OUTSIDE_PROJECT]');
    });

    it.runIf(onMac)('sandboxes commands and explains denials', async () => {
      const read = await h.call('run_command', { command: `cat '${path.join(h.outsideDir, 'secret.txt')}'` });
      expect(read.text).not.toContain('outside-secret');
      expect(read.text).toContain('Operation not permitted');
      expect(read.text).toContain('Note: this server runs in Project-Only mode');
      const script = await h.call('run_script', { language: 'bash', code: `echo x > '${path.join(h.outsideDir, 'planted.txt')}' || echo blocked` });
      expect(script.text).toContain('blocked');
      const background = await h.call('start_process', { command: `ls '${h.outsideDir}'; echo rc=$?`, wait_seconds: 3 });
      expect(background.text).not.toContain('secret.txt');
      expect(background.data?.['sandboxed']).toBe(true);
    });
  }
});
