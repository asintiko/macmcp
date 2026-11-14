import { constants as fsConstants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { runProgram } from '../core/exec.js';
import { expandHome } from '../core/permissions.js';
import type { Choice, Prompter } from './prompts.js';

export type DirectoryCheck = { ok: true; path: string; warnings: string[] } | { ok: false; reason: string };

/** Directories that are too broad or too sensitive to be a sensible project directory. */
const BROAD_DIRECTORIES = ['/', '/Users', '/home', '/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/Volumes', '/tmp'];

/**
 * Turn what a person typed or dragged into a terminal into an absolute path: trims, removes
 * surrounding quotes, un-escapes "\ " as produced by dragging a folder from Finder, expands ~.
 */
export function normalizePathInput(raw: string, cwd: string, home: string): string {
  let text = raw.trim();
  const quoted = /^(['"])(.*)\1$/.exec(text);
  if (quoted) text = quoted[2] as string;
  else text = text.replace(/\\(.)/g, '$1');
  if (text === '') return '';
  return path.resolve(cwd, expandHome(text, home));
}

/** Check that a path is usable as the project directory and report anything worth a warning. */
export async function validateProjectDirectory(input: string, context: { cwd: string; home: string }): Promise<DirectoryCheck> {
  const absolute = normalizePathInput(input, context.cwd, context.home);
  if (absolute === '') return { ok: false, reason: 'Enter a directory path.' };
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return { ok: false, reason: `Directory does not exist: ${absolute}` };
  }
  const info = await stat(real).catch(() => undefined);
  if (!info?.isDirectory()) return { ok: false, reason: `Not a directory: ${absolute}` };
  try {
    await access(real, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return { ok: false, reason: `You do not have permission to read ${real}` };
  }

  const warnings: string[] = [];
  const writable = await access(real, fsConstants.W_OK).then(
    () => true,
    () => false,
  );
  if (!writable) warnings.push('You cannot write to this directory, so the agent will not be able to change files in it.');
  const homeReal = await realpath(context.home).catch(() => context.home);
  if (real === homeReal) warnings.push('This is your whole home directory: it contains documents, credentials and application data.');
  else if (BROAD_DIRECTORIES.includes(real)) warnings.push('This is a system-wide directory rather than a project.');
  return { ok: true, path: real, warnings };
}

/** Sub-directories of `dir`, sorted, optionally including hidden ones. */
export async function listSubdirectories(dir: string, includeHidden: boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) names.push(entry.name);
    else if (entry.isSymbolicLink()) {
      const target = await stat(path.join(dir, entry.name)).catch(() => undefined);
      if (target?.isDirectory()) names.push(entry.name);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

type BrowseAction = { kind: 'use' } | { kind: 'up' } | { kind: 'enter'; name: string } | { kind: 'hidden' } | { kind: 'type' } | { kind: 'back' };

/** Arrow-key folder browser. Resolves with the chosen directory, or undefined to go back. */
export async function browseDirectories(prompter: Prompter, start: string): Promise<string | 'type' | undefined> {
  let current = start;
  let showHidden = false;
  for (;;) {
    const children = await listSubdirectories(current, showHidden);
    const choices: Choice<BrowseAction>[] = [{ name: `✔ Use this directory (${current})`, value: { kind: 'use' } }];
    if (path.dirname(current) !== current) choices.push({ name: '↑ Parent directory (..)', value: { kind: 'up' } });
    for (const name of children) choices.push({ name: `  ${name}/`, value: { kind: 'enter', name } });
    choices.push(
      { name: showHidden ? '· Hide hidden folders' : '· Show hidden folders', value: { kind: 'hidden' } },
      { name: '· Type a path instead', value: { kind: 'type' } },
      { name: '· Back', value: { kind: 'back' } },
    );
    const action = await prompter.select<BrowseAction>({
      message: `Browse: ${current}${children.length === 0 ? '  (no sub-folders)' : ''}`,
      choices,
      pageSize: 16,
    });
    switch (action.kind) {
      case 'use':
        return current;
      case 'up':
        current = path.dirname(current);
        break;
      case 'enter':
        current = await realpath(path.join(current, action.name)).catch(() => path.join(current, action.name));
        break;
      case 'hidden':
        showHidden = !showHidden;
        break;
      case 'type':
        return 'type';
      case 'back':
        return undefined;
    }
  }
}

/** Native macOS folder dialog. Resolves undefined when cancelled or unavailable. */
export async function chooseWithFinder(): Promise<string | undefined> {
  const script = 'POSIX path of (choose folder with prompt "Choose the project directory for mcpclaude")';
  const result = await runProgram('/usr/bin/osascript', ['-e', script], { timeoutMs: 10 * 60_000 }).catch(() => undefined);
  const chosen = result?.code === 0 ? result.stdout.trim() : '';
  return chosen === '' ? undefined : chosen;
}

export interface PickDirectoryContext {
  cwd: string;
  home: string;
  recent: string[];
  platform: NodeJS.Platform;
  /** Print a line to the terminal (warnings, validation errors). */
  say: (text: string) => void;
  finder?: () => Promise<string | undefined>;
}

type Source = { kind: 'path'; path: string } | { kind: 'browse' } | { kind: 'type' } | { kind: 'finder' };

/**
 * Wizard step 2: let the user pick the project directory from the current directory, recent
 * directories, a folder browser, the Finder dialog, or by typing a path. Always returns a
 * validated, symlink-free path.
 */
export async function pickDirectory(prompter: Prompter, context: PickDirectoryContext): Promise<string> {
  const validateTyped = async (value: string): Promise<true | string> => {
    const check = await validateProjectDirectory(value, context);
    return check.ok ? true : check.reason;
  };
  const accept = async (candidate: string): Promise<string | undefined> => {
    const check = await validateProjectDirectory(candidate, context);
    if (!check.ok) {
      context.say(check.reason);
      return undefined;
    }
    for (const warning of check.warnings) context.say(`Note: ${warning}`);
    if (check.warnings.length > 0 && !(await prompter.confirm({ message: `Use ${check.path} anyway?`, default: false }))) return undefined;
    return check.path;
  };

  for (;;) {
    const choices: Choice<Source>[] = [{ name: `Current directory (${context.cwd})`, value: { kind: 'path', path: context.cwd } }];
    for (const dir of context.recent.filter((d) => d !== context.cwd).slice(0, 5)) {
      choices.push({ name: `Recent: ${dir}`, value: { kind: 'path', path: dir } });
    }
    choices.push({ name: 'Browse folders…', value: { kind: 'browse' } });
    if (context.platform === 'darwin') choices.push({ name: 'Choose in a Finder dialog…', value: { kind: 'finder' } });
    choices.push({ name: 'Type a path…', value: { kind: 'type' } });

    let source = await prompter.select<Source>({ message: 'Which directory should the agent work in?', choices });
    let candidate: string | undefined;
    if (source.kind === 'browse') {
      const browsed = await browseDirectories(prompter, context.cwd);
      if (browsed === 'type') source = { kind: 'type' };
      else candidate = browsed;
    }
    if (source.kind === 'finder') candidate = await (context.finder ?? chooseWithFinder)();
    if (source.kind === 'type') {
      candidate = await prompter.input({ message: 'Path (you can drag a folder into the terminal):', validate: validateTyped });
    }
    if (source.kind === 'path') candidate = source.path;
    if (candidate === undefined) continue;
    const accepted = await accept(candidate);
    if (accepted) return accepted;
  }
}
