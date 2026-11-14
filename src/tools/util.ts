import { stat } from 'node:fs/promises';
import { ToolError } from '../core/errors.js';
import type { Runtime } from '../core/runtime.js';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parse `NAME=value` strings into an environment map. */
export function parseEnvList(entries: string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries ?? []) {
    const eq = entry.indexOf('=');
    const name = eq > 0 ? entry.slice(0, eq) : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ToolError('INVALID_ARGUMENT', `Invalid environment entry "${entry}"`, 'Use NAME=value, for example "NODE_ENV=production".');
    }
    env[name] = entry.slice(eq + 1);
  }
  return env;
}

/** Parse `Name: value` strings into HTTP headers. */
export function parseHeaderList(entries: string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of entries ?? []) {
    const colon = entry.indexOf(':');
    const name = colon > 0 ? entry.slice(0, colon).trim() : '';
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new ToolError('INVALID_ARGUMENT', `Invalid header "${entry}"`, 'Use "Name: value", for example "Authorization: Bearer abc".');
    }
    headers[name] = entry.slice(colon + 1).trim();
  }
  return headers;
}

/** Resolve an optional `cwd` argument to an existing, authorised directory. */
export async function resolveDirectory(runtime: Runtime, input: string | undefined): Promise<string> {
  const dir = input === undefined ? runtime.cwd : await runtime.resolvePath(input);
  const info = await stat(dir).catch(() => undefined);
  if (!info) throw new ToolError('NOT_FOUND', `Directory does not exist: ${dir}`);
  if (!info.isDirectory()) throw new ToolError('INVALID_ARGUMENT', `Not a directory: ${dir}`);
  return dir;
}

/** Split a command string into words, honouring single and double quotes. */
export function splitWords(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: string | undefined;
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) current += input[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      current += input[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) words.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
    }
  }
  if (quote) throw new ToolError('INVALID_ARGUMENT', 'Unterminated quote');
  if (started || current) words.push(current);
  return words;
}

/** Quote one word for display in a shell-like command line. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Monospace table with left-aligned columns; the last column is not padded. */
export function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
