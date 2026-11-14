import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, cp, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import * as z from 'zod';
import { ToolError } from '../core/errors.js';
import { runProgram } from '../core/exec.js';
import { createGlobMatcher, HEAVY_DIRECTORIES, walk, type WalkState } from '../core/glob.js';
import { fitWithin, IMAGE_MIME, readImageInfo } from '../core/image.js';
import type { Runtime } from '../core/runtime.js';
import { type AnyTool, defineTool } from './registry.js';
import { formatBytes, formatTime } from './util.js';

const MAX_LINE_CHARS = 4000;
const MAX_READ_CHARS = 250_000;
const MAX_SEARCH_FILE_BYTES = 4 * 1024 * 1024;
const MAX_VIEW_SOURCE_BYTES = 200 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 1_200_000;

async function looksBinary(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function requireFile(file: string): Promise<{ size: number }> {
  const info = await stat(file);
  if (info.isDirectory()) throw new ToolError('INVALID_ARGUMENT', `Is a directory: ${file}`, 'Use list_directory for directories.');
  if (!info.isFile()) throw new ToolError('INVALID_ARGUMENT', `Not a regular file: ${file}`);
  return { size: info.size };
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Paths whose deletion is never what anyone wants. */
function protectedPaths(runtime: Runtime): Set<string> {
  return new Set(['/', runtime.home, runtime.projectDir, '/System', '/Users', '/Applications', '/Library', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/Volumes', '/home']);
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.js': 'text/javascript', '.ts': 'text/typescript',
  '.html': 'text/html', '.css': 'text/css', '.py': 'text/x-python', '.sh': 'text/x-shellscript', '.xml': 'application/xml',
  '.yaml': 'application/yaml', '.yml': 'application/yaml', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.exr': 'image/x-exr',
  '.psd': 'image/vnd.adobe.photoshop', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.blend': 'application/x-blender',
  '.aep': 'application/vnd.adobe.aftereffects.project', '.jsx': 'text/javascript',
};

export function guessMime(file: string): string {
  return MIME_BY_EXTENSION[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function fileTools(): AnyTool[] {
  const readFileTool = defineTool({
    name: 'read_file',
    title: 'Read a text file',
    group: 'files',
    access: 'any',
    description: [
      'Read a text file, whole or by line range. The first output line is a bracketed header with the path and the line range; the file content follows unchanged.',
      'Large files are returned in pages: continue with `offset`. Binary files are refused — use view_image for pictures and download_file for other binary data.',
    ].join(' '),
    input: z.object({
      path: z.string().describe('File to read (absolute, ~/…, or relative to the working directory).'),
      offset: z.number().int().min(1).default(1).describe('First line to return (1-based).'),
      limit: z.number().int().min(1).max(20_000).default(2000).describe('Maximum number of lines to return.'),
      line_numbers: z.boolean().default(false).describe('Prefix each line with its line number and a tab.'),
    }),
    examples: [
      { note: 'Read a whole file.', arguments: { path: 'src/index.ts' } },
      { note: 'Read 100 lines of a long log starting at line 5000.', arguments: { path: 'build.log', offset: 5000, limit: 100, line_numbers: true } },
    ],
    hints: { readOnly: true, idempotent: true },
    async handler(args, { runtime }) {
      const file = await runtime.resolvePath(args.path);
      const { size } = await requireFile(file);
      if (await looksBinary(file)) {
        throw new ToolError('INVALID_ARGUMENT', `${file} looks like a binary file (${formatBytes(size)}).`, 'Use view_image for images or download_file for raw bytes.');
      }
      const lines: string[] = [];
      let lineNumber = 0;
      let chars = 0;
      let more = false;
      const stream = createReadStream(file, { encoding: 'utf8' });
      const reader = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const raw of reader) {
        lineNumber += 1;
        if (lineNumber < args.offset) continue;
        if (lines.length >= args.limit || chars >= MAX_READ_CHARS) {
          more = true;
          break;
        }
        const line = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}… [line truncated, ${raw.length} chars]` : raw;
        chars += line.length + 1;
        lines.push(args.line_numbers ? `${String(lineNumber).padStart(6)}\t${line}` : line);
      }
      reader.close();
      stream.destroy();

      const last = args.offset + lines.length - 1;
      const range = lines.length === 0 ? (lineNumber === 0 ? 'empty file' : `no lines at offset ${args.offset} (file has ${lineNumber})`) : `lines ${args.offset}-${last}`;
      const header = `[${file} — ${range}${more ? `; more follow, continue with offset ${last + 1}` : lines.length > 0 ? ' (end of file)' : ''}]`;
      return {
        text: lines.length > 0 ? `${header}\n${lines.join('\n')}` : header,
        data: { path: file, size_bytes: size, first_line: args.offset, lines_returned: lines.length, more },
      };
    },
  });

  const writeFileTool = defineTool({
    name: 'write_file',
    title: 'Write a text file',
    group: 'files',
    access: 'any',
    description: [
      'Create or replace a text file with the given content (UTF-8). Missing parent directories are created.',
      'mode "overwrite" replaces the file, "append" adds to its end, "create" fails if it already exists. For small changes to an existing file prefer edit_file; for binary data use upload_file.',
    ].join(' '),
    input: z.object({
      path: z.string().describe('File to write (absolute, ~/…, or relative to the working directory).'),
      content: z.string().describe('Full text to write.'),
      mode: z.enum(['overwrite', 'append', 'create']).default('overwrite').describe('How to treat an existing file.'),
    }),
    examples: [
      { note: 'Create a new script.', arguments: { path: 'scripts/render.sh', content: '#!/bin/bash\nset -euo pipefail\necho "rendering"\n', mode: 'create' } },
      { note: 'Append a line to a log.', arguments: { path: 'notes.md', content: '- render finished\n', mode: 'append' } },
    ],
    hints: { destructive: true },
    async handler(args, { runtime }) {
      const file = await runtime.resolvePath(args.path);
      await mkdir(path.dirname(file), { recursive: true });
      const existed = await stat(file).then(
        (info) => {
          if (info.isDirectory()) throw new ToolError('INVALID_ARGUMENT', `Is a directory: ${file}`);
          return true;
        },
        () => false,
      );
      if (args.mode === 'append') {
        await appendFile(file, args.content, 'utf8');
      } else {
        try {
          await writeFile(file, args.content, { encoding: 'utf8', flag: args.mode === 'create' ? 'wx' : 'w' });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new ToolError('ALREADY_EXISTS', `File already exists: ${file}`, 'Use mode "overwrite" to replace it or edit_file to change part of it.');
          }
          throw err;
        }
      }
      const bytes = Buffer.byteLength(args.content, 'utf8');
      const action = args.mode === 'append' ? 'Appended' : existed ? 'Overwrote' : 'Created';
      return {
        text: `${action} ${file} (${formatBytes(bytes)}, ${countLines(args.content)} lines${args.mode === 'append' ? ' added' : ''}).`,
        data: { path: file, bytes_written: bytes, created: !existed, mode: args.mode },
      };
    },
  });

  const editFile = defineTool({
    name: 'edit_file',
    title: 'Edit a text file',
    group: 'files',
    access: 'any',
    description: [
      'Replace an exact piece of text in a file. old_text must match the file character for character (including indentation) and must be unique unless replace_all is true.',
      'Read the file first and copy the text to replace from it. To insert, include a neighbouring line in old_text and repeat it in new_text.',
    ].join(' '),
    input: z.object({
      path: z.string().describe('File to edit.'),
      old_text: z.string().min(1).describe('Exact text to find.'),
      new_text: z.string().describe('Text to put in its place (may be empty to delete).'),
      replace_all: z.boolean().default(false).describe('Replace every occurrence instead of requiring exactly one.'),
    }),
    examples: [
      { note: 'Change one setting.', arguments: { path: 'config.json', old_text: '"fps": 24', new_text: '"fps": 30' } },
      { note: 'Rename an identifier everywhere in a file.', arguments: { path: 'src/app.py', old_text: 'old_name', new_text: 'new_name', replace_all: true } },
    ],
    hints: { destructive: true },
    async handler(args, { runtime }) {
      const file = await runtime.resolvePath(args.path);
      await requireFile(file);
      if (await looksBinary(file)) throw new ToolError('INVALID_ARGUMENT', `${file} looks like a binary file; edit_file only works on text.`);
      if (args.old_text === args.new_text) throw new ToolError('INVALID_ARGUMENT', 'old_text and new_text are identical.');
      const original = await readFile(file, 'utf8');
      const occurrences = original.split(args.old_text).length - 1;
      if (occurrences === 0) {
        const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
        const nearMiss = squash(original).includes(squash(args.old_text));
        throw new ToolError(
          'NOT_FOUND',
          `old_text was not found in ${file}.`,
          nearMiss
            ? 'The text exists with different whitespace or line breaks. Read the file and copy the exact characters.'
            : 'Read the file to see its current content; it may have changed.',
        );
      }
      if (occurrences > 1 && !args.replace_all) {
        throw new ToolError(
          'CONFLICT',
          `old_text occurs ${occurrences} times in ${file}.`,
          'Include more surrounding text to make it unique, or set replace_all to true.',
        );
      }
      const updated = args.replace_all ? original.split(args.old_text).join(args.new_text) : original.replace(args.old_text, () => args.new_text);
      await writeFile(file, updated, 'utf8');
      const firstLine = original.slice(0, original.indexOf(args.old_text)).split('\n').length;
      return {
        text: `Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${file} (first at line ${firstLine}).`,
        data: { path: file, replacements: occurrences, first_line: firstLine },
      };
    },
  });

  const listDirectory = defineTool({
    name: 'list_directory',
    title: 'List a directory',
    group: 'files',
    access: 'any',
    description: [
      'List files and folders with type, size and modification time. depth > 1 shows a tree; dependency and VCS folders (node_modules, .git, …) are listed but not expanded.',
      'Hidden entries (names starting with a dot) are skipped unless include_hidden is true.',
    ].join(' '),
    input: z.object({
      path: z.string().default('.').describe('Directory to list. Default: the working directory.'),
      depth: z.number().int().min(1).max(6).default(1).describe('How many levels to descend.'),
      include_hidden: z.boolean().default(false).describe('Include entries whose name starts with a dot.'),
      limit: z.number().int().min(1).max(5000).default(500).describe('Maximum number of entries to return.'),
    }),
    examples: [
      { note: 'List the working directory.', arguments: {} },
      { note: 'Show a two-level tree of a folder including dotfiles.', arguments: { path: 'assets', depth: 2, include_hidden: true } },
    ],
    hints: { readOnly: true, idempotent: true },
    async handler(args, { runtime, signal }) {
      const dir = await runtime.resolvePath(args.path);
      const info = await stat(dir);
      if (!info.isDirectory()) throw new ToolError('INVALID_ARGUMENT', `Not a directory: ${dir}`, 'Use read_file or get_file_info for files.');

      const entries: Record<string, unknown>[] = [];
      const lines: string[] = [];
      let truncated = false;
      for await (const entry of walk(dir, { includeHidden: args.include_hidden, maxDepth: args.depth, signal })) {
        if (entries.length >= args.limit) {
          truncated = true;
          break;
        }
        const details = await lstat(entry.absolute).catch(() => undefined);
        const indent = '  '.repeat(entry.depth - 1);
        if (entry.dirent.isSymbolicLink()) {
          const target = await readlink(entry.absolute).catch(() => '?');
          entries.push({ path: entry.relative, type: 'symlink', target });
          lines.push(`${indent}${entry.dirent.name} -> ${target}`);
        } else if (entry.dirent.isDirectory()) {
          const collapsed = HEAVY_DIRECTORIES.has(entry.dirent.name) && entry.depth < args.depth;
          entries.push({ path: entry.relative, type: 'directory', modified: details?.mtime.toISOString() });
          lines.push(`${indent}${entry.dirent.name}/${collapsed ? '  (not expanded)' : ''}`);
        } else {
          entries.push({ path: entry.relative, type: 'file', size_bytes: details?.size ?? 0, modified: details?.mtime.toISOString() });
          lines.push(`${indent}${entry.dirent.name}  ${formatBytes(details?.size ?? 0)}  ${details ? formatTime(details.mtime) : ''}`.trimEnd());
        }
      }
      const summary = `${dir} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${truncated ? ` (limit reached; raise limit or list sub-directories)` : ''}`;
      return {
        text: [summary, ...(lines.length > 0 ? lines : ['(empty)'])].join('\n'),
        data: { path: dir, entries, truncated },
      };
    },
  });

  const createDirectory = defineTool({
    name: 'create_directory',
    title: 'Create a directory',
    group: 'files',
    access: 'any',
    description: 'Create a directory, including any missing parent directories. Succeeds if the directory already exists.',
    input: z.object({
      path: z.string().describe('Directory to create.'),
    }),
    examples: [{ note: 'Create a nested output folder.', arguments: { path: 'renders/2026-11/final' } }],
    hints: { idempotent: true },
    async handler(args, { runtime }) {
      const dir = await runtime.resolvePath(args.path);
      const existing = await stat(dir).catch(() => undefined);
      if (existing && !existing.isDirectory()) throw new ToolError('ALREADY_EXISTS', `A file with that name exists: ${dir}`);
      await mkdir(dir, { recursive: true });
      return { text: existing ? `Directory already exists: ${dir}` : `Created ${dir}`, data: { path: dir, created: !existing } };
    },
  });

  const movePath = defineTool({
    name: 'move_path',
    title: 'Move or rename',
    group: 'files',
    access: 'any',
    description:
      'Move or rename a file or directory. `destination` is the full new path, not the folder to move into. Fails if the destination exists unless overwrite is true. Missing parent directories of the destination are created.',
    input: z.object({
      source: z.string().describe('Existing file or directory.'),
      destination: z.string().describe('New path, including the new name.'),
      overwrite: z.boolean().default(false).describe('Replace an existing destination.'),
    }),
    examples: [{ note: 'Rename a render output.', arguments: { source: 'out/comp1.mov', destination: 'out/final_v2.mov' } }],
    hints: { destructive: true },
    async handler(args, { runtime }) {
      const source = await runtime.resolvePath(args.source, { followFinal: false });
      const destination = await runtime.resolvePath(args.destination, { followFinal: false });
      await lstat(source);
      if (protectedPaths(runtime).has(source)) throw new ToolError('PERMISSION_DENIED', `Refusing to move ${source}.`);
      const existing = await lstat(destination).catch(() => undefined);
      if (existing && !args.overwrite) {
        throw new ToolError('ALREADY_EXISTS', `Destination already exists: ${destination}`, 'Set overwrite to true to replace it.');
      }
      if (existing) await rm(destination, { recursive: true, force: true });
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await rename(source, destination);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        // Different volume: copy, then remove the original.
        await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
        await rm(source, { recursive: true, force: true });
      }
      return { text: `Moved ${source} -> ${destination}`, data: { source, destination } };
    },
  });

  const copyPath = defineTool({
    name: 'copy_path',
    title: 'Copy a file or directory',
    group: 'files',
    access: 'any',
    description:
      'Copy a file, or a directory with all its contents. `destination` is the full path of the copy. Fails if the destination exists unless overwrite is true. Symbolic links are copied as links.',
    input: z.object({
      source: z.string().describe('Existing file or directory.'),
      destination: z.string().describe('Path of the copy, including its name.'),
      overwrite: z.boolean().default(false).describe('Replace existing files at the destination.'),
    }),
    examples: [{ note: 'Duplicate a project file before changing it.', arguments: { source: 'scene.blend', destination: 'backup/scene_before_edit.blend' } }],
    hints: { destructive: true },
    async handler(args, { runtime }) {
      const source = await runtime.resolvePath(args.source);
      const destination = await runtime.resolvePath(args.destination, { followFinal: false });
      await stat(source);
      const existing = await lstat(destination).catch(() => undefined);
      if (existing && !args.overwrite) {
        throw new ToolError('ALREADY_EXISTS', `Destination already exists: ${destination}`, 'Set overwrite to true to replace it.');
      }
      if (destination === source || destination.startsWith(`${source}${path.sep}`)) {
        throw new ToolError('INVALID_ARGUMENT', 'Cannot copy a directory into itself.');
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true, force: args.overwrite, errorOnExist: !args.overwrite, verbatimSymlinks: true });
      return { text: `Copied ${source} -> ${destination}`, data: { source, destination } };
    },
  });

  const deletePath = defineTool({
    name: 'delete_path',
    title: 'Delete a file or directory',
    group: 'files',
    access: 'any',
    description:
      'Permanently delete a file, symbolic link or directory (it does not go to the Trash). Directories with contents require recursive: true. The project directory itself, the home directory and system directories are refused.',
    input: z.object({
      path: z.string().describe('File or directory to delete.'),
      recursive: z.boolean().default(false).describe('Required to delete a directory that is not empty.'),
    }),
    examples: [
      { note: 'Delete one file.', arguments: { path: 'tmp/scratch.txt' } },
      { note: 'Delete a build folder with everything in it.', arguments: { path: 'build', recursive: true } },
    ],
    hints: { destructive: true },
    async handler(args, { runtime }) {
      const target = await runtime.resolvePath(args.path, { followFinal: false });
      if (protectedPaths(runtime).has(target)) {
        throw new ToolError('PERMISSION_DENIED', `Refusing to delete ${target}.`, 'This path is protected. Delete its contents individually if that is really intended.');
      }
      const info = await lstat(target);
      if (info.isDirectory()) {
        const children = await readdir(target);
        if (children.length > 0 && !args.recursive) {
          throw new ToolError('CONFLICT', `Directory is not empty (${children.length} entries): ${target}`, 'Pass recursive: true to delete it with its contents.');
        }
        await rm(target, { recursive: true });
        return { text: `Deleted directory ${target}${children.length > 0 ? ' and its contents' : ''}.`, data: { path: target, type: 'directory' } };
      }
      await rm(target);
      return { text: `Deleted ${target}.`, data: { path: target, type: info.isSymbolicLink() ? 'symlink' : 'file' } };
    },
  });

  const getFileInfo = defineTool({
    name: 'get_file_info',
    title: 'File or directory details',
    group: 'files',
    access: 'any',
    description:
      'Return metadata for a path: type, size, permissions, timestamps, symlink target, a MIME type guessed from the extension, pixel dimensions for common image formats and the entry count for directories.',
    input: z.object({
      path: z.string().describe('File or directory to inspect.'),
    }),
    examples: [{ note: 'Check that a render exists and how big it is.', arguments: { path: 'out/final.mov' } }],
    hints: { readOnly: true, idempotent: true },
    async handler(args, { runtime }) {
      const target = await runtime.resolvePath(args.path, { followFinal: false });
      const info = await lstat(target);
      const type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
      const data: Record<string, unknown> = {
        path: target,
        type,
        size_bytes: info.size,
        size: formatBytes(info.size),
        permissions: (info.mode & 0o777).toString(8).padStart(3, '0'),
        modified: info.mtime.toISOString(),
        created: info.birthtime.toISOString(),
      };
      if (type === 'symlink') {
        data['target'] = await readlink(target).catch(() => undefined);
        data['target_exists'] = await stat(target).then(
          () => true,
          () => false,
        );
      } else if (type === 'directory') {
        data['entries'] = (await readdir(target).catch(() => [])).length;
      } else if (type === 'file') {
        data['mime_type'] = guessMime(target);
        const handle = await open(target, 'r');
        try {
          const head = Buffer.alloc(Math.min(info.size, 256 * 1024));
          await handle.read(head, 0, head.length, 0);
          const image = readImageInfo(head);
          if (image) Object.assign(data, { mime_type: IMAGE_MIME[image.format], image_width: image.width, image_height: image.height });
        } finally {
          await handle.close();
        }
      }
      return { data };
    },
  });

  const searchFiles = defineTool({
    name: 'search_files',
    title: 'Find files by name',
    group: 'files',
    access: 'any',
    description: [
      'Find files and folders by name with a glob pattern. A pattern without "/" matches the name at any depth ("*.aep"); a pattern with "/" matches the path relative to the search root ("src/**/*.ts").',
      'Supports *, **, ?, [abc] and {a,b}. Dependency and VCS folders (node_modules, .git, …) and hidden entries are skipped unless include_hidden is true.',
    ].join(' '),
    input: z.object({
      pattern: z.string().min(1).describe('Glob pattern, for example "*.blend" or "assets/**/*.{png,jpg}".'),
      path: z.string().default('.').describe('Directory to search in. Default: the working directory.'),
      type: z.enum(['any', 'file', 'directory']).default('any').describe('Restrict results to files or directories.'),
      include_hidden: z.boolean().default(false).describe('Also search hidden entries and dependency/VCS folders.'),
      limit: z.number().int().min(1).max(5000).default(200).describe('Maximum number of results.'),
    }),
    examples: [
      { note: 'Find all After Effects projects below the working directory.', arguments: { pattern: '*.aep' } },
      { note: 'Find TypeScript sources in src.', arguments: { pattern: 'src/**/*.ts', type: 'file' } },
    ],
    hints: { readOnly: true, idempotent: true },
    async handler(args, { runtime, signal }) {
      const root = await runtime.resolvePath(args.path);
      if (!(await stat(root)).isDirectory()) throw new ToolError('INVALID_ARGUMENT', `Not a directory: ${root}`);
      const matches = createGlobMatcher(args.pattern, runtime.platform === 'darwin');
      const state: WalkState = { visited: 0, exhausted: false };
      const results: { path: string; type: string }[] = [];
      let truncated = false;
      for await (const entry of walk(root, { includeHidden: args.include_hidden, includeHeavy: args.include_hidden, signal }, state)) {
        const isDirectory = entry.dirent.isDirectory();
        if (args.type === 'file' && isDirectory) continue;
        if (args.type === 'directory' && !isDirectory) continue;
        if (!matches(entry.relative)) continue;
        if (results.length >= args.limit) {
          truncated = true;
          break;
        }
        results.push({ path: entry.relative, type: isDirectory ? 'directory' : entry.dirent.isSymbolicLink() ? 'symlink' : 'file' });
      }
      const notes = [truncated ? 'limit reached' : '', state.exhausted ? 'search stopped early: too many entries, narrow the path' : ''].filter(Boolean);
      const header = `${results.length} match${results.length === 1 ? '' : 'es'} for "${args.pattern}" in ${root}${notes.length ? ` (${notes.join('; ')})` : ''}`;
      return {
        text: [header, ...results.map((r) => (r.type === 'directory' ? `${r.path}/` : r.path))].join('\n'),
        data: { root, results, truncated: truncated || state.exhausted },
      };
    },
  });

  const searchText = defineTool({
    name: 'search_text',
    title: 'Search file contents',
    group: 'files',
    access: 'any',
    description: [
      'Search the contents of text files (like grep) and return matching lines as path:line: text. The query is literal text unless regex is true.',
      'Use `glob` to restrict which files are searched. Binary files, files over 4 MB, hidden entries and dependency/VCS folders are skipped.',
    ].join(' '),
    input: z.object({
      query: z.string().min(1).describe('Text to search for, or a JavaScript regular expression when regex is true.'),
      path: z.string().default('.').describe('File or directory to search. Default: the working directory.'),
      glob: z.string().optional().describe('Only search files matching this glob, for example "*.py" or "src/**/*.ts".'),
      regex: z.boolean().default(false).describe('Treat query as a regular expression.'),
      case_sensitive: z.boolean().default(false).describe('Match case exactly.'),
      context_lines: z.number().int().min(0).max(10).default(0).describe('Lines of context to show before and after each match.'),
      include_hidden: z.boolean().default(false).describe('Also search hidden entries and dependency/VCS folders.'),
      limit: z.number().int().min(1).max(2000).default(100).describe('Maximum number of matching lines.'),
    }),
    examples: [
      { note: 'Find where a function is used.', arguments: { query: 'renderQueue', glob: '*.jsx' } },
      { note: 'Regex search with context.', arguments: { query: 'TODO|FIXME', regex: true, context_lines: 1, path: 'src' } },
    ],
    hints: { readOnly: true, idempotent: true },
    async handler(args, { runtime, signal }) {
      const root = await runtime.resolvePath(args.path);
      const rootInfo = await stat(root);
      let pattern: RegExp;
      try {
        const source = args.regex ? args.query : args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        pattern = new RegExp(source, args.case_sensitive ? '' : 'i');
      } catch (err) {
        throw new ToolError('INVALID_ARGUMENT', `Invalid regular expression: ${(err as Error).message}`);
      }
      const fileFilter = args.glob ? createGlobMatcher(args.glob, runtime.platform === 'darwin') : undefined;

      const output: string[] = [];
      const matches: { path: string; line: number; text: string }[] = [];
      let filesSearched = 0;
      let truncated = false;
      const state: WalkState = { visited: 0, exhausted: false };

      const searchFile = async (absolute: string, shown: string): Promise<void> => {
        const info = await stat(absolute).catch(() => undefined);
        if (!info?.isFile() || info.size > MAX_SEARCH_FILE_BYTES || info.size === 0) return;
        if (await looksBinary(absolute).catch(() => true)) return;
        filesSearched += 1;
        const lines = (await readFile(absolute, 'utf8')).split('\n');
        // A trailing newline does not start another line.
        if (lines.at(-1) === '') lines.pop();
        let lastPrinted = -1;
        for (let i = 0; i < lines.length; i++) {
          if (!pattern.test(lines[i] as string)) continue;
          if (matches.length >= args.limit) {
            truncated = true;
            return;
          }
          const clip = (s: string): string => (s.length > 300 ? `${s.slice(0, 300)}…` : s);
          matches.push({ path: shown, line: i + 1, text: clip(lines[i] as string) });
          const from = Math.max(lastPrinted + 1, i - args.context_lines);
          const to = Math.min(lines.length - 1, i + args.context_lines);
          if (args.context_lines > 0 && lastPrinted >= 0 && from > lastPrinted + 1) output.push('--');
          for (let j = from; j <= to; j++) {
            output.push(`${shown}:${j + 1}${j === i ? ':' : '-'} ${clip(lines[j] as string)}`);
          }
          lastPrinted = to;
        }
      };

      if (rootInfo.isFile()) {
        await searchFile(root, path.basename(root));
      } else {
        for await (const entry of walk(root, { includeHidden: args.include_hidden, includeHeavy: args.include_hidden, signal }, state)) {
          if (truncated) break;
          if (!entry.dirent.isFile()) continue;
          if (fileFilter && !fileFilter(entry.relative)) continue;
          await searchFile(entry.absolute, entry.relative);
        }
      }
      const notes = [truncated ? 'limit reached' : '', state.exhausted ? 'stopped early: too many entries, narrow the path' : ''].filter(Boolean);
      const header = `${matches.length} matching line${matches.length === 1 ? '' : 's'} in ${filesSearched} file${filesSearched === 1 ? '' : 's'} searched${notes.length ? ` (${notes.join('; ')})` : ''}`;
      return {
        text: [header, ...output].join('\n'),
        data: { root, matches, files_searched: filesSearched, truncated: truncated || state.exhausted },
      };
    },
  });

  const viewImage = defineTool({
    name: 'view_image',
    title: 'Look at an image file',
    group: 'files',
    access: 'any',
    description: [
      'Return an image file as a picture you can see: rendered frames, exported stills, screenshots saved to disk, textures.',
      'PNG, JPEG, GIF and WebP are returned directly when small enough; larger images and other formats (TIFF, PSD, HEIC, EXR, BMP, PDF first page) are converted and scaled down with the macOS image tools.',
    ].join(' '),
    input: z.object({
      path: z.string().describe('Image file to view.'),
      max_dimension: z.number().int().min(64).max(2000).default(1280).describe('Longest edge of the returned picture in pixels; larger images are scaled down.'),
    }),
    examples: [{ note: 'Inspect a rendered frame.', arguments: { path: 'renders/frame_0001.png' } }],
    hints: { readOnly: true, idempotent: true },
    async handler(args, { runtime }) {
      const file = await runtime.resolvePath(args.path);
      const { size } = await requireFile(file);
      if (size > MAX_VIEW_SOURCE_BYTES) throw new ToolError('TOO_LARGE', `${file} is ${formatBytes(size)}; too large to convert.`);

      const head = Buffer.alloc(Math.min(size, 256 * 1024));
      const handle = await open(file, 'r');
      try {
        await handle.read(head, 0, head.length, 0);
      } finally {
        await handle.close();
      }
      const info = readImageInfo(head);
      const fits = info !== undefined && Math.max(info.width, info.height) <= args.max_dimension && size <= MAX_INLINE_IMAGE_BYTES;
      if (info && fits) {
        const bytes = await readFile(file);
        return {
          text: `${file} — ${info.format.toUpperCase()} ${info.width}x${info.height}, ${formatBytes(size)}`,
          data: { path: file, format: info.format, width: info.width, height: info.height, size_bytes: size, converted: false },
          images: [{ base64: bytes.toString('base64'), mimeType: IMAGE_MIME[info.format] }],
        };
      }

      if (runtime.platform !== 'darwin') {
        throw new ToolError(
          info ? 'TOO_LARGE' : 'UNSUPPORTED_PLATFORM',
          info ? `${file} is ${info.width}x${info.height} (${formatBytes(size)}), larger than can be returned as is.` : `Cannot decode ${path.extname(file) || 'this'} files on this host.`,
          'Scaling and format conversion use the macOS image tools.',
        );
      }
      const target = info ? fitWithin(info.width, info.height, args.max_dimension) : undefined;
      const out = path.join(runtime.scratchDir, `view-${randomBytes(6).toString('hex')}.jpg`);
      const resize = target ? ['-z', String(target.height), String(target.width)] : ['-Z', String(args.max_dimension)];
      // The file's content is under the agent's control, so the converter runs under the same confinement as commands.
      const plan = runtime.spawnPlan(['/usr/bin/sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', ...resize, file, '--out', out]);
      try {
        const result = await runProgram(plan.file, plan.args, { env: runtime.commandEnv(), timeoutMs: 60_000 });
        const converted = await readFile(out).catch(() => undefined);
        if (result.code !== 0 || !converted) {
          throw new ToolError('FAILED', `Could not convert ${file}: ${(result.stderr || result.stdout).trim().slice(0, 500) || 'unsupported format'}`);
        }
        const shown = readImageInfo(converted);
        return {
          text: `${file} — ${info ? `${info.format.toUpperCase()} ${info.width}x${info.height}` : path.extname(file).slice(1).toUpperCase() || 'image'}, ${formatBytes(size)}; shown as JPEG ${shown ? `${shown.width}x${shown.height}` : ''}`.trimEnd(),
          data: { path: file, format: info?.format ?? path.extname(file).slice(1).toLowerCase(), width: info?.width, height: info?.height, size_bytes: size, converted: true, shown_width: shown?.width, shown_height: shown?.height },
          images: [{ base64: converted.toString('base64'), mimeType: 'image/jpeg' }],
        };
      } finally {
        await rm(out, { force: true }).catch(() => undefined);
      }
    },
  });

  return [readFileTool, writeFileTool, editFile, listDirectory, createDirectory, movePath, copyPath, deletePath, getFileInfo, searchFiles, searchText, viewImage];
}
