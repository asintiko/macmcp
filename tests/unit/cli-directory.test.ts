import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browseDirectories, listSubdirectories, normalizePathInput, pickDirectory, validateProjectDirectory } from '../../src/cli/directory.js';
import { ScriptedPrompter } from '../helpers/cli.js';

const isRoot = process.getuid?.() === 0;

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-dir-')));
  home = path.join(root, 'home');
  project = path.join(home, 'code', 'my project');
  await mkdir(path.join(project, 'src', 'deep'), { recursive: true });
  await mkdir(path.join(project, 'assets'));
  await mkdir(path.join(project, '.git'));
  await writeFile(path.join(project, 'README.md'), 'hello');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('normalizePathInput', () => {
  it('handles what people type, paste or drag into a terminal', () => {
    expect(normalizePathInput('  /a/b  ', '/cwd', '/home/me')).toBe('/a/b');
    expect(normalizePathInput('sub/dir', '/cwd', '/home/me')).toBe('/cwd/sub/dir');
    expect(normalizePathInput('~', '/cwd', '/home/me')).toBe('/home/me');
    expect(normalizePathInput('~/Projects/x', '/cwd', '/home/me')).toBe('/home/me/Projects/x');
    // Finder drag-and-drop escapes spaces; copy-as-pathname quotes.
    expect(normalizePathInput('/Users/me/My\\ Project\\ \\(v2\\)', '/cwd', '/home/me')).toBe('/Users/me/My Project (v2)');
    expect(normalizePathInput("'/Users/me/My Project'", '/cwd', '/home/me')).toBe('/Users/me/My Project');
    expect(normalizePathInput('"~/My Project"', '/cwd', '/home/me')).toBe('/home/me/My Project');
    expect(normalizePathInput('   ', '/cwd', '/home/me')).toBe('');
  });
});

