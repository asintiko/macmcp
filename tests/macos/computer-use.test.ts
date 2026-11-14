import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readImageInfo } from '../../src/core/image.js';
import { realBlender } from '../helpers/blender.js';
import { type CallOutcome, createHarness, type Harness } from '../helpers/harness.js';
import { buildClickRecorder, buildVirtualDisplay, ClickRecorder, VirtualDisplay } from '../helpers/native.js';
import { decodePng } from '../helpers/png.js';

/**
 * Computer Use against a real desktop: the hosted macOS runners have a logged-in session with
 * a 1024×768 display, and grant Accessibility and Screen Recording to the runner process.
 * Every effect is read back from the system (pointer position, window geometry, text of the
 * document, clipboard), not assumed. The steps build on each other and run in order.
 *
 * With MCPCLAUDE_TEST_ARTIFACTS set, a screenshot is saved after every step.
 */
const artifacts = process.env['MCPCLAUDE_TEST_ARTIFACTS'];

interface WindowInfo {
  window_id: number;
  application: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  focused: boolean;
  fullscreen: boolean;
  on_screen: boolean;
}

interface ElementInfo {
  element_id: string;
  role: string;
  label: string | null;
  value: string | number | null;
  center: { x: number; y: number } | null;
  frame: { x: number; y: number; width: number; height: number } | null;
}

