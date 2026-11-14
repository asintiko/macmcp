import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Translate a glob into a regular expression over POSIX-style relative paths.
 * Supports `*`, `**`, `?`, `[abc]`, `[!abc]` and `{a,b}`.
 */
export function globToRegExp(pattern: string, caseInsensitive = false): RegExp {
  let source = '';
  let braceDepth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const atSegmentStart = i === 0 || pattern[i - 1] === '/';
        i += 1;
        if (atSegmentStart && pattern[i + 1] === '/') {
          // "**/" matches zero or more whole directories.
          i += 1;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 2);
      if (close === -1) {
        source += '\\[';
      } else {
        let body = pattern.slice(i + 1, close);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        source += `[${body.replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else if (ch === '{') {
      braceDepth += 1;
      source += '(?:';
    } else if (ch === '}' && braceDepth > 0) {
      braceDepth -= 1;
      source += ')';
    } else if (ch === ',' && braceDepth > 0) {
      source += '|';
    } else {
      source += ch.replace(/[.+^$()|\\{}]/g, '\\$&');
    }
  }
  if (braceDepth > 0) source += ')'.repeat(braceDepth);
  return new RegExp(`^${source}$`, caseInsensitive ? 'i' : '');
}

/** A matcher for file search: patterns without a slash match the file name at any depth. */
export function createGlobMatcher(pattern: string, caseInsensitive = false): (relativePath: string) => boolean {
  const normalized = pattern.replace(/^\.\//, '');
  const regex = globToRegExp(normalized, caseInsensitive);
  if (!normalized.includes('/')) return (relativePath) => regex.test(path.posix.basename(relativePath));
  return (relativePath) => regex.test(relativePath);
}

/** Directories that are almost never what a search is looking for. */
export const HEAVY_DIRECTORIES = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.next', '.turbo', 'DerivedData']);

export interface WalkEntry {
  /** POSIX-style path relative to the walk root. */
  relative: string;
  absolute: string;
  dirent: Dirent;
  depth: number;
}

export interface WalkOptions {
  includeHidden?: boolean;
  /** Descend into node_modules, .git and similar. */
  includeHeavy?: boolean;
  maxDepth?: number;
  /** Stop after visiting this many entries. */
  maxVisited?: number;
  signal?: AbortSignal;
}

export interface WalkState {
  visited: number;
  /** True when the walk stopped early because of maxVisited. */
  exhausted: boolean;
}

/**
 * Depth-first walk in sorted order. Symbolic links are reported but never followed, so a
 * walk cannot leave the tree it started in.
 */
export async function* walk(root: string, options: WalkOptions = {}, state: WalkState = { visited: 0, exhausted: false }): AsyncGenerator<WalkEntry> {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const maxVisited = options.maxVisited ?? 200_000;

  async function* visit(dir: string, relativeDir: string, depth: number): AsyncGenerator<WalkEntry> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directories are skipped
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of entries) {
      if (options.signal?.aborted || state.exhausted) return;
      if (!options.includeHidden && dirent.name.startsWith('.')) continue;
      if (++state.visited > maxVisited) {
        state.exhausted = true;
        return;
      }
      const relative = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
      const absolute = path.join(dir, dirent.name);
      yield { relative, absolute, dirent, depth };
      if (dirent.isDirectory() && depth < maxDepth && (options.includeHeavy || !HEAVY_DIRECTORIES.has(dirent.name))) {
        yield* visit(absolute, relative, depth + 1);
      }
    }
  }

  yield* visit(root, '', 1);
}
