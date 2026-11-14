import * as z from 'zod';
import { ToolError } from '../core/errors.js';
import type { Desktop } from '../desktop/desktop.js';
import { type Rect, rectFromShot } from '../desktop/geometry.js';
import { applicationParams, applicationSelector, desktopOf, displayParam, finish, formatRect, screenshotParam } from './desktop-util.js';
import { type AnyTool, defineTool } from './registry.js';
import { renderTable } from './util.js';

interface RawWindow {
  app: string;
  pid: number;
  bundle_id?: string;
  title: string;
  minimized?: boolean;
  main?: boolean;
  focused?: boolean;
  fullscreen?: boolean;
  kind?: string;
  frame?: Rect;
  window_id?: number;
  z?: number;
}

export interface WindowInfo {
  window_id: number | null;
  application: string;
  pid: number;
  title: string;
  /** Position and size in pixels of the full screenshot of `display`. */
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  display: number | null;
  minimized: boolean;
  focused: boolean;
  fullscreen: boolean;
  /** False for minimised windows and windows on another Space. */
  on_screen: boolean;
}

async function describeWindow(desktop: Desktop, raw: RawWindow): Promise<WindowInfo> {
  const frame = raw.frame ? await desktop.fromRect(raw.frame) : undefined;
  return {
    window_id: raw.window_id ?? null,
    application: raw.app,
    pid: raw.pid,
    title: raw.title,
    x: frame?.x ?? null,
    y: frame?.y ?? null,
    width: frame?.width ?? null,
    height: frame?.height ?? null,
    display: frame?.display ?? null,
    minimized: raw.minimized ?? false,
    focused: (raw.main ?? false) || (raw.focused ?? false),
    fullscreen: raw.fullscreen ?? false,
    on_screen: raw.z !== undefined && !(raw.minimized ?? false),
  };
}

function windowLabel(info: WindowInfo): string {
  return `${info.application} — "${info.title}"${info.window_id !== null ? ` (window ${info.window_id})` : ''}`;
}

const windowId = z.number().int().describe('Window id from list_windows.');

