import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolError } from '../../src/core/errors.js';
import { ACCESSIBILITY_HINT, SCREEN_RECORDING_HINT } from '../../src/desktop/helper.js';
import { FakeDesktopDriver, type FakeDisplay, PLAIN, result, RETINA } from '../helpers/fake-desktop.js';
import { createHarness, type Harness } from '../helpers/harness.js';
import { readImageInfo } from '../../src/core/image.js';

let h: Harness | undefined;
let fake: FakeDesktopDriver;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function start(displays: FakeDisplay[] = [RETINA], mode: 'full' | 'project' = 'full'): Promise<Harness> {
  fake = new FakeDesktopDriver(displays);
  h = await createHarness({ mode, runtime: { desktop: fake } });
  return h;
}

const SECOND: FakeDisplay = { id: 2, index: 2, main: false, x: 1440, y: 0, width: 1920, height: 1080, pixel_width: 1920, pixel_height: 1080, scale: 1 };

describe('desktop tools: availability', () => {
  it('exist only in Full System Access mode', async () => {
    const project = await start([RETINA], 'project');
    const client = await project.connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ['screenshot', 'click', 'type_text', 'list_windows', 'open_application', 'find_ui_elements', 'run_applescript']) expect(names).not.toContain(name);
    const refused = await project.call('screenshot');
    expect(refused.text).toContain('Error [PERMISSION_DENIED]: screenshot requires Full System Access');
    expect(fake.commands).toEqual([]);
    expect(fake.captures).toEqual([]);
    await project.close();

    const full = await start();
    const all = (await (await full.connect()).listTools()).tools.map((t) => t.name);
    for (const name of ['screenshot', 'click', 'drag', 'scroll', 'type_text', 'press_key', 'computer_actions', 'list_windows', 'open_application', 'find_ui_elements', 'select_menu_item', 'run_applescript', 'get_clipboard']) {
      expect(all).toContain(name);
    }
  });

  it('are absent and refused on a host without a desktop driver', async () => {
    h = await createHarness({ runtime: { desktop: null } });
    const names = (await (await h.connect()).listTools()).tools.map((t) => t.name);
    expect(names).toContain('run_command');
    expect(names).not.toContain('screenshot');
    const refused = await h.call('click', { x: 1, y: 1 });
    expect(refused.text).toContain('Error [UNSUPPORTED_PLATFORM]: click needs macOS desktop control');
    const info = await h.call('server_info');
    expect(info.data).toMatchObject({ desktop_control: false, tool_groups: { computer: { status: 'not available on this host' } } });
  });

  it('can be switched off as a group', async () => {
    await start();
    h?.runtime.disabledGroups.add('computer');
    expect((await h?.call('screenshot'))?.text).toContain('The "computer" tool group was disabled by the user');
    expect((await h?.call('list_windows'))?.isError).toBe(true); // no answer scripted, but not refused as a group
    expect((await h?.call('list_windows'))?.text).not.toContain('disabled by the user');
  });
});

describe('screenshot', () => {
  it('returns the whole display scaled to the coordinate space, with pointer and frontmost window', async () => {
    await start();
    fake.pointer = { x: 720.5625, y: 450.5625 };
    const shot = await h!.call('screenshot');
    expect(shot.isError).toBe(false);
    expect(fake.captures).toEqual([{ display: 1, cursor: true }]);
    expect(fake.encodes).toEqual([{ width: 1280, height: 800, format: 'jpeg', quality: 80 }]);
    expect(shot.images).toHaveLength(1);
    expect(shot.images[0]?.mimeType).toBe('image/jpeg');
    expect(readImageInfo(Buffer.from(shot.images[0]?.data ?? '', 'base64'))).toMatchObject({ width: 1280, height: 800 });
    expect(shot.text).toBe(
      ['Screenshot of display 1 (1280×800). Coordinates for click, drag, scroll and the other tools are pixels of this image.', 'Pointer at (640, 400).', 'Frontmost: Finder — "Desktop".'].join('\n'),
    );
    expect(shot.data).toMatchObject({ display: 1, width: 1280, height: 800, screen: { width: 1280, height: 800 }, format: 'jpeg', pointer: { display: 1, x: 640, y: 400 }, frontmost_application: 'Finder', frontmost_window: 'Desktop' });
  });

  it('keeps a lossless PNG untouched when no scaling is needed', async () => {
    await start([PLAIN]);
    const shot = await h!.call('screenshot', { format: 'png', show_cursor: false });
    expect(fake.captures).toEqual([{ display: 1, cursor: false }]);
    expect(fake.encodes).toEqual([]);
    expect(shot.images[0]?.mimeType).toBe('image/png');
    expect(shot.data).toMatchObject({ width: 1024, height: 768, format: 'png' });
  });

  it('enlarges a region and explains how its pixels map back', async () => {
    await start();
    const shot = await h!.call('screenshot', { region: { x: 100, y: 200, width: 400, height: 300 } });
    // 400×300 screenshot pixels are 450×337.5 points, captured at 2× as 900×675 pixels.
    expect(fake.captures).toEqual([{ region: { x: 112.5, y: 225, width: 450, height: 337.5 }, cursor: true }]);
    expect(fake.encodes).toEqual([{ width: 900, height: 675, format: 'jpeg', quality: 80 }]);
    expect(shot.data).toMatchObject({ width: 900, height: 675, region: { x: 100, y: 200, width: 400, height: 300 }, zoom: 2.25, screen: { width: 1280, height: 800 } });
    expect(shot.text).toContain('Enlarged view of the area x=100 y=200 400×300 of display 1, shown at 2.25× (900×675).');
    expect(shot.text).toContain('full_x = 100 + image_x / 2.25, full_y = 200 + image_y / 2.25');

    const clipped = await h!.call('screenshot', { region: { x: 1200, y: 700, width: 500, height: 500 } });
    expect(clipped.data).toMatchObject({ region: { x: 1200, y: 700, width: 80, height: 100 } });
    const outside = await h!.call('screenshot', { region: { x: 1300, y: 0, width: 50, height: 50 } });
    expect(outside.text).toContain('Error [INVALID_ARGUMENT]: The region does not overlap the screen (1280×800 pixels).');
  });

  it('captures a single window', async () => {
    await start();
    const shot = await h!.call('screenshot', { window_id: 4821 });
    expect(fake.captures).toEqual([{ windowId: 4821, cursor: false }]);
    expect(fake.encodes).toEqual([{ width: 1280, height: 800, format: 'jpeg', quality: 80 }]);
    expect(shot.text).toContain('Picture of window 4821 (1280×800). It is for reading only');
  });

  it('selects other displays and rejects ones that do not exist', async () => {
    await start([RETINA, SECOND]);
    const shot = await h!.call('screenshot', { display: 2 });
    expect(fake.captures).toEqual([{ display: 2, cursor: true }]);
    expect(shot.data).toMatchObject({ display: 2, width: 1280, height: 720 });
    expect((await h!.call('screenshot', { display: 3 })).text).toContain('Error [INVALID_ARGUMENT]: There is no display 3: this Mac has 2 displays');
  });

  it('explains a missing Screen Recording permission', async () => {
    await start();
    fake.captureError = new ToolError('MACOS_PERMISSION_REQUIRED', 'The screen could not be captured.', SCREEN_RECORDING_HINT);
    const shot = await h!.call('screenshot');
    expect(shot.isError).toBe(true);
    expect(shot.text).toContain('Error [MACOS_PERMISSION_REQUIRED]: The screen could not be captured.');
    expect(shot.text).toContain('Hint: Ask the user to open System Settings → Privacy & Security → Screen & System Audio Recording');
  });
});

