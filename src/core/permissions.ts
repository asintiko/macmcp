import { lstat, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ToolError } from './errors.js';

export type PermissionMode = 'project' | 'full';

export const MODE_LABEL: Record<PermissionMode, string> = {
  project: 'Project-Only Access',
  full: 'Full System Access',
};

export function expandHome(input: string, home: string = homedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/')) return path.join(home, input.slice(2));
  return input;
}

export function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(prefix);
}

const MAX_SYMLINK_HOPS = 40;

/**
 * Real path of `target`, tolerating a tail that does not exist yet: the deepest existing
 * ancestor is resolved and the remaining components are appended. Dangling symlinks are
 * followed by hand so that a link pointing outside a directory cannot hide behind ENOENT.
 */
export async function resolveReal(target: string): Promise<string> {
  let current = path.resolve(target);
  const tail: string[] = [];
  let hops = 0;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
    const link = await lstat(current).catch(() => undefined);
    if (link?.isSymbolicLink()) {
      if (++hops > MAX_SYMLINK_HOPS) throw new ToolError('INVALID_ARGUMENT', `Too many symbolic links: ${target}`);
      current = path.resolve(path.dirname(current), await readlink(current));
      continue;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.join(current, ...tail.reverse());
    tail.push(path.basename(current));
    current = parent;
  }
}

export interface AuthorizeOptions {
  /**
   * Whether a symlink in the final component is followed (default true). Pass false for
   * operations that act on the link itself, such as delete, rename or lstat.
   */
  followFinal?: boolean;
}

/**
 * Decides which paths the file tools may touch. In Project-Only mode every path is resolved
 * through symlinks and must stay inside the project directory.
 */
export class PathPolicy {
  readonly mode: PermissionMode;
  /** Real (symlink-free) path of the project directory. */
  readonly projectDir: string;

  constructor(mode: PermissionMode, projectDirReal: string) {
    this.mode = mode;
    this.projectDir = projectDirReal;
  }

  /** Absolute form of a user-supplied path; no filesystem access, no authorisation. */
  absolute(input: string, cwd: string): string {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new ToolError('INVALID_ARGUMENT', 'Path must be a non-empty string');
    }
    if (input.includes('\0')) throw new ToolError('INVALID_ARGUMENT', 'Path contains a NUL byte');
    return path.resolve(cwd, expandHome(input));
  }

  contains(realPath: string): boolean {
    return this.mode === 'full' || isWithin(this.projectDir, realPath);
  }

  /**
   * Resolve a user-supplied path and check it against the mode. Returns the path to operate
   * on: in Project-Only mode the symlink-free path, so later syscalls do not re-traverse links.
   */
  async authorize(input: string, cwd: string, options: AuthorizeOptions = {}): Promise<string> {
    const absolute = this.absolute(input, cwd);
    if (this.mode === 'full') return absolute;

    const followFinal = options.followFinal ?? true;
    const real = followFinal
      ? await resolveReal(absolute)
      : path.join(await resolveReal(path.dirname(absolute)), path.basename(absolute));
    if (!isWithin(this.projectDir, real)) {
      throw new ToolError(
        'OUTSIDE_PROJECT',
        `Path is outside the project directory: ${absolute}${real !== absolute ? ` (resolves to ${real})` : ''}`,
        `This server runs in Project-Only mode. Only paths inside ${this.projectDir} are accessible.`,
      );
    }
    return real;
  }
}
