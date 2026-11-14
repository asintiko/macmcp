import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { desktopChecks, prepareDesktop, terminalName } from '../../src/cli/desktop-setup.js';
import { ToolError } from '../../src/core/errors.js';
import type { PermissionMode } from '../../src/core/permissions.js';
import { Runtime } from '../../src/core/runtime.js';
import { captureUi } from '../helpers/cli.js';
import { FakeDesktopDriver } from '../helpers/fake-desktop.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-desktop-setup-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function runtimeWith(mac: FakeDesktopDriver | null, mode: PermissionMode = 'full', env: NodeJS.ProcessEnv = { TERM_PROGRAM: 'iTerm.app' }): Promise<Runtime> {
  const runtime = new Runtime({ stateDir: path.join(root, 'state'), authMode: 'token', auditToDisk: false, desktop: mac, allowUnsandboxed: true, env });
  await runtime.configure({ mode, projectDir: root });
  return runtime;
}

describe('desktop preparation in the wizard', () => {
  it('confirms that desktop control is ready', async () => {
    const mac = new FakeDesktopDriver();
    const out = captureUi();
    await prepareDesktop(await runtimeWith(mac), out.ui);
    expect(out.text()).toBe('✔ Desktop control ready: screen capture, mouse, keyboard, windows and menus.\n');
    // macOS is asked to show its permission dialogs.
    expect(mac.sent('permissions')).toEqual([{ prompt: true }]);
  });

  it('names the missing macOS permissions and where to grant them', async () => {
    const mac = new FakeDesktopDriver();
    mac.handlers['permissions'] = () => ({ accessibility: false, screen_recording: false });
    const out = captureUi();
    await prepareDesktop(await runtimeWith(mac), out.ui);
    expect(out.text().split('\n')).toEqual([
      '! macOS has not granted Accessibility access: the agent cannot use the mouse, the keyboard, windows or menus yet.',
      '  → System Settings → Privacy & Security → Accessibility: switch on iTerm. It takes effect immediately.',
      '! macOS has not granted Screen Recording access: the agent cannot see the screen yet.',
      '  → System Settings → Privacy & Security → Screen & System Audio Recording: switch on iTerm, then quit and reopen iTerm.',
      '',
    ]);

    mac.handlers['permissions'] = () => ({ accessibility: true, screen_recording: false });
    out.clear();
    await prepareDesktop(await runtimeWith(mac, 'full', {}), out.ui);
    expect(out.text()).toContain('✔ Accessibility access granted');
    expect(out.text()).toContain('switch on your terminal application, then quit and reopen your terminal application.');
  });

  it('keeps going when the helper cannot be built', async () => {
    const mac = new FakeDesktopDriver();
    mac.needsBuild = true;
    mac.prepareError = new ToolError('DEPENDENCY_MISSING', 'Desktop control needs the Xcode Command Line Tools to build its helper, and they are not installed.', 'Ask the user to run "xcode-select --install".');
    const out = captureUi();
    await expect(prepareDesktop(await runtimeWith(mac), out.ui)).resolves.toBeUndefined();
    expect(out.text().split('\n')).toEqual([
      '! Desktop control is not ready: Desktop control needs the Xcode Command Line Tools to build its helper, and they are not installed.',
      '  → Install the Xcode Command Line Tools with "xcode-select --install", then start mcpclaude again.',
      '  Shell and file tools work; screen, mouse and keyboard tools report this problem to the agent until it is fixed.',
      '',
    ]);
    expect(mac.sent('permissions')).toEqual([]);
  });

  it('does nothing in Project-Only mode, without a desktop, or when every desktop group is switched off', async () => {
    const mac = new FakeDesktopDriver();
    const out = captureUi();
    await prepareDesktop(await runtimeWith(mac, 'project'), out.ui);
    await prepareDesktop(await runtimeWith(null), out.ui);
    const off = await runtimeWith(mac);
    for (const group of ['apps', 'windows', 'computer', 'ui', 'scripting', 'after_effects', 'blender']) off.disabledGroups.add(group);
    await prepareDesktop(off, out.ui);
    expect(out.text()).toBe('');
    expect(mac.commands).toEqual([]);
  });

  it('recognises common terminal applications', () => {
    expect(terminalName({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('Terminal');
    expect(terminalName({ TERM_PROGRAM: 'vscode' })).toBe('Visual Studio Code');
    expect(terminalName({ TERM_PROGRAM: 'Rio.app' })).toBe('Rio');
    expect(terminalName({ KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(terminalName({})).toBe('your terminal application');
  });
});

describe('desktop checks of mcpclaude doctor', () => {
  const deps = (driver: FakeDesktopDriver | undefined, platform: NodeJS.Platform = 'darwin') => ({
    stateDir: path.join(root, 'state'),
    platform,
    env: { TERM_PROGRAM: 'Apple_Terminal' },
    ...(driver ? { driver } : {}),
  });

  it('reports the helper and both permissions without asking for them', async () => {
    const mac = new FakeDesktopDriver();
    mac.needsBuild = true;
    expect(await desktopChecks(deps(mac))).toEqual([
      { name: 'Desktop helper', status: 'ok', detail: 'compiled from source and cached' },
      { name: 'Accessibility', status: 'ok', detail: 'granted to Terminal: mouse, keyboard, windows and menus' },
      { name: 'Screen Recording', status: 'ok', detail: 'granted to Terminal: screenshots' },
    ]);
    expect(mac.sent('permissions')).toEqual([{ prompt: false }]);

    mac.needsBuild = false;
    mac.handlers['permissions'] = () => ({ accessibility: false, screen_recording: false });
    expect(await desktopChecks(deps(mac))).toEqual([
      { name: 'Desktop helper', status: 'ok', detail: 'built and cached' },
      {
        name: 'Accessibility',
        status: 'warn',
        detail: 'not granted: no mouse, keyboard, window or menu control',
        fix: 'System Settings → Privacy & Security → Accessibility: switch on Terminal. It takes effect immediately.',
      },
      {
        name: 'Screen Recording',
        status: 'warn',
        detail: 'not granted: no screenshots',
        fix: 'System Settings → Privacy & Security → Screen & System Audio Recording: switch on Terminal, then quit and reopen Terminal.',
      },
    ]);
  });

  it('reports a helper that does not compile, and skips everything off macOS', async () => {
    const mac = new FakeDesktopDriver();
    mac.prepareError = new ToolError('DEPENDENCY_MISSING', 'The desktop helper could not be compiled:\nmain.swift:3: error: no such module');
    const [helper, ...rest] = await desktopChecks(deps(mac));
    expect(helper).toMatchObject({ name: 'Desktop helper', status: 'fail', detail: 'The desktop helper could not be compiled: main.swift:3: error: no such module' });
    expect(rest).toEqual([]);
    expect(await desktopChecks(deps(undefined, 'linux'))).toEqual([{ name: 'Desktop control', status: 'skip', detail: 'macOS only' }]);
  });
});