describe('mouse', () => {
  it('converts screenshot pixels to display points', async () => {
    await start();
    const clicked = await h!.call('click', { x: 640, y: 400 });
    expect(fake.sent('mouse_click')).toEqual([{ x: 720.5625, y: 450.5625, button: 'left', count: 1, modifiers: [] }]);
    expect(clicked.text).toContain('Clicked at (640, 400).\nScreenshot of display 1 (1280×800).');
    expect(clicked.images).toHaveLength(1);
    expect(clicked.data).toMatchObject({ x: 640, y: 400, button: 'left', count: 1, screenshot: { width: 1280, height: 800 } });
  });

  it('passes button, click count and modifiers on, and can skip the screenshot', async () => {
    await start([PLAIN]);
    const right = await h!.call('click', { x: 10, y: 20, button: 'right', screenshot: false });
    expect(right.text).toBe('Clicked the right button at (10, 20).');
    expect(right.images).toEqual([]);
    expect(fake.captures).toEqual([]);
    expect((await h!.call('click', { x: 10, y: 20, count: 2, screenshot: false })).text).toBe('Double-clicked at (10, 20).');
    expect((await h!.call('click', { x: 10, y: 20, count: 3, modifiers: ['shift', 'cmd'], screenshot: false })).text).toBe('Triple-clicked at (10, 20) holding cmd+shift.');
    expect(fake.sent('mouse_click')).toEqual([
      { x: 10, y: 20, button: 'right', count: 1, modifiers: [] },
      { x: 10, y: 20, button: 'left', count: 2, modifiers: [] },
      { x: 10, y: 20, button: 'left', count: 3, modifiers: ['cmd', 'shift'] },
    ]);
  });

  it('refuses coordinates that are not on the screenshot', async () => {
    await start();
    const off = await h!.call('click', { x: 1500, y: 400 });
    expect(off.text).toContain('Error [INVALID_ARGUMENT]: Coordinates (1500, 400) are outside the screen: the screenshot of display 1 is 1280×800 pixels.');
    expect(off.text).toContain('Hint: Take a screenshot and use pixel coordinates from it.');
    expect(fake.sent('mouse_click')).toEqual([]);
  });

  it('addresses secondary displays by their own screenshot', async () => {
    await start([RETINA, SECOND]);
    await h!.call('click', { x: 100, y: 60, display: 2, screenshot: false });
    expect(fake.sent('mouse_click')[0]).toMatchObject({ x: 1590.75, y: 90.75 });
    expect((await h!.call('cursor_position')).data).toEqual({ display: 2, x: 100, y: 60 });
  });

  it('moves, drags and scrolls', async () => {
    await start([PLAIN]);
    expect((await h!.call('mouse_move', { x: 5, y: 6, screenshot: false })).text).toBe('Moved the pointer to (5, 6).');
    expect((await h!.call('cursor_position')).text).toBe('Pointer at (5, 6) on display 1.');

    const dragged = await h!.call('drag', { from_x: 100, from_y: 100, to_x: 300, to_y: 150, duration_ms: 200, modifiers: ['alt'], screenshot: false });
    expect(dragged.text).toBe('Dragged from (100, 100) to (300, 150) holding alt.');
    expect(fake.sent('mouse_drag')).toEqual([{ from_x: 100, from_y: 100, to_x: 300, to_y: 150, button: 'left', duration_ms: 200, modifiers: ['alt'] }]);

    await h!.call('scroll', { x: 50, y: 60, direction: 'down', amount: 10, screenshot: false });
    await h!.call('scroll', { x: 50, y: 60, direction: 'up', screenshot: false });
    await h!.call('scroll', { x: 50, y: 60, direction: 'right', amount: 3, screenshot: false });
    expect(fake.sent('mouse_scroll')).toEqual([
      { x: 50, y: 60, dx: 0, dy: -10, unit: 'line', modifiers: [] },
      { x: 50, y: 60, dx: 0, dy: 5, unit: 'line', modifiers: [] },
      { x: 50, y: 60, dx: -3, dy: 0, unit: 'line', modifiers: [] },
    ]);
  });
});

