import * as z from 'zod';
import { ToolError } from '../core/errors.js';
import { sleep } from '../core/exec.js';
import type { Desktop } from '../desktop/desktop.js';
import { type HelperCommand, HelperFailure } from '../desktop/helper.js';
import { parseKeySequence, parseModifiers } from '../desktop/keys.js';
import { describeScreenshot, desktopOf, displayParam, finish, modifiersParam, screenshotData, screenshotParam } from './desktop-util.js';
import { type AnyTool, defineTool } from './registry.js';

const xParam = z.number().describe('X coordinate, in pixels of the full screenshot (0 is the left edge).');
const yParam = z.number().describe('Y coordinate, in pixels of the full screenshot (0 is the top edge).');
const buttonParam = z.enum(['left', 'right', 'middle']);

/** One step of desktop input, as accepted by the single-action tools and by computer_actions. */
export interface ActionInput {
  action: 'click' | 'double_click' | 'right_click' | 'mouse_move' | 'mouse_down' | 'mouse_up' | 'drag' | 'scroll' | 'type_text' | 'press_key' | 'key_down' | 'key_up' | 'wait';
  x?: number | undefined;
  y?: number | undefined;
  to_x?: number | undefined;
  to_y?: number | undefined;
  button?: 'left' | 'right' | 'middle' | undefined;
  count?: number | undefined;
  modifiers?: string[] | undefined;
  text?: string | undefined;
  keys?: string | undefined;
  direction?: 'up' | 'down' | 'left' | 'right' | undefined;
  amount?: number | undefined;
  seconds?: number | undefined;
  duration_ms?: number | undefined;
  delay_ms?: number | undefined;
  repeat?: number | undefined;
  hold_ms?: number | undefined;
  /** mouse_move while a button is held (between mouse_down and mouse_up): which button. */
  dragging?: 'left' | 'right' | 'middle' | undefined;
}

interface Planned {
  commands: HelperCommand[];
  /** What the step does, in the past tense, for the result text. */
  summary: string;
  /** Rough time the helper needs for it. */
  durationMs: number;
}

function need<T>(value: T | undefined, action: string, name: string): T {
  if (value === undefined) throw new ToolError('INVALID_ARGUMENT', `"${action}" needs "${name}".`);
  return value;
}

