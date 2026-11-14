import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desktopChecks, prepareDesktop } from '../../src/cli/desktop-setup.js';
import { captureUi } from '../helpers/cli.js';
import { type CallOutcome, createHarness, type Harness } from '../helpers/harness.js';

/**
 * Desktop control on a Mac that has NOT granted Accessibility and Screen Recording: what the
 * real helper, the real `screencapture` and the real macOS answer, and what the agent and the
 * user are told.
 *
 * DESTRUCTIVE, therefore opt-in: with MCPCLAUDE_TEST_REVOKE_PERMISSIONS=1 this suite runs
 * `tccutil reset` and so withdraws both permissions from every application on the Mac. CI runs
 * it as the last step of the macOS jobs, on a machine that is thrown away afterwards.
 */
const run = promisify(execFile);
const enabled = process.platform === 'darwin' && process.env['MCPCLAUDE_TEST_REVOKE_PERMISSIONS'] === '1';

const ACCESSIBILITY = 'macOS has not granted Accessibility access to the application that runs mcpclaude';
const ACCESSIBILITY_HINT = 'Hint: Ask the user to open System Settings → Privacy & Security → Accessibility, enable the application that runs mcpclaude (Terminal, iTerm, …) and restart mcpclaude. You cannot grant this yourself.';
const SCREEN_RECORDING_HINT =
  'Hint: Ask the user to open System Settings → Privacy & Security → Screen & System Audio Recording, enable the application that runs mcpclaude (Terminal, iTerm, …) and restart mcpclaude. You cannot grant this yourself.';