describe('keyboard', () => {
  it('types text and reports a preview', async () => {
    await start([PLAIN]);
    const typed = await h!.call('type_text', { text: 'Héllo ✓\n', delay_ms: 20, screenshot: false });
    expect(typed.text).toBe('Typed "Héllo ✓\\n".');
    expect(fake.sent('type')).toEqual([{ text: 'Héllo ✓\n', delay_ms: 20 }]);
    const long = await h!.call('type_text', { text: 'x'.repeat(200), screenshot: false });
    expect(long.text).toBe(`Typed "${'x'.repeat(60)}…" (200 characters).`);
  });

  it('presses named keys, shortcuts and sequences', async () => {
    await start([PLAIN]);
    expect((await h!.call('press_key', { keys: 'cmd+shift+s', screenshot: false })).text).toBe('Pressed cmd+shift+s.');
    expect((await h!.call('press_key', { keys: 'down', repeat: 3, screenshot: false })).text).toBe('Pressed down 3 times.');
    expect((await h!.call('press_key', { keys: 'cmd+a cmd+c escape', hold_ms: 50, screenshot: false })).text).toBe('Pressed cmd+a, cmd+c, escape.');
    expect(fake.sent('key')).toEqual([
      { char: 's', modifiers: ['cmd', 'shift'], repeat: 1 },
      { code: 125, modifiers: [], repeat: 3 },
      { char: 'a', modifiers: ['cmd'], repeat: 1, hold_ms: 50 },
      { char: 'c', modifiers: ['cmd'], repeat: 1, hold_ms: 50 },
      { code: 53, modifiers: [], repeat: 1, hold_ms: 50 },
    ]);
    // One helper run per call, however many keys it carries.
    expect(fake.invocations.filter((commands) => commands.some((c) => c.command === 'key')).map((commands) => commands.length)).toEqual([1, 1, 3]);
    expect((await h!.call('press_key', { keys: 'cmd+banana' })).text).toContain('Error [INVALID_ARGUMENT]: Unknown key "banana"');
  });

  it('explains a missing Accessibility permission', async () => {
    await start([PLAIN]);
    fake.handlers['type'] = () => {
      throw new ToolError('MACOS_PERMISSION_REQUIRED', 'macOS has not granted Accessibility access to the application that runs mcpclaude', ACCESSIBILITY_HINT);
    };
    const typed = await h!.call('type_text', { text: 'x' });
    expect(typed.isError).toBe(true);
    expect(typed.text).toContain('Error [MACOS_PERMISSION_REQUIRED]');
    expect(typed.text).toContain('Privacy & Security → Accessibility');
    expect(typed.images).toEqual([]);
  });
});