/** Translate one step into helper commands, converting screenshot pixels to display points. */
export async function planAction(desktop: Desktop, input: ActionInput, display: number | undefined): Promise<Planned> {
  const { action } = input;
  const modifiers = parseModifiers(input.modifiers);
  const held = modifiers.length > 0 ? ` holding ${modifiers.join('+')}` : '';
  const at = async (): Promise<{ x: number; y: number }> => desktop.toPoint({ x: need(input.x, action, 'x'), y: need(input.y, action, 'y') }, display);
  const where = `(${input.x}, ${input.y})`;

  switch (action) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      const button = action === 'right_click' ? 'right' : (input.button ?? 'left');
      const count = action === 'double_click' ? 2 : (input.count ?? 1);
      const verb = count === 2 ? 'Double-clicked' : count === 3 ? 'Triple-clicked' : 'Clicked';
      return {
        commands: [{ command: 'mouse_click', params: { ...(await at()), button, count, modifiers } }],
        summary: `${verb}${button === 'left' ? '' : ` the ${button} button`} at ${where}${held}`,
        durationMs: 300 * count,
      };
    }
    case 'mouse_move':
      return {
        commands: [{ command: 'mouse_move', params: { ...(await at()), ...(input.dragging ? { dragging: input.dragging, modifiers } : {}) } }],
        summary: `Moved the pointer to ${where}${input.dragging ? ` with the ${input.dragging} button held` : ''}`,
        durationMs: 100,
      };
    case 'mouse_down':
    case 'mouse_up': {
      const button = input.button ?? 'left';
      return {
        commands: [{ command: action, params: { ...(await at()), button, modifiers } }],
        summary: `${action === 'mouse_down' ? 'Pressed' : 'Released'} the ${button} button at ${where}${held}`,
        durationMs: 150,
      };
    }
    case 'drag': {
      const from = await at();
      const to = await desktop.toPoint({ x: need(input.to_x, action, 'to_x'), y: need(input.to_y, action, 'to_y') }, display);
      const duration = input.duration_ms ?? 600;
      return {
        commands: [{ command: 'mouse_drag', params: { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, button: input.button ?? 'left', duration_ms: duration, modifiers } }],
        summary: `Dragged from ${where} to (${input.to_x}, ${input.to_y})${held}`,
        durationMs: duration + 400,
      };
    }
    case 'scroll': {
      const direction = need(input.direction, action, 'direction');
      const amount = input.amount ?? 5;
      const dy = direction === 'up' ? amount : direction === 'down' ? -amount : 0;
      const dx = direction === 'left' ? amount : direction === 'right' ? -amount : 0;
      return {
        commands: [{ command: 'mouse_scroll', params: { ...(await at()), dx, dy, unit: 'line', modifiers } }],
        summary: `Scrolled ${direction} by ${amount} at ${where}${held}`,
        durationMs: 200 + amount * 10,
      };
    }
    case 'type_text': {
      const text = need(input.text, action, 'text');
      const delay = input.delay_ms ?? 6;
      const shown = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      return {
        commands: [{ command: 'type', params: { text, delay_ms: delay } }],
        summary: `Typed ${JSON.stringify(shown)}${text.length > 60 ? ` (${text.length} characters)` : ''}`,
        durationMs: 200 + text.length * (delay + 4),
      };
    }
    case 'press_key': {
      const strokes = parseKeySequence(need(input.keys, action, 'keys'));
      const repeat = input.repeat ?? 1;
      return {
        commands: strokes.map((stroke) => ({
          command: 'key',
          params: {
            ...(stroke.code !== undefined ? { code: stroke.code } : { char: stroke.char }),
            modifiers: stroke.modifiers,
            repeat,
            ...(input.hold_ms !== undefined ? { hold_ms: input.hold_ms } : {}),
          },
        })),
        summary: `Pressed ${strokes.map((stroke) => stroke.label).join(', ')}${repeat > 1 ? ` ${repeat} times` : ''}`,
        durationMs: strokes.length * repeat * (120 + (input.hold_ms ?? 0)),
      };
    }
    case 'key_down':
    case 'key_up': {
      const strokes = parseKeySequence(need(input.keys, action, 'keys'));
      return {
        commands: strokes.map((stroke) => ({
          command: action,
          params: { ...(stroke.code !== undefined ? { code: stroke.code } : { char: stroke.char }), modifiers: stroke.modifiers },
        })),
        summary: `${action === 'key_down' ? 'Held down' : 'Released'} ${strokes.map((stroke) => stroke.label).join(', ')}`,
        durationMs: 100 * strokes.length,
      };
    }
    case 'wait': {
      const seconds = input.seconds ?? 1;
      return { commands: [{ command: 'sleep', params: { ms: Math.round(seconds * 1000) } }], summary: `Waited ${seconds} s`, durationMs: seconds * 1000 };
    }
  }
}

async function perform(desktop: Desktop, planned: Planned, signal: AbortSignal): Promise<void> {
  await desktop.run(planned.commands, { timeoutMs: 30_000 + planned.durationMs, signal });
}

