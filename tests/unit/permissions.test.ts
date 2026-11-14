import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolError } from '../../src/core/errors.js';
import { expandHome, isWithin, PathPolicy, resolveReal } from '../../src/core/permissions.js';

let root: string;
let project: string;
let outside: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-perm-')));
  project = path.join(root, 'project');
  outside = path.join(root, 'outside');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(project, 'src', 'a.txt'), 'inside');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(outside, path.join(project, 'link-to-outside'));
  await symlink(path.join(outside, 'secret.txt'), path.join(project, 'link-to-secret'));
  await symlink(path.join(outside, 'not-there-yet.txt'), path.join(project, 'dangling'));
  await symlink(path.join(project, 'src'), path.join(project, 'link-inside'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('path helpers', () => {
  it('expands ~ only at the start', () => {
    expect(expandHome('~', '/home/u')).toBe('/home/u');
    expect(expandHome('~/x', '/home/u')).toBe('/home/u/x');
    expect(expandHome('a/~/x', '/home/u')).toBe('a/~/x');
    expect(expandHome('~other/x', '/home/u')).toBe('~other/x');
  });

  it('isWithin is not fooled by sibling prefixes', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c')).toBe(true);
    expect(isWithin('/a/b', '/a/bc')).toBe(false);
    expect(isWithin('/a/b', '/a')).toBe(false);
    expect(isWithin('/', '/anything')).toBe(true);
  });

  it('resolves paths whose tail does not exist yet', async () => {
    expect(await resolveReal(path.join(project, 'new', 'deep', 'file.txt'))).toBe(path.join(project, 'new', 'deep', 'file.txt'));
    expect(await resolveReal(path.join(project, 'link-inside', 'new.txt'))).toBe(path.join(project, 'src', 'new.txt'));
  });

  it('follows dangling symlinks instead of treating them as new files', async () => {
    expect(await resolveReal(path.join(project, 'dangling'))).toBe(path.join(outside, 'not-there-yet.txt'));
  });
});

describe('PathPolicy in project mode', () => {
  const policy = (): PathPolicy => new PathPolicy('project', project);

  it('allows paths inside the project, relative or absolute', async () => {
    expect(await policy().authorize('src/a.txt', project)).toBe(path.join(project, 'src', 'a.txt'));
    expect(await policy().authorize(path.join(project, 'src'), project)).toBe(path.join(project, 'src'));
    expect(await policy().authorize('.', project)).toBe(project);
    expect(await policy().authorize('new/file.txt', project)).toBe(path.join(project, 'new', 'file.txt'));
    expect(await policy().authorize('link-inside/a.txt', project)).toBe(path.join(project, 'src', 'a.txt'));
  });

  it.each([
    ['parent traversal', '../outside/secret.txt'],
    ['deep traversal', 'src/../../outside/secret.txt'],
    ['absolute path', '/etc/hosts'],
    ['home directory', '~/.ssh/id_rsa'],
    ['symlinked directory', 'link-to-outside/secret.txt'],
    ['symlinked file', 'link-to-secret'],
    ['dangling symlink', 'dangling'],
    ['new file below a symlinked directory', 'link-to-outside/new.txt'],
    ['project root sibling with same prefix', '../project-other/x'],
  ])('rejects %s', async (_label, input) => {
    const attempt = policy().authorize(input, project);
    await expect(attempt).rejects.toBeInstanceOf(ToolError);
    await expect(attempt).rejects.toMatchObject({ code: 'OUTSIDE_PROJECT' });
  });

  it('can address a symlink itself without following it', async () => {
    const real = await policy().authorize('link-to-secret', project, { followFinal: false });
    expect(real).toBe(path.join(project, 'link-to-secret'));
    // …but not through a symlinked parent.
    await expect(policy().authorize('link-to-outside/secret.txt', project, { followFinal: false })).rejects.toMatchObject({
      code: 'OUTSIDE_PROJECT',
    });
  });

  it('rejects empty paths and NUL bytes', async () => {
    await expect(policy().authorize('', project)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(policy().authorize('a\0b', project)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('contains() reflects the project boundary', () => {
    expect(policy().contains(path.join(project, 'x'))).toBe(true);
    expect(policy().contains(outside)).toBe(false);
  });
});

describe('PathPolicy in full mode', () => {
  it('allows any path and does not resolve symlinks', async () => {
    const policy = new PathPolicy('full', project);
    expect(await policy.authorize('/etc/hosts', project)).toBe('/etc/hosts');
    expect(await policy.authorize('../outside/secret.txt', project)).toBe(path.join(outside, 'secret.txt'));
    expect(await policy.authorize('link-to-secret', project)).toBe(path.join(project, 'link-to-secret'));
    expect(policy.contains('/anywhere')).toBe(true);
  });
});