describe('computer_actions', () => {
  it('runs every step in one go and returns a single screenshot', async () => {
    await start();
    const batch = await h!.call('computer_actions', {
      actions: [
        { action: 'click', x: 640, y: 400 },
        { action: 'press_key', keys: 'cmd+a' },
        { action: 'type_text', text: '1920' },
        { action: 'wait', seconds: 0.5 },
        { action: 'double_click', x: 10, y: 10 },
        { action: 'right_click', x: 20, y: 20, modifiers: ['ctrl'] },
        { action: 'scroll', x: 30, y: 30, direction: 'up', amount: 2 },
        { action: 'drag', x: 0, y: 0, to_x: 80, to_y: 160 },
      ],
    });
    expect(batch.isError).toBe(false);
    const inputRuns = fake.invocations.filter((commands) => commands.some((c) => c.command === 'mouse_click'));
    expect(inputRuns).toHaveLength(1);
    expect(inputRuns[0]?.map((c) => c.command)).toEqual(['mouse_click', 'key', 'type', 'sleep', 'mouse_click', 'mouse_click', 'mouse_scroll', 'mouse_drag']);
    expect(inputRuns[0]?.[3]?.params).toEqual({ ms: 500 });
    expect(inputRuns[0]?.[4]?.params).toMatchObject({ count: 2, button: 'left' });
    expect(inputRuns[0]?.[5]?.params).toMatchObject({ count: 1, button: 'right', modifiers: ['ctrl'] });
    expect(inputRuns[0]?.[7]?.params).toMatchObject({ from_x: 0.5625, from_y: 0.5625, to_x: 90.5625, to_y: 180.5625 });
    expect(batch.text).toContain('1. Clicked at (640, 400)\n2. Pressed cmd+a\n3. Typed "1920"\n4. Waited 0.5 s\n5. Double-clicked at (10, 10)');
    expect(batch.images).toHaveLength(1);
    expect(fake.captures).toHaveLength(1);
    expect(batch.data).toMatchObject({ steps: 8 });
  });

  it('reports movement as dragging while a button is held', async () => {
    await start([PLAIN]);
    await h!.call('computer_actions', {
      screenshot: false,
      actions: [
        { action: 'key_down', keys: 'shift' },
        { action: 'mouse_move', x: 10, y: 10 },
        { action: 'mouse_down', x: 10, y: 10 },
        { action: 'mouse_move', x: 50, y: 10 },
        { action: 'mouse_up', x: 90, y: 10 },
        { action: 'mouse_move', x: 95, y: 10 },
        { action: 'key_up', keys: 'shift' },
      ],
    });
    expect(fake.commands.filter((c) => c.command !== 'displays')).toEqual([
      { command: 'key_down', params: { code: 56, modifiers: [] } },
      { command: 'mouse_move', params: { x: 10, y: 10 } },
      { command: 'mouse_down', params: { x: 10, y: 10, button: 'left', modifiers: [] } },
      { command: 'mouse_move', params: { x: 50, y: 10, dragging: 'left', modifiers: [] } },
      { command: 'mouse_up', params: { x: 90, y: 10, button: 'left', modifiers: [] } },
      { command: 'mouse_move', params: { x: 95, y: 10 } },
      { command: 'key_up', params: { code: 56, modifiers: [] } },
    ]);
  });

  it('carries out nothing when a step is malformed', async () => {
    await start([PLAIN]);
    const bad = await h!.call('computer_actions', { actions: [{ action: 'click', x: 10, y: 10 }, { action: 'type_text' }] });
    expect(bad.text).toContain('Error [INVALID_ARGUMENT]: Step 2 (type_text): "type_text" needs "text". Nothing was carried out.');
    const off = await h!.call('computer_actions', { actions: [{ action: 'click', x: 10, y: 10 }, { action: 'click', x: 5000, y: 10 }] });
    expect(off.text).toContain('Step 2 (click): Coordinates (5000, 10) are outside the screen');
    expect(fake.sent('mouse_click')).toEqual([]);
    const slow = await h!.call('computer_actions', { actions: Array.from({ length: 7 }, () => ({ action: 'wait', seconds: 30 })) });
    expect(slow.text).toContain('would take longer than three minutes');
  });

  it('says which step failed and what was done before it', async () => {
    await start([PLAIN]);
    fake.handlers['type'] = () => {
      throw new ToolError('FAILED', 'Could not create a keyboard event');
    };
    const failed = await h!.call('computer_actions', { actions: [{ action: 'click', x: 1, y: 1 }, { action: 'press_key', keys: 'cmd+a cmd+c' }, { action: 'type_text', text: 'x' }, { action: 'click', x: 2, y: 2 }] });
    expect(failed.text).toBe('Error [FAILED]: Step 3 (type_text) failed: Could not create a keyboard event Steps 1-2 were carried out.');
    expect(fake.sent('mouse_click')).toHaveLength(1);
  });
});

describe('wait and action results', () => {
  it('waits, then looks', async () => {
    await start([PLAIN]);
    const before = Date.now();
    const waited = await h!.call('wait', { seconds: 0.3 });
    expect(Date.now() - before).toBeGreaterThanOrEqual(290);
    expect(waited.text).toContain('Waited 0.3 s.\nScreenshot of display 1 (1024×768)');
    expect(waited.images).toHaveLength(1);
  });

  it('still reports a completed action when the screenshot afterwards fails', async () => {
    await start([PLAIN]);
    fake.captureError = new ToolError('MACOS_PERMISSION_REQUIRED', 'The screen could not be captured.', SCREEN_RECORDING_HINT);
    const clicked = await h!.call('click', { x: 10, y: 10 });
    expect(clicked.isError).toBe(false);
    expect(clicked.text).toContain('Clicked at (10, 10).\nThe action was carried out, but no screenshot could be taken: The screen could not be captured.');
    expect(clicked.images).toEqual([]);
    expect(fake.sent('mouse_click')).toHaveLength(1);
  });

  it('never interleaves the input of concurrent calls', async () => {
    await start([PLAIN]);
    fake.delayMs = 40;
    await Promise.all([
      h!.call('computer_actions', { screenshot: false, actions: [{ action: 'click', x: 1, y: 1 }, { action: 'type_text', text: 'first' }] }),
      h!.call('computer_actions', { screenshot: false, actions: [{ action: 'click', x: 2, y: 2 }, { action: 'type_text', text: 'second' }] }),
      h!.call('press_key', { keys: 'return', screenshot: false }),
    ]);
    const order = fake.commands.filter((c) => c.command !== 'displays').map((c) => c.command);
    expect(order.slice(0, 2)).toEqual(['mouse_click', 'type']);
    expect(order.filter((c) => c === 'mouse_click' || c === 'type' || c === 'key')).toHaveLength(5);
    // Each batch stays contiguous.
    const joined = order.join(' ');
    expect(joined.match(/mouse_click type/g)).toHaveLength(2);
  });
});

