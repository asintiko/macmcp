import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readImageInfo } from '../../src/core/image.js';
import { type CallOutcome, createHarness, type Harness } from '../helpers/harness.js';
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
    // Compile the helper outside the timed steps.
    await h.runtime.desktop?.driver.prepare();
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
      const value = (found.data?.['elements'] as ElementInfo[] | undefined)?.[0]?.value;
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
});