export function computerTools(): AnyTool[] {
  const screenshot = defineTool({
    name: 'screenshot',
    title: 'Take a screenshot',
    group: 'computer',
    access: 'full',
    desktop: true,
    description: [
      'Capture the screen and return it as an image, with the pointer position and the frontmost application. Look before you act, and after every step that changes the screen.',
      'The full screenshot defines the coordinate system of every mouse tool: x and y are pixels of this image, measured from its top-left corner.',
      'Pass `region` to enlarge part of the screen when text or controls are too small to read; the enlarged picture is for reading only. `window_id` (from list_windows) captures a single window.',
    ].join(' '),
    input: z.object({
      display: displayParam,
      region: z
        .object({
          x: z.number().describe('Left edge of the area, in pixels of the full screenshot.'),
          y: z.number().describe('Top edge of the area, in pixels of the full screenshot.'),
          width: z.number().min(1).describe('Width of the area in pixels of the full screenshot.'),
          height: z.number().min(1).describe('Height of the area in pixels of the full screenshot.'),
        })
        .optional()
        .describe('Area to enlarge instead of capturing the whole display.'),
      window_id: z.number().int().optional().describe('Capture only this window (id from list_windows).'),
      format: z.enum(['jpeg', 'png']).default('jpeg').describe('jpeg is compact and fine for most work; png is lossless, for pixel-exact inspection.'),
      show_cursor: z.boolean().default(true).describe('Draw the mouse pointer into the picture.'),
    }),
    examples: [
      { note: 'Look at the screen.', arguments: {} },
      { note: 'Enlarge the top-left corner to read small text.', arguments: { region: { x: 0, y: 0, width: 400, height: 250 } } },
    ],
    hints: { readOnly: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const shot = await desktop.screenshot({
          ...(args.display !== undefined ? { display: args.display } : {}),
          ...(args.region ? { region: args.region } : {}),
          ...(args.window_id !== undefined ? { windowId: args.window_id } : {}),
          format: args.format,
          cursor: args.show_cursor,
        });
        const lines = [describeScreenshot(shot, args.window_id)];
        const data: Record<string, unknown> = screenshotData(shot);
        const pointer = await desktop.cursor().catch(() => undefined);
        if (pointer) {
          data['pointer'] = pointer;
          lines.push(`Pointer at (${pointer.x}, ${pointer.y})${pointer.display !== shot.display ? ` on display ${pointer.display}` : ''}.`);
        }
        const front = await desktop.call<{ application?: { name?: string; pid?: number }; window?: { title?: string; window_id?: number } }>('frontmost').catch(() => undefined);
        if (front?.application?.name) {
          data['frontmost_application'] = front.application.name;
          if (front.window?.title !== undefined) data['frontmost_window'] = front.window.title;
          lines.push(`Frontmost: ${front.application.name}${front.window?.title ? ` — "${front.window.title}"` : ''}.`);
        }
        return { text: lines.join('\n'), data, images: [{ base64: shot.base64, mimeType: shot.mimeType }] };
      });
    },
  });

  const mouseMove = defineTool({
    name: 'mouse_move',
    title: 'Move the mouse pointer',
    group: 'computer',
    access: 'full',
    desktop: true,
    description: 'Move the mouse pointer to a position without clicking, for example to reveal a tooltip or hover state, or to open a menu that reacts to hovering.',
    input: z.object({ x: xParam, y: yParam, display: displayParam, screenshot: screenshotParam }),
    examples: [{ note: 'Hover over a toolbar button.', arguments: { x: 412, y: 88 } }],
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const planned = await planAction(desktop, { action: 'mouse_move', x: args.x, y: args.y }, args.display);
        await perform(desktop, planned, ctx.signal);
        return finish(desktop, { screenshot: args.screenshot, display: args.display, signal: ctx.signal }, `${planned.summary}.`, { x: args.x, y: args.y });
      });
    },
  });

  const click = defineTool({
    name: 'click',
    title: 'Click the mouse',
    group: 'computer',
    access: 'full',
    desktop: true,
    description: [
      'Click at a position on the screen. Coordinates are pixels of the most recent full screenshot — take one first and aim at the centre of the control.',
      'Use count 2 for a double-click (open a file, select a word) and 3 for a triple-click (select a line); button "right" opens context menus; modifiers give cmd-click, shift-click and so on.',
      'Clicking a window of another application brings that application to the front.',
    ].join(' '),
    input: z.object({
      x: xParam,
      y: yParam,
      button: buttonParam.default('left').describe('Mouse button.'),
      count: z.number().int().min(1).max(3).default(1).describe('1 = click, 2 = double-click, 3 = triple-click.'),
      modifiers: modifiersParam,
      display: displayParam,
      screenshot: screenshotParam,
    }),
    examples: [
      { note: 'Click a button.', arguments: { x: 640, y: 412 } },
      { note: 'Open a context menu.', arguments: { x: 300, y: 220, button: 'right' } },
      { note: 'Double-click a file to open it.', arguments: { x: 180, y: 260, count: 2 } },
    ],
    hints: { destructive: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const planned = await planAction(desktop, { action: 'click', x: args.x, y: args.y, button: args.button, count: args.count, modifiers: args.modifiers }, args.display);
        await perform(desktop, planned, ctx.signal);
        return finish(desktop, { screenshot: args.screenshot, display: args.display, signal: ctx.signal }, `${planned.summary}.`, { x: args.x, y: args.y, button: args.button, count: args.count });
      });
    },
  });

  const drag = defineTool({
    name: 'drag',
    title: 'Drag with the mouse',
    group: 'computer',
    access: 'full',
    desktop: true,
    description: [
      'Press a mouse button at one position, move to another and release: move layers and keyframes, drag files, resize panels, draw, select a range.',
      'The movement is spread over duration_ms; slow it down (1000-2000) for applications that ignore fast drags or for drag-and-drop between windows.',
    ].join(' '),
    input: z.object({
      from_x: z.number().describe('X of the start position, in pixels of the full screenshot.'),
      from_y: z.number().describe('Y of the start position, in pixels of the full screenshot.'),
      to_x: z.number().describe('X of the end position, in pixels of the full screenshot.'),
      to_y: z.number().describe('Y of the end position, in pixels of the full screenshot.'),
      button: buttonParam.default('left').describe('Mouse button held during the drag.'),
      duration_ms: z.number().int().min(50).max(10_000).default(600).describe('Time the movement takes, in milliseconds.'),
      modifiers: modifiersParam,
      display: displayParam,
      screenshot: screenshotParam,
    }),
    examples: [{ note: 'Drag a slider handle 200 pixels to the right.', arguments: { from_x: 400, from_y: 300, to_x: 600, to_y: 300 } }],
    hints: { destructive: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const planned = await planAction(
          desktop,
          { action: 'drag', x: args.from_x, y: args.from_y, to_x: args.to_x, to_y: args.to_y, button: args.button, duration_ms: args.duration_ms, modifiers: args.modifiers },
          args.display,
        );
        await perform(desktop, planned, ctx.signal);
        return finish(desktop, { screenshot: args.screenshot, display: args.display, signal: ctx.signal }, `${planned.summary}.`, {
          from: { x: args.from_x, y: args.from_y },
          to: { x: args.to_x, y: args.to_y },
        });
      });
    },
  });

  const scroll = defineTool({
    name: 'scroll',
    title: 'Scroll',
    group: 'computer',
    access: 'full',
    desktop: true,
    description: [
      'Turn the scroll wheel with the pointer at a position: the view under that position scrolls. "down" moves towards the end of a document, "up" towards its start.',
      'amount is in wheel lines; 5 is a comfortable step, 20-50 moves quickly through long content. Hold modifiers for application-specific behaviour, such as alt or cmd to zoom a timeline.',
    ].join(' '),
    input: z.object({
      x: xParam,
      y: yParam,
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Direction to scroll in.'),
      amount: z.number().int().min(1).max(200).default(5).describe('Number of wheel lines.'),
      modifiers: modifiersParam,
      display: displayParam,
      screenshot: screenshotParam,
    }),
    examples: [{ note: 'Scroll a document down.', arguments: { x: 640, y: 400, direction: 'down', amount: 10 } }],
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const planned = await planAction(desktop, { action: 'scroll', x: args.x, y: args.y, direction: args.direction, amount: args.amount, modifiers: args.modifiers }, args.display);
        await perform(desktop, planned, ctx.signal);
        return finish(desktop, { screenshot: args.screenshot, display: args.display, signal: ctx.signal }, `${planned.summary}.`, { direction: args.direction, amount: args.amount });
      });
    },
  });

  const typeText = defineTool({
    name: 'type_text',
    title: 'Type text',
    group: 'computer',
    access: 'full',
    desktop: true,
    description: [
      'Type text into whatever has keyboard focus, as if on the keyboard. Click the field first (or check get_focused_ui_element) so the text goes where you intend.',
      'Any characters work, including accents, symbols and emoji, whatever the keyboard layout. A newline presses Return and a tab presses Tab. For shortcuts and special keys use press_key instead.',
    ].join(' '),
    input: z.object({
      text: z.string().min(1).max(20_000).describe('Text to type.'),
      delay_ms: z.number().int().min(0).max(500).default(6).describe('Pause between characters in milliseconds; raise it (20-50) for applications that drop fast input.'),
      screenshot: screenshotParam,
    }),
    examples: [
      { note: 'Fill in a field that has focus.', arguments: { text: 'Final_Render_v3' } },
      { note: 'Type a line and confirm it with Return.', arguments: { text: 'echo hello\n' } },
    ],
    hints: { destructive: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const planned = await planAction(desktop, { action: 'type_text', text: args.text, delay_ms: args.delay_ms }, undefined);
        await perform(desktop, planned, ctx.signal);
        return finish(desktop, { screenshot: args.screenshot, signal: ctx.signal }, `${planned.summary}.`, { characters: args.text.length });
      });
    },
  });

  const pressKey = defineTool({
    name: 'press_key',
    title: 'Press keys',
    group: 'computer',
    access: 'full',
    desktop: true,
    description: [
      'Press a key or keyboard shortcut in the frontmost application: "return", "escape", "cmd+s", "cmd+shift+z", "ctrl+alt+left", "f5", "space".',
      'Modifiers are cmd, shift, alt (option), ctrl and fn, joined with "+", the key last. Named keys: return, tab, space, delete, forwarddelete, escape, up, down, left, right, home, end, pageup, pagedown, f1-f20. Anything else is the character on the key ("a", "7", "/", "plus").',
      'Several presses can be given separated by spaces: "cmd+a cmd+c", or "down down return".',
    ].join(' '),
    input: z.object({
      keys: z.string().min(1).max(400).describe('Key or shortcut, or several separated by spaces.'),
      repeat: z.number().int().min(1).max(100).default(1).describe('Press each one this many times.'),
      hold_ms: z.number().int().min(0).max(5000).optional().describe('Keep each key down this long, for applications that need a long press.'),
      screenshot: screenshotParam,
    }),
    examples: [
      { note: 'Save the document.', arguments: { keys: 'cmd+s' } },
      { note: 'Select everything and copy it.', arguments: { keys: 'cmd+a cmd+c' } },
      { note: 'Move five rows down in a list.', arguments: { keys: 'down', repeat: 5 } },
    ],
    hints: { destructive: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const planned = await planAction(desktop, { action: 'press_key', keys: args.keys, repeat: args.repeat, hold_ms: args.hold_ms }, undefined);
        await perform(desktop, planned, ctx.signal);
        return finish(desktop, { screenshot: args.screenshot, signal: ctx.signal }, `${planned.summary}.`, { keys: args.keys, repeat: args.repeat });
      });
    },
  });

  const cursorPosition = defineTool({
    name: 'cursor_position',
    title: 'Get the pointer position',
    group: 'computer',
    access: 'full',
    desktop: true,
    description: 'Report where the mouse pointer is, in pixels of the full screenshot of the display it is on. Useful to confirm that a move arrived, or to find out what the user is pointing at.',
    input: z.object({}),
    examples: [{ arguments: {} }],
    hints: { readOnly: true, idempotent: true },
    async handler(_args, ctx) {
      const desktop = desktopOf(ctx);
      const pointer = await desktop.cursor();
      return { text: `Pointer at (${pointer.x}, ${pointer.y}) on display ${pointer.display}.`, data: { ...pointer } };
    },
  });

  const wait = defineTool({
    name: 'wait',
    title: 'Wait',
    group: 'computer',
    access: 'full',
    desktop: true,
    description: 'Pause while an application loads, renders or animates, then return a screenshot. Prefer short waits followed by a look at the screen over one long guess.',
    input: z.object({
      seconds: z.number().min(0.1).max(60).default(2).describe('How long to wait.'),
      display: displayParam,
      screenshot: screenshotParam,
    }),
    examples: [{ note: 'Give an application three seconds to open a project.', arguments: { seconds: 3 } }],
    hints: { readOnly: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      await sleep(args.seconds * 1000, ctx.signal);
      return desktop.exclusive(() => finish(desktop, { screenshot: args.screenshot, display: args.display, settleMs: 0, signal: ctx.signal }, `Waited ${args.seconds} s.`, { seconds: args.seconds }));
    },
  });

  const computerActions = defineTool({
    name: 'computer_actions',
    title: 'Run several input actions',
    group: 'computer',
    access: 'full',
    desktop: true,
    description: [
      'Carry out a sequence of mouse and keyboard actions in one call, without a round trip between them, and return one screenshot at the end. Use it when you already know every step: click a field, type, press Return; or a careful drag built from mouse_down, mouse_move and mouse_up.',
      'Each step has an `action` and the fields that action needs: click / double_click / right_click / mouse_move / mouse_down / mouse_up (x, y), drag (x, y, to_x, to_y), scroll (x, y, direction, amount), type_text (text), press_key / key_down / key_up (keys), wait (seconds).',
      'The steps stop at the first one that fails; the error says which. Do not chain steps whose positions depend on how the screen changes.',
    ].join(' '),
    input: z.object({
      actions: z
        .array(
          z.object({
            action: z
              .enum(['click', 'double_click', 'right_click', 'mouse_move', 'mouse_down', 'mouse_up', 'drag', 'scroll', 'type_text', 'press_key', 'key_down', 'key_up', 'wait'])
              .describe('What to do in this step.'),
            x: z.number().optional().describe('X in pixels of the full screenshot (start position for drag).'),
            y: z.number().optional().describe('Y in pixels of the full screenshot (start position for drag).'),
            to_x: z.number().optional().describe('drag: X of the end position.'),
            to_y: z.number().optional().describe('drag: Y of the end position.'),
            button: buttonParam.optional().describe('Mouse button (default left).'),
            count: z.number().int().min(1).max(3).optional().describe('click: number of clicks (default 1).'),
            modifiers: modifiersParam,
            text: z.string().max(20_000).optional().describe('type_text: the text to type.'),
            keys: z.string().max(400).optional().describe('press_key, key_down, key_up: key or shortcut such as "cmd+s"; key_down "shift" holds Shift until key_up "shift".'),
            direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('scroll: direction.'),
            amount: z.number().int().min(1).max(200).optional().describe('scroll: wheel lines (default 5).'),
            seconds: z.number().min(0).max(30).optional().describe('wait: how long (default 1).'),
            duration_ms: z.number().int().min(50).max(10_000).optional().describe('drag: time the movement takes (default 600).'),
          }),
        )
        .min(1)
        .max(60)
        .describe('Steps to carry out in order.'),
      display: displayParam,
      screenshot: screenshotParam,
    }),
    examples: [
      {
        note: 'Click a text field, replace its content and confirm.',
        arguments: {
          actions: [
            { action: 'click', x: 520, y: 310 },
            { action: 'press_key', keys: 'cmd+a' },
            { action: 'type_text', text: '1920' },
            { action: 'press_key', keys: 'return' },
          ],
        },
      },
      {
        note: 'Shift-drag in small steps.',
        arguments: {
          actions: [
            { action: 'key_down', keys: 'shift' },
            { action: 'mouse_down', x: 300, y: 400 },
            { action: 'mouse_move', x: 380, y: 400 },
            { action: 'mouse_up', x: 460, y: 400 },
            { action: 'key_up', keys: 'shift' },
          ],
        },
      },
    ],
    hints: { destructive: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const commands: HelperCommand[] = [];
        const owner: number[] = [];
        const summaries: string[] = [];
        let duration = 0;
        let held: 'left' | 'right' | 'middle' | undefined;
        for (const [index, step] of args.actions.entries()) {
          let planned: Planned;
          try {
            planned = await planAction(desktop, step.action === 'mouse_move' ? { ...step, dragging: held } : step, args.display);
          } catch (err) {
            if (err instanceof ToolError) throw new ToolError(err.code, `Step ${index + 1} (${step.action}): ${err.message} Nothing was carried out.`, err.hint);
            throw err;
          }
          if (step.action === 'mouse_down') held = step.button ?? 'left';
          if (step.action === 'mouse_up') held = undefined;
          for (const command of planned.commands) {
            commands.push(command);
            owner.push(index);
          }
          summaries.push(planned.summary);
          duration += planned.durationMs;
        }
        if (duration > 180_000) throw new ToolError('INVALID_ARGUMENT', 'These steps would take longer than three minutes; split them over several calls.');

        try {
          await desktop.run(commands, { timeoutMs: 30_000 + duration, signal: ctx.signal });
        } catch (err) {
          if (err instanceof HelperFailure) {
            const failed = owner[err.index] ?? 0;
            const done = failed === 0 ? 'No step was carried out before it.' : `Steps 1-${failed} were carried out.`;
            throw new ToolError(err.code, `Step ${failed + 1} (${args.actions[failed]?.action}) failed: ${err.message} ${done}`, err.hint);
          }
          throw err;
        }
        const text = summaries.map((summary, index) => `${index + 1}. ${summary}`).join('\n');
        return finish(desktop, { screenshot: args.screenshot, display: args.display, signal: ctx.signal }, text, { steps: summaries.length });
      });
    },
  });

  return [screenshot, mouseMove, click, drag, scroll, typeText, pressKey, cursorPosition, wait, computerActions];
}