describe('applications', () => {
  const apps = [
    { pid: 100, name: 'Finder', bundle_id: 'com.apple.finder', path: '/System/Library/CoreServices/Finder.app', active: true, hidden: false, kind: 'regular' },
    { pid: 200, name: 'Blender', bundle_id: 'org.blenderfoundation.blender', path: '/Applications/Blender.app', active: false, hidden: true, kind: 'regular' },
    { pid: 300, name: 'Dropbox', bundle_id: 'com.getdropbox.dropbox', path: '/Applications/Dropbox.app', active: false, hidden: false, kind: 'accessory' },
  ];

  it('lists running applications and marks the frontmost', async () => {
    await start([PLAIN]);
    fake.handlers['apps'] = (params) => ({ applications: apps.filter((a) => params['include_background'] || a.kind === 'regular'), frontmost: apps[0] });
    const listed = await h!.call('list_applications');
    expect(listed.text).toContain('*  Finder       100  com.apple.finder');
    expect(listed.text).toMatch(/Blender\s+200\s+org\.blenderfoundation\.blender\s+hidden/);
    expect(listed.text).toContain('* frontmost: Finder');
    expect(listed.text).not.toContain('Dropbox');
    expect(listed.data).toMatchObject({ frontmost: 'Finder' });
    const all = await h!.call('list_applications', { include_background: true, installed: true });
    expect(all.text).toMatch(/Dropbox\s+300\s+com\.getdropbox\.dropbox\s+accessory/);
    expect(all.text).toMatch(/Installed \(\d+\):/);
    expect(Array.isArray(all.data?.['installed'])).toBe(true);
  });

  it('opens an application by name, waits for it and brings it to the front', async () => {
    await start([PLAIN]);
    let polls = 0;
    fake.handlers['apps'] = () => ({ applications: (polls += 1) >= 3 ? apps : [apps[0]], frontmost: apps[0] });
    fake.handlers['app_activate'] = (params) => ({ ...apps[1], pid: params['pid'], active: true });
    const opened = await h!.call('open_application', { application: 'Blender' });
    expect(fake.opened).toEqual([['-a', 'Blender']]);
    expect(polls).toBe(3);
    expect(fake.sent('app_activate')).toEqual([{ pid: 200 }]);
    expect(opened.text).toContain('Blender (pid 200) is frontmost.');
    expect(opened.data).toMatchObject({ running: true, name: 'Blender', pid: 200, frontmost: true, bundle_id: 'org.blenderfoundation.blender' });
    expect(opened.images).toHaveLength(1);
  });

  it('opens by bundle id or path, with arguments, a new instance or in the background', async () => {
    const harness = await start([PLAIN]);
    fake.handlers['apps'] = () => ({ applications: apps, frontmost: apps[0] });
    const background = await harness.call('open_application', { application: 'org.blenderfoundation.blender', background: true, new_instance: true, arguments: ['--factory-startup'], screenshot: false });
    expect(background.text).toBe('Blender (pid 200) is running in the background.');
    expect(fake.sent('app_activate')).toEqual([]);

    const bundle = path.join(harness.projectDir, 'Blender.app');
    await mkdir(bundle);
    await harness.call('open_application', { application: bundle, screenshot: false });
    expect(fake.opened).toEqual([['-n', '-g', '-b', 'org.blenderfoundation.blender', '--args', '--factory-startup'], [bundle]]);
    expect((await harness.call('open_application', { application: path.join(harness.projectDir, 'Missing.app') })).text).toContain('Error [NOT_FOUND]: No application at');
  });

  it('explains when the application does not exist or does not appear', async () => {
    await start([PLAIN]);
    fake.handlers['apps'] = () => ({ applications: [apps[0]], frontmost: apps[0] });
    fake.openResult = () => result({ code: 1, stderr: "Unable to find application named 'Blendr'\n" });
    const missing = await h!.call('open_application', { application: 'Blendr' });
    expect(missing.text).toBe('Error [NOT_FOUND]: macOS found no application "Blendr".\nHint: list_applications with installed: true shows the names of the installed applications.');

    fake.openResult = () => result();
    const slow = await h!.call('open_application', { application: 'Blender', wait_seconds: 0.5, screenshot: false });
    expect(slow.isError).toBe(false);
    expect(slow.text).toContain('it has not appeared among the running applications after 0.5 s');
    expect(slow.data).toMatchObject({ running: false });
  });

  it('activates and quits applications', async () => {
    await start([PLAIN]);
    fake.handlers['app_activate'] = (params) => ({ ...apps[1], name: String(params['name'] ?? 'Blender'), active: true });
    fake.handlers['app_quit'] = (params) => ({ ...apps[1], requested: true, terminated: !params['force'] });
    expect((await h!.call('activate_application', { application: 'Blender', screenshot: false })).text).toBe('Blender (pid 200) is now frontmost.');
    expect((await h!.call('activate_application', { screenshot: false })).text).toContain('Error [INVALID_ARGUMENT]: Name the application with `application` or `pid`.');
    expect((await h!.call('quit_application', { pid: 200, screenshot: false })).text).toBe('Blender has quit.');
    expect((await h!.call('quit_application', { application: 'Blender', force: true, wait_seconds: 1, screenshot: false })).text).toContain('was asked to quit but is still running after 1 s');
    expect(fake.sent('app_quit')).toEqual([
      { pid: 200, force: false, wait_seconds: 10 },
      { name: 'Blender', force: true, wait_seconds: 1 },
    ]);
  });

  it('opens files, folders and URLs, optionally with a chosen application', async () => {
    const harness = await start([PLAIN]);
    const file = path.join(harness.projectDir, 'title.aep');
    await writeFile(file, 'x');
    expect((await harness.call('open_path', { target: 'title.aep', application: 'Adobe After Effects 2025', screenshot: false })).text).toBe(`Opened with Adobe After Effects 2025: ${file}`);
    expect((await harness.call('open_path', { target: file, reveal: true, background: true, screenshot: false })).text).toBe(`Revealed in Finder: ${file}`);
    expect((await harness.call('open_path', { target: 'https://www.blender.org/download/', application: 'com.apple.Safari', screenshot: false })).text).toBe('Opened with com.apple.Safari: https://www.blender.org/download/');
    expect(fake.opened).toEqual([
      ['-a', 'Adobe After Effects 2025', file],
      ['-R', '-g', file],
      ['-b', 'com.apple.Safari', 'https://www.blender.org/download/'],
    ]);
    expect((await harness.call('open_path', { target: 'missing.aep' })).text).toContain('Error [NOT_FOUND]: No such file or directory');
    expect((await harness.call('open_path', { target: 'https://example.com', reveal: true })).text).toContain('Only files and folders can be revealed');
  });
});