describe.runIf(enabled)('desktop control without the macOS privacy permissions', () => {
  let h: Harness;

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> => {
    const outcome = await h.call(name, args);
    console.log(`[no-permissions] ${name} ${JSON.stringify(args)} → ${outcome.text.slice(0, 300)}`);
    return outcome;
  };

  beforeAll(async () => {
    h = await createHarness({ mode: 'full' });
    await h.runtime.desktop?.driver.prepare();
    for (const service of ['Accessibility', 'ScreenCapture', 'PostEvent', 'ListenEvent']) {
      await run('/usr/bin/tccutil', ['reset', service]);
    }
  }, 600_000);

  afterAll(async () => {
    await h.close();
  });

  it('finds both permissions missing, while the tools stay on offer', async () => {
    expect(await h.runtime.desktop?.permissions()).toEqual({ accessibility: false, screen_recording: false });
    const info = (await call('server_info')).data as { desktop_control: boolean; tool_groups: Record<string, { status: string }> };
    expect(info.desktop_control).toBe(true);
    expect(info.tool_groups['computer']?.status).toBe('available');
  });

  it('refuses screenshots and names the Screen Recording setting', async () => {
    for (const args of [{}, { format: 'png' }, { region: { x: 0, y: 0, width: 200, height: 100 } }]) {
      const shot = await call('screenshot', args);
      expect(shot.isError).toBe(true);
      expect(shot.images).toEqual([]);
      expect(shot.text).toBe(`Error [MACOS_PERMISSION_REQUIRED]: macOS has not granted Screen Recording access to the application that runs mcpclaude, so the screen cannot be captured.\n${SCREEN_RECORDING_HINT}`);
    }
  });

  it('refuses mouse and keyboard input and names the Accessibility setting', async () => {
    const before = (await call('cursor_position')).data as { x: number; y: number };
    const attempts: [string, Record<string, unknown>][] = [
      ['mouse_move', { x: 300, y: 300 }],
      ['click', { x: 300, y: 300 }],
      ['click', { x: 300, y: 300, button: 'right' }],
      ['drag', { from_x: 100, from_y: 100, to_x: 200, to_y: 200 }],
      ['scroll', { x: 300, y: 300, direction: 'down' }],
      ['type_text', { text: 'never typed' }],
      ['press_key', { keys: 'cmd+a' }],
    ];
    for (const [name, args] of attempts) {
      const outcome = await call(name, args);
      expect(outcome.isError, name).toBe(true);
      expect(outcome.text, name).toBe(`Error [MACOS_PERMISSION_REQUIRED]: ${ACCESSIBILITY}, so mouse and keyboard events are discarded\n${ACCESSIBILITY_HINT}`);
    }
    // Nothing moved: the refusal comes before any event is posted.
    expect((await call('cursor_position')).data).toEqual(before);

    const batch = await call('computer_actions', { actions: [{ action: 'click', x: 10, y: 10 }, { action: 'type_text', text: 'x' }] });
    expect(batch.text).toBe(`Error [MACOS_PERMISSION_REQUIRED]: Step 1 (click) failed: ${ACCESSIBILITY}, so mouse and keyboard events are discarded No step was carried out before it.\n${ACCESSIBILITY_HINT}`);
  });

  it('refuses window, interface and menu control the same way', async () => {
    // The window server still lists what is on screen, without titles of minimised windows or any control.
    const windows = await call('list_windows');
    expect(windows.isError).toBe(false);
    expect(windows.data?.['limited']).toBe(true);
    expect(windows.text).toContain('Note: macOS has not granted Accessibility access, so minimised windows are missing, titles may be empty and windows cannot be managed.');

    const attempts: [string, Record<string, unknown>][] = [
      ['focus_window', { window_id: 1 }],
      ['set_window_bounds', { window_id: 1, x: 10, y: 40 }],
      ['set_window_state', { window_id: 1, state: 'minimized' }],
      ['close_window', { window_id: 1 }],
      ['find_ui_elements', { text: 'OK' }],
      ['get_ui_tree', {}],
      ['get_ui_element_at', { x: 100, y: 100 }],
      ['get_focused_ui_element', {}],
      ['perform_ui_action', { element_id: '1:0:AXButton', action: 'press' }],
      ['list_menus', { application: 'Finder' }],
      ['select_menu_item', { application: 'Finder', path: ['File', 'New Finder Window'] }],
    ];
    for (const [name, args] of attempts) {
      const outcome = await call(name, args);
      expect(outcome.isError, name).toBe(true);
      expect(outcome.text, name).toBe(`Error [MACOS_PERMISSION_REQUIRED]: ${ACCESSIBILITY}\n${ACCESSIBILITY_HINT}`);
    }
  });

  it('keeps working where macOS asks for no permission', async () => {
    const apps = await call('list_applications');
    expect(apps.isError).toBe(false);
    expect((apps.data?.['running'] as { name: string }[]).map((app) => app.name)).toContain('Finder');

    await call('set_clipboard', { text: 'no permission needed' });
    expect((await call('get_clipboard')).text).toBe('no permission needed');
    expect((await call('run_applescript', { script: 'return 6 * 7' })).text).toBe('42');
    expect((await call('run_command', { command: 'echo still-here' })).text).toContain('still-here');
    expect(typeof (await call('cursor_position')).data?.['x']).toBe('number');

    // An action that works still reports that it could not show the result.
    const waited = await call('wait', { seconds: 0.1 });
    expect(waited.isError).toBe(false);
    expect(waited.text).toMatch(/^Waited 0\.1 s\.\nThe action was carried out, but no screenshot could be taken: macOS has not granted Screen Recording access/);
  });

  it('tells the user in the wizard and in doctor what to switch on', async () => {
    const out = captureUi();
    // The wizard asks macOS to show its permission dialogs; nobody answers them here.
    await prepareDesktop(h.runtime, out.ui);
    console.log(`[no-permissions] wizard:\n${out.text()}`);
    expect(out.text()).toContain('! macOS has not granted Accessibility access: the agent cannot use the mouse, the keyboard, windows or menus yet.');
    expect(out.text()).toContain('System Settings → Privacy & Security → Accessibility: switch on ');
    expect(out.text()).toContain('! macOS has not granted Screen Recording access: the agent cannot see the screen yet.');
    expect(out.text()).toContain('System Settings → Privacy & Security → Screen & System Audio Recording: switch on ');

    const checks = await desktopChecks({ stateDir: h.stateDir, platform: 'darwin', env: { TERM_PROGRAM: 'Apple_Terminal' } });
    expect(checks.find((check) => check.name === 'Desktop helper')?.status).toBe('ok');
    expect(checks.find((check) => check.name === 'Accessibility')).toEqual({
      name: 'Accessibility',
      status: 'warn',
      detail: 'not granted: no mouse, keyboard, window or menu control',
      fix: 'System Settings → Privacy & Security → Accessibility: switch on Terminal. It takes effect immediately.',
    });
    expect(checks.find((check) => check.name === 'Screen Recording')).toEqual({
      name: 'Screen Recording',
      status: 'warn',
      detail: 'not granted: no screenshots',
      fix: 'System Settings → Privacy & Security → Screen & System Audio Recording: switch on Terminal, then quit and reopen Terminal.',
    });

    // The installed command: warnings, not failures — shell and file tools work regardless.
    const cli = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
    const doctor = await run(process.execPath, [cli, 'doctor', '--offline'], { env: { ...process.env, MCPCLAUDE_HOME: h.stateDir, NO_COLOR: '1' } });
    console.log(`[no-permissions] doctor:\n${doctor.stdout}`);
    expect(doctor.stdout).toMatch(/! Accessibility\s+not granted: no mouse, keyboard, window or menu control/);
    expect(doctor.stdout).toMatch(/! Screen Recording\s+not granted: no screenshots/);
    expect(doctor.stdout).not.toContain('✖');
  }, 120_000);
});