export function windowTools(): AnyTool[] {
  const listWindows = defineTool({
    name: 'list_windows',
    title: 'List windows',
    group: 'windows',
    access: 'full',
    desktop: true,
    description: [
      'List the open windows, front to back: id, application, title, position and size, and whether each is minimised, full screen or the focused window of its application.',
      'Positions are in pixels of the full screenshot, so a window can be clicked without looking for it. Use the id with focus_window, set_window_bounds, set_window_state, close_window and screenshot.',
    ].join(' '),
    input: z.object({ ...applicationParams, application: applicationParams.application.describe('Only list windows of this application (name or bundle id). Default: all applications.') }),
    examples: [
      { note: 'Everything that is open.', arguments: {} },
      { note: 'The windows of one application.', arguments: { application: 'Blender' } },
    ],
    hints: { readOnly: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      const { windows: raw, limited } = await desktop.call<{ windows: RawWindow[]; limited: boolean }>('windows', applicationSelector(args));
      const windows = await Promise.all(raw.map((window) => describeWindow(desktop, window)));
      const rows = windows.map((w) => [
        w.window_id === null ? '-' : String(w.window_id),
        w.application,
        w.title.length > 50 ? `${w.title.slice(0, 49)}…` : w.title || '(untitled)',
        w.x === null ? '-' : `(${w.x}, ${w.y}) ${w.width}×${w.height}`,
        [w.focused ? 'focused' : '', w.minimized ? 'minimised' : '', w.fullscreen ? 'full screen' : '', !w.on_screen && !w.minimized ? 'not on this Space' : ''].filter(Boolean).join(', ') || '-',
      ]);
      const lines = [windows.length > 0 ? renderTable(['id', 'application', 'title', 'position and size', 'state'], rows) : 'No windows are open.'];
      if (limited) {
        lines.push('Note: macOS has not granted Accessibility access, so minimised windows are missing, titles may be empty and windows cannot be managed.');
      }
      return { text: lines.join('\n'), data: { windows, limited } };
    },
  });

  const act = async (desktop: Desktop, id: number, action: string, params: Record<string, unknown> = {}): Promise<WindowInfo> =>
    describeWindow(desktop, await desktop.call<RawWindow>('window_action', { window_id: id, action, ...params }));

  const focusWindow = defineTool({
    name: 'focus_window',
    title: 'Bring a window to the front',
    group: 'windows',
    access: 'full',
    desktop: true,
    description: 'Bring one window to the front and give it keyboard focus, activating its application and restoring the window if it is minimised.',
    input: z.object({ window_id: windowId, screenshot: screenshotParam }),
    examples: [{ arguments: { window_id: 4821 } }],
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const info = await act(desktop, args.window_id, 'focus');
        return finish(desktop, { screenshot: args.screenshot, display: info.display ?? undefined, signal: ctx.signal }, `Focused ${windowLabel(info)}.`, { window: info });
      });
    },
  });

  const setWindowBounds = defineTool({
    name: 'set_window_bounds',
    title: 'Move or resize a window',
    group: 'windows',
    access: 'full',
    desktop: true,
    description: [
      'Move a window, resize it, or both. Position and size are in pixels of the full screenshot; give x and y together and width and height together.',
      'Useful to lay out an application predictably before working in it, or to bring an off-screen window back. Applications may enforce a minimum size; the result reports the bounds that were actually applied.',
    ].join(' '),
    input: z.object({
      window_id: windowId,
      x: z.number().optional().describe('New left edge, in pixels of the full screenshot.'),
      y: z.number().optional().describe('New top edge, in pixels of the full screenshot.'),
      width: z.number().min(1).optional().describe('New width, in pixels of the full screenshot.'),
      height: z.number().min(1).optional().describe('New height, in pixels of the full screenshot.'),
      display: displayParam,
      screenshot: screenshotParam,
    }),
    examples: [
      { note: 'Put a window in the top-left corner at a fixed size.', arguments: { window_id: 4821, x: 0, y: 30, width: 1000, height: 700 } },
      { note: 'Only move it.', arguments: { window_id: 4821, x: 200, y: 120 } },
    ],
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      const move = args.x !== undefined || args.y !== undefined;
      const resize = args.width !== undefined || args.height !== undefined;
      if (!move && !resize) throw new ToolError('INVALID_ARGUMENT', 'Give x and y to move the window, width and height to resize it, or all four.');
      if (move && (args.x === undefined || args.y === undefined)) throw new ToolError('INVALID_ARGUMENT', 'Give x and y together.');
      if (resize && (args.width === undefined || args.height === undefined)) throw new ToolError('INVALID_ARGUMENT', 'Give width and height together.');
      return desktop.exclusive(async () => {
        const geometry = await desktop.geometry(args.display);
        const target = rectFromShot(geometry, { x: args.x ?? 0, y: args.y ?? 0, width: args.width ?? 0, height: args.height ?? 0 });
        let info: WindowInfo | undefined;
        // Position first: a window that is partly off screen may refuse its new size.
        if (move) info = await act(desktop, args.window_id, 'move', { x: target.x, y: target.y });
        if (resize) info = await act(desktop, args.window_id, 'resize', { width: target.width, height: target.height });
        const result = info as WindowInfo;
        const bounds = result.x === null ? 'unknown bounds' : formatRect({ x: result.x, y: result.y as number, width: result.width as number, height: result.height as number });
        return finish(desktop, { screenshot: args.screenshot, display: result.display ?? undefined, signal: ctx.signal }, `${windowLabel(result)} is now at ${bounds}.`, { window: result });
      });
    },
  });

  const setWindowState = defineTool({
    name: 'set_window_state',
    title: 'Minimise, restore or full-screen a window',
    group: 'windows',
    access: 'full',
    desktop: true,
    description: 'Change the state of a window: "minimized" sends it to the Dock, "restored" brings a minimised window back, "fullscreen" puts it in its own full-screen Space and "windowed" leaves full screen again (macOS decides where the window lands then: read its position from list_windows before clicking in it).',
    input: z.object({
      window_id: windowId,
      state: z.enum(['minimized', 'restored', 'fullscreen', 'windowed']).describe('State to put the window in.'),
      screenshot: screenshotParam,
    }),
    examples: [{ note: 'Get a window out of the way.', arguments: { window_id: 4821, state: 'minimized' } }],
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      const actions = { minimized: 'minimize', restored: 'restore', fullscreen: 'fullscreen', windowed: 'exit_fullscreen' } as const;
      return desktop.exclusive(async () => {
        const info = await act(desktop, args.window_id, actions[args.state]);
        // Full-screen transitions animate for about a second; the helper waits for them to finish.
        const settleMs = args.state === 'fullscreen' || args.state === 'windowed' ? 1000 : 700;
        let text = `${windowLabel(info)} is now ${args.state === 'minimized' ? 'minimised' : args.state}.`;
        // Not every window can go full screen (dialogs, panels), and macOS does not say no: report what the window says.
        if (args.state === 'fullscreen' && !info.fullscreen) {
          text = `${windowLabel(info)} did not go full screen. Windows such as dialogs and panels cannot; for others the change may still be under way — check list_windows.`;
        } else if (args.state === 'windowed' && info.fullscreen) {
          text = `${windowLabel(info)} is still full screen; the change may be under way — check list_windows.`;
        }
        return finish(desktop, { screenshot: args.screenshot, settleMs, signal: ctx.signal }, text, { window: info });
      });
    },
  });

  const closeWindow = defineTool({
    name: 'close_window',
    title: 'Close a window',
    group: 'windows',
    access: 'full',
    desktop: true,
    description: 'Close a window with its close button. A document with unsaved changes asks what to do in a dialog: look at the screenshot and answer it. The application keeps running.',
    input: z.object({ window_id: windowId, screenshot: screenshotParam }),
    examples: [{ arguments: { window_id: 4821 } }],
    hints: { destructive: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        await desktop.call('window_action', { window_id: args.window_id, action: 'close' });
        return finish(desktop, { screenshot: args.screenshot, settleMs: 600, signal: ctx.signal }, `Pressed the close button of window ${args.window_id}.`, { window_id: args.window_id });
      });
    },
  });

  return [listWindows, focusWindow, setWindowBounds, setWindowState, closeWindow];
}