describe('windows', () => {
  const raw = [
    { app: 'Blender', pid: 200, title: 'Blender', minimized: false, main: true, focused: true, fullscreen: false, frame: { x: 112.5, y: 225, width: 900, height: 450 }, window_id: 4821, z: 0 },
    { app: 'Finder', pid: 100, title: 'Documents', minimized: true, main: false, focused: false, fullscreen: false, frame: { x: 0, y: 28.125, width: 450, height: 225 }, window_id: 77 },
  ];

  it('lists windows with positions in screenshot pixels', async () => {
    await start();
    fake.handlers['windows'] = () => ({ windows: raw, limited: false });
    const listed = await h!.call('list_windows', { application: 'Blender' });
    expect(fake.sent('windows')).toEqual([{ name: 'Blender' }]);
    expect(listed.text).toContain('4821  Blender      Blender    (100, 200) 800×400  focused');
    expect(listed.text).toContain('77    Finder       Documents  (0, 25) 400×200     minimised');
    expect((listed.data?.['windows'] as unknown[])[0]).toEqual({
      window_id: 4821, application: 'Blender', pid: 200, title: 'Blender', x: 100, y: 200, width: 800, height: 400, display: 1,
      minimized: false, focused: true, fullscreen: false, on_screen: true,
    });
    fake.handlers['windows'] = () => ({ windows: [], limited: true });
    const limited = await h!.call('list_windows');
    expect(limited.text).toContain('No windows are open.');
    expect(limited.text).toContain('macOS has not granted Accessibility access');
  });

  it('focuses, moves, resizes, changes state and closes', async () => {
    await start();
    fake.handlers['window_action'] = (params) => (params['action'] === 'close' ? { closed: true } : { ...raw[0], ...(params['action'] === 'move' ? { frame: { x: params['x'], y: params['y'], width: 900, height: 450 } } : {}) });
    expect((await h!.call('focus_window', { window_id: 4821, screenshot: false })).text).toBe('Focused Blender — "Blender" (window 4821).');
    const moved = await h!.call('set_window_bounds', { window_id: 4821, x: 0, y: 32, width: 1000, height: 600, screenshot: false });
    expect(fake.sent('window_action').slice(1)).toEqual([
      { window_id: 4821, action: 'move', x: 0, y: 36 },
      { window_id: 4821, action: 'resize', width: 1125, height: 675 },
    ]);
    expect(moved.text).toContain('Blender — "Blender" (window 4821) is now at');
    expect((await h!.call('set_window_bounds', { window_id: 4821, x: 5 })).text).toContain('Error [INVALID_ARGUMENT]: Give x and y together.');
    expect((await h!.call('set_window_bounds', { window_id: 4821, width: 5 })).text).toContain('Give width and height together.');
    expect((await h!.call('set_window_bounds', { window_id: 4821 })).text).toContain('Give x and y to move the window');

    for (const [state, action] of [['minimized', 'minimize'], ['restored', 'restore'], ['fullscreen', 'fullscreen'], ['windowed', 'exit_fullscreen']] as const) {
      await h!.call('set_window_state', { window_id: 4821, state, screenshot: false });
      expect(fake.sent('window_action').at(-1)).toEqual({ window_id: 4821, action });
    }
    expect((await h!.call('close_window', { window_id: 4821, screenshot: false })).text).toBe('Pressed the close button of window 4821.');
  });
});

