import { ToolError } from '../core/errors.js';

export type Modifier = 'cmd' | 'shift' | 'alt' | 'ctrl' | 'fn';

export const MODIFIERS: readonly Modifier[] = ['cmd', 'shift', 'alt', 'ctrl', 'fn'];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  '⌘': 'cmd',
  shift: 'shift',
  '⇧': 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  '⌥': 'alt',
  ctrl: 'ctrl',
  control: 'ctrl',
  '⌃': 'ctrl',
  fn: 'fn',
  function: 'fn',
};

/** macOS virtual key codes of the keys that have a name rather than a character. */
export const NAMED_KEYS: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  spacebar: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  forwarddelete: 117,
  del: 117,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  arrowleft: 123,
  arrowright: 124,
  arrowdown: 125,
  arrowup: 126,
  capslock: 57,
  help: 114,
  insert: 114,
  keypadenter: 76,
  volumeup: 72,
  volumedown: 73,
  mute: 74,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  f13: 105,
  f14: 107,
  f15: 113,
  f16: 106,
  f17: 64,
  f18: 79,
  f19: 80,
  f20: 90,
};

/** Names for characters that are awkward to write inside a combination such as "cmd+plus". */
const CHARACTER_NAMES: Record<string, string> = {
  plus: '+',
  minus: '-',
  hyphen: '-',
  equal: '=',
  equals: '=',
  comma: ',',
  period: '.',
  dot: '.',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  quote: "'",
  apostrophe: "'",
  backtick: '`',
  grave: '`',
  leftbracket: '[',
  rightbracket: ']',
};

/** Key codes of the modifier keys themselves, for holding one down on its own. */
const MODIFIER_KEY_CODES: Record<Modifier, number> = { cmd: 55, shift: 56, alt: 58, ctrl: 59, fn: 63 };

export interface KeyStroke {
  modifiers: Modifier[];
  /** Virtual key code, for named keys. */
  code?: number;
  /** Character the key produces, for everything else; resolved against the keyboard layout on the Mac. */
  char?: string;
  /** Normalised spelling, for messages: "cmd+shift+s". */
  label: string;
}

/** Parse one combination: "cmd+shift+s", "ctrl+alt+delete", "escape", "cmd++", "F5". */
export function parseKeyCombo(input: string): KeyStroke {
  const text = input.trim();
  if (text === '') throw new ToolError('INVALID_ARGUMENT', 'Empty key combination');

  let parts: string[];
  if (text === '+') parts = ['+'];
  else if (text.endsWith('++')) parts = [...text.slice(0, -2).split('+'), '+'];
  else parts = text.split('+');
  parts = parts.map((part) => part.trim());
  if (parts.some((part) => part === '')) throw new ToolError('INVALID_ARGUMENT', `Malformed key combination "${input}"`, 'Write it like "cmd+shift+s".');

  const keyPart = parts[parts.length - 1] as string;
  const modifiers: Modifier[] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (!modifier) {
      throw new ToolError('INVALID_ARGUMENT', `Unknown modifier "${part}" in "${input}"`, 'Modifiers are cmd, shift, alt (option), ctrl and fn; the key comes last.');
    }
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  modifiers.sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));

  const lower = keyPart.toLowerCase();
  const stroke: KeyStroke = { modifiers, label: '' };
  const lone = MODIFIER_ALIASES[lower];
  if (lower in NAMED_KEYS) {
    stroke.code = NAMED_KEYS[lower] as number;
    stroke.label = lower;
  } else if (lower in CHARACTER_NAMES) {
    stroke.char = CHARACTER_NAMES[lower] as string;
    stroke.label = stroke.char;
  } else if ([...keyPart].length === 1) {
    // With a modifier the unshifted key is meant: "cmd+S" is the same shortcut as "cmd+s".
    stroke.char = modifiers.length > 0 ? lower : keyPart;
    stroke.label = stroke.char;
  } else if (lone && [...keyPart].length > 1) {
    // A modifier on its own, e.g. to hold shift while dragging.
    stroke.code = MODIFIER_KEY_CODES[lone];
    stroke.label = lone;
  } else {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `Unknown key "${keyPart}" in "${input}"`,
      `Use a single character or one of: ${Object.keys(NAMED_KEYS).filter((name) => !name.startsWith('arrow')).join(', ')}.`,
    );
  }
  stroke.label = [...modifiers, stroke.label].join('+');
  return stroke;
}

/** Parse a sequence of combinations separated by spaces: "cmd+a cmd+c", "down down return". */
export function parseKeySequence(input: string): KeyStroke[] {
  const combos = input.trim().split(/\s+/).filter(Boolean);
  if (combos.length === 0) throw new ToolError('INVALID_ARGUMENT', 'No keys given');
  return combos.map(parseKeyCombo);
}

/** Normalise a list of modifier names as accepted in tool arguments. */
export function parseModifiers(names: readonly string[] | undefined): Modifier[] {
  const modifiers: Modifier[] = [];
  for (const name of names ?? []) {
    const modifier = MODIFIER_ALIASES[name.trim().toLowerCase()];
    if (!modifier) throw new ToolError('INVALID_ARGUMENT', `Unknown modifier "${name}"`, 'Modifiers are cmd, shift, alt (option), ctrl and fn.');
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return modifiers.sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));
}