describe('validateProjectDirectory', () => {
  const check = (input: string): ReturnType<typeof validateProjectDirectory> => validateProjectDirectory(input, { cwd: project, home });

  it('accepts an existing directory and returns its real path', async () => {
    expect(await check(project)).toEqual({ ok: true, path: project, warnings: [] });
    expect(await check('src')).toEqual({ ok: true, path: path.join(project, 'src'), warnings: [] });
    expect(await check('~/code/my\\ project')).toEqual({ ok: true, path: project, warnings: [] });

    await symlink(project, path.join(root, 'link'));
    expect(await check(path.join(root, 'link'))).toEqual({ ok: true, path: project, warnings: [] });
  });

  it('rejects empty input, missing paths and files', async () => {
    expect(await check('')).toEqual({ ok: false, reason: 'Enter a directory path.' });
    expect(await check('nope')).toEqual({ ok: false, reason: `Directory does not exist: ${path.join(project, 'nope')}` });
    expect(await check('README.md')).toEqual({ ok: false, reason: `Not a directory: ${path.join(project, 'README.md')}` });
  });

  it('warns about the home directory and system-wide directories', async () => {
    const whole = await check('~');
    expect(whole).toMatchObject({ ok: true, path: home });
    expect(whole.ok && whole.warnings.join(' ')).toContain('whole home directory');

    const system = await validateProjectDirectory('/', { cwd: project, home });
    expect(system.ok && system.warnings.join(' ')).toContain('system-wide directory');
    const temp = await validateProjectDirectory('/tmp', { cwd: project, home });
    expect(temp.ok && temp.warnings.join(' ')).toContain('system-wide directory');
  });

  it.skipIf(isRoot)('warns about read-only directories and rejects unreadable ones', async () => {
    const readOnly = path.join(root, 'read-only');
    const locked = path.join(root, 'locked');
    await mkdir(readOnly, { mode: 0o555 });
    await mkdir(locked, { mode: 0o000 });
    try {
      const result = await check(readOnly);
      expect(result.ok && result.warnings.join(' ')).toContain('cannot write to this directory');
      expect(await check(locked)).toEqual({ ok: false, reason: `You do not have permission to read ${locked}` });
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

describe('listSubdirectories', () => {
  it('lists folders in order, hides dot-folders unless asked, and follows links to folders', async () => {
    await symlink(path.join(project, 'src'), path.join(project, 'linked'));
    await symlink(path.join(project, 'README.md'), path.join(project, 'readme-link'));
    expect(await listSubdirectories(project, false)).toEqual(['assets', 'linked', 'src']);
    expect(await listSubdirectories(project, true)).toEqual(['.git', 'assets', 'linked', 'src']);
    expect(await listSubdirectories(path.join(project, 'nope'), false)).toEqual([]);
  });
});

describe('browseDirectories', () => {
  it('walks down and up the tree and returns the chosen folder', async () => {
    const prompter = new ScriptedPrompter([{ select: 'src/' }, { select: 'deep/' }, { select: 'Parent directory' }, { select: 'Parent directory' }, { select: 'assets/' }, { select: 'Use this directory' }]);
    expect(await browseDirectories(prompter, project)).toBe(path.join(project, 'assets'));
    expect(prompter.asked.map((a) => a.message)).toEqual([
      `Browse: ${project}`,
      `Browse: ${path.join(project, 'src')}`,
      `Browse: ${path.join(project, 'src', 'deep')}  (no sub-folders)`,
      `Browse: ${path.join(project, 'src')}`,
      `Browse: ${project}`,
      `Browse: ${path.join(project, 'assets')}  (no sub-folders)`,
    ]);
    expect(prompter.asked[0]?.choices).toEqual([
      `✔ Use this directory (${project})`,
      '↑ Parent directory (..)',
      '  assets/',
      '  src/',
      '· Show hidden folders',
      '· Type a path instead',
      '· Back',
    ]);
  });

  it('can reveal hidden folders, switch to typing, or go back', async () => {
    const hidden = new ScriptedPrompter([{ select: 'Show hidden folders' }, { select: '.git/' }, { select: 'Use this directory' }]);
    expect(await browseDirectories(hidden, project)).toBe(path.join(project, '.git'));
    expect(hidden.asked[1]?.choices).toContain('· Hide hidden folders');

    expect(await browseDirectories(new ScriptedPrompter([{ select: 'Type a path instead' }]), project)).toBe('type');
    expect(await browseDirectories(new ScriptedPrompter([{ select: 'Back' }]), project)).toBeUndefined();
  });

  it('offers no parent at the filesystem root', async () => {
    const prompter = new ScriptedPrompter([{ select: 'Back' }]);
    await browseDirectories(prompter, '/');
    expect(prompter.asked[0]?.choices).not.toContain('↑ Parent directory (..)');
  });
});

describe('pickDirectory', () => {
  const context = (overrides: Partial<Parameters<typeof pickDirectory>[1]> = {}): Parameters<typeof pickDirectory>[1] & { said: string[] } => {
    const said: string[] = [];
    return { cwd: project, home, recent: [], platform: 'linux', say: (text) => said.push(text), said, ...overrides };
  };

  it('offers the current directory first', async () => {
    const prompter = new ScriptedPrompter([{ select: 'Current directory' }]);
    expect(await pickDirectory(prompter, context())).toBe(project);
    expect(prompter.asked[0]).toMatchObject({
      message: 'Which directory should the agent work in?',
      choices: [`Current directory (${project})`, 'Browse folders…', 'Type a path…'],
    });
  });

  it('lists recent directories (not the current one, five at most) and the Finder dialog on macOS', async () => {
    const recent = [project, ...['a', 'b', 'c', 'd', 'e', 'f'].map((n) => path.join(root, n))];
    await mkdir(path.join(root, 'b'));
    const prompter = new ScriptedPrompter([{ select: `Recent: ${path.join(root, 'b')}` }]);
    expect(await pickDirectory(prompter, context({ recent, platform: 'darwin' }))).toBe(path.join(root, 'b'));
    expect(prompter.asked[0]?.choices).toEqual([
      `Current directory (${project})`,
      ...['a', 'b', 'c', 'd', 'e'].map((n) => `Recent: ${path.join(root, n)}`),
      'Browse folders…',
      'Choose in a Finder dialog…',
      'Type a path…',
    ]);
  });

  it('asks again when a recent directory no longer exists', async () => {
    const gone = path.join(root, 'gone');
    const ctx = context({ recent: [gone] });
    const prompter = new ScriptedPrompter([{ select: 'Recent:' }, { select: 'Current directory' }]);
    expect(await pickDirectory(prompter, ctx)).toBe(project);
    expect(ctx.said).toEqual([`Directory does not exist: ${gone}`]);
  });

  it('validates a typed path until it is usable', async () => {
    const prompter = new ScriptedPrompter([{ select: 'Type a path' }, { input: '' }, { input: 'missing' }, { input: 'README.md' }, { input: '~/code/my\\ project/src' }]);
    expect(await pickDirectory(prompter, context())).toBe(path.join(project, 'src'));
    expect(prompter.asked[1]?.errors).toEqual(['Enter a directory path.', `Directory does not exist: ${path.join(project, 'missing')}`, `Not a directory: ${path.join(project, 'README.md')}`]);
  });

  it('browses folders, including the detour through typing', async () => {
    const browse = new ScriptedPrompter([{ select: 'Browse folders' }, { select: 'src/' }, { select: 'Use this directory' }]);
    expect(await pickDirectory(browse, context())).toBe(path.join(project, 'src'));

    const detour = new ScriptedPrompter([{ select: 'Browse folders' }, { select: 'Type a path instead' }, { input: 'assets' }]);
    expect(await pickDirectory(detour, context())).toBe(path.join(project, 'assets'));

    const back = new ScriptedPrompter([{ select: 'Browse folders' }, { select: 'Back' }, { select: 'Current directory' }]);
    expect(await pickDirectory(back, context())).toBe(project);
  });

  it('uses the Finder dialog and returns to the menu when it is cancelled', async () => {
    const answers = [undefined, `${path.join(project, 'assets')}/`];
    const prompter = new ScriptedPrompter([{ select: 'Finder' }, { select: 'Finder' }]);
    const chosen = await pickDirectory(prompter, context({ platform: 'darwin', finder: async () => answers.shift() }));
    expect(chosen).toBe(path.join(project, 'assets'));
    expect(prompter.unused).toBe(0);
  });

  it('asks for confirmation before accepting a risky directory', async () => {
    const ctx = context({ cwd: home });
    const prompter = new ScriptedPrompter([{ select: 'Current directory' }, { confirm: false }, { select: 'Type a path' }, { input: project }]);
    expect(await pickDirectory(prompter, ctx)).toBe(project);
    expect(ctx.said).toEqual(['Note: This is your whole home directory: it contains documents, credentials and application data.']);
    expect(prompter.asked[1]).toMatchObject({ kind: 'confirm', message: `Use ${home} anyway?` });

    const accept = new ScriptedPrompter([{ select: 'Current directory' }, { confirm: true }]);
    expect(await pickDirectory(accept, context({ cwd: home }))).toBe(home);
  });
});