describe('interface elements', () => {
  const button = { id: '200:0.3.1:AXButton', role: 'AXButton', title: 'Export', frame: { x: 112.5, y: 225, width: 90, height: 45 }, actions: ['AXPress'] };
  const field = { id: '200:0.2.0:AXTextField', role: 'AXTextField', description: 'Name', value: 'Comp 1', focused: true, frame: { x: 225, y: 450, width: 225, height: 22.5 } };

  it('finds elements and says where to click them', async () => {
    await start();
    fake.handlers['ui_find'] = () => ({ application: 'Blender', pid: 200, elements: [button, { ...field, enabled: false }], truncated: false });
    const found = await h!.call('find_ui_elements', { text: 'export', role: 'Button', application: 'Blender' });
    expect(fake.sent('ui_find')).toEqual([{ name: 'Blender', text: 'export', role: 'Button', limit: 25 }]);
    expect(found.text).toBe(
      ['2 elements in Blender:', 'Button "Export" @(140, 220) id=200:0.3.1:AXButton', 'TextField "Name" value="Comp 1" [disabled] [focused] @(300, 410) id=200:0.2.0:AXTextField'].join('\n'),
    );
    expect((found.data?.['elements'] as unknown[])[0]).toMatchObject({ element_id: '200:0.3.1:AXButton', role: 'Button', label: 'Export', frame: { x: 100, y: 200, width: 80, height: 40 }, center: { x: 140, y: 220 }, actions: ['Press'] });
    expect((await h!.call('find_ui_elements', {})).text).toContain('Give `text`, `role` or both.');
    fake.handlers['ui_find'] = () => ({ application: 'Blender', pid: 200, elements: [], truncated: false });
    expect((await h!.call('find_ui_elements', { text: 'nothing', window_id: 9 })).text).toContain('No matching element in Blender.');
    expect(fake.sent('ui_find').at(-1)).toEqual({ window_id: 9, text: 'nothing', limit: 25 });
  });

  it('outlines the interface as an indented tree', async () => {
    await start();
    fake.handlers['ui_tree'] = () => ({
      application: 'Blender',
      pid: 200,
      truncated: true,
      elements: [{ id: '200:0:AXWindow', role: 'AXWindow', title: 'Blender', depth: 0, frame: { x: 0, y: 0, width: 1440, height: 900 } }, { ...button, depth: 2 }, { id: '200:0.9:AXSlider', role: 'AXSlider', value: 0.5, depth: 1 }],
    });
    const tree = await h!.call('get_ui_tree', { window_id: 4821, max_depth: 3, include_containers: true });
    expect(fake.sent('ui_tree')).toEqual([{ window_id: 4821, max_depth: 3, max_elements: 250, compact: false }]);
    expect(tree.text).toBe(
      [
        'Interface of Blender (3 elements):',
        'Window "Blender" @(640, 400) id=200:0:AXWindow',
        '    Button "Export" @(140, 220) id=200:0.3.1:AXButton',
        '  Slider value=0.5 id=200:0.9:AXSlider',
        '… truncated: raise max_depth or max_elements, or look at a single window.',
      ].join('\n'),
    );
  });

  it('identifies the element at a position and the focused element', async () => {
    await start();
    fake.handlers['ui_at'] = () => ({ ...button, application: 'Blender', pid: 200, ancestors: ['AXToolbar', 'AXWindow "Blender"', 'AXApplication "Blender"'] });
    const at = await h!.call('get_ui_element_at', { x: 140, y: 220 });
    expect(fake.sent('ui_at')).toEqual([{ x: 158.0625, y: 248.0625 }]);
    expect(at.text).toBe(['Button "Export" @(140, 220) id=200:0.3.1:AXButton', 'Application: Blender', 'Actions: Press', 'Inside: Toolbar < Window "Blender" < Application "Blender"'].join('\n'));

    fake.handlers['ui_focused'] = () => ({ ...field, application: 'Blender', pid: 200, value_length: 9000 });
    const focused = await h!.call('get_focused_ui_element', { max_value_chars: 50 });
    expect(fake.sent('ui_focused')).toEqual([{ value_limit: 50 }]);
    expect(focused.text).toContain('TextField "Name" value="Comp 1" [focused]');
    expect(focused.text).toContain('(value truncated: 9000 characters in total)');
    expect(focused.data).toMatchObject({ value: 'Comp 1', focused: true, application: 'Blender' });
  });

  it('presses, sets values and clicks elements', async () => {
    await start();
    fake.handlers['ui_action'] = (params) => ({ ...(String(params['id']).includes('Slider') ? { id: params['id'], role: 'AXSlider', value: params['value'] } : button), ...(params['action'] === 'press' ? { note: 'The application did not confirm the action in time; it has most likely happened.' } : {}) });
    const pressed = await h!.call('perform_ui_action', { element_id: button.id, screenshot: false });
    expect(pressed.text).toBe('Pressed Button "Export" @(140, 220) id=200:0.3.1:AXButton\nThe application did not confirm the action in time; it has most likely happened.');

    await h!.call('perform_ui_action', { element_id: field.id, action: 'set_value', value: '1920', screenshot: false });
    await h!.call('perform_ui_action', { element_id: '200:0.9:AXSlider', action: 'set_value', value: '0.75', screenshot: false });
    await h!.call('perform_ui_action', { element_id: '200:0.4:AXCheckBox', action: 'set_value', value: 'on', screenshot: false });
    expect(fake.sent('ui_action').slice(1)).toEqual([
      { id: field.id, action: 'set_value', value: '1920' },
      { id: '200:0.9:AXSlider', action: 'set_value', value: 0.75 },
      { id: '200:0.4:AXCheckBox', action: 'set_value', value: 1 },
    ]);
    expect((await h!.call('perform_ui_action', { element_id: '200:0.9:AXSlider', action: 'set_value', value: 'loud' })).text).toContain('A Slider takes a number, not "loud".');
    expect((await h!.call('perform_ui_action', { element_id: field.id, action: 'set_value' })).text).toContain('set_value needs `value`.');

    // Mouse clicks go to the centre of the element, in display points.
    const clicked = await h!.call('perform_ui_action', { element_id: button.id, action: 'double_click', screenshot: false });
    expect(clicked.text).toContain('Double-clicked Button "Export"');
    expect(fake.sent('ui_action').at(-1)).toEqual({ id: button.id, action: 'describe' });
    expect(fake.sent('mouse_click')).toEqual([{ x: 157.5, y: 247.5, button: 'left', count: 2 }]);
    fake.handlers['ui_action'] = () => ({ id: button.id, role: 'AXButton' });
    expect((await h!.call('perform_ui_action', { element_id: button.id, action: 'click' })).text).toContain('This element has no position on screen');
  });

  it('lists menus and chooses menu items', async () => {
    await start([PLAIN]);
    fake.handlers['menu_list'] = () => ({
      application: 'TextEdit',
      pid: 300,
      path: ['File'],
      items: [
        { title: 'New', shortcut: 'cmd+n' },
        { title: 'Open Recent', submenu: true, items: [{ title: 'notes.txt' }, { title: 'Clear Menu', enabled: false }] },
        { title: 'Show Ruler', checked: true, shortcut: 'cmd+r' },
      ],
    });
    const menus = await h!.call('list_menus', { application: 'TextEdit', path: ['File'], depth: 2 });
    expect(fake.sent('menu_list')).toEqual([{ name: 'TextEdit', path: ['File'], max_depth: 2 }]);
    expect(menus.text).toBe(['TextEdit > File:', '  New  (cmd+n)', '  Open Recent  ▸', '    notes.txt', '    Clear Menu  [disabled]', '  Show Ruler  ✓ (cmd+r)'].join('\n'));

    fake.handlers['menu_select'] = (params) => ({ application: 'TextEdit', selected: params['path'] });
    const chosen = await h!.call('select_menu_item', { path: ['File', 'Save As…'], pid: 300, screenshot: false });
    expect(fake.sent('menu_select')).toEqual([{ pid: 300, path: ['File', 'Save As…'] }]);
    expect(chosen.text).toBe('Chose File > Save As… in TextEdit.');
    fake.handlers['menu_select'] = () => {
      throw new ToolError('NOT_FOUND', 'No menu item "Sav" in "File". Available: New, Open…, Close');
    };
    expect((await h!.call('select_menu_item', { path: ['File', 'Sav'] })).text).toBe('Error [NOT_FOUND]: No menu item "Sav" in "File". Available: New, Open…, Close');
  });
});

