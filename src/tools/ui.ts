import * as z from 'zod';
import { ToolError } from '../core/errors.js';
import type { Desktop } from '../desktop/desktop.js';
import { centerOf, type Rect } from '../desktop/geometry.js';
import { applicationParams, applicationSelector, desktopOf, displayParam, finish, screenshotParam } from './desktop-util.js';
import { type AnyTool, defineTool } from './registry.js';

interface RawElement {
  id?: string;
  role: string;
  subrole?: string;
  title?: string;
  description?: string;
  value?: string | number;
  value_length?: number;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  frame?: Rect;
  identifier?: string;
  help?: string;
  placeholder?: string;
  depth?: number;
  children?: number;
  actions?: string[];
  ancestors?: string[];
  application?: string;
  pid?: number;
  note?: string;
  orientation?: 'vertical' | 'horizontal';
  /** The action made the element disappear (a button that closed its dialog). */
  gone?: boolean;
}

export interface ElementInfo {
  element_id: string | null;
  role: string;
  label: string | null;
  value: string | number | null;
  enabled: boolean;
  focused: boolean;
  /** Position and size in pixels of the full screenshot of `display`. */
  frame: Rect | null;
  /** Where to click it. */
  center: { x: number; y: number } | null;
  display: number | null;
  actions?: string[];
  depth?: number;
  help?: string;
  identifier?: string;
  selected?: boolean;
  /** What kind of element it is within its role, e.g. "CloseButton", when it has no label. */
  subrole?: string;
  orientation?: 'vertical' | 'horizontal';
}

const roleName = (role: string): string => role.replace(/^AX/, '');

async function describeElement(desktop: Desktop, raw: RawElement): Promise<ElementInfo> {
  const located = raw.frame && raw.frame.width > 0 && raw.frame.height > 0 ? await desktop.fromRect(raw.frame) : undefined;
  const frame = located ? { x: located.x, y: located.y, width: located.width, height: located.height } : null;
  const info: ElementInfo = {
    element_id: raw.id ?? null,
    role: roleName(raw.role),
    label: raw.title ?? raw.description ?? raw.placeholder ?? null,
    value: raw.value ?? null,
    enabled: raw.enabled !== false,
    focused: raw.focused === true,
    frame,
    center: frame ? centerOf(frame) : null,
    display: located?.display ?? null,
  };
  if (raw.actions) info.actions = raw.actions.map(roleName);
  if (raw.depth !== undefined) info.depth = raw.depth;
  if (raw.help) info.help = raw.help;
  if (raw.identifier) info.identifier = raw.identifier;
  if (raw.selected) info.selected = true;
  if (raw.subrole && info.label === null) info.subrole = roleName(raw.subrole);
  if (raw.orientation) info.orientation = raw.orientation;
  return info;
}

/** One line per element: role, label, value, state, where to click, id. */
function elementLine(info: ElementInfo): string {
  const parts = [info.role];
  if (info.label) parts.push(JSON.stringify(info.label));
  else if (info.subrole) parts.push(`(${info.subrole})`);
  if (info.orientation) parts.push(info.orientation);
  if (info.value !== null && info.value !== '') parts.push(`value=${typeof info.value === 'string' ? JSON.stringify(info.value) : info.value}`);
  if (!info.enabled) parts.push('[disabled]');
  if (info.focused) parts.push('[focused]');
  if (info.selected) parts.push('[selected]');
  if (info.center) parts.push(`@(${info.center.x}, ${info.center.y})`);
  if (info.element_id) parts.push(`id=${info.element_id}`);
  return `${'  '.repeat(info.depth ?? 0)}${parts.join(' ')}`;
}

const scopeParams = {
  ...applicationParams,
  window_id: z.number().int().optional().describe('Only look inside this window (id from list_windows).'),
};

function scopeSelector(args: { application?: string | undefined; pid?: number | undefined; window_id?: number | undefined }): Record<string, unknown> {
  return args.window_id !== undefined ? { window_id: args.window_id } : applicationSelector(args);
}

