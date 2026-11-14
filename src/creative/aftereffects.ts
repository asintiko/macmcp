import { constants as fsConstants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../core/errors.js';
import type { Runtime } from '../core/runtime.js';

/** An After Effects installation, in Adobe's layout: a folder holding the application and aerender. */
export interface AfterEffectsInstall {
  /** Application name as AppleScript addresses it: "Adobe After Effects 2025". */
  name: string;
  /** Path of the .app bundle. */
  app: string;
  /** Path of the command-line renderer, if it is installed next to the application. */
  aerender?: string;
  /** Release year from the name; 0 when the name has none. */
  year: number;
  beta: boolean;
}

/** What the ExtendScript wrapper reports. */
export interface ScriptReply {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Line of the user's code where the error was raised. */
  line?: number;
  log?: string[];
  /** After Effects version, e.g. "25.1x2". */
  version?: string;
  /** Path of the open project; null for an unsaved project. */
  project?: string | null;
}

const NAME_PATTERN = /^Adobe After Effects.*$/i;

async function isExecutable(file: string): Promise<boolean> {
  return access(file, fsConstants.X_OK).then(
    () => true,
    () => false,
  );
}

function describe(name: string, app: string, aerender: string | undefined): AfterEffectsInstall {
  return { name, app, ...(aerender ? { aerender } : {}), year: Number(/\b(20\d\d)\b/.exec(name)?.[1] ?? 0), beta: /beta/i.test(name) };
}

/** After Effects installations on this Mac, newest release first, betas last. */
export async function findAfterEffects(runtime: Runtime): Promise<AfterEffectsInstall[]> {
  const installs: AfterEffectsInstall[] = [];
  for (const root of ['/Applications', path.join(runtime.home, 'Applications')]) {
    for (const entry of (await readdir(root).catch(() => [])).filter((name) => NAME_PATTERN.test(name))) {
      const full = path.join(root, entry);
      if (entry.endsWith('.app')) {
        installs.push(describe(entry.slice(0, -4), full, undefined));
        continue;
      }
      if (!(await stat(full).catch(() => undefined))?.isDirectory()) continue;
      const apps = (await readdir(full).catch(() => [])).filter((name) => NAME_PATTERN.test(name) && name.endsWith('.app') && !/render engine/i.test(name));
      const aerender = path.join(full, 'aerender');
      for (const app of apps) installs.push(describe(app.slice(0, -4), path.join(full, app), (await isExecutable(aerender)) ? aerender : undefined));
    }
  }
  return installs.sort((a, b) => Number(a.beta) - Number(b.beta) || b.year - a.year || a.name.localeCompare(b.name));
}

/** The command-line renderer to use: MCPCLAUDE_AERENDER, or the one of the chosen (default: newest) installation. */
export async function requireAerender(runtime: Runtime, application?: string): Promise<{ aerender: string; install?: AfterEffectsInstall }> {
  const override = runtime.env['MCPCLAUDE_AERENDER']?.trim();
  if (override) {
    if (await isExecutable(override)) return { aerender: path.resolve(override) };
    throw new ToolError('DEPENDENCY_MISSING', `MCPCLAUDE_AERENDER points to ${override}, which is not an executable file.`);
  }
  const installs = await findAfterEffects(runtime);
  const wanted = application?.trim().toLowerCase().replace(/\.app$/, '');
  const chosen = wanted ? installs.filter((install) => install.name.toLowerCase() === wanted || install.name.toLowerCase().endsWith(` ${wanted}`)) : installs;
  if (wanted && chosen.length === 0) {
    throw new ToolError('NOT_FOUND', `No After Effects installation named "${application}".`, installs.length > 0 ? `Installed: ${installs.map((install) => install.name).join(', ')}.` : undefined);
  }
  const install = chosen.find((candidate) => candidate.aerender);
  if (!install?.aerender) {
    throw new ToolError(
      'DEPENDENCY_MISSING',
      installs.length === 0 ? 'Adobe After Effects is not installed on this Mac (nothing matching "Adobe After Effects" in /Applications).' : 'The After Effects installation has no aerender next to the application.',
      'Rendering needs a licensed After Effects installation. Alternatively render from the running application: add the composition to the render queue and start it with after_effects_run_script (app.project.renderQueue.render()).',
    );
  }
  return { aerender: install.aerender, install };
}

/** A string literal that ExtendScript (ES3) and AppleScript-embedded code can read: ASCII only. */
export function jsStringLiteral(text: string): string {
  let out = '"';
  for (const unit of text.split('')) {
    const code = unit.charCodeAt(0);
    if (unit === '"') out += '\\"';
    else if (unit === '\\') out += '\\\\';
    else if (unit === '\n') out += '\\n';
    else if (unit === '\r') out += '\\r';
    else if (unit === '\t') out += '\\t';
    else if (code < 32 || code > 126) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += unit;
  }
  return `${out}"`;
}

/**
 * Wrap user ExtendScript so that its value, an exception or collected log lines come back as
 * one ASCII JSON string — the return value of DoScriptFile, which osascript prints.
 *
 * The code runs through eval inside a function: its value is the value of the last statement,
 * `var` declarations stay local to the call, and a helper `log(...)` is in scope.
 * ExtendScript is ECMAScript 3: no JSON object, no Array.prototype.map, no trailing commas.
 */
export function buildScriptWrapper(code: string, options: { undoGroup?: string | undefined } = {}): string {
  const undo = options.undoGroup?.trim();
  return `(function () {
  var __logs = [];
  function __quote(text) {
    var out = '"', i, unit, code, hex;
    text = String(text);
    for (i = 0; i < text.length; i++) {
      unit = text.charAt(i);
      code = text.charCodeAt(i);
      if (unit === '"') { out += '\\\\"'; }
      else if (unit === '\\\\') { out += '\\\\\\\\'; }
      else if (code < 32 || code > 126) {
        hex = code.toString(16);
        while (hex.length < 4) { hex = '0' + hex; }
        out += '\\\\u' + hex;
      } else { out += unit; }
    }
    return out + '"';
  }
  function __kind(value) {
    try { if (value.reflect && value.reflect.name) { return String(value.reflect.name); } } catch (ignore) {}
    return '';
  }
  function __json(value, depth) {
    var kind = typeof value, parts = [], key, i, name, described;
    if (value === null || value === undefined) { return 'null'; }
    if (kind === 'number') { return isFinite(value) ? String(value) : 'null'; }
    if (kind === 'boolean') { return value ? 'true' : 'false'; }
    if (kind === 'string') { return __quote(value); }
    if (depth > 6) { return __quote(String(value)); }
    if (value instanceof Array) {
      for (i = 0; i < value.length && i < 2000; i++) { parts.push(__json(value[i], depth + 1)); }
      return '[' + parts.join(',') + ']';
    }
    name = __kind(value);
    if (kind === 'object' && (name === '' || name === 'Object')) {
      for (key in value) {
        if (value.hasOwnProperty(key) && typeof value[key] !== 'function') { parts.push(__quote(key) + ':' + __json(value[key], depth + 1)); }
      }
      return '{' + parts.join(',') + '}';
    }
    if (name === 'File' || name === 'Folder') { return __quote(value.fsName); }
    // Application objects (CompItem, AVLayer, Property and so on): what they are and what they are called.
    described = '{"type":' + __quote(name || kind);
    try { if (value.name !== undefined) { described += ',"name":' + __quote(value.name); } } catch (ignore1) {}
    try { if (typeof value.id === 'number') { described += ',"id":' + value.id; } } catch (ignore2) {}
    try { if (typeof value.index === 'number') { described += ',"index":' + value.index; } } catch (ignore3) {}
    return described + '}';
  }
  function log() {
    var words = [], i;
    for (i = 0; i < arguments.length; i++) { words.push(typeof arguments[i] === 'string' ? arguments[i] : __json(arguments[i], 0)); }
    __logs.push(words.join(' '));
  }
  var __reply = { ok: true, result: null };
  var __source = ${jsStringLiteral(code)};
  try {
    ${undo ? `app.beginUndoGroup(${jsStringLiteral(undo)});` : ''}
    try {
      __reply.result = eval(__source);
    } finally {
      ${undo ? 'app.endUndoGroup();' : ''}
    }
  } catch (error) {
    __reply = { ok: false, error: String(error && error.message !== undefined ? (error.name ? error.name + ': ' : '') + error.message : error) };
    try { if (typeof error.line === 'number') { __reply.line = error.line; } } catch (ignore4) {}
  }
  __reply.log = __logs;
  try { __reply.version = String(app.version); } catch (ignore5) {}
  try { __reply.project = app.project && app.project.file ? app.project.file.fsName : null; } catch (ignore6) {}
  return __json(__reply, 0);
})();
`;
}

/** AppleScript that runs a .jsx file in After Effects and returns the script's value. */
export function buildAppleScript(application: string, scriptFile: string, timeoutSeconds: number): string {
  const quote = (text: string): string => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    `with timeout of ${Math.ceil(timeoutSeconds) + 5} seconds`,
    `  tell application ${quote(application)}`,
    `    DoScriptFile ${quote(scriptFile)}`,
    '  end tell',
    'end timeout',
  ].join('\n');
}

/** Parse the JSON string the wrapper returned through osascript. */
export function parseScriptReply(stdout: string): ScriptReply | undefined {
  const text = stdout.trim();
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start)) as ScriptReply;
    return typeof parsed.ok === 'boolean' ? parsed : undefined;
  } catch {
    return undefined;
  }
}