describe('scripting and clipboard', () => {
  it('runs AppleScript and JavaScript for Automation', async () => {
    await start([PLAIN]);
    fake.scriptResult = (source) => result({ stdout: source.includes('Finder') ? '/Users/me/Documents/\n' : '42\n', stderr: source.includes('console') ? 'debug line\n' : '' });
    const apple = await h!.call('run_applescript', { script: 'tell application "Finder" to get POSIX path of (target of front window as alias)', args: ['a', 'b'], timeout_seconds: 5 });
    expect(apple.text).toBe('/Users/me/Documents/');
    expect(fake.scripts[0]).toMatchObject({ options: { language: 'applescript', args: ['a', 'b'], timeoutMs: 5000 } });
    const jxa = await h!.call('run_applescript', { language: 'javascript', script: 'console.log("x"); 6 * 7' });
    expect(jxa.text).toBe('42\n--- log ---\ndebug line');
    expect(jxa.data).toMatchObject({ result: '42', log: 'debug line' });
    fake.scriptResult = () => result();
    expect((await h!.call('run_applescript', { script: 'delay 0' })).text).toBe('(the script returned nothing)');
  });

  it('explains script failures', async () => {
    await start([PLAIN]);
    const fail = async (stderr: string, timedOut = false): Promise<string> => {
      fake.scriptResult = () => result({ code: timedOut ? null : 1, stderr, timedOut });
      return (await h!.call('run_applescript', { script: 'x', timeout_seconds: 3 })).text;
    };
    expect(await fail('execution error: Not authorized to send Apple events to Finder. (-1743)\n')).toMatch(/^Error \[MACOS_PERMISSION_REQUIRED\]: execution error: Not authorized.*\nHint: Ask the user to allow it in System Settings → Privacy & Security → Automation/);
    expect(await fail('execution error: System Events got an error: osascript is not allowed assistive access. (-25211)')).toContain('Privacy & Security → Accessibility');
    expect(await fail("31:36: execution error: Application isn't running. (-600)")).toContain('Hint: The application is not running: start it with open_application first.');
    expect(await fail('0:1: syntax error: A unknown token can’t go here. (-2740)')).toBe('Error [FAILED]: 0:1: syntax error: A unknown token can’t go here. (-2740)');
    expect(await fail('', true)).toContain('Error [TIMEOUT]: The script did not finish within 3 s and was stopped.');
  });

  it('reads and writes the clipboard', async () => {
    await start([PLAIN]);
    expect((await h!.call('get_clipboard')).text).toBe('The clipboard contains no text. It is empty.');
    fake.handlers['clipboard_get'] = () => ({ types: ['public.png', 'public.tiff'] });
    expect((await h!.call('get_clipboard')).text).toBe('The clipboard contains no text. It holds: public.png, public.tiff.');
    delete fake.handlers['clipboard_get'];
    expect((await h!.call('set_clipboard', { text: 'Lower third — Jane ✓' })).text).toBe('Copied 20 characters to the clipboard.');
    const read = await h!.call('get_clipboard');
    expect(read.text).toBe('Lower third — Jane ✓');
    expect(read.data).toMatchObject({ characters: 20, truncated_chars: 0 });
    fake.clipboard = 'y'.repeat(500);
    expect((await h!.call('get_clipboard', { max_chars: 100 })).data).toMatchObject({ characters: 500, truncated_chars: 400 });
  });
});
