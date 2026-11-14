import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ToolError } from '../../src/core/errors.js';
import { readImageInfo } from '../../src/core/image.js';
import { FakeDesktopDriver, PLAIN, result, RETINA } from '../helpers/fake-desktop.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * The desktop tools end to end through MCP, against a fake Mac: what they ask the operating
 * system to do, how coordinates are converted, and what the agent gets back. The same tools
 * run against a real desktop in tests/macos/computer-use.test.ts.
 */

const DESKTOP_TOOLS = [
  'list_applications', 'open_application', 'activate_application', 'quit_application', 'open_path',
  'list_windows', 'focus_window', 'set_window_bounds', 'set_window_state', 'close_window',
  'screenshot', 'mouse_move', 'click', 'drag', 'scroll', 'type_text', 'press_key', 'cursor_position', 'wait', 'computer_actions',
  'find_ui_elements', 'get_ui_tree', 'get_ui_element_at', 'get_focused_ui_element', 'perform_ui_action', 'list_menus', 'select_menu_item',
  'run_applescript', 'get_clipboard', 'set_clipboard',
]; // prettier-ignore

/** On the Retina fake a screenshot pixel covers 1.125 points; the centre of pixel n is at n × 1.125 + 0.5625. */
const pt = (pixel: number): number => pixel * 1.125 + 0.5625;