/** Roles whose value is a number (or an on/off state) rather than text. */
const NUMERIC_ROLES = new Set(['AXSlider', 'AXIncrementor', 'AXCheckBox', 'AXRadioButton', 'AXValueIndicator', 'AXScrollBar', 'AXLevelIndicator', 'AXDisclosureTriangle', 'AXSwitch', 'AXToggle']);

interface MenuItem {
  title: string;
  enabled?: boolean;
  checked?: boolean;
  shortcut?: string;
  submenu?: boolean;
  items?: MenuItem[];
}

function menuLines(items: MenuItem[], depth: number): string[] {
  return items.flatMap((item) => {
    const marks = [item.checked ? '✓' : '', item.submenu ? '▸' : '', item.shortcut ? `(${item.shortcut})` : '', item.enabled === false ? '[disabled]' : ''].filter(Boolean).join(' ');
    return [`${'  '.repeat(depth)}${item.title}${marks ? `  ${marks}` : ''}`, ...menuLines(item.items ?? [], depth + 1)];
  });
}

export function uiTools(): AnyTool[] {
  const findUiElements = defineTool({
    name: 'find_ui_elements',
    title: 'Find interface elements',
    group: 'ui',
    access: 'full',
    desktop: true,
    description: [
      'Search the interface of an application for buttons, fields, checkboxes, menus, tabs and other controls through the macOS Accessibility API, by the text they show and/or their role. Each match comes with its exact position (ready for click) and an element_id for perform_ui_action.',
      'This is more reliable than guessing coordinates from a screenshot, and it finds controls that are hard to see. `text` matches titles, descriptions, values and tooltips, ignoring case. Common roles: Button, TextField, TextArea, CheckBox, RadioButton, PopUpButton, MenuButton, Slider, StaticText, Tab, Row, Image, Link.',
      'Not every application exposes its interface this way (canvases, timelines and custom-drawn panels often do not): fall back to screenshots there.',
    ].join(' '),
    input: z.object({
      text: z.string().optional().describe('Text the element shows or is described by (case-insensitive, partial match).'),
      role: z.string().optional().describe('Kind of element, for example "Button" or "TextField".'),
      ...scopeParams,
      limit: z.number().int().min(1).max(200).default(25).describe('Maximum number of matches.'),
    }),
    examples: [
      { note: 'Find the Export button of the frontmost application.', arguments: { text: 'Export', role: 'Button' } },
      { note: 'List every text field in a window.', arguments: { role: 'TextField', window_id: 4821 } },
    ],
    hints: { readOnly: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      if (!args.text && !args.role) throw new ToolError('INVALID_ARGUMENT', 'Give `text`, `role` or both.');
      const result = await desktop.call<{ application: string; pid: number; elements: RawElement[]; truncated: boolean }>('ui_find', {
        ...scopeSelector(args),
        ...(args.text ? { text: args.text } : {}),
        ...(args.role ? { role: args.role } : {}),
        limit: args.limit,
      });
      const elements = await Promise.all(result.elements.map((raw) => describeElement(desktop, { ...raw, depth: 0 })));
      const header = `${elements.length} element${elements.length === 1 ? '' : 's'} in ${result.application || `pid ${result.pid}`}${result.truncated ? ' (more exist; narrow the search or raise limit)' : ''}:`;
      const text = elements.length > 0 ? [header, ...elements.map(elementLine)].join('\n') : `No matching element in ${result.application || `pid ${result.pid}`}. The application may not expose this part of its interface; check a screenshot.`;
      return { text, data: { application: result.application, pid: result.pid, elements, truncated: result.truncated } };
    },
  });

  const getUiTree = defineTool({
    name: 'get_ui_tree',
    title: 'Outline the interface of an application',
    group: 'ui',
    access: 'full',
    desktop: true,
    description: [
      'Return the interface of an application or window as an indented outline of its controls with labels, values, click positions and element ids. Use it to understand an unfamiliar window or dialog, or to read text that is too small in a screenshot.',
      'Large applications have thousands of elements: start with one window and a small max_depth, then go deeper where needed. Containers without a label are left out unless include_containers is set.',
    ].join(' '),
    input: z.object({
      ...scopeParams,
      max_depth: z.number().int().min(1).max(40).default(8).describe('How many levels below the application or window to descend.'),
      max_elements: z.number().int().min(1).max(2000).default(250).describe('Stop after this many elements.'),
      include_containers: z.boolean().default(false).describe('Also list unlabelled groups, scroll areas and other structural elements.'),
    }),
    examples: [
      { note: 'Outline the frontmost application.', arguments: {} },
      { note: 'Look closely at one dialog.', arguments: { window_id: 4821, max_depth: 12 } },
    ],
    hints: { readOnly: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      const result = await desktop.call<{ application: string; pid: number; elements: RawElement[]; truncated: boolean }>(
        'ui_tree',
        { ...scopeSelector(args), max_depth: args.max_depth, max_elements: args.max_elements, compact: !args.include_containers },
        { timeoutMs: 90_000, signal: ctx.signal },
      );
      const elements = await Promise.all(result.elements.map((raw) => describeElement(desktop, raw)));
      const lines = [`Interface of ${result.application || `pid ${result.pid}`} (${elements.length} elements):`, ...elements.map(elementLine)];
      if (result.truncated) lines.push('… truncated: raise max_depth or max_elements, or look at a single window.');
      return { text: lines.join('\n'), data: { application: result.application, pid: result.pid, elements, truncated: result.truncated } };
    },
  });

  const getUiElementAt = defineTool({
    name: 'get_ui_element_at',
    title: 'Identify the element at a position',
    group: 'ui',
    access: 'full',
    desktop: true,
    description: 'Tell what interface element is at a screen position: its role, label, value, the actions it supports and the elements that contain it. Use it to check what a click would hit, or to get an element_id for something you can see.',
    input: z.object({
      x: z.number().describe('X coordinate, in pixels of the full screenshot.'),
      y: z.number().describe('Y coordinate, in pixels of the full screenshot.'),
      display: displayParam,
    }),
    examples: [{ arguments: { x: 640, y: 412 } }],
    hints: { readOnly: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      const point = await desktop.toPoint({ x: args.x, y: args.y }, args.display);
      const raw = await desktop.call<RawElement>('ui_at', { ...point });
      const info = await describeElement(desktop, raw);
      const lines = [elementLine(info), `Application: ${raw.application ?? `pid ${raw.pid}`}`];
      if (info.actions && info.actions.length > 0) lines.push(`Actions: ${info.actions.join(', ')}`);
      if (raw.ancestors && raw.ancestors.length > 0) lines.push(`Inside: ${raw.ancestors.map((a) => a.replace(/^AX/, '')).join(' < ')}`);
      return { text: lines.join('\n'), data: { ...info, application: raw.application ?? null, pid: raw.pid ?? null, ancestors: raw.ancestors ?? [] } };
    },
  });

  const getFocusedUiElement = defineTool({
    name: 'get_focused_ui_element',
    title: 'Inspect the element with keyboard focus',
    group: 'ui',
    access: 'full',
    desktop: true,
    description: 'Report which interface element has keyboard focus — where typed text will go — including its current text. Use it before typing to confirm the right field is active, and afterwards to read back what was entered.',
    input: z.object({
      max_value_chars: z.number().int().min(20).max(100_000).default(4000).describe('How much of the text of the element to return.'),
    }),
    examples: [{ arguments: {} }],
    hints: { readOnly: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      const raw = await desktop.call<RawElement>('ui_focused', { value_limit: args.max_value_chars });
      const info = await describeElement(desktop, raw);
      const lines = [elementLine(info), `Application: ${raw.application ?? `pid ${raw.pid}`}`];
      if (raw.value_length !== undefined) lines.push(`(value truncated: ${raw.value_length} characters in total)`);
      return { text: lines.join('\n'), data: { ...info, application: raw.application ?? null, pid: raw.pid ?? null } };
    },
  });

  const performUiAction = defineTool({
    name: 'perform_ui_action',
    title: 'Act on an interface element',
    group: 'ui',
    access: 'full',
    desktop: true,
    description: [
      'Operate a control found with find_ui_elements, get_ui_tree or get_ui_element_at, by its element_id. "press" activates buttons, checkboxes and menu items without moving the mouse; "set_value" replaces the content of a text field or sets a slider or checkbox; "focus" gives it keyboard focus; "show_menu" opens its context or pop-up menu.',
      '"click", "double_click" and "right_click" use the real mouse at the centre of the element, for controls that ignore "press". Other actions: increment, decrement, confirm, cancel, raise, select, scroll_to_visible.',
      'Element ids go stale when the interface changes; if one is no longer found, search again.',
    ].join(' '),
    input: z.object({
      element_id: z.string().min(3).describe('Id of the element, as returned by the interface tools.'),
      action: z
        .enum(['press', 'click', 'double_click', 'right_click', 'focus', 'set_value', 'show_menu', 'increment', 'decrement', 'confirm', 'cancel', 'raise', 'select', 'scroll_to_visible'])
        .default('press')
        .describe('What to do with the element.'),
      value: z.string().optional().describe('set_value: the new text; for sliders a number, for checkboxes "1" or "0".'),
      screenshot: screenshotParam,
    }),
    examples: [
      { note: 'Press a button.', arguments: { element_id: '512:0.3.1:AXButton' } },
      { note: 'Replace the content of a text field.', arguments: { element_id: '512:0.2.0:AXTextField', action: 'set_value', value: 'Comp 1' } },
    ],
    hints: { destructive: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const role = args.element_id.split(':')[2] ?? '';
        let raw: RawElement;
        let done: string;
        if (args.action === 'click' || args.action === 'double_click' || args.action === 'right_click') {
          raw = await desktop.call<RawElement>('ui_action', { id: args.element_id, action: 'describe' });
          if (!raw.frame || raw.frame.width <= 0 || raw.frame.height <= 0) {
            throw new ToolError('FAILED', 'This element has no position on screen, so it cannot be clicked.', 'Try action "press", or "scroll_to_visible" first.');
          }
          const point = { x: raw.frame.x + raw.frame.width / 2, y: raw.frame.y + raw.frame.height / 2 };
          await desktop.call('mouse_click', { ...point, button: args.action === 'right_click' ? 'right' : 'left', count: args.action === 'double_click' ? 2 : 1 });
          done = args.action === 'click' ? 'Clicked' : args.action === 'double_click' ? 'Double-clicked' : 'Right-clicked';
        } else if (args.action === 'set_value') {
          if (args.value === undefined) throw new ToolError('INVALID_ARGUMENT', 'set_value needs `value`.');
          let value: string | number = args.value;
          if (NUMERIC_ROLES.has(role)) {
            const text = args.value.trim().toLowerCase();
            const number = text === 'true' || text === 'on' ? 1 : text === 'false' || text === 'off' ? 0 : Number(text);
            if (!Number.isFinite(number) || text === '') throw new ToolError('INVALID_ARGUMENT', `A ${roleName(role)} takes a number, not "${args.value}".`);
            value = number;
          }
          raw = await desktop.call<RawElement>('ui_action', { id: args.element_id, action: 'set_value', value });
          done = 'Set the value of';
        } else {
          raw = await desktop.call<RawElement>('ui_action', { id: args.element_id, action: args.action });
          done = { press: 'Pressed', focus: 'Focused', show_menu: 'Opened the menu of', increment: 'Incremented', decrement: 'Decremented', confirm: 'Confirmed', cancel: 'Cancelled', raise: 'Raised', select: 'Selected', scroll_to_visible: 'Scrolled into view:' }[
            args.action
          ];
        }
        const info = await describeElement(desktop, raw);
        const lines = [`${done} ${elementLine({ ...info, depth: 0 })}`];
        if (raw.note) lines.push(raw.note);
        if (raw.gone) lines.push('The element is no longer part of the interface: the action closed or replaced it.');
        return finish(desktop, { screenshot: args.screenshot, display: info.display ?? undefined, signal: ctx.signal }, lines.join('\n'), { element: info });
      });
    },
  });

  const listMenus = defineTool({
    name: 'list_menus',
    title: 'List the menus of an application',
    group: 'ui',
    access: 'full',
    desktop: true,
    description: [
      'Read the menu bar of an application without opening it: every menu and its items, with keyboard shortcuts, check marks, and which items are disabled right now. The fastest way to find out what an application can do and how a command is called.',
      'With `path` it lists one menu or submenu, e.g. ["File", "Export"]. `depth` controls how many submenu levels are expanded. Applications refresh the disabled state only when a menu opens, so it can be out of date here; select_menu_item checks it properly.',
    ].join(' '),
    input: z.object({
      ...applicationParams,
      path: z.array(z.string()).optional().describe('Menu to list, as the titles leading to it. Default: the whole menu bar.'),
      depth: z.number().int().min(0).max(5).default(1).describe('Submenu levels to expand below the listed menu.'),
    }),
    examples: [
      { note: 'All menus of the frontmost application.', arguments: {} },
      { note: 'What is in File > Export of After Effects?', arguments: { application: 'Adobe After Effects 2025', path: ['File', 'Export'], depth: 2 } },
    ],
    hints: { readOnly: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      const result = await desktop.call<{ application: string; pid: number; path: string[]; items: MenuItem[] }>(
        'menu_list',
        { ...applicationSelector(args), path: args.path ?? [], max_depth: args.depth },
        { timeoutMs: 60_000, signal: ctx.signal },
      );
      const where = result.path.length > 0 ? `${result.application} > ${result.path.join(' > ')}` : `Menu bar of ${result.application}`;
      return { text: [`${where}:`, ...menuLines(result.items, 1)].join('\n'), data: { ...result } };
    },
  });

  const selectMenuItem = defineTool({
    name: 'select_menu_item',
    title: 'Choose a menu item',
    group: 'ui',
    access: 'full',
    desktop: true,
    description: [
      'Choose a command from the menu bar of an application by its path of titles, e.g. ["File", "Save As…"] or ["Composition", "Add to Render Queue"]. More reliable than clicking through menus: no coordinates, no timing.',
      'Titles are matched ignoring case and a trailing "…"; an unambiguous beginning is enough. A disabled item is reported as such rather than chosen. The application should be frontmost for commands that act on the current window.',
    ].join(' '),
    input: z.object({
      path: z.array(z.string().min(1)).min(1).max(8).describe('Titles from the menu bar down to the item.'),
      ...applicationParams,
      screenshot: screenshotParam,
    }),
    examples: [
      { note: 'Save in the frontmost application.', arguments: { path: ['File', 'Save'] } },
      { note: 'Add the active composition to the render queue.', arguments: { application: 'Adobe After Effects 2025', path: ['Composition', 'Add to Render Queue'] } },
    ],
    hints: { destructive: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const result = await desktop.call<{ application: string; selected: string[] }>('menu_select', { ...applicationSelector(args), path: args.path });
        return finish(desktop, { screenshot: args.screenshot, settleMs: 600, signal: ctx.signal }, `Chose ${result.selected.join(' > ')} in ${result.application}.`, { ...result });
      });
    },
  });

  return [findUiElements, getUiTree, getUiElementAt, getFocusedUiElement, performUiAction, listMenus, selectMenuItem];
}
