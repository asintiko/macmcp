import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Runtime } from '../../src/core/runtime.js';

let root: string;
let project: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-rt-')));
  project = path.join(root, 'project');
  await mkdir(project);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const runtimeFor = (platform: NodeJS.Platform, extra: Partial<ConstructorParameters<typeof Runtime>[0]> = {}): Runtime =>
  new Runtime({ stateDir: path.join(root, 'state'), authMode: 'token', platform, auditToDisk: false, home: root, env: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', NGROK_AUTHTOKEN: 'secret', MCPCLAUDE_TOKEN: 'secret', SSH_AUTH_SOCK: '/tmp/agent' }, ...extra });

describe('Runtime', () => {
  it('refuses everything until configured', () => {
    const runtime = runtimeFor('linux');
    expect(runtime.configured).toBe(false);
    expect(() => runtime.mode).toThrow(/setup is not finished/);
    expect(() => runtime.cwd).toThrow(/setup is not finished/);
    expect(() => runtime.assertOperational()).toThrow(/setup is not finished/);
  });

  it('resolves the project directory and starts there', async () => {
    const runtime = runtimeFor('linux');
    await runtime.configure({ mode: 'project', projectDir: `${project}/` });
    expect(runtime.state).toBe('ready');
    expect(runtime.projectDir).toBe(project);
    expect(runtime.cwd).toBe(project);
    await expect(runtime.resolvePath('a/b.txt')).resolves.toBe(path.join(project, 'a', 'b.txt'));
    await expect(runtime.resolvePath('../x')).rejects.toMatchObject({ code: 'OUTSIDE_PROJECT' });
    await expect(runtimeFor('linux').configure({ mode: 'full', projectDir: path.join(root, 'missing') })).rejects.toThrow();
  });

  it('strips its own secrets from the environment of commands', async () => {
    const runtime = runtimeFor('linux');
    await runtime.configure({ mode: 'full', projectDir: project });
    const env = runtime.commandEnv({ EXTRA: '1' });
    expect(env['NGROK_AUTHTOKEN']).toBeUndefined();
    expect(env['MCPCLAUDE_TOKEN']).toBeUndefined();
    expect(env).toMatchObject({ EXTRA: '1', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', SSH_AUTH_SOCK: '/tmp/agent' });
  });

  it('runs commands unwrapped in Full System Access mode', async () => {
    const runtime = runtimeFor('darwin');
    await runtime.configure({ mode: 'full', projectDir: project });
    expect(runtime.shellPlan('echo hi', 'sh')).toEqual({ file: '/bin/sh', args: ['-c', 'echo hi'], sandboxed: false });
    expect(runtime.sandboxStatus()).toMatchObject({ active: false });
    expect(runtime.scratchDir).toBe(path.join(root, 'state', 'tmp'));
  });

  it('has no OS sandbox outside macOS and says so', async () => {
    const runtime = runtimeFor('linux');
    await runtime.configure({ mode: 'project', projectDir: project });
    expect(runtime.shellPlan('echo hi', 'sh')).toEqual({ file: '/bin/sh', args: ['-c', 'echo hi'], sandboxed: false });
    expect(runtime.sandboxStatus()).toMatchObject({ active: false, kind: 'none', detail: expect.stringContaining('No OS sandbox on this platform') });
  });

  // On Linux there is no sandbox-exec, which is exactly the "sandbox cannot be applied" case.
  it.runIf(process.platform !== 'darwin')('fails closed on macOS when the sandbox cannot be applied', async () => {
    const runtime = runtimeFor('darwin');
    await runtime.configure({ mode: 'project', projectDir: project });
    expect(runtime.sandboxStatus()).toMatchObject({ active: false, detail: expect.stringContaining('Seatbelt sandbox unavailable') });
    expect(() => runtime.shellPlan('echo hi', 'sh')).toThrow(/Commands are disabled/);

    const unsafe = runtimeFor('darwin', { allowUnsandboxed: true });
    await unsafe.configure({ mode: 'project', projectDir: project });
    expect(unsafe.shellPlan('echo hi', 'sh')).toEqual({ file: '/bin/sh', args: ['-c', 'echo hi'], sandboxed: false });
  });

  it('pauses and resumes', async () => {
    const runtime = runtimeFor('linux');
    await runtime.configure({ mode: 'full', projectDir: project });
    let changes = 0;
    runtime.events.on('change', () => changes++);
    runtime.setPaused(true);
    expect(() => runtime.assertOperational()).toThrow(/paused/);
    runtime.setPaused(false);
    runtime.assertOperational();
    expect(changes).toBe(2);
  });
});
