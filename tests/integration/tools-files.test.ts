import { mkdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionMode } from '../../src/core/permissions.js';
import { createHarness, type Harness } from '../helpers/harness.js';
import { makePng, noisyPixel } from '../helpers/png.js';

const onMac = process.platform === 'darwin';
const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

describe.each<PermissionMode>(['full', 'project'])('file tools (%s mode)', (mode) => {
  let h: Harness;
  const inProject = (...parts: string[]): string => path.join(h.projectDir, ...parts);

  beforeAll(async () => {
    h = await createHarness({ mode });
    await writeFile(path.join(h.outsideDir, 'secret.txt'), 'outside-secret');
  });
  afterAll(async () => {
    await h.close();
  });

  it('writes, appends and refuses to clobber in create mode', async () => {
    const created = await h.call('write_file', { path: 'notes/a.txt', content: 'one\ntwo\n', mode: 'create' });
    expect(created.text).toBe(`Created ${inProject('notes', 'a.txt')} (8 B, 2 lines).`);
    expect(created.data).toMatchObject({ created: true, bytes_written: 8 });

    expect((await h.call('write_file', { path: 'notes/a.txt', content: 'x', mode: 'create' })).text).toContain('Error [ALREADY_EXISTS]');
    expect((await h.call('write_file', { path: 'notes/a.txt', content: 'three\n', mode: 'append' })).text).toMatch(/^Appended .*1 lines added/);
    expect(await readFile(inProject('notes', 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect((await h.call('write_file', { path: 'notes/a.txt', content: 'replaced\n' })).text).toMatch(/^Overwrote /);
    expect((await h.call('write_file', { path: 'notes', content: 'x' })).text).toContain('Error [INVALID_ARGUMENT]: Is a directory');
  });

  it('reads whole files, ranges and numbered lines', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    await writeFile(inProject('long.txt'), `${lines.join('\n')}\n`);

    const whole = await h.call('read_file', { path: 'long.txt' });
    expect(whole.text.split('\n')[0]).toBe(`[${inProject('long.txt')} — lines 1-50 (end of file)]`);
    expect(whole.text.split('\n').slice(1)).toEqual(lines);

    const page = await h.call('read_file', { path: 'long.txt', offset: 10, limit: 3, line_numbers: true });
    expect(page.text).toBe(`[${inProject('long.txt')} — lines 10-12; more follow, continue with offset 13]\n    10\tline 10\n    11\tline 11\n    12\tline 12`);
    expect(page.data).toMatchObject({ first_line: 10, lines_returned: 3, more: true });

    expect((await h.call('read_file', { path: 'long.txt', offset: 99 })).text).toContain('no lines at offset 99 (file has 50)');
    await writeFile(inProject('empty.txt'), '');
    expect((await h.call('read_file', { path: 'empty.txt' })).text).toContain('empty file');
  });

  it('refuses binary files, directories and missing files when reading', async () => {
    await writeFile(inProject('blob.bin'), Buffer.from([1, 2, 0, 3, 4]));
    expect((await h.call('read_file', { path: 'blob.bin' })).text).toContain('looks like a binary file');
    expect((await h.call('read_file', { path: '.' })).text).toContain('Error [INVALID_ARGUMENT]: Is a directory');
    expect((await h.call('read_file', { path: 'nope.txt' })).text).toContain('Error [NOT_FOUND]: No such file or directory');
  });

  it('edits text exactly once unless replace_all is set', async () => {
    await writeFile(inProject('edit.txt'), 'alpha = 1\nbeta = 2\nalpha_again = 1\n');
    const one = await h.call('edit_file', { path: 'edit.txt', old_text: 'beta = 2', new_text: 'beta = 20' });
    expect(one.text).toBe(`Replaced 1 occurrence in ${inProject('edit.txt')} (first at line 2).`);

    const ambiguous = await h.call('edit_file', { path: 'edit.txt', old_text: 'alpha', new_text: 'gamma' });
    expect(ambiguous.text).toContain('Error [CONFLICT]: old_text occurs 2 times');
    const all = await h.call('edit_file', { path: 'edit.txt', old_text: 'alpha', new_text: 'gamma', replace_all: true });
    expect(all.data).toMatchObject({ replacements: 2 });
    expect(await readFile(inProject('edit.txt'), 'utf8')).toBe('gamma = 1\nbeta = 20\ngamma_again = 1\n');

    const missing = await h.call('edit_file', { path: 'edit.txt', old_text: 'beta  =  20', new_text: 'x' });
    expect(missing.text).toContain('Error [NOT_FOUND]: old_text was not found');
    expect(missing.text).toContain('different whitespace');
    expect((await h.call('edit_file', { path: 'edit.txt', old_text: 'zzz', new_text: 'x' })).text).toContain('it may have changed');

    // Replacement text is literal: "$&" and "$1" are not special.
    await h.call('edit_file', { path: 'edit.txt', old_text: 'beta = 20', new_text: 'cost = $& $1' });
    expect(await readFile(inProject('edit.txt'), 'utf8')).toContain('cost = $& $1');
  });

  it('lists directories as a tree and skips hidden and dependency folders', async () => {
    await mkdir(inProject('tree', 'src', 'deep'), { recursive: true });
    await mkdir(inProject('tree', 'node_modules', 'pkg'), { recursive: true });
    await writeFile(inProject('tree', 'src', 'main.ts'), 'x');
    await writeFile(inProject('tree', 'src', 'deep', 'util.ts'), 'xx');
    await writeFile(inProject('tree', '.hidden'), 'h');
    await writeFile(inProject('tree', 'node_modules', 'pkg', 'index.js'), 'm');

    const flat = await h.call('list_directory', { path: 'tree' });
    expect(flat.text.split('\n')).toEqual([`${inProject('tree')} — 2 entries`, 'node_modules/', 'src/']);

    const deep = await h.call('list_directory', { path: 'tree', depth: 3, include_hidden: true });
    const rows = deep.text.split('\n').slice(1).map((l) => l.replace(/\s+\d+ B\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, ''));
    expect(rows).toEqual(['.hidden', 'node_modules/  (not expanded)', 'src/', '  deep/', '    util.ts', '  main.ts']);
    expect((deep.data?.['entries'] as { path: string; type: string }[]).find((e) => e.path === 'src/deep/util.ts')).toMatchObject({ type: 'file', size_bytes: 2 });

    const limited = await h.call('list_directory', { path: 'tree', depth: 3, limit: 2 });
    expect(limited.text).toContain('limit reached');
    expect((await h.call('list_directory', { path: 'tree/src/main.ts' })).text).toContain('Error [INVALID_ARGUMENT]: Not a directory');
  });

  it('creates, copies, moves and deletes', async () => {
    expect((await h.call('create_directory', { path: 'ops/a/b' })).text).toBe(`Created ${inProject('ops', 'a', 'b')}`);
    expect((await h.call('create_directory', { path: 'ops/a/b' })).text).toContain('already exists');
    await writeFile(inProject('ops', 'a', 'f.txt'), 'payload');
    expect((await h.call('create_directory', { path: 'ops/a/f.txt' })).text).toContain('Error [ALREADY_EXISTS]');

    expect((await h.call('copy_path', { source: 'ops/a', destination: 'ops/copy' })).isError).toBe(false);
    expect(await readFile(inProject('ops', 'copy', 'f.txt'), 'utf8')).toBe('payload');
    expect((await h.call('copy_path', { source: 'ops/a', destination: 'ops/copy' })).text).toContain('Error [ALREADY_EXISTS]');
    expect((await h.call('copy_path', { source: 'ops/a', destination: 'ops/a/inside' })).text).toContain('Cannot copy a directory into itself');

    expect((await h.call('move_path', { source: 'ops/copy/f.txt', destination: 'ops/moved/renamed.txt' })).isError).toBe(false);
    expect(await exists(inProject('ops', 'copy', 'f.txt'))).toBe(false);
    expect(await readFile(inProject('ops', 'moved', 'renamed.txt'), 'utf8')).toBe('payload');
    expect((await h.call('move_path', { source: 'ops/a/f.txt', destination: 'ops/moved/renamed.txt' })).text).toContain('Error [ALREADY_EXISTS]');
    expect((await h.call('move_path', { source: 'ops/a/f.txt', destination: 'ops/moved/renamed.txt', overwrite: true })).isError).toBe(false);
    expect((await h.call('move_path', { source: 'ops/ghost', destination: 'ops/x' })).text).toContain('Error [NOT_FOUND]');

    expect((await h.call('delete_path', { path: 'ops/moved' })).text).toContain('Error [CONFLICT]: Directory is not empty (1 entries)');
    expect((await h.call('delete_path', { path: 'ops/moved', recursive: true })).text).toContain('and its contents');
    expect(await exists(inProject('ops', 'moved'))).toBe(false);
    expect((await h.call('delete_path', { path: 'ops/a/b' })).text).toMatch(/^Deleted directory .*b\.$/);
    expect((await h.call('delete_path', { path: 'ops/ghost' })).text).toContain('Error [NOT_FOUND]');
  });

  it('refuses to delete or move protected locations', async () => {
    for (const target of ['.', h.projectDir, '/', '~']) {
      const result = await h.call('delete_path', { path: target, recursive: true });
      expect(result.isError, target).toBe(true);
      expect(result.text, target).toMatch(mode === 'project' && (target === '/' || target === '~') ? /OUTSIDE_PROJECT/ : /PERMISSION_DENIED/);
    }
    expect((await h.call('move_path', { source: '.', destination: 'elsewhere' })).isError).toBe(true);
    expect(await exists(h.projectDir)).toBe(true);
  });

  it('deletes a symlink without touching its target', async () => {
    await writeFile(inProject('target.txt'), 'keep me');
    await symlink(inProject('target.txt'), inProject('alias'));
    const info = await h.call('get_file_info', { path: 'alias' });
    expect(info.data).toMatchObject({ type: 'symlink', target: inProject('target.txt'), target_exists: true });
    expect((await h.call('delete_path', { path: 'alias' })).data).toMatchObject({ type: 'symlink' });
    expect(await readFile(inProject('target.txt'), 'utf8')).toBe('keep me');
  });

  it('describes files, directories and images', async () => {
    await writeFile(inProject('pic.png'), makePng(40, 30));
    const image = await h.call('get_file_info', { path: 'pic.png' });
    expect(image.data).toMatchObject({ type: 'file', mime_type: 'image/png', image_width: 40, image_height: 30, permissions: expect.stringMatching(/^[0-7]{3}$/) });
    const dir = await h.call('get_file_info', { path: '.' });
    expect(dir.data).toMatchObject({ type: 'directory', path: h.projectDir });
    expect(dir.data?.['entries']).toBeGreaterThan(3);
    expect((await h.call('get_file_info', { path: 'scene.blend.missing' })).text).toContain('Error [NOT_FOUND]');
  });

  it('finds files by glob', async () => {
    await mkdir(inProject('find', 'a', 'b'), { recursive: true });
    await mkdir(inProject('find', 'node_modules', 'x'), { recursive: true });
    for (const file of ['find/top.aep', 'find/a/one.ts', 'find/a/b/two.ts', 'find/a/b/shot.blend', 'find/node_modules/x/dep.ts', 'find/a/.secret.ts']) {
      await writeFile(inProject(...file.split('/')), 'x');
    }
    const byName = await h.call('search_files', { pattern: '*.ts', path: 'find' });
    expect((byName.data?.['results'] as { path: string }[]).map((r) => r.path)).toEqual(['a/b/two.ts', 'a/one.ts']);
    const byPath = await h.call('search_files', { pattern: 'a/**/*.{ts,blend}', path: 'find' });
    expect((byPath.data?.['results'] as { path: string }[]).map((r) => r.path)).toEqual(['a/b/shot.blend', 'a/b/two.ts', 'a/one.ts']);
    const hidden = await h.call('search_files', { pattern: '*.ts', path: 'find', include_hidden: true });
    expect((hidden.data?.['results'] as { path: string }[]).map((r) => r.path)).toEqual(['a/.secret.ts', 'a/b/two.ts', 'a/one.ts', 'node_modules/x/dep.ts']);
    const dirs = await h.call('search_files', { pattern: '?', path: 'find', type: 'directory' });
    expect(dirs.text.split('\n').slice(1)).toEqual(['a/', 'a/b/']);
    expect((await h.call('search_files', { pattern: '*.ts', path: 'find', limit: 1 })).text).toContain('limit reached');
  });

  it('searches file contents with literal text, regex, context and globs', async () => {
    await mkdir(inProject('grep'), { recursive: true });
    await writeFile(inProject('grep', 'one.jsx'), 'var comp = app.project.items.addComp("Main", 1920, 1080, 1, 10, 30);\n// TODO: add layers\ncomp.openInViewer();\n');
    await writeFile(inProject('grep', 'two.py'), 'import bpy\n# todo later\nbpy.ops.render.render(write_still=True)\n');
    await writeFile(inProject('grep', 'data.bin'), Buffer.from([0, 1, 2, 84, 79, 68, 79]));

    const literal = await h.call('search_text', { query: 'todo', path: 'grep' });
    expect(literal.text.split('\n')).toEqual(['2 matching lines in 2 files searched', 'one.jsx:2: // TODO: add layers', 'two.py:2: # todo later']);
    const sensitive = await h.call('search_text', { query: 'todo', path: 'grep', case_sensitive: true });
    expect(sensitive.data?.['matches']).toHaveLength(1);

    const regex = await h.call('search_text', { query: 'render\\.\\w+\\(', path: 'grep', regex: true, glob: '*.py', context_lines: 1 });
    expect(regex.text.split('\n')).toEqual(['1 matching line in 1 file searched', 'two.py:2- # todo later', 'two.py:3: bpy.ops.render.render(write_still=True)']);
    // Regex metacharacters are literal unless regex is true.
    expect((await h.call('search_text', { query: 'addComp("Main"', path: 'grep' })).data?.['matches']).toHaveLength(1);
    expect((await h.call('search_text', { query: '(unclosed', path: 'grep', regex: true })).text).toContain('Error [INVALID_ARGUMENT]: Invalid regular expression');
    const single = await h.call('search_text', { query: 'bpy', path: 'grep/two.py' });
    expect(single.data?.['matches']).toHaveLength(2);
    expect((await h.call('search_text', { query: 'o', path: 'grep', limit: 1 })).text).toContain('limit reached');
  });

  it('shows small images directly', async () => {
    const png = makePng(64, 48, (x, y) => [x * 4, y * 5, 128]);
    await writeFile(inProject('frame.png'), png);
    const shown = await h.call('view_image', { path: 'frame.png' });
    expect(shown.isError).toBe(false);
    expect(shown.text).toMatch(/frame\.png — PNG 64x48, [\d.]+ (B|KB)$/);
    expect(shown.images).toEqual([{ mimeType: 'image/png', data: png.toString('base64') }]);
    expect((await h.call('view_image', { path: 'long.txt' })).isError).toBe(true);
  });

  it('scales down large images (macOS) or says why it cannot (elsewhere)', async () => {
    await writeFile(inProject('big.png'), makePng(900, 600, noisyPixel));
    const shown = await h.call('view_image', { path: 'big.png', max_dimension: 300 });
    if (onMac) {
      expect(shown.isError, shown.text).toBe(false);
      expect(shown.text).toContain('shown as JPEG 300x200');
      expect(shown.images[0]?.mimeType).toBe('image/jpeg');
      expect(Buffer.from(shown.images[0]?.data ?? '', 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(shown.data).toMatchObject({ converted: true, width: 900, height: 600, shown_width: 300, shown_height: 200 });
    } else {
      expect(shown.text).toContain('Error [TOO_LARGE]: ');
    }
  });

  if (mode === 'project') {
    it.each([
      ['read_file', { path: '../outside/secret.txt' }],
      ['read_file', { path: '/etc/hosts' }],
      ['read_file', { path: '~/.ssh/id_rsa' }],
      ['write_file', { path: '../outside/planted.txt', content: 'x' }],
      ['edit_file', { path: '../outside/secret.txt', old_text: 'outside', new_text: 'x' }],
      ['list_directory', { path: '..' }],
      ['list_directory', { path: '/' }],
      ['create_directory', { path: '../outside/newdir' }],
      ['move_path', { source: 'long.txt', destination: '../outside/long.txt' }],
      ['move_path', { source: '../outside/secret.txt', destination: 'stolen.txt' }],
      ['copy_path', { source: '../outside/secret.txt', destination: 'stolen.txt' }],
      ['copy_path', { source: 'long.txt', destination: '/tmp/mcpclaude-escape.txt' }],
      ['delete_path', { path: '../outside/secret.txt' }],
      ['get_file_info', { path: '../outside/secret.txt' }],
      ['search_files', { pattern: '*', path: '..' }],
      ['search_text', { query: 'secret', path: '../outside' }],
      ['view_image', { path: '../outside/secret.txt' }],
    ])('%s cannot reach outside the project: %j', async (tool, args) => {
      const result = await h.call(tool, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Error [OUTSIDE_PROJECT]');
      expect(result.text).not.toContain('outside-secret');
    });

    it('does not follow symlinks out of the project', async () => {
      await symlink(h.outsideDir, inProject('escape-dir'));
      await symlink(path.join(h.outsideDir, 'secret.txt'), inProject('escape-file'));
      await symlink(path.join(h.outsideDir, 'created-through-link.txt'), inProject('escape-dangling'));

      expect((await h.call('read_file', { path: 'escape-dir/secret.txt' })).text).toContain('Error [OUTSIDE_PROJECT]');
      expect((await h.call('read_file', { path: 'escape-file' })).text).toContain('Error [OUTSIDE_PROJECT]');
      expect((await h.call('write_file', { path: 'escape-dangling', content: 'x' })).text).toContain('Error [OUTSIDE_PROJECT]');
      expect((await h.call('write_file', { path: 'escape-dir/new.txt', content: 'x' })).text).toContain('Error [OUTSIDE_PROJECT]');
      expect((await h.call('copy_path', { source: 'escape-file', destination: 'copy-of-secret.txt' })).text).toContain('Error [OUTSIDE_PROJECT]');
      expect(await exists(path.join(h.outsideDir, 'created-through-link.txt'))).toBe(false);
      expect(await exists(path.join(h.outsideDir, 'new.txt'))).toBe(false);

      // Listings and searches report links but never walk through them.
      const listed = await h.call('list_directory', { path: '.', depth: 3 });
      expect(listed.text).toContain(`escape-dir -> ${h.outsideDir}`);
      const listedPaths = (listed.data?.['entries'] as { path: string }[]).map((e) => e.path);
      expect(listedPaths).toContain('escape-dir');
      expect(listedPaths.filter((p) => p.startsWith('escape-dir/'))).toEqual([]);
      expect((await h.call('search_text', { query: 'outside-secret' })).data?.['matches']).toEqual([]);

      // The links themselves can be removed; their targets stay.
      expect((await h.call('delete_path', { path: 'escape-file' })).isError).toBe(false);
      expect(await readFile(path.join(h.outsideDir, 'secret.txt'), 'utf8')).toBe('outside-secret');
      // Copying a directory keeps inner links as links instead of copying what they point to.
      await mkdir(inProject('with-link'));
      await symlink(path.join(h.outsideDir, 'secret.txt'), inProject('with-link', 'inner'));
      expect((await h.call('copy_path', { source: 'with-link', destination: 'with-link-copy' })).isError).toBe(false);
      expect(await readlink(inProject('with-link-copy', 'inner'))).toBe(path.join(h.outsideDir, 'secret.txt'));
    });
  } else {
    it('can read and write anywhere the user can', async () => {
      expect((await h.call('read_file', { path: '../outside/secret.txt' })).text).toContain('outside-secret');
      expect((await h.call('write_file', { path: path.join(h.outsideDir, 'made.txt'), content: 'made' })).isError).toBe(false);
      expect(await readFile(path.join(h.outsideDir, 'made.txt'), 'utf8')).toBe('made');
      expect((await h.call('list_directory', { path: h.outsideDir })).text).toContain('secret.txt');
    });
  }
});