describe.runIf(process.platform === 'darwin')('computer use on a real Mac', () => {
  let h: Harness;
  let note: string;
  let windowId = 0;
  let step = 0;
  let recorderBinary = '';

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> => {
    const outcome = await h.call(name, args);
    if (outcome.isError) console.log(`[computer-use] ${name} ${JSON.stringify(args)} → ${outcome.text}`);
    return outcome;
  };

  /** Call a tool that is expected to work, without the screenshot that action tools return by default. */
  const act = async (name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> => {
    const takesScreenshot = 'screenshot' in (h.registry.get(name)?.input.shape ?? {});
    const outcome = await call(name, takesScreenshot ? { screenshot: false, ...args } : args);
    expect(outcome.isError, `${name}: ${outcome.text}`).toBe(false);
    return outcome;
  };

  async function eventually<T>(what: string, probe: () => Promise<T | undefined | false | null>, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== undefined && value !== false && value !== null) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  const textEditWindows = async (): Promise<WindowInfo[]> => {
    const listed = await call('list_windows', { application: 'TextEdit' });
    return listed.isError ? [] : (listed.data?.['windows'] as WindowInfo[]);
  };

  const theWindow = async (): Promise<WindowInfo> => {
    const found = (await textEditWindows()).find((w) => w.window_id === windowId);
    if (!found) throw new Error(`Window ${windowId} is gone`);
    return found;
  };

  /** Text of the element that has keyboard focus. */
  const focusedText = async (): Promise<string> => {
    const focused = await call('get_focused_ui_element');
    return focused.isError ? `<${focused.text}>` : String(focused.data?.['value'] ?? '');
  };

  const clickIntoDocument = async (): Promise<void> => {
    const w = await theWindow();
    await act('click', { x: Math.round(w.x + w.width / 2), y: Math.round(w.y + w.height * 0.75) });
    await eventually('the text area to have focus', async () => (await call('get_focused_ui_element')).data?.['role'] === 'TextArea');
  };

  /** Replace the document text, bypassing the keyboard, and return when it is in place. */
  const setDocument = async (text: string): Promise<ElementInfo> => {
    const found = await act('find_ui_elements', { role: 'TextArea', window_id: windowId });
    const area = (found.data?.['elements'] as ElementInfo[])[0];
    if (!area) throw new Error(`No text area in the window: ${found.text}`);
    await act('perform_ui_action', { element_id: area.element_id, action: 'set_value', value: text });
    return area;
  };

  beforeAll(async () => {
    h = await createHarness({ mode: 'full' });
    note = path.join(h.projectDir, 'mcpclaude-note.txt');
    await writeFile(note, 'first line\n');
    if (artifacts) await mkdir(artifacts, { recursive: true });
    // A predictable editor: no autocorrection, no smart punctuation, no restored windows.
    const prepared = await h.call('run_command', {
      command: [
        ...['CorrectSpellingAutomatically', 'CheckSpellingWhileTyping', 'SmartQuotes', 'SmartDashes', 'SmartSubstitutionsEnabledInRichTextOnly', 'TextReplacement', 'NSQuitAlwaysKeepsWindows'].map(
          (key) => `defaults write com.apple.TextEdit ${key} -bool false`,
        ),
        ...['NSAutomaticSpellingCorrectionEnabled', 'NSAutomaticCapitalizationEnabled', 'NSAutomaticPeriodSubstitutionEnabled', 'NSAutomaticDashSubstitutionEnabled', 'NSAutomaticQuoteSubstitutionEnabled', 'NSAutomaticTextCompletionEnabled'].map(
          (key) => `defaults write -g ${key} -bool false`,
        ),
        'defaults write com.apple.TextEdit ApplePersistenceIgnoreState -bool true',
      ].join(' && '),
    });
    expect(prepared.text, prepared.text).toMatch(/^Exit code 0/);
    // Compile the helper and the click recorder outside the timed steps.
    await h.runtime.desktop?.driver.prepare();
    recorderBinary = await buildClickRecorder(path.join(h.root, 'click-recorder'));
  }, 600_000);

  afterEach(async (context) => {
    step += 1;
    if (!artifacts) return;
    const name = `${String(step).padStart(2, '0')}-${context.task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}`;
    const shot = await h.call('screenshot', { format: 'png' }).catch(() => undefined);
    if (shot?.images[0]) await writeFile(path.join(artifacts, `${name}.png`), Buffer.from(shot.images[0].data, 'base64'));
    if (context.task.result?.state === 'fail') {
      const tree = await h.call('get_ui_tree', { max_depth: 14, max_elements: 400, include_containers: true }).catch(() => undefined);
      const windows = await h.call('list_windows').catch(() => undefined);
      const apps = await h.call('list_applications').catch(() => undefined);
      await writeFile(path.join(artifacts, `${name}.txt`), [shot?.text, apps?.text, windows?.text, tree?.text].join('\n\n'));
    }
  });

  afterAll(async () => {
    await h.call('quit_application', { application: 'TextEdit', force: true, screenshot: false }).catch(() => undefined);
    await h.close();
  });

  it('reports desktop control as available', async () => {
    const info = (await call('server_info')).data as { desktop_control: boolean; tool_groups: Record<string, { status: string }> };
    expect(info.desktop_control).toBe(true);
    expect(info.tool_groups['computer']?.status).toBe('available');
    const permissions = await h.runtime.desktop?.permissions();
    expect(permissions).toEqual({ accessibility: true, screen_recording: true });
  });

  it('takes screenshots of the screen and of a region', async () => {
    const shot = await call('screenshot');
    expect(shot.isError, shot.text).toBe(false);
    expect(shot.images[0]?.mimeType).toBe('image/jpeg');
    const jpeg = readImageInfo(Buffer.from(shot.images[0]?.data ?? '', 'base64'));
    const data = shot.data as { width: number; height: number; screen: { width: number; height: number }; pointer: { x: number; y: number }; frontmost_application: string };
    expect(jpeg).toEqual({ format: 'jpeg', width: data.width, height: data.height });
    expect(data.screen).toEqual({ width: data.width, height: data.height });
    expect(data.width).toBeGreaterThanOrEqual(640);
    expect(Math.max(data.width, data.height)).toBeLessThanOrEqual(1280);
    expect(typeof data.pointer.x).toBe('number');
    expect(typeof data.frontmost_application).toBe('string');

    // A lossless capture really shows the desktop: it is not one flat colour.
    const png = await call('screenshot', { format: 'png', show_cursor: false });
    expect(png.images[0]?.mimeType).toBe('image/png');
    const picture = decodePng(Buffer.from(png.images[0]?.data ?? '', 'base64'));
    expect([picture.width, picture.height]).toEqual([data.width, data.height]);
    const colours = new Set<string>();
    for (let y = 2; y < picture.height; y += 16) for (let x = 2; x < picture.width; x += 16) colours.add(picture.pixel(x, y).join(','));
    expect(colours.size).toBeGreaterThan(1);

    const region = await call('screenshot', { region: { x: 0, y: 0, width: 320, height: 200 }, format: 'png' });
    expect(region.isError, region.text).toBe(false);
    const zoomed = readImageInfo(Buffer.from(region.images[0]?.data ?? '', 'base64'));
    const zoom = region.data?.['zoom'] as number;
    expect(zoom).toBeGreaterThanOrEqual(1);
    expect(zoomed).toMatchObject({ format: 'png', width: Math.round(320 * zoom), height: Math.round(200 * zoom) });
  });

  it('moves the pointer to screenshot coordinates', async () => {
    for (const target of [{ x: 300, y: 200 }, { x: 51, y: 77 }, { x: 640, y: 480 }]) {
      const moved = await act('mouse_move', target);
      expect(moved.text).toBe(`Moved the pointer to (${target.x}, ${target.y}).`);
      expect((await call('cursor_position')).data).toEqual({ display: 1, ...target });
    }
    const withShot = await call('mouse_move', { x: 200, y: 150 });
    expect(withShot.images).toHaveLength(1);
    expect(withShot.text).toContain('Screenshot of display 1');
  });

  it('opens a document in an application and finds its window', async () => {
    const opened = await act('open_path', { target: note, application: 'TextEdit' });
    expect(opened.text).toBe(`Opened with TextEdit: ${note}`);
    const window = await eventually('the TextEdit window', async () => (await textEditWindows()).find((w) => w.title.includes('mcpclaude-note')), 60_000);
    windowId = window.window_id;
    expect(windowId).toBeGreaterThan(0);
    expect(window.application).toBe('TextEdit');
    expect(window.width).toBeGreaterThan(100);

    const running = await call('list_applications', { installed: true });
    expect((running.data?.['running'] as { name: string }[]).map((app) => app.name)).toContain('TextEdit');
    expect((running.data?.['installed'] as { name: string; path: string }[]).find((app) => app.name === 'TextEdit')?.path).toMatch(/\/TextEdit\.app$/);

    const again = await act('open_application', { application: 'TextEdit' });
    expect(again.text).toMatch(/^TextEdit \(pid \d+\) is frontmost\.$/);
    expect((await call('screenshot')).data).toMatchObject({ frontmost_application: 'TextEdit' });
  }, 120_000);

  it('moves and resizes the window', async () => {
    const placed = await act('set_window_bounds', { window_id: windowId, x: 60, y: 80, width: 640, height: 420 });
    expect(placed.text).toMatch(/is now at \(60, 80\) 640×420\.$/);
    expect(await theWindow()).toMatchObject({ x: 60, y: 80, width: 640, height: 420, minimized: false, on_screen: true });
    await act('set_window_bounds', { window_id: windowId, x: 90, y: 110 });
    expect(await theWindow()).toMatchObject({ x: 90, y: 110, width: 640, height: 420 });
    await act('set_window_bounds', { window_id: windowId, width: 600, height: 400 });
    expect(await theWindow()).toMatchObject({ x: 90, y: 110, width: 600, height: 400 });
  });

  it('clicks into the document and types text', async () => {
    await act('focus_window', { window_id: windowId });
    await clickIntoDocument();
    await act('type_text', { text: 'Hello from mcpclaude 123!' });
    await eventually('the typed text', async () => (await focusedText()).includes('Hello from mcpclaude 123!'));
    expect(await focusedText()).toBe('first line\nHello from mcpclaude 123!');

    // Shortcuts, named keys, capitals, symbols and characters that are on no key.
    await act('press_key', { keys: 'cmd+a' });
    await act('type_text', { text: 'Résumé #2 — (50% done) ✓' });
    await act('press_key', { keys: 'return' });
    await act('type_text', { text: 'tab\there\n' });
    await eventually('the replaced text', async () => (await focusedText()) === 'Résumé #2 — (50% done) ✓\ntab\there\n');

    await act('press_key', { keys: 'delete', repeat: 6 });
    await act('press_key', { keys: 'shift+a b plus' });
    await eventually('the edited text', async () => (await focusedText()) === 'Résumé #2 — (50% done) ✓\ntabAb+');
  }, 90_000);

  it('copies and pastes through the clipboard', async () => {
    await act('set_clipboard', { text: 'placeholder' });
    await act('press_key', { keys: 'cmd+a cmd+c' });
    await eventually('the copied text', async () => (await call('get_clipboard')).text === 'Résumé #2 — (50% done) ✓\ntabAb+');

    const pasted = 'Pasted line one\nPasted line two — ünïcödé 日本語';
    expect((await act('set_clipboard', { text: pasted })).text).toBe(`Copied ${pasted.length} characters to the clipboard.`);
    await act('press_key', { keys: 'cmd+a cmd+v' });
    await eventually('the pasted text', async () => (await focusedText()) === pasted);
  }, 60_000);

  it('finds interface elements and operates them', async () => {
    const area = await setDocument('Set through accessibility');
    expect(area.role).toBe('TextArea');
    const w = await theWindow();
    expect(area.center?.x).toBeGreaterThan(w.x);
    expect(area.center?.x).toBeLessThan(w.x + w.width);
    expect(area.center?.y).toBeGreaterThan(w.y);
    expect(area.center?.y).toBeLessThan(w.y + w.height);
    await eventually('the new value', async () => (await focusedText()) === 'Set through accessibility');

    const at = await call('get_ui_element_at', area.center ?? {});
    expect(at.isError, at.text).toBe(false);
    expect(at.data).toMatchObject({ role: 'TextArea', application: 'TextEdit', value: 'Set through accessibility' });
    expect(at.text).toMatch(/Inside: .*Window "mcpclaude-note/);

    const tree = await call('get_ui_tree', { window_id: windowId });
    expect(tree.isError, tree.text).toBe(false);
    expect(tree.text).toMatch(/^Interface of TextEdit \(\d+ elements\):\nWindow "mcpclaude-note/);
    expect(tree.text).toMatch(/\n\s+TextArea[^\n]*value="Set through accessibility"/);
    // Unlabelled controls are named by what they are.
    expect(tree.text).toMatch(/\n\s+Button \(CloseButton\) @\(\d+, \d+\)/);
    expect(tree.text).toMatch(/\n\s+ScrollBar vertical /);

    const byText = await call('find_ui_elements', { text: 'through ACCESS', application: 'TextEdit' });
    expect((byText.data?.['elements'] as ElementInfo[]).map((element) => element.role)).toContain('TextArea');

    // A real button: the find bar's "Done" closes the bar again.
    await clickIntoDocument();
    await act('press_key', { keys: 'cmd+f' });
    const done = await eventually('the Done button of the find bar', async () => {
      const found = await call('find_ui_elements', { text: 'Done', role: 'Button', window_id: windowId });
      return (found.data?.['elements'] as ElementInfo[] | undefined)?.[0];
    });
    const pressed = await act('perform_ui_action', { element_id: done.element_id, action: 'press' });
    expect(pressed.text).toMatch(/^Pressed Button "Done"/);
    expect(pressed.text).toContain('The element is no longer part of the interface');
    await eventually('the find bar to close', async () => {
      const found = await call('find_ui_elements', { text: 'Done', role: 'Button', window_id: windowId });
      return (found.data?.['elements'] as ElementInfo[] | undefined)?.length === 0;
    });
    expect((await call('perform_ui_action', { element_id: done.element_id, action: 'press', screenshot: false })).text).toMatch(/^Error \[NOT_FOUND\]: The interface has changed/);
  }, 90_000);

  it('reads the menu bar and chooses menu items', async () => {
    const bar = await call('list_menus', { application: 'TextEdit', depth: 0 });
    expect(bar.isError, bar.text).toBe(false);
    const titles = (bar.data?.['items'] as { title: string }[]).map((item) => item.title);
    for (const title of ['TextEdit', 'File', 'Edit', 'Format', 'Window', 'Help']) expect(titles).toContain(title);

    const edit = await call('list_menus', { application: 'TextEdit', path: ['edit'] });
    const items = edit.data?.['items'] as { title: string; shortcut?: string; submenu?: boolean }[];
    expect(items.find((item) => item.title === 'Select All')).toMatchObject({ shortcut: 'cmd+a' });
    expect(items.find((item) => item.title === 'Copy')).toMatchObject({ shortcut: 'cmd+c' });
    expect(items.find((item) => item.title === 'Find')).toMatchObject({ submenu: true });
    expect(edit.text).toContain('TextEdit > Edit:');

    // Choosing items has the effect of the commands: select everything, copy it.
    await setDocument('Chosen from the menu');
    await clickIntoDocument();
    await act('set_clipboard', { text: 'placeholder' });
    expect((await act('select_menu_item', { application: 'TextEdit', path: ['Edit', 'Select All'] })).text).toBe('Chose Edit > Select All in TextEdit.');
    await act('select_menu_item', { application: 'TextEdit', path: ['edit', 'copy'] });
    await eventually('the text copied by the menu command', async () => (await call('get_clipboard')).text === 'Chosen from the menu');

    expect((await call('select_menu_item', { application: 'TextEdit', path: ['Edit', 'No Such Command'], screenshot: false })).text).toMatch(/^Error \[NOT_FOUND\]: No menu item "No Such Command" in "Edit"\. Available: /);
    expect((await call('select_menu_item', { application: 'TextEdit', path: ['Edit', 'Find'], screenshot: false })).text).toContain('is a submenu');

    // An item that really is disabled is reported, and the menu that was opened to check is closed again.
    await clickIntoDocument();
    await act('press_key', { keys: 'cmd+z', repeat: 30 });
    const redoable = await call('select_menu_item', { application: 'TextEdit', path: ['Edit', 'Undo'], screenshot: false });
    expect(redoable.text).toBe('Error [FAILED]: The menu item "Edit > Undo" is disabled right now');
    await act('type_text', { text: '!' });
    await eventually('typing to work after the menu was closed', async () => (await focusedText()).endsWith('!'));
  }, 60_000);

  it('drags the window by its title bar', async () => {
    await act('set_window_bounds', { window_id: windowId, x: 80, y: 100, width: 600, height: 400 });
    const before = await theWindow();
    const grip = { x: Math.round(before.x + before.width / 2), y: before.y + 12 };
    const dragged = await act('drag', { from_x: grip.x, from_y: grip.y, to_x: grip.x + 150, to_y: grip.y + 90, duration_ms: 900 });
    expect(dragged.text).toBe(`Dragged from (${grip.x}, ${grip.y}) to (${grip.x + 150}, ${grip.y + 90}).`);
    const after = await eventually('the window to have moved', async () => {
      const w = await theWindow();
      return w.x !== before.x ? w : undefined;
    });
    expect(Math.abs(after.x - (before.x + 150))).toBeLessThanOrEqual(4);
    expect(Math.abs(after.y - (before.y + 90))).toBeLessThanOrEqual(4);
    expect([after.width, after.height]).toEqual([before.width, before.height]);
    expect((await call('cursor_position')).data).toMatchObject({ x: grip.x + 150, y: grip.y + 90 });
  }, 60_000);

  it('scrolls a long document', async () => {
    await act('set_window_bounds', { window_id: windowId, x: 80, y: 100, width: 600, height: 400 });
    const area = await setDocument(Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join('\n'));
    const scrollBar = async (): Promise<number | undefined> => {
      const found = await call('find_ui_elements', { role: 'ScrollBar', window_id: windowId });
      const value = (found.data?.['elements'] as (ElementInfo & { orientation?: string })[] | undefined)?.find((bar) => bar.orientation === 'vertical')?.value;
      return typeof value === 'number' ? value : undefined;
    };
    const centre = area.center ?? { x: 380, y: 300 };
    // Go to the top first, wherever the insertion point left the view.
    await act('scroll', { ...centre, direction: 'up', amount: 200 });
    const top = await eventually('the scroll bar', async () => {
      const value = await scrollBar();
      return value !== undefined && value < 0.02 ? { value } : undefined;
    });
    const down = await act('scroll', { ...centre, direction: 'down', amount: 30 });
    expect(down.text).toBe(`Scrolled down by 30 at (${centre.x}, ${centre.y}).`);
    const lower = await eventually('the view to scroll down', async () => {
      const value = await scrollBar();
      return value !== undefined && value > top.value + 0.01 ? { value } : undefined;
    });
    await act('scroll', { ...centre, direction: 'up', amount: 10 });
    await eventually('the view to scroll back up', async () => {
      const value = await scrollBar();
      return value !== undefined && value < lower.value - 0.005;
    });
  }, 60_000);

  it('runs several actions in one call', async () => {
    await setDocument('');
    const w = await theWindow();
    const batch = await call('computer_actions', {
      actions: [
        { action: 'click', x: Math.round(w.x + w.width / 2), y: Math.round(w.y + w.height / 2) },
        { action: 'press_key', keys: 'cmd+a' },
        { action: 'type_text', text: 'batch one' },
        { action: 'press_key', keys: 'return' },
        { action: 'wait', seconds: 0.2 },
        { action: 'key_down', keys: 'shift' },
        { action: 'press_key', keys: 'b' },
        { action: 'key_up', keys: 'shift' },
        { action: 'type_text', text: 'atch two' },
      ],
    });
    expect(batch.isError, batch.text).toBe(false);
    expect(batch.images).toHaveLength(1);
    expect(batch.text).toContain('9. Typed "atch two"');
    await eventually('the text typed by the batch', async () => (await focusedText()) === 'batch one\nBatch two');

    // Double-click selects a word, triple-click a line; typing replaces the selection.
    const area = await setDocument('alpha beta gamma');
    const frame = area.frame ?? { x: w.x, y: w.y + 30, width: w.width, height: 20 };
    await act('click', { x: frame.x + 20, y: frame.y + 10, count: 2 });
    await act('type_text', { text: 'ALPHA' });
    await eventually('the word replaced after a double-click', async () => (await focusedText()) === 'ALPHA beta gamma');
    await act('click', { x: frame.x + 20, y: frame.y + 10, count: 3 });
    await act('type_text', { text: 'one line' });
    await eventually('the line replaced after a triple-click', async () => (await focusedText()) === 'one line');
  }, 90_000);

  it('opens a context menu with the right button and chooses from it', async () => {
    await act('focus_window', { window_id: windowId });
    await setDocument('');
    await clickIntoDocument();
    await act('set_clipboard', { text: 'pasted from the context menu' });
    const w = await theWindow();
    await act('click', { x: Math.round(w.x + w.width / 2), y: Math.round(w.y + w.height * 0.6), button: 'right' });
    // The menu that opens is part of the window's interface: its items can be found and clicked.
    const paste = await eventually('the Paste item of the context menu', async () => {
      const found = await call('find_ui_elements', { role: 'MenuItem', text: 'Paste', window_id: windowId });
      return (found.data?.['elements'] as ElementInfo[] | undefined)?.find((item) => item.label === 'Paste' && item.center !== null);
    });
    await act('click', paste.center ?? {});
    await eventually('the text pasted through the context menu', async () => (await focusedText()) === 'pasted from the context menu');
    await eventually('the context menu to be gone', async () => {
      const found = await call('find_ui_elements', { role: 'MenuItem', text: 'Paste', window_id: windowId });
      return (found.data?.['elements'] as ElementInfo[] | undefined)?.length === 0;
    });
  }, 60_000);

  it('delivers right, middle, double and modified clicks to an application', async () => {
    // A window that writes down every mouse event macOS hands it.
    const recorder = await ClickRecorder.start(recorderBinary, path.join(h.root, 'clicks.jsonl'), { x: 620, y: 420, width: 320, height: 220 });
    try {
      const window = await eventually('the recorder window', async () => ((await call('list_windows', { pid: recorder.pid })).data?.['windows'] as WindowInfo[] | undefined)?.find((w) => w.width > 100));
      // The middle of the content area, worked out from what list_windows says about the window.
      const contentHeight = recorder.content.height * (window.width / recorder.content.width);
      const target = { x: Math.round(window.x + window.width / 2), y: Math.round(window.y + window.height - contentHeight / 2) };
      const expected = { x: recorder.content.x + recorder.content.width / 2, y: recorder.content.y + recorder.content.height / 2 };

      expect((await act('click', { ...target, button: 'right' })).text).toBe(`Clicked the right button at (${target.x}, ${target.y}).`);
      expect((await act('click', { ...target, button: 'middle' })).text).toBe(`Clicked the middle button at (${target.x}, ${target.y}).`);
      await act('click', { ...target, count: 2 });
      await act('click', { ...target, modifiers: ['shift', 'alt'] });
      await act('click', { ...target, button: 'right', modifiers: ['cmd'] });

      const events = await eventually('the clicks to arrive', async () => {
        const seen = await recorder.events();
        return seen.length >= 12 ? seen : undefined;
      });
      console.log(`[computer-use] recorded ${JSON.stringify(events)}`);
      expect(events.map((event) => `${event.kind} button=${event.button} clicks=${event.clicks} ${event.modifiers.join('+')}`.trim())).toEqual([
        'down button=1 clicks=1',
        'up button=1 clicks=1',
        'down button=2 clicks=1',
        'up button=2 clicks=1',
        'down button=0 clicks=1',
        'up button=0 clicks=1',
        'down button=0 clicks=2',
        'up button=0 clicks=2',
        'down button=0 clicks=1 shift+alt',
        'up button=0 clicks=1 shift+alt',
        'down button=1 clicks=1 cmd',
        'up button=1 clicks=1 cmd',
      ]);
      // Every event arrived where it was aimed, in the application's own coordinates.
      for (const event of events) {
        expect(Math.abs(event.x - expected.x), JSON.stringify(event)).toBeLessThanOrEqual(2);
        expect(Math.abs(event.y - expected.y), JSON.stringify(event)).toBeLessThanOrEqual(2);
      }

      // The same buttons inside a batch, held and released as separate steps.
      await recorder.forget();
      const batch = await call('computer_actions', {
        screenshot: false,
        actions: [
          { action: 'mouse_down', ...target, button: 'middle' },
          { action: 'mouse_up', ...target, button: 'middle' },
          { action: 'click', ...target, button: 'right' },
        ],
      });
      expect(batch.isError, batch.text).toBe(false);
      const batched = await eventually('the batched clicks to arrive', async () => {
        const seen = await recorder.events();
        return seen.length >= 4 ? seen : undefined;
      });
      expect(batched.map((event) => `${event.kind} ${event.button}`)).toEqual(['down 2', 'up 2', 'down 1', 'up 1']);
    } finally {
      await recorder.stop();
    }
    // Keyboard focus goes back to the document for the steps that follow.
    await act('focus_window', { window_id: windowId });
  }, 90_000);

  it('captures a single window', async () => {
    const shot = await call('screenshot', { window_id: windowId, format: 'png' });
    expect(shot.isError, shot.text).toBe(false);
    const info = readImageInfo(Buffer.from(shot.images[0]?.data ?? '', 'base64'));
    const w = await theWindow();
    expect(info?.format).toBe('png');
    // The picture has the proportions of the window.
    expect(Math.abs((info?.width ?? 0) / (info?.height ?? 1) - w.width / w.height)).toBeLessThan(0.05);
    expect((await call('screenshot', { window_id: 999_999_999 })).text).toMatch(/^Error \[FAILED\]: Window 999999999 could not be captured/);
  });

  it('minimises and restores the window', async () => {
    const minimised = await act('set_window_state', { window_id: windowId, state: 'minimized' });
    expect(minimised.text).toMatch(/is now minimised\.$/);
    await eventually('the window to be minimised', async () => (await theWindow()).minimized);
    await act('set_window_state', { window_id: windowId, state: 'restored' });
    await eventually('the window to be back', async () => {
      const w = await theWindow();
      return !w.minimized && w.on_screen;
    });
    await act('set_window_state', { window_id: windowId, state: 'minimized' });
    await eventually('the window to be minimised again', async () => (await theWindow()).minimized);
    // Focusing a minimised window restores it.
    await act('focus_window', { window_id: windowId });
    await eventually('the window to be focused', async () => {
      const w = await theWindow();
      return !w.minimized && w.focused;
    });
  }, 60_000);

  it('makes the window full screen and back', async () => {
    await act('set_window_bounds', { window_id: windowId, x: 80, y: 100, width: 600, height: 400 });
    const before = await theWindow();
    expect(before.fullscreen).toBe(false);
    const screen = (await call('screenshot')).data?.['screen'] as { width: number; height: number };

    const entered = await act('set_window_state', { window_id: windowId, state: 'fullscreen' });
    expect(entered.text).toMatch(/is now fullscreen\.$/);
    const filling = await eventually(
      'the window to fill the screen',
      async () => {
        const w = await theWindow();
        return w.fullscreen && w.width >= screen.width - 2 ? w : undefined;
      },
      30_000,
    );
    expect(filling).toMatchObject({ x: 0, width: screen.width, minimized: false });
    expect(filling.height).toBeGreaterThan(screen.height - 60);
    expect((await call('list_windows', { application: 'TextEdit' })).text).toContain('full screen');
    // The document is still there to work in.
    await setDocument('typed in full screen');
    await eventually('the text in the full-screen window', async () => (await focusedText()) === 'typed in full screen');

    const left = await act('set_window_state', { window_id: windowId, state: 'windowed' });
    expect(left.text).toMatch(/is now windowed\.$/);
    const back = await eventually(
      'the window to leave full screen',
      async () => {
        const w = await theWindow();
        return !w.fullscreen && w.on_screen && w.width < screen.width - 100 ? w : undefined;
      },
      30_000,
    );
    expect(back).toMatchObject({ x: before.x, y: before.y, width: before.width, height: before.height });
    await act('focus_window', { window_id: windowId });
  }, 120_000);

  it('switches between applications', async () => {
    const finder = await act('activate_application', { application: 'Finder' });
    expect(finder.text).toMatch(/^Finder \(pid \d+\) is now frontmost\.$/);
    await eventually('Finder to be frontmost', async () => (await call('screenshot')).data?.['frontmost_application'] === 'Finder');
    const back = await act('activate_application', { application: 'com.apple.TextEdit' });
    expect(back.data).toMatchObject({ name: 'TextEdit', frontmost: true });
    await eventually('TextEdit to be frontmost', async () => (await call('screenshot')).data?.['frontmost_application'] === 'TextEdit');
    expect((await call('activate_application', { application: 'No Such App 42', screenshot: false })).text).toBe('Error [NOT_FOUND]: No running application named "No Such App 42"');
  }, 60_000);

  it('runs AppleScript and JavaScript for Automation', async () => {
    const sum = await call('run_applescript', { script: 'on run argv\n  return (item 1 of argv as integer) * 7\nend run', args: ['6'] });
    expect(sum.text).toBe('42');
    const jxa = await call('run_applescript', { language: 'javascript', script: 'function run(argv) { console.log("working"); return argv.join("-") + "!"; }', args: ['a', 'b'] });
    expect(jxa.text).toBe('a-b!\n--- log ---\nworking');
    const broken = await call('run_applescript', { script: 'this is not applescript (' });
    console.log(`[computer-use] syntax error → ${broken.text}`);
    expect(broken.text).toMatch(/^Error \[FAILED\]: .+/);
    const slow = await call('run_applescript', { script: 'delay 30', timeout_seconds: 1 });
    expect(slow.text).toContain('Error [TIMEOUT]: The script did not finish within 1 s and was stopped.');

    // Controlling another application needs the user's consent (Automation); either it is
    // there, or the agent is told exactly what is missing.
    const events = await call('run_applescript', { script: 'tell application "System Events" to get name of first application process whose frontmost is true', timeout_seconds: 20 });
    console.log(`[computer-use] System Events → ${events.text}`);
    if (events.isError) expect(events.text).toMatch(/^Error \[(MACOS_PERMISSION_REQUIRED|TIMEOUT)\]/);
    else expect(events.text).toBe('TextEdit');
  }, 90_000);

  it('closes windows and quits the application', async () => {
    await act('activate_application', { application: 'TextEdit' });
    await act('select_menu_item', { application: 'TextEdit', path: ['File', 'New'] });
    const extra = await eventually('a second window', async () => {
      const windows = await textEditWindows();
      return windows.length >= 2 ? windows.find((w) => w.window_id !== windowId) : undefined;
    });
    expect((await act('close_window', { window_id: extra.window_id })).text).toBe(`Pressed the close button of window ${extra.window_id}.`);
    await eventually('the second window to close', async () => !(await textEditWindows()).some((w) => w.window_id === extra.window_id));
    expect((await call('focus_window', { window_id: extra.window_id, screenshot: false })).text).toMatch(/^Error \[NOT_FOUND\]: No window with id/);

    const quit = await act('quit_application', { application: 'TextEdit', force: true, wait_seconds: 20 });
    expect(quit.text).toBe('TextEdit has quit.');
    await eventually('TextEdit to be gone', async () => !((await call('list_applications')).data?.['running'] as { name: string }[]).some((app) => app.name === 'TextEdit'));
    expect((await call('quit_application', { application: 'TextEdit', screenshot: false })).text).toBe('Error [NOT_FOUND]: No running application named "TextEdit"');
  }, 90_000);

  it('reports After Effects honestly when it is not there', async () => {
    const info = await call('after_effects_info');
    expect(info.isError, info.text).toBe(false);
    if ((info.data?.['installed'] as unknown[]).length === 0) {
      expect(info.text).toContain('After Effects is not installed on this Mac');
      expect((await call('after_effects_render', { project: note })).text).toContain('Error [DEPENDENCY_MISSING]: Adobe After Effects is not installed on this Mac');
    }
    if ((info.data?.['running'] as unknown[]).length === 0) {
      expect(info.text).toContain('Running: no.');
      expect((await call('after_effects_run_script', { code: 'app.version' })).text).toContain('Error [FAILED]: After Effects is not running.');
    }
  });

  // A real Blender with its window, driven through the bridge and seen through Computer Use.
  describe.runIf(realBlender())('with Blender', () => {
    let blenderPid = 0;
    afterAll(() => {
      if (blenderPid > 0) {
        try {
          process.kill(blenderPid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    });

    it('starts a live Blender session whose window is on screen', async () => {
      const launched = await call('blender_launch', { factory_settings: true, wait_seconds: 180 });
      expect(launched.isError, launched.text).toBe(false);
      expect(launched.text).toMatch(/^Blender \d+\.\d+(\.\d+)?( \w+)* is running \(pid \d+\) and connected\./);
      blenderPid = launched.data?.['pid'] as number;

      const window = await eventually('the Blender window', async () => ((await call('list_windows', { pid: blenderPid })).data?.['windows'] as WindowInfo[] | undefined)?.find((w) => w.width > 200), 60_000);
      expect(window.application).toMatch(/blender/i);
      const info = await call('blender_info');
      expect(info.text).toMatch(/Live session: Blender [\d.]+( \w+)* \(pid \d+\) is running\./);
      expect(info.data?.['live_session']).toMatchObject({ pid: blenderPid, objects: 3, scene: 'Scene' });
    }, 300_000);

    it('runs Python inside the session and sees the result on screen', async () => {
      const added = await call('blender_run_python', { code: 'bpy.ops.mesh.primitive_monkey_add(location=(0, 0, 2))\nbpy.context.object.name = "Suzanne"\n[bpy.context.area.type, sorted(o.name for o in bpy.data.objects)]' });
      expect(added.isError, added.text).toBe(false);
      expect(added.data?.['result']).toEqual(['VIEW_3D', ['Camera', 'Cube', 'Light', 'Suzanne']]);

      await act('activate_application', { pid: blenderPid });
      const shot = await eventually('Blender to be frontmost', async () => {
        const taken = await call('screenshot');
        return /blender/i.test(String(taken.data?.['frontmost_application'])) ? taken : undefined;
      }, 30_000);
      expect(shot.images).toHaveLength(1);

      const file = path.join(h.projectDir, 'live.blend');
      const saved = await call('blender_run_python', { mode: 'live', code: `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(file)})\nbpy.data.filepath` });
      expect(saved.data?.['result']).toBe(file);
      // The saved scene renders headless while the session stays open.
      const render = await call('blender_render', { blend_file: file, frame: 1, engine: 'CYCLES', samples: 1, resolution_x: 64, resolution_y: 48, resolution_percentage: 100, wait_seconds: 200 });
      expect(render.isError, render.text).toBe(false);
      expect(readImageInfo(await readFile((render.data?.['files'] as string[])[0] as string))).toEqual({ format: 'png', width: 64, height: 48 });
    }, 400_000);

    it('ends the session when Blender quits', async () => {
      const quit = await act('quit_application', { pid: blenderPid, force: true, wait_seconds: 20 });
      expect(quit.text).toMatch(/has quit\.$/);
      blenderPid = 0;
      await eventually('the session to be gone', async () => (await call('blender_info')).text.includes('Live session: none.'));
      expect((await call('blender_run_python', { mode: 'live', code: '1' })).text).toContain('Error [FAILED]: No live Blender session is running.');
    }, 60_000);
  });

  // A second, Retina display, added to the Mac for the duration of these steps. macOS gives the
  // main display a larger mode while it is there, so the main display is scaled as well: one
  // screenshot pixel is no longer one point on either of them.
  describe('with a Retina display next to the main one', () => {
    interface DisplayData {
      index: number;
      main: boolean;
      x: number;
      y: number;
      width: number;
      height: number;
      pixelWidth: number;
      pixelHeight: number;
      scale: number;
    }
    let virtual: VirtualDisplay | undefined;
    let second: DisplayData;
    let main: DisplayData;
    const recorders: ClickRecorder[] = [];

    const displays = async (): Promise<DisplayData[]> => (await h.runtime.desktop?.displays(true)) ?? [];
    const recorderWindow = async (recorder: ClickRecorder): Promise<WindowInfo & { display: number }> =>
      eventually('the recorder window', async () => ((await call('list_windows', { pid: recorder.pid })).data?.['windows'] as (WindowInfo & { display: number })[] | undefined)?.find((w) => w.width > 100));
    const isMagenta = ([r, g, b]: number[]): boolean => (r ?? 0) > 180 && (g ?? 255) < 100 && (b ?? 0) > 180;

    beforeAll(async () => {
      const tool = await buildVirtualDisplay(path.join(h.root, 'virtual-display'));
      virtual = await VirtualDisplay.start(tool, { width: 1280, height: 800, hiDPI: true });
      const found = await eventually('macOS to list the new display', async () => {
        const all = await displays();
        return all.length === 2 ? all : undefined;
      });
      main = found.find((d) => d.main) as DisplayData;
      second = found.find((d) => !d.main) as DisplayData;
      console.log(`[computer-use] displays ${JSON.stringify(found)}`);
    }, 300_000);

    afterAll(async () => {
      for (const recorder of recorders) await recorder.stop();
      await virtual?.stop();
      await eventually('the display to be gone', async () => (await displays()).length === 1).catch(() => undefined);
    });

    it('reports two displays, the second with twice the pixels', async () => {
      expect(main).toMatchObject({ index: 1, x: 0, y: 0 });
      expect(second).toMatchObject({ index: 2, width: 1280, height: 800, pixelWidth: 2560, pixelHeight: 1600, scale: 2 });

      const first = await call('screenshot', { format: 'png' });
      expect(first.isError, first.text).toBe(false);
      const firstSize = first.data?.['screen'] as { width: number; height: number };
      expect(first.data).toMatchObject({ display: 1 });
      expect(Math.max(firstSize.width, firstSize.height)).toBeLessThanOrEqual(1280);
      // The proportions of the display survive the scaling.
      expect(Math.abs(firstSize.width / firstSize.height - main.width / main.height)).toBeLessThan(0.01);
      expect(readImageInfo(Buffer.from(first.images[0]?.data ?? '', 'base64'))).toEqual({ format: 'png', ...firstSize });

      // 2560×1600 pixels come back as the 1280×800 picture that coordinates refer to.
      const other = await call('screenshot', { display: 2, format: 'png' });
      expect(other.isError, other.text).toBe(false);
      expect(other.data).toMatchObject({ display: 2, width: 1280, height: 800, screen: { width: 1280, height: 800 } });
      expect(readImageInfo(Buffer.from(other.images[0]?.data ?? '', 'base64'))).toEqual({ format: 'png', width: 1280, height: 800 });
      expect(other.text).toContain('Screenshot of display 2 (1280×800)');

      // Enlarging a region shows the extra pixels of the Retina display.
      const region = await call('screenshot', { display: 2, region: { x: 100, y: 100, width: 200, height: 125 }, format: 'png' });
      expect(region.isError, region.text).toBe(false);
      expect(region.data).toMatchObject({ display: 2, zoom: 2, width: 400, height: 250 });
      expect(readImageInfo(Buffer.from(region.images[0]?.data ?? '', 'base64'))).toEqual({ format: 'png', width: 400, height: 250 });

      expect((await call('screenshot', { display: 3 })).text).toContain('Error [INVALID_ARGUMENT]: There is no display 3: this Mac has 2 displays');
    }, 60_000);

    it('moves the pointer on each display in that display\'s screenshot coordinates', async () => {
      for (const target of [{ x: 640, y: 400 }, { x: 37, y: 91 }, { x: 1200, y: 700 }]) {
        await act('mouse_move', { ...target, display: 2 });
        expect((await call('cursor_position')).data).toEqual({ display: 2, ...target });
      }
      for (const target of [{ x: 300, y: 200 }, { x: 51, y: 77 }]) {
        await act('mouse_move', target);
        expect((await call('cursor_position')).data).toEqual({ display: 1, ...target });
      }
      const shot = await call('screenshot', { display: 2 });
      expect(shot.data?.['pointer']).toMatchObject({ display: 1 });
    }, 60_000);

    it('clicks where it aims on the Retina display, and the screenshot shows the same place', async () => {
      // Content area at (300, 250) 400×240 of the second display, given to the application in global points.
      const recorder = await ClickRecorder.start(recorderBinary, path.join(h.root, 'clicks-display-2.jsonl'), { x: second.x + 300, y: second.y + 250, width: 400, height: 240 });
      recorders.push(recorder);
      expect(recorder.scale).toBe(2);
      const window = await recorderWindow(recorder);
      expect(window.display).toBe(2);
      // A point of this display is a screenshot pixel, so the window is where it was put.
      expect(window).toMatchObject({ x: 300, width: 400 });
      expect(window.y + window.height).toBe(490);

      const centre = { x: 500, y: 370 };
      await act('click', { ...centre, display: 2 });
      await act('click', { ...centre, display: 2, button: 'right' });
      await act('click', { ...centre, display: 2, button: 'middle' });
      const events = await eventually('the clicks to arrive', async () => {
        const seen = await recorder.events();
        return seen.length >= 6 ? seen : undefined;
      });
      console.log(`[computer-use] recorded on display 2 ${JSON.stringify(events)}`);
      expect(events.map((event) => `${event.kind} ${event.button}`)).toEqual(['down 0', 'up 0', 'down 1', 'up 1', 'down 2', 'up 2']);
      for (const event of events) {
        expect(Math.abs(event.x - (second.x + centre.x)), JSON.stringify(event)).toBeLessThanOrEqual(1);
        expect(Math.abs(event.y - (second.y + centre.y)), JSON.stringify(event)).toBeLessThanOrEqual(1);
      }

      // The picture agrees: the window's colour is at those pixels and stops at its edges.
      const shot = await call('screenshot', { display: 2, format: 'png', show_cursor: false });
      const picture = decodePng(Buffer.from(shot.images[0]?.data ?? '', 'base64'));
      expect(isMagenta(picture.pixel(centre.x, centre.y))).toBe(true);
      expect(isMagenta(picture.pixel(305, 255))).toBe(true);
      expect(isMagenta(picture.pixel(695, 485))).toBe(true);
      expect(isMagenta(picture.pixel(294, 370))).toBe(false);
      expect(isMagenta(picture.pixel(706, 370))).toBe(false);
      expect(isMagenta(picture.pixel(500, 496))).toBe(false);

      // Interface elements are located in the same coordinates.
      const at = await call('get_ui_element_at', { ...centre, display: 2 });
      expect(at.isError, at.text).toBe(false);
      expect(at.text).toContain('mcpclaude click recorder');
    }, 90_000);

    it('clicks where it aims on the scaled main display', async () => {
      const recorder = await ClickRecorder.start(recorderBinary, path.join(h.root, 'clicks-display-1.jsonl'), { x: Math.round(main.width * 0.4), y: Math.round(main.height * 0.4), width: 360, height: 240 });
      recorders.push(recorder);
      const window = await recorderWindow(recorder);
      expect(window.display).toBe(1);
      const screen = (await call('screenshot')).data?.['screen'] as { width: number; height: number };
      const perPoint = screen.width / main.width;
      console.log(`[computer-use] main display ${main.width}×${main.height} points → ${screen.width}×${screen.height} screenshot`);
      // The window is reported in screenshot pixels: smaller numbers than its size in points.
      expect(Math.abs(window.width - 360 * perPoint)).toBeLessThanOrEqual(1);
      expect(Math.abs(window.x - recorder.content.x * perPoint)).toBeLessThanOrEqual(1);

      const target = { x: Math.round((recorder.content.x + 180) * perPoint), y: Math.round((recorder.content.y + 120) * perPoint) };
      await act('click', target);
      await act('click', { ...target, button: 'right' });
      const events = await eventually('the clicks to arrive', async () => {
        const seen = await recorder.events();
        return seen.length >= 4 ? seen : undefined;
      });
      expect(events.map((event) => `${event.kind} ${event.button}`)).toEqual(['down 0', 'up 0', 'down 1', 'up 1']);
      // A screenshot pixel covers 1/perPoint points; the click lands inside the pixel that was named.
      const tolerance = 1 / perPoint + 0.5;
      for (const event of events) {
        expect(Math.abs(event.x - (recorder.content.x + 180)), JSON.stringify(event)).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(event.y - (recorder.content.y + 120)), JSON.stringify(event)).toBeLessThanOrEqual(tolerance);
      }
      const shot = await call('screenshot', { format: 'png', show_cursor: false });
      const picture = decodePng(Buffer.from(shot.images[0]?.data ?? '', 'base64'));
      expect(isMagenta(picture.pixel(target.x, target.y))).toBe(true);
    }, 90_000);

    it('moves a window from one display to the other', async () => {
      const recorder = recorders[0] as ClickRecorder;
      const before = await recorderWindow(recorder);
      const moved = await act('set_window_bounds', { window_id: before.window_id, x: 200, y: 150 });
      expect(moved.text).toContain('is now at (200, 150)');
      await eventually('the window on the main display', async () => {
        const w = await recorderWindow(recorder);
        return w.display === 1 && w.x === 200 && w.y === 150;
      });
      await act('set_window_bounds', { window_id: before.window_id, x: 640, y: 320, display: 2 });
      const back = await eventually('the window back on the second display', async () => {
        const w = await recorderWindow(recorder);
        return w.display === 2 ? w : undefined;
      });
      expect(back).toMatchObject({ x: 640, y: 320, width: before.width, height: before.height });
    }, 60_000);
  });
});