describe('desktop tools on a fake Mac (Full System Access)', () => {
  let h: Harness;
  let mac: FakeDesktopDriver;

  beforeAll(async () => {
    mac = new FakeDesktopDriver([RETINA]);
    h = await createHarness({ mode: 'full', runtime: { desktop: mac } });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    mac.commands.length = 0;
    mac.invocations.length = 0;
    mac.captures.length = 0;
    mac.encodes.length = 0;
    mac.opened.length = 0;
    mac.scripts.length = 0;
    mac.events.length = 0;
    mac.handlers = {};
    mac.captureError = undefined;
    mac.delayMs = 0;
    mac.openResult = () => result();
    mac.scriptResult = () => result();
  });

  it('are advertised and reported by server_info', async () => {
    const client = await h.connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of DESKTOP_TOOLS) expect(names, name).toContain(name);

    const info = (await h.call('server_info')).data as { desktop_control: boolean; tool_groups: Record<string, { status: string; tools: number }>; guides: string[] };
    expect(info.desktop_control).toBe(true);
    expect(info.tool_groups['computer']).toEqual({ title: 'Computer Use', tools: 10, status: 'available' });
    expect(info.tool_groups['apps']?.status).toBe('available');
    expect(info.tool_groups['windows']?.status).toBe('available');
    expect(info.tool_groups['ui']?.status).toBe('available');
    expect(info.tool_groups['scripting']?.status).toBe('available');
    expect(info.guides).toContain('computer-use');
    expect((await h.call('usage_guide', { topic: 'computer-use' })).text).toContain('pixel of the full screenshot');
  });

  describe('screenshot', () => {
    it('returns the whole display in screenshot space, with pointer and frontmost application', async () => {
      mac.pointer = { x: 720, y: 450 };
      const shot = await h.call('screenshot');
      expect(shot.isError, shot.text).toBe(false);
      expect(mac.captures).toEqual([{ display: 1, cursor: true }]);
      // 2880×1800 pixels are scaled so that the long edge is 1280.
      expect(mac.encodes).toEqual([{ width: 1280, height: 800, format: 'jpeg', quality: 80 }]);
      expect(shot.images).toHaveLength(1);
      expect(shot.images[0]?.mimeType).toBe('image/jpeg');
      expect(readImageInfo(Buffer.from(shot.images[0]?.data ?? '', 'base64'))).toMatchObject({ width: 1280, height: 800 });
      expect(shot.data).toMatchObject({
        display: 1,
        width: 1280,
        height: 800,
        screen: { width: 1280, height: 800 },
        format: 'jpeg',
        pointer: { display: 1, x: 640, y: 400 },
        frontmost_application: 'Finder',
        frontmost_window: 'Desktop',
      });
      expect(shot.text).toBe(
        ['Screenshot of display 1 (1280×800). Coordinates for click, drag, scroll and the other tools are pixels of this image.', 'Pointer at (640, 400).', 'Frontmost: Finder — "Desktop".'].join('\n'),
      );
    });

    it('enlarges a region and explains how its pixels map back', async () => {
      const shot = await h.call('screenshot', { region: { x: 100, y: 40, width: 400, height: 250 }, format: 'png', show_cursor: false });
      expect(shot.isError, shot.text).toBe(false);
      // The region is captured at native resolution: 400×250 screenshot pixels are 450×281.25 points.
      expect(mac.captures).toEqual([{ region: { x: 112.5, y: 45, width: 450, height: 281.25 }, cursor: false }]);
      expect(shot.images[0]?.mimeType).toBe('image/png');
      expect(shot.data).toMatchObject({ width: 900, height: 563, screen: { width: 1280, height: 800 }, region: { x: 100, y: 40, width: 400, height: 250 }, zoom: 2.25, format: 'png' });
      expect(shot.text).toContain('Enlarged view of the area x=100 y=40 400×250 of display 1, shown at 2.25× (900×563).');
      expect(shot.text).toContain('full_x = 100 + image_x / 2.25, full_y = 40 + image_y / 2.25');

      const clipped = await h.call('screenshot', { region: { x: 1200, y: 700, width: 500, height: 500 } });
      expect(clipped.data).toMatchObject({ region: { x: 1200, y: 700, width: 80, height: 100 } });
      expect((await h.call('screenshot', { region: { x: 2000, y: 0, width: 10, height: 10 } })).text).toContain('Error [INVALID_ARGUMENT]: The region does not overlap the screen (1280×800 pixels).');
    });

    it('captures a single window, and rejects displays that do not exist', async () => {
      const shot = await h.call('screenshot', { window_id: 77 });
      expect(mac.captures).toEqual([{ windowId: 77, cursor: false }]);
      expect(shot.data).toMatchObject({ width: 1280, height: 800 });
      expect(shot.text).toContain('Picture of window 77 (1280×800). It is for reading only');
      expect((await h.call('screenshot', { display: 2 })).text).toContain('Error [INVALID_ARGUMENT]: There is no display 2: this Mac has 1 display (1 is the main one).');
    });

    it('tells the agent which macOS permission is missing', async () => {
      mac.captureError = new ToolError('MACOS_PERMISSION_REQUIRED', 'The screen could not be captured. macOS has most likely not granted Screen Recording access.', 'Ask the user to open System Settings.');
      const shot = await h.call('screenshot');
      expect(shot.isError).toBe(true);
      expect(shot.text).toBe('Error [MACOS_PERMISSION_REQUIRED]: The screen could not be captured. macOS has most likely not granted Screen Recording access.\nHint: Ask the user to open System Settings.');
    });

    it('uses the pixel grid of an unscaled display as is', async () => {
      mac.displays = [PLAIN];
      try {
        // Let the display cache of the earlier tests expire.
        await new Promise((resolve) => setTimeout(resolve, 3100));
        const shot = await h.call('screenshot', { format: 'png' });
        expect(shot.data).toMatchObject({ width: 1024, height: 768, screen: { width: 1024, height: 768 } });
        // Nothing to scale and nothing to convert: the capture is returned unchanged.
        expect(mac.encodes).toEqual([]);
        await h.call('click', { x: 10, y: 20, screenshot: false });
        expect(mac.sent('mouse_click')).toEqual([{ x: 10, y: 20, button: 'left', count: 1, modifiers: [] }]);
      } finally {
        mac.displays = [RETINA];
        await new Promise((resolve) => setTimeout(resolve, 3100));
      }
    }, 20_000);
  });

  describe('mouse and keyboard', () => {
    it('clicks at screenshot coordinates and returns a screenshot of the result', async () => {
      const click = await h.call('click', { x: 640, y: 400 });
      expect(click.isError, click.text).toBe(false);
      expect(mac.sent('mouse_click')).toEqual([{ x: pt(640), y: pt(400), button: 'left', count: 1, modifiers: [] }]);
      expect(click.text).toBe('Clicked at (640, 400).\nScreenshot of display 1 (1280×800). Coordinates for click, drag, scroll and the other tools are pixels of this image.');
      expect(click.images).toHaveLength(1);
      expect(click.data).toMatchObject({ x: 640, y: 400, button: 'left', count: 1, screenshot: { width: 1280, height: 800 } });
      // The screenshot is taken after the click.
      expect(mac.events.filter((event) => event !== 'run:displays')).toEqual(['run:mouse_click', 'capture']);
    });

    it('supports buttons, click counts and modifiers, and can skip the screenshot', async () => {
      const right = await h.call('click', { x: 10, y: 20, button: 'right', screenshot: false });
      expect(right.text).toBe('Clicked the right button at (10, 20).');
      expect(right.images).toEqual([]);
      expect(mac.captures).toEqual([]);
      expect((await h.call('click', { x: 10, y: 20, count: 2, screenshot: false })).text).toBe('Double-clicked at (10, 20).');
      expect((await h.call('click', { x: 10, y: 20, count: 3, modifiers: ['shift', 'cmd'], screenshot: false })).text).toBe('Triple-clicked at (10, 20) holding cmd+shift.');
      expect(mac.sent('mouse_click').map((p) => [p['button'], p['count'], p['modifiers']])).toEqual([
        ['right', 1, []],
        ['left', 2, []],
        ['left', 3, ['cmd', 'shift']],
      ]);
    });

    it('rejects coordinates that are not on the screenshot', async () => {
      const outside = await h.call('click', { x: 1281, y: 10 });
      expect(outside.text).toBe(
        'Error [INVALID_ARGUMENT]: Coordinates (1281, 10) are outside the screen: the screenshot of display 1 is 1280×800 pixels.\nHint: Take a screenshot and use pixel coordinates from it.',
      );
      expect(mac.sent('mouse_click')).toEqual([]);
      // The far edges belong to the last pixel.
      expect((await h.call('click', { x: 1280, y: 800, screenshot: false })).isError).toBe(false);
      expect(mac.sent('mouse_click')[0]).toMatchObject({ x: pt(1279), y: pt(799) });
    });

    it('moves, drags and scrolls', async () => {
      expect((await h.call('mouse_move', { x: 100, y: 200, screenshot: false })).text).toBe('Moved the pointer to (100, 200).');
      expect(mac.sent('mouse_move')).toEqual([{ x: pt(100), y: pt(200) }]);
      expect((await h.call('cursor_position')).data).toEqual({ display: 1, x: 100, y: 200 });

      const drag = await h.call('drag', { from_x: 400, from_y: 300, to_x: 600, to_y: 300, duration_ms: 100, modifiers: ['alt'], screenshot: false });
      expect(drag.text).toBe('Dragged from (400, 300) to (600, 300) holding alt.');
      expect(mac.sent('mouse_drag')).toEqual([{ from_x: pt(400), from_y: pt(300), to_x: pt(600), to_y: pt(300), button: 'left', duration_ms: 100, modifiers: ['alt'] }]);

      expect((await h.call('scroll', { x: 640, y: 400, direction: 'down', amount: 10, screenshot: false })).text).toBe('Scrolled down by 10 at (640, 400).');
      await h.call('scroll', { x: 640, y: 400, direction: 'up', screenshot: false });
      await h.call('scroll', { x: 640, y: 400, direction: 'right', amount: 3, screenshot: false });
      expect(mac.sent('mouse_scroll').map((p) => [p['dx'], p['dy'], p['unit']])).toEqual([
        [0, -10, 'line'],
        [0, 5, 'line'],
        [-3, 0, 'line'],
      ]);
    });

    it('types text and presses keys', async () => {
      const typed = await h.call('type_text', { text: 'Final_Render_v3\n', screenshot: false });
      expect(typed.text).toBe('Typed "Final_Render_v3\\n".');
      expect(mac.sent('type')).toEqual([{ text: 'Final_Render_v3\n', delay_ms: 6 }]);
      const long = await h.call('type_text', { text: 'x'.repeat(200), delay_ms: 0, screenshot: false });
      expect(long.text).toBe(`Typed "${'x'.repeat(60)}…" (200 characters).`);

      const keys = await h.call('press_key', { keys: 'cmd+a Cmd+Shift+S escape', screenshot: false });
      expect(keys.text).toBe('Pressed cmd+a, cmd+shift+s, escape.');
      expect(mac.sent('key')).toEqual([
        { char: 'a', modifiers: ['cmd'], repeat: 1 },
        { char: 's', modifiers: ['cmd', 'shift'], repeat: 1 },
        { code: 53, modifiers: [], repeat: 1 },
      ]);
      // One helper run for the whole sequence.
      expect(mac.invocations.filter((commands) => commands[0]?.command === 'key')).toHaveLength(1);

      mac.commands.length = 0;
      expect((await h.call('press_key', { keys: 'down', repeat: 5, hold_ms: 30, screenshot: false })).text).toBe('Pressed down 5 times.');
      expect(mac.sent('key')).toEqual([{ code: 125, modifiers: [], repeat: 5, hold_ms: 30 }]);
      expect((await h.call('press_key', { keys: 'hyper+x' })).text).toContain('Error [INVALID_ARGUMENT]: Unknown modifier "hyper" in "hyper+x"');
      expect((await h.call('press_key', { keys: 'cmd+bogus' })).text).toContain('Error [INVALID_ARGUMENT]: Unknown key "bogus" in "cmd+bogus"');
    });

    it('waits, then shows the screen', async () => {
      const started = Date.now();
      const waited = await h.call('wait', { seconds: 0.3 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(280);
      expect(waited.text).toContain('Waited 0.3 s.\nScreenshot of display 1');
      expect(waited.images).toHaveLength(1);
    });

    it('reports a completed action even when the screenshot afterwards fails', async () => {
      mac.captureError = new ToolError('MACOS_PERMISSION_REQUIRED', 'The screen could not be captured.', 'Grant Screen Recording.');
      const click = await h.call('click', { x: 5, y: 5 });
      expect(click.isError).toBe(false);
      expect(click.text).toBe('Clicked at (5, 5).\nThe action was carried out, but no screenshot could be taken: The screen could not be captured. Grant Screen Recording.');
      expect(click.images).toEqual([]);
    });

    it('passes on helper failures with their remedy', async () => {
      mac.handlers['mouse_click'] = () => {
        throw new ToolError('MACOS_PERMISSION_REQUIRED', 'macOS has not granted Accessibility access to the application that runs mcpclaude', 'Ask the user to open System Settings → Privacy & Security → Accessibility.');
      };
      const click = await h.call('click', { x: 5, y: 5 });
      expect(click.isError).toBe(true);
      expect(click.text).toBe(
        'Error [MACOS_PERMISSION_REQUIRED]: macOS has not granted Accessibility access to the application that runs mcpclaude\nHint: Ask the user to open System Settings → Privacy & Security → Accessibility.',
      );
      expect(mac.captures).toEqual([]);
    });

    it('never interleaves the actions of concurrent calls', async () => {
      mac.delayMs = 25;
      await Promise.all([h.call('click', { x: 1, y: 1 }), h.call('type_text', { text: 'abc' }), h.call('click', { x: 2, y: 2 })]);
      const order = mac.events.filter((event) => event !== 'run:displays');
      expect(order).toHaveLength(6);
      // Each action is followed by its own screenshot before the next action starts.
      for (let index = 0; index < order.length; index += 2) {
        expect(order[index]).toMatch(/^run:(mouse_click|type)$/);
        expect(order[index + 1]).toBe('capture');
      }
    });
  });

  describe('computer_actions', () => {
    it('runs a whole sequence in one helper run and returns one screenshot', async () => {
      const batch = await h.call('computer_actions', {
        actions: [
          { action: 'click', x: 520, y: 310 },
          { action: 'press_key', keys: 'cmd+a' },
          { action: 'type_text', text: '1920' },
          { action: 'press_key', keys: 'return' },
          { action: 'wait', seconds: 0.2 },
          { action: 'scroll', x: 520, y: 310, direction: 'down' },
          { action: 'double_click', x: 30, y: 40 },
          { action: 'right_click', x: 30, y: 40 },
          { action: 'drag', x: 10, y: 10, to_x: 50, to_y: 60 },
        ],
      });
      expect(batch.isError, batch.text).toBe(false);
      expect(batch.text.split('\n')).toEqual([
        '1. Clicked at (520, 310)',
        '2. Pressed cmd+a',
        '3. Typed "1920"',
        '4. Pressed return',
        '5. Waited 0.2 s',
        '6. Scrolled down by 5 at (520, 310)',
        '7. Double-clicked at (30, 40)',
        '8. Clicked the right button at (30, 40)',
        '9. Dragged from (10, 10) to (50, 60)',
        'Screenshot of display 1 (1280×800). Coordinates for click, drag, scroll and the other tools are pixels of this image.',
      ]);
      expect(batch.data).toMatchObject({ steps: 9 });
      expect(batch.images).toHaveLength(1);
      const runs = mac.invocations.filter((commands) => commands[0]?.command !== 'displays');
      expect(runs).toHaveLength(1);
      expect(runs[0]?.map((command) => command.command)).toEqual(['mouse_click', 'key', 'type', 'key', 'sleep', 'mouse_scroll', 'mouse_click', 'mouse_click', 'mouse_drag']);
      expect(mac.sent('sleep')).toEqual([{ ms: 200 }]);
      expect(mac.captures).toHaveLength(1);
    });

    it('builds a modifier-drag from single steps', async () => {
      const batch = await h.call('computer_actions', {
        screenshot: false,
        actions: [
          { action: 'key_down', keys: 'shift' },
          { action: 'mouse_down', x: 300, y: 400 },
          { action: 'mouse_move', x: 380, y: 400 },
          { action: 'mouse_up', x: 460, y: 400 },
          { action: 'key_up', keys: 'shift' },
          { action: 'mouse_move', x: 10, y: 10 },
        ],
      });
      expect(batch.text.split('\n')).toEqual([
        '1. Held down shift',
        '2. Pressed the left button at (300, 400)',
        '3. Moved the pointer to (380, 400) with the left button held',
        '4. Released the left button at (460, 400)',
        '5. Released shift',
        '6. Moved the pointer to (10, 10)',
      ]);
      expect(mac.commands.filter((command) => command.command !== 'displays')).toEqual([
        { command: 'key_down', params: { code: 56, modifiers: [] } },
        { command: 'mouse_down', params: { x: pt(300), y: pt(400), button: 'left', modifiers: [] } },
        // While the button is down, movement is sent as a drag.
        { command: 'mouse_move', params: { x: pt(380), y: pt(400), dragging: 'left', modifiers: [] } },
        { command: 'mouse_up', params: { x: pt(460), y: pt(400), button: 'left', modifiers: [] } },
        { command: 'key_up', params: { code: 56, modifiers: [] } },
        { command: 'mouse_move', params: { x: pt(10), y: pt(10) } },
      ]);
    });

    it('says so when keys or buttons were left held', async () => {
      const batch = await h.call('computer_actions', {
        screenshot: false,
        actions: [
          { action: 'key_down', keys: 'shift space' },
          { action: 'key_up', keys: 'shift' },
          { action: 'mouse_down', x: 5, y: 5, button: 'right' },
        ],
      });
      expect(batch.text.split('\n')).toEqual([
        '1. Held down shift, space',
        '2. Released shift',
        '3. Pressed the right button at (5, 5)',
        'Released at the end, because no step did: space, the right mouse button.',
      ]);
    });

    it('checks every step before doing anything', async () => {
      const missing = await h.call('computer_actions', { actions: [{ action: 'click', x: 10, y: 10 }, { action: 'type_text' }] });
      expect(missing.text).toBe('Error [INVALID_ARGUMENT]: Step 2 (type_text): "type_text" needs "text". Nothing was carried out.');
      const outside = await h.call('computer_actions', { actions: [{ action: 'click', x: 10, y: 10 }, { action: 'click', x: 5000, y: 10 }] });
      expect(outside.text).toContain('Error [INVALID_ARGUMENT]: Step 2 (click): Coordinates (5000, 10) are outside the screen');
      expect(outside.text).toContain('Nothing was carried out.');
      expect(mac.sent('mouse_click')).toEqual([]);
      expect((await h.call('computer_actions', { actions: [] })).isError).toBe(true);
      const long = await h.call('computer_actions', { actions: Array.from({ length: 7 }, () => ({ action: 'wait', seconds: 30 })) });
      expect(long.text).toContain('Error [INVALID_ARGUMENT]: These steps would take longer than three minutes');
    });

    it('says which step failed and what was done before it', async () => {
      mac.handlers['type'] = () => {
        throw new ToolError('FAILED', 'Could not create a keyboard event');
      };
      const batch = await h.call('computer_actions', {
        actions: [
          { action: 'click', x: 10, y: 10 },
          { action: 'press_key', keys: 'cmd+a cmd+c' },
          { action: 'type_text', text: 'x' },
          { action: 'press_key', keys: 'return' },
        ],
      });
      expect(batch.isError).toBe(true);
      expect(batch.text).toBe('Error [FAILED]: Step 3 (type_text) failed: Could not create a keyboard event Steps 1-2 were carried out.');
      mac.handlers['mouse_click'] = () => {
        throw new ToolError('FAILED', 'boom');
      };
      expect((await h.call('computer_actions', { actions: [{ action: 'click', x: 1, y: 1 }] })).text).toBe('Error [FAILED]: Step 1 (click) failed: boom No step was carried out before it.');
    });
  });

  describe('applications', () => {
    const finder = { pid: 100, name: 'Finder', bundle_id: 'com.apple.finder', path: '/System/Library/CoreServices/Finder.app', active: true, hidden: false, kind: 'regular' };
    const textEdit = { pid: 512, name: 'TextEdit', bundle_id: 'com.apple.TextEdit', path: '/System/Applications/TextEdit.app', active: false, hidden: false, kind: 'regular' };
    const dock = { pid: 90, name: 'Dock', bundle_id: 'com.apple.dock', active: false, hidden: false, kind: 'background' };

    it('lists what is running', async () => {
      mac.handlers['apps'] = (params) => ({ applications: params['include_background'] ? [finder, textEdit, dock] : [finder, textEdit], frontmost: finder });
      const listed = await h.call('list_applications');
      expect(listed.text.split('\n')).toEqual([
        '   application  pid  bundle id           state',
        '*  Finder       100  com.apple.finder    -',
        '   TextEdit     512  com.apple.TextEdit  -',
        '* frontmost: Finder',
      ]);
      expect(listed.data).toMatchObject({ frontmost: 'Finder', running: [{ name: 'Finder' }, { name: 'TextEdit' }] });
      const all = await h.call('list_applications', { include_background: true });
      expect(all.text).toContain('Dock');
      expect(all.text).toContain('background');
    });

    it('opens an application, waits for it and brings it to the front', async () => {
      let polls = 0;
      mac.handlers['apps'] = () => ({ applications: ++polls >= 3 ? [finder, textEdit] : [finder], frontmost: finder });
      mac.handlers['app_activate'] = (params) => ({ ...textEdit, active: params['pid'] === 512 });
      const opened = await h.call('open_application', { application: 'TextEdit.app', screenshot: false });
      expect(opened.isError, opened.text).toBe(false);
      expect(mac.opened).toEqual([['-a', 'TextEdit']]);
      expect(polls).toBe(3);
      expect(opened.text).toBe('TextEdit (pid 512) is frontmost.');
      expect(opened.data).toEqual({ running: true, name: 'TextEdit', pid: 512, bundle_id: 'com.apple.TextEdit', frontmost: true });

      mac.opened.length = 0;
      await h.call('open_application', { application: 'com.apple.TextEdit', arguments: ['--flag', 'value'], new_instance: true, background: true, screenshot: false });
      expect(mac.opened).toEqual([['-n', '-g', '-b', 'com.apple.TextEdit', '--args', '--flag', 'value']]);
    });

    it('explains when an application does not exist or does not appear', async () => {
      mac.openResult = () => result({ code: 1, stderr: 'Unable to find application named \'Nope\'\n' });
      const missing = await h.call('open_application', { application: 'Nope' });
      expect(missing.text).toBe('Error [NOT_FOUND]: macOS found no application "Nope".\nHint: list_applications with installed: true shows the names of the installed applications.');

      mac.openResult = () => result();
      mac.handlers['apps'] = () => ({ applications: [finder], frontmost: finder });
      const slow = await h.call('open_application', { application: 'Blender', wait_seconds: 0.5, screenshot: false });
      expect(slow.isError).toBe(false);
      expect(slow.text).toBe('Asked macOS to open Blender; it has not appeared among the running applications after 0.5 s. It may still be starting.');
      expect(slow.data).toEqual({ running: false });
      expect((await h.call('open_application', { application: '/Applications/Missing.app' })).text).toContain('Error [NOT_FOUND]: No application at /Applications/Missing.app');
    });

    it('activates and quits applications', async () => {
      mac.handlers['app_activate'] = (params) => {
        if (params['name'] !== 'TextEdit') throw new ToolError('NOT_FOUND', `No running application named "${String(params['name'])}"`);
        return { ...textEdit, active: true };
      };
      expect((await h.call('activate_application', { application: 'TextEdit', screenshot: false })).text).toBe('TextEdit (pid 512) is now frontmost.');
      expect((await h.call('activate_application', { application: 'Ghost' })).text).toBe('Error [NOT_FOUND]: No running application named "Ghost"');
      expect((await h.call('activate_application', {})).text).toBe('Error [INVALID_ARGUMENT]: Name the application with `application` or `pid`.');

      mac.handlers['app_quit'] = (params) => ({ ...textEdit, requested: true, terminated: params['force'] === true });
      const asked = await h.call('quit_application', { pid: 512, wait_seconds: 1, screenshot: false });
      expect(mac.sent('app_quit')).toEqual([{ pid: 512, force: false, wait_seconds: 1 }]);
      expect(asked.text).toBe('TextEdit was asked to quit but is still running after 1 s. It is probably showing a dialog (unsaved changes?) — look at the screen.');
      expect((await h.call('quit_application', { application: 'TextEdit', force: true, screenshot: false })).text).toBe('TextEdit has quit.');
    });

    it('opens files, folders and URLs', async () => {
      await mkdir(path.join(h.projectDir, 'renders'));
      await writeFile(path.join(h.projectDir, 'renders', 'final.mov'), 'x');
      const file = path.join(h.projectDir, 'renders', 'final.mov');

      expect((await h.call('open_path', { target: 'renders/final.mov', screenshot: false })).text).toBe(`Opened: ${file}`);
      expect((await h.call('open_path', { target: 'renders/final.mov', reveal: true, screenshot: false })).text).toBe(`Revealed in Finder: ${file}`);
      expect((await h.call('open_path', { target: file, application: 'QuickTime Player', background: true, screenshot: false })).text).toBe(`Opened with QuickTime Player: ${file}`);
      expect((await h.call('open_path', { target: 'https://www.blender.org/download/', application: 'com.apple.Safari', screenshot: false })).data).toEqual({ target: 'https://www.blender.org/download/', url: true });
      expect(mac.opened).toEqual([[file], ['-R', file], ['-g', '-a', 'QuickTime Player', file], ['-b', 'com.apple.Safari', 'https://www.blender.org/download/']]);

      expect((await h.call('open_path', { target: 'renders/missing.mov' })).text).toContain('Error [NOT_FOUND]: No such file or directory');
      expect((await h.call('open_path', { target: 'https://example.com', reveal: true })).text).toBe('Error [INVALID_ARGUMENT]: Only files and folders can be revealed in Finder.');
      mac.openResult = () => result({ code: 1, stderr: 'Unable to find application named \'Nope\'' });
      expect((await h.call('open_path', { target: file, application: 'Nope' })).text).toContain('Error [NOT_FOUND]: macOS found no application "Nope".');
    });
  });

  describe('windows', () => {
    const raw = {
      app: 'TextEdit',
      pid: 512,
      title: 'notes.txt',
      main: true,
      window_id: 4821,
      z: 0,
      // Points; in screenshot space this is (100, 50) 800×500.
      frame: { x: 112.5, y: 56.25, width: 900, height: 562.5 },
    };

    it('lists windows with their place in the screenshot', async () => {
      mac.handlers['windows'] = (params) => ({
        windows: params['name'] ? [raw] : [raw, { app: 'Finder', pid: 100, title: '', minimized: true, window_id: 12 }, { app: 'Blender', pid: 700, title: 'Blender', window_id: 90, frame: { x: 0, y: 0, width: 1440, height: 900 } }],
        limited: false,
      });
      const listed = await h.call('list_windows');
      expect(listed.text.split('\n')).toEqual([
        'id    application  title       position and size  state',
        '4821  TextEdit     notes.txt   (100, 50) 800×500  focused',
        '12    Finder       (untitled)  -                  minimised',
        '90    Blender      Blender     (0, 0) 1280×800    not on this Space',
      ]);
      expect((listed.data?.['windows'] as unknown[])[0]).toEqual({
        window_id: 4821,
        application: 'TextEdit',
        pid: 512,
        title: 'notes.txt',
        x: 100,
        y: 50,
        width: 800,
        height: 500,
        display: 1,
        minimized: false,
        focused: true,
        fullscreen: false,
        on_screen: true,
      });
      await h.call('list_windows', { application: 'TextEdit' });
      expect(mac.sent('windows')).toEqual([{}, { name: 'TextEdit' }]);

      mac.handlers['windows'] = () => ({ windows: [], limited: true });
      expect((await h.call('list_windows')).text).toBe('No windows are open.\nNote: macOS has not granted Accessibility access, so minimised windows are missing, titles may be empty and windows cannot be managed.');
    });

    it('focuses, moves, resizes, minimises and closes a window', async () => {
      mac.handlers['window_action'] = (params) => {
        if (params['window_id'] !== 4821) throw new ToolError('NOT_FOUND', `No window with id ${String(params['window_id'])}.`);
        if (params['action'] === 'close') return { closed: true, window_id: 4821 };
        if (params['action'] === 'move') return { ...raw, frame: { ...raw.frame, x: params['x'], y: params['y'] } };
        if (params['action'] === 'resize') return { ...raw, frame: { x: 225, y: 135, width: params['width'], height: params['height'] } };
        if (params['action'] === 'fullscreen') return { ...raw, fullscreen: !refusesFullScreen };
        if (params['action'] === 'exit_fullscreen') return { ...raw, fullscreen: false };
        return { ...raw, minimized: params['action'] === 'minimize' };
      };
      let refusesFullScreen = false;
      expect((await h.call('focus_window', { window_id: 4821, screenshot: false })).text).toBe('Focused TextEdit — "notes.txt" (window 4821).');

      const moved = await h.call('set_window_bounds', { window_id: 4821, x: 200, y: 120, width: 1000, height: 700, screenshot: false });
      expect(moved.text).toBe('TextEdit — "notes.txt" (window 4821) is now at (200, 120) 1000×700.');
      // Screenshot pixels are converted to points; position first, then size.
      expect(mac.sent('window_action').slice(1)).toEqual([
        { window_id: 4821, action: 'move', x: 225, y: 135 },
        { window_id: 4821, action: 'resize', width: 1125, height: 787.5 },
      ]);
      expect((await h.call('set_window_bounds', { window_id: 4821, x: 5 })).text).toBe('Error [INVALID_ARGUMENT]: Give x and y together.');
      expect((await h.call('set_window_bounds', { window_id: 4821, width: 5 })).text).toBe('Error [INVALID_ARGUMENT]: Give width and height together.');
      expect((await h.call('set_window_bounds', { window_id: 4821 })).text).toContain('Error [INVALID_ARGUMENT]: Give x and y to move the window');

      expect((await h.call('set_window_state', { window_id: 4821, state: 'minimized', screenshot: false })).text).toBe('TextEdit — "notes.txt" (window 4821) is now minimised.');
      expect((await h.call('set_window_state', { window_id: 4821, state: 'restored', screenshot: false })).data).toMatchObject({ window: { minimized: false } });
      const full = await h.call('set_window_state', { window_id: 4821, state: 'fullscreen', screenshot: false });
      expect(full.text).toBe('TextEdit — "notes.txt" (window 4821) is now fullscreen.');
      expect(full.data).toMatchObject({ window: { fullscreen: true } });
      expect((await h.call('set_window_state', { window_id: 4821, state: 'windowed', screenshot: false })).text).toBe('TextEdit — "notes.txt" (window 4821) is now windowed.');
      // macOS accepts the request for any window; what the window reports afterwards is what counts.
      refusesFullScreen = true;
      const refused = await h.call('set_window_state', { window_id: 4821, state: 'fullscreen', screenshot: false });
      expect(refused.isError).toBe(false);
      expect(refused.text).toBe('TextEdit — "notes.txt" (window 4821) did not go full screen. Windows such as dialogs and panels cannot; for others the change may still be under way — check list_windows.');

      expect((await h.call('close_window', { window_id: 4821, screenshot: false })).text).toBe('Pressed the close button of window 4821.');
      expect((await h.call('focus_window', { window_id: 1 })).text).toBe('Error [NOT_FOUND]: No window with id 1.');
      expect(mac.sent('window_action').map((p) => p['action'])).toEqual(['focus', 'move', 'resize', 'minimize', 'restore', 'fullscreen', 'exit_fullscreen', 'fullscreen', 'close', 'focus']);
    });
  });

  describe('interface elements', () => {
    // Points; in screenshot space the frame is (400, 300) 80×24 and its centre (440, 312).
    const button = { id: '512:0.3.1:AXButton', role: 'AXButton', title: 'Export', frame: { x: 450, y: 337.5, width: 90, height: 27 }, actions: ['AXPress'] };
    const field = { id: '512:0.2.0:AXTextField', role: 'AXTextField', description: 'Name', value: 'Comp 1', focused: true, frame: { x: 0, y: 0, width: 225, height: 22.5 } };

    it('finds elements and reports where to click them', async () => {
      mac.handlers['ui_find'] = () => ({ application: 'After Effects', pid: 512, elements: [button, { ...field, enabled: false }], truncated: true });
      const found = await h.call('find_ui_elements', { text: 'Export', role: 'Button', application: 'After Effects', limit: 2 });
      expect(mac.sent('ui_find')).toEqual([{ name: 'After Effects', text: 'Export', role: 'Button', limit: 2 }]);
      expect(found.text.split('\n')).toEqual([
        '2 elements in After Effects (more exist; narrow the search or raise limit):',
        'Button "Export" @(440, 312) id=512:0.3.1:AXButton',
        'TextField "Name" value="Comp 1" [disabled] [focused] @(100, 10) id=512:0.2.0:AXTextField',
      ]);
      expect((found.data?.['elements'] as unknown[])[0]).toEqual({
        element_id: '512:0.3.1:AXButton',
        role: 'Button',
        label: 'Export',
        value: null,
        enabled: true,
        focused: false,
        frame: { x: 400, y: 300, width: 80, height: 24 },
        center: { x: 440, y: 312 },
        display: 1,
        actions: ['Press'],
        depth: 0,
      });

      mac.handlers['ui_find'] = () => ({ application: 'Blender', pid: 700, elements: [], truncated: false });
      expect((await h.call('find_ui_elements', { role: 'Slider', window_id: 90 })).text).toBe('No matching element in Blender. The application may not expose this part of its interface; check a screenshot.');
      expect(mac.sent('ui_find')[1]).toEqual({ window_id: 90, role: 'Slider', limit: 25 });
      expect((await h.call('find_ui_elements', {})).text).toBe('Error [INVALID_ARGUMENT]: Give `text`, `role` or both.');
    });

    it('outlines a window as an indented tree', async () => {
      mac.handlers['ui_tree'] = () => ({
        application: 'After Effects',
        pid: 512,
        truncated: true,
        elements: [
          { id: '512:0:AXWindow', role: 'AXWindow', title: 'Render', depth: 0, children: 2 },
          { ...field, depth: 1 },
          { ...button, depth: 2 },
          { id: '512:0.1:AXButton', role: 'AXButton', subrole: 'AXCloseButton', depth: 1 },
          { id: '512:0.4:AXScrollBar', role: 'AXScrollBar', orientation: 'vertical', value: 0.25, depth: 1 },
        ],
      });
      const tree = await h.call('get_ui_tree', { window_id: 4821, max_depth: 3, include_containers: true });
      expect(mac.sent('ui_tree')).toEqual([{ window_id: 4821, max_depth: 3, max_elements: 250, compact: false }]);
      expect(tree.text.split('\n')).toEqual([
        'Interface of After Effects (5 elements):',
        'Window "Render" id=512:0:AXWindow',
        '  TextField "Name" value="Comp 1" [focused] @(100, 10) id=512:0.2.0:AXTextField',
        '    Button "Export" @(440, 312) id=512:0.3.1:AXButton',
        '  Button (CloseButton) id=512:0.1:AXButton',
        '  ScrollBar vertical value=0.25 id=512:0.4:AXScrollBar',
        '… truncated: raise max_depth or max_elements, or look at a single window.',
      ]);
    });

    it('identifies the element at a position and the focused element', async () => {
      mac.handlers['ui_at'] = () => ({ ...button, application: 'After Effects', pid: 512, ancestors: ['AXGroup', 'AXWindow "Render"', 'AXApplication "After Effects"'] });
      const at = await h.call('get_ui_element_at', { x: 440, y: 312 });
      expect(mac.sent('ui_at')).toEqual([{ x: pt(440), y: pt(312) }]);
      expect(at.text.split('\n')).toEqual(['Button "Export" @(440, 312) id=512:0.3.1:AXButton', 'Application: After Effects', 'Actions: Press', 'Inside: Group < Window "Render" < Application "After Effects"']);

      mac.handlers['ui_focused'] = () => ({ ...field, value: 'Lorem', value_length: 9000, application: 'TextEdit', pid: 300 });
      const focused = await h.call('get_focused_ui_element', { max_value_chars: 20 });
      expect(mac.sent('ui_focused')).toEqual([{ value_limit: 20 }]);
      expect(focused.text.split('\n')).toEqual(['TextField "Name" value="Lorem" [focused] @(100, 10) id=512:0.2.0:AXTextField', 'Application: TextEdit', '(value truncated: 9000 characters in total)']);
      expect(focused.data).toMatchObject({ role: 'TextField', value: 'Lorem', focused: true, application: 'TextEdit', pid: 300 });
    });

    it('presses, fills in and clicks elements', async () => {
      mac.handlers['ui_action'] = (params) => {
        if (params['id'] === 'gone:1:AXButton') throw new ToolError('NOT_FOUND', 'The interface has changed: element gone:1:AXButton no longer exists. Look it up again.');
        const base = String(params['id']).endsWith('AXButton') ? button : String(params['id']).endsWith('AXSlider') ? { id: params['id'], role: 'AXSlider', value: params['value'] } : { ...field, value: params['value'] ?? field.value };
        return { ...base, id: params['id'], ...(params['action'] === 'press' ? { note: 'The application did not confirm the action in time; it has most likely happened.' } : {}), ...(params['action'] === 'cancel' ? { gone: true, frame: undefined } : {}) };
      };
      const pressed = await h.call('perform_ui_action', { element_id: button.id, screenshot: false });
      expect(pressed.text).toBe('Pressed Button "Export" @(440, 312) id=512:0.3.1:AXButton\nThe application did not confirm the action in time; it has most likely happened.');

      const closed = await h.call('perform_ui_action', { element_id: button.id, action: 'cancel', screenshot: false });
      expect(closed.text).toBe('Cancelled Button "Export" id=512:0.3.1:AXButton\nThe element is no longer part of the interface: the action closed or replaced it.');
      mac.commands.length = 0;
      await h.call('perform_ui_action', { element_id: button.id, screenshot: false });

      const filled = await h.call('perform_ui_action', { element_id: field.id, action: 'set_value', value: 'Comp 2', screenshot: false });
      expect(filled.text).toBe('Set the value of TextField "Name" value="Comp 2" [focused] @(100, 10) id=512:0.2.0:AXTextField');
      // Sliders and checkboxes take numbers.
      await h.call('perform_ui_action', { element_id: '512:0.4:AXSlider', action: 'set_value', value: '0.5', screenshot: false });
      await h.call('perform_ui_action', { element_id: '512:0.5:AXCheckBox', action: 'set_value', value: 'on', screenshot: false });
      expect(mac.sent('ui_action').map((p) => [p['action'], p['value']])).toEqual([
        ['press', undefined],
        ['set_value', 'Comp 2'],
        ['set_value', 0.5],
        ['set_value', 1],
      ]);
      expect((await h.call('perform_ui_action', { element_id: '512:0.4:AXSlider', action: 'set_value', value: 'half' })).text).toBe('Error [INVALID_ARGUMENT]: A Slider takes a number, not "half".');
      expect((await h.call('perform_ui_action', { element_id: field.id, action: 'set_value' })).text).toBe('Error [INVALID_ARGUMENT]: set_value needs `value`.');

      // "click" uses the real mouse at the centre of the element (in points).
      const clicked = await h.call('perform_ui_action', { element_id: button.id, action: 'double_click', screenshot: false });
      expect(clicked.text).toBe('Double-clicked Button "Export" @(440, 312) id=512:0.3.1:AXButton');
      expect(mac.sent('mouse_click')).toEqual([{ x: 495, y: 351, button: 'left', count: 2 }]);
      expect((await h.call('perform_ui_action', { element_id: 'gone:1:AXButton' })).text).toBe('Error [NOT_FOUND]: The interface has changed: element gone:1:AXButton no longer exists. Look it up again.');
    });

    it('lists menus and chooses menu items', async () => {
      mac.handlers['menu_list'] = (params) => ({
        application: 'TextEdit',
        pid: 512,
        path: params['path'],
        items: [
          { title: 'New', shortcut: 'cmd+n' },
          { title: 'Open Recent', submenu: true, items: [{ title: 'notes.txt' }, { title: 'Clear Menu', enabled: false }] },
          { title: 'Show Ruler', checked: true, shortcut: 'cmd+r' },
        ],
      });
      const menu = await h.call('list_menus', { application: 'TextEdit', path: ['File'], depth: 2 });
      expect(mac.sent('menu_list')).toEqual([{ name: 'TextEdit', path: ['File'], max_depth: 2 }]);
      expect(menu.text.split('\n')).toEqual(['TextEdit > File:', '  New  (cmd+n)', '  Open Recent  ▸', '    notes.txt', '    Clear Menu  [disabled]', '  Show Ruler  ✓ (cmd+r)']);
      expect((await h.call('list_menus')).text.startsWith('Menu bar of TextEdit:')).toBe(true);

      mac.handlers['menu_select'] = (params) => {
        const menuPath = params['path'] as string[];
        if (menuPath[1] === 'Paste') throw new ToolError('FAILED', 'The menu item "Edit > Paste" is disabled right now');
        return { application: 'TextEdit', selected: ['File', 'Save As…'] };
      };
      const chosen = await h.call('select_menu_item', { path: ['file', 'save as'], screenshot: false });
      expect(chosen.text).toBe('Chose File > Save As… in TextEdit.');
      expect((await h.call('select_menu_item', { path: ['Edit', 'Paste'] })).text).toBe('Error [FAILED]: The menu item "Edit > Paste" is disabled right now');
      expect((await h.call('select_menu_item', { path: [] })).isError).toBe(true);
    });
  });

  describe('scripting and clipboard', () => {
    it('runs AppleScript and JavaScript for Automation', async () => {
      mac.scriptResult = (source) => result({ stdout: source.includes('console') ? 'done\n' : '/Users/me/Desktop/\n', stderr: source.includes('console') ? 'step 1\n' : '' });
      const finder = await h.call('run_applescript', { script: 'tell application "Finder" to get POSIX path of (target of front window as alias)', args: ['a b'], timeout_seconds: 5 });
      expect(finder.text).toBe('/Users/me/Desktop/');
      expect(finder.data).toEqual({ result: '/Users/me/Desktop/', truncated_chars: 0 });
      expect(mac.scripts[0]?.source).toBe('tell application "Finder" to get POSIX path of (target of front window as alias)');
      expect(mac.scripts[0]?.options).toMatchObject({ language: 'applescript', args: ['a b'], timeoutMs: 5000 });

      const jxa = await h.call('run_applescript', { language: 'javascript', script: 'console.log("step 1"); "done"' });
      expect(jxa.text).toBe('done\n--- log ---\nstep 1');
      expect(mac.scripts[1]?.options).toMatchObject({ language: 'javascript', timeoutMs: 60_000 });

      mac.scriptResult = () => result();
      expect((await h.call('run_applescript', { script: 'beep' })).text).toBe('(the script returned nothing)');
    });

    it('turns script failures into errors the agent can act on', async () => {
      mac.scriptResult = () => result({ code: 1, stderr: '36:54: execution error: Not authorized to send Apple events to Finder. (-1743)\n' });
      const denied = await h.call('run_applescript', { script: 'tell application "Finder" to activate' });
      expect(denied.text).toContain('Error [MACOS_PERMISSION_REQUIRED]: 36:54: execution error: Not authorized to send Apple events to Finder. (-1743)');
      expect(denied.text).toContain('Privacy & Security → Automation');

      mac.scriptResult = () => result({ code: 1, stderr: '0:13: execution error: System Events got an error: osascript is not allowed assistive access. (-25211)' });
      expect((await h.call('run_applescript', { script: 'x' })).text).toContain('Privacy & Security → Accessibility');

      mac.scriptResult = () => result({ code: 1, stderr: 'execution error: Photoshop got an error: Application isn’t running. (-600)' });
      expect((await h.call('run_applescript', { script: 'x' })).text).toContain('Hint: The application is not running: start it with open_application first.');

      mac.scriptResult = () => result({ code: 1, stderr: '7:8: syntax error: Expected end of line but found identifier. (-2741)' });
      expect((await h.call('run_applescript', { script: 'x' })).text).toBe('Error [FAILED]: 7:8: syntax error: Expected end of line but found identifier. (-2741)');

      mac.scriptResult = () => result({ code: null, signal: 'SIGKILL', timedOut: true });
      const slow = await h.call('run_applescript', { script: 'delay 99', timeout_seconds: 2 });
      expect(slow.text).toContain('Error [TIMEOUT]: The script did not finish within 2 s and was stopped.');
    });

    it('reads and writes the clipboard', async () => {
      mac.clipboard = undefined;
      expect((await h.call('get_clipboard')).text).toBe('The clipboard contains no text. It is empty.');
      mac.handlers['clipboard_get'] = () => ({ types: ['public.tiff', 'public.png'] });
      expect((await h.call('get_clipboard')).text).toBe('The clipboard contains no text. It holds: public.tiff, public.png.');
      mac.handlers = {};

      const set = await h.call('set_clipboard', { text: 'Lower third — Jane Doe' });
      expect(set.text).toBe('Copied 22 characters to the clipboard.');
      const got = await h.call('get_clipboard');
      expect(got.text).toBe('Lower third — Jane Doe');
      expect(got.data).toMatchObject({ text: 'Lower third — Jane Doe', characters: 22, truncated_chars: 0 });

      mac.clipboard = 'x'.repeat(500);
      const cut = await h.call('get_clipboard', { max_chars: 100 });
      expect(cut.data).toMatchObject({ characters: 500, truncated_chars: 400 });
    });
  });
});

describe('desktop tools on several displays', () => {
  let h: Harness;
  let mac: FakeDesktopDriver;
  // A 1920×1080 display to the left of the Retina main display: screenshots are 1280×720.
  const LEFT = { id: 2, index: 2, main: false, x: -1920, y: 0, width: 1920, height: 1080, pixel_width: 1920, pixel_height: 1080, scale: 1 };

  beforeAll(async () => {
    mac = new FakeDesktopDriver([RETINA, LEFT]);
    h = await createHarness({ mode: 'full', runtime: { desktop: mac } });
  });
  afterAll(async () => {
    await h.close();
  });

  it('addresses each display in its own screenshot space', async () => {
    const shot = await h.call('screenshot', { display: 2 });
    expect(shot.data).toMatchObject({ display: 2, width: 1280, height: 720, screen: { width: 1280, height: 720 } });
    expect(mac.captures.at(-1)).toEqual({ display: 2, cursor: true });

    await h.call('click', { x: 640, y: 360, display: 2, screenshot: false });
    // 1.5 points per screenshot pixel, offset by the display origin.
    expect(mac.sent('mouse_click')).toEqual([{ x: -1920 + 640 * 1.5 + 0.75, y: 360 * 1.5 + 0.75, button: 'left', count: 1, modifiers: [] }]);
    expect((await h.call('cursor_position')).data).toEqual({ display: 2, x: 640, y: 360 });

    mac.handlers['windows'] = () => ({ windows: [{ app: 'Blender', pid: 7, title: 'Render', window_id: 5, z: 0, frame: { x: -1920 + 150, y: 300, width: 600, height: 300 } }], limited: false });
    expect((await h.call('list_windows')).data?.['windows']).toMatchObject([{ display: 2, x: 100, y: 200, width: 400, height: 200 }]);
  });
});

describe('desktop tools where they are not allowed', () => {
  it('are hidden and refused in Project-Only mode', async () => {
    const h = await createHarness({ mode: 'project', runtime: { desktop: new FakeDesktopDriver(), allowUnsandboxed: true } });
    try {
      const names = (await (await h.connect()).listTools()).tools.map((tool) => tool.name);
      for (const name of DESKTOP_TOOLS) expect(names, name).not.toContain(name);
      const refused = await h.call('screenshot');
      expect(refused.text).toContain('Error [PERMISSION_DENIED]: screenshot requires Full System Access');
      const info = (await h.call('server_info')).data as { tool_groups: Record<string, { status: string }> };
      expect(info.tool_groups['computer']?.status).toBe('requires Full System Access');
    } finally {
      await h.close();
    }
  });

  it('do not exist on a host without a desktop driver', async () => {
    const h = await createHarness({ mode: 'full', runtime: { desktop: null } });
    try {
      const names = (await (await h.connect()).listTools()).tools.map((tool) => tool.name);
      for (const name of DESKTOP_TOOLS) expect(names, name).not.toContain(name);
      expect((await h.call('click', { x: 1, y: 1 })).text).toContain('Error [UNSUPPORTED_PLATFORM]: click needs macOS desktop control, which is not available on this host.');
      const info = (await h.call('server_info')).data as { desktop_control: boolean; tool_groups: Record<string, { status: string }> };
      expect(info.desktop_control).toBe(false);
      expect(info.tool_groups['computer']?.status).toBe('not available on this host');
    } finally {
      await h.close();
    }
  });

  it('can be switched off by group', async () => {
    const h = await createHarness({ mode: 'full', runtime: { desktop: new FakeDesktopDriver() } });
    try {
      h.runtime.disabledGroups.add('computer');
      const names = (await (await h.connect()).listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain('click');
      expect(names).toContain('list_windows');
      expect((await h.call('click', { x: 1, y: 1 })).text).toContain('Error [PERMISSION_DENIED]: The "computer" tool group was disabled by the user');
    } finally {
      await h.close();
    }
  });
});

describe('desktop tools before macOS has granted Screen Recording', () => {
  it('refuse to pass off a picture without windows as a screenshot, and work once access is there', async () => {
    const mac = new FakeDesktopDriver([RETINA]);
    let granted = false;
    mac.handlers['permissions'] = () => ({ accessibility: true, screen_recording: granted });
    const h = await createHarness({ mode: 'full', runtime: { desktop: mac } });
    try {
      // macOS 15 lets `screencapture` succeed without the permission; the picture then shows the desktop only.
      const refused = await h.call('screenshot');
      expect(refused.text).toBe(
        [
          'Error [MACOS_PERMISSION_REQUIRED]: macOS has not granted Screen Recording access to the application that runs mcpclaude, so the screen cannot be captured.',
          'Hint: Ask the user to open System Settings → Privacy & Security → Screen & System Audio Recording, enable the application that runs mcpclaude (Terminal, iTerm, …) and restart mcpclaude. You cannot grant this yourself.',
        ].join('\n'),
      );
      expect(mac.captures).toEqual([]);
      // The question travels with the display list: one helper run, not two.
      expect(mac.events).toEqual(['run:displays,permissions']);

      // Input does not need this permission: the action happens and says why there is no picture.
      const click = await h.call('click', { x: 5, y: 5 });
      expect(click.isError).toBe(false);
      expect(click.text).toMatch(/^Clicked at \(5, 5\)\.\nThe action was carried out, but no screenshot could be taken: macOS has not granted Screen Recording access/);
      expect(mac.captures).toEqual([]);

      granted = true;
      mac.events.length = 0;
      expect((await h.call('screenshot')).images).toHaveLength(1);
      expect((await h.call('screenshot')).images).toHaveLength(1);
      // Asked until the answer is yes, then never again.
      expect(mac.events.filter((event) => event.includes('displays'))).toEqual(['run:displays,permissions', 'run:displays']);
      expect(mac.captures).toHaveLength(2);
    } finally {
      await h.close();
    }
  });
});
