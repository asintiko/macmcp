import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSeatbeltProfile, detectToolchainDirs, prepareSandbox, sandboxArgv, SANDBOX_EXEC } from '../../src/core/sandbox.js';

describe('Seatbelt profile', () => {
  const profile = buildSeatbeltProfile({
    projectDir: '/Users/me/My Project',
    readWriteDirs: ['/Users/me/.mcpclaude/sandbox'],
    readOnlyDirs: ['/Users/me/.nvm/versions/node/v24.0.0', '/Users/me/.pyenv'],
    readOnlyFiles: ['/Users/me/.gitconfig'],
  });

  it('denies by default and never interpolates paths into the profile text', () => {
    expect(profile.profile).toMatch(/^\(version 1\)\n\(deny default\)/);
    expect(profile.profile).not.toContain('/Users/me');
    expect(profile.defines).toEqual([
      '-DPROJECT=/Users/me/My Project',
      '-DRW_0=/Users/me/.mcpclaude/sandbox',
      '-DRO_0=/Users/me/.nvm/versions/node/v24.0.0',
      '-DRO_1=/Users/me/.pyenv',
      '-DROF_0=/Users/me/.gitconfig',
    ]);
  });

  it('allows writes only to the project, the scratch area and device nodes', () => {
    const writes = /\(allow file-write\*\n([\s\S]*?)\)\n\(allow file-ioctl/.exec(profile.profile)?.[1] ?? '';
    expect(writes).toContain('(subpath (param "PROJECT"))');
    expect(writes).toContain('(subpath (param "RW_0"))');
    expect(writes).not.toContain('RO_0');
    expect(writes).not.toContain('"/private/tmp"');
    expect(writes).not.toContain('"/usr"');
  });

  it('allows reading toolchains but not the home directory or shared temp', () => {
    const reads = /\(allow file-read\*\n([\s\S]*?)\)\n\n; writes/.exec(profile.profile)?.[1] ?? '';
    for (const expected of ['(subpath "/usr")', '(subpath "/System")', '(subpath (param "RO_1"))', '(literal (param "ROF_0"))']) {
      expect(reads).toContain(expected);
    }
    expect(reads).not.toContain('"/Users"');
    expect(reads).not.toContain('"/private/tmp"');
    expect(reads).not.toContain('"/Volumes"');
  });

  it('keeps escape routes closed', () => {
    for (const forbidden of ['appleevent-send', 'lsopen', 'job-creation', 'user-preference', '(allow default)', 'com.apple.pasteboard', 'com.apple.coreservices.appleevents']) {
      expect(profile.profile).not.toContain(forbidden);
    }
    expect(profile.profile).toContain('(deny file-write-unlink (require-all (literal (param "PROJECT")) (vnode-type DIRECTORY)))');
  });

  it('has balanced parentheses', () => {
    let depth = 0;
    for (const ch of profile.profile.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/;.*$/gm, '')) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('wraps a command line', () => {
    const { file, args } = sandboxArgv(profile, ['/bin/zsh', '-c', 'echo hi']);
    expect(file).toBe(SANDBOX_EXEC);
    expect(args.slice(0, 2)).toEqual(['-p', profile.profile]);
    expect(args.slice(-4)).toEqual(['--', '/bin/zsh', '-c', 'echo hi']);
  });
});

describe('toolchain detection', () => {
  let home: string;
  let elsewhere: string;

  beforeAll(async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-sbx-')));
    home = path.join(root, 'home');
    elsewhere = path.join(root, 'elsewhere');
    for (const dir of [
      '.nvm/versions/node/v24.0.0/bin',
      '.nvm/versions/node/v24.0.0/lib',
      '.cargo/bin',
      '.cargo/registry',
      '.local/bin',
      '.local/lib',
      '.local/share/secrets',
      '.pyenv/shims',
      'Documents',
      'tools/bin',
    ]) {
      await mkdir(path.join(home, dir), { recursive: true });
    }
    await mkdir(path.join(elsewhere, 'bin'), { recursive: true });
    await writeFile(path.join(home, '.gitconfig'), '[user]\nname = Test\n');
  });
  afterAll(async () => {
    await rm(path.dirname(home), { recursive: true, force: true });
  });

  it('opens toolchain prefixes but not directories with mixed user data', async () => {
    const env = {
      PATH: [
        path.join(home, '.nvm/versions/node/v24.0.0/bin'),
        path.join(home, '.cargo/bin'),
        path.join(home, '.local/bin'),
        path.join(home, 'tools/bin'),
        path.join(elsewhere, 'bin'),
        home,
        '/usr/bin',
        path.join(home, 'does-not-exist/bin'),
      ].join(path.delimiter),
    };
    const dirs = await detectToolchainDirs(env, home);
    expect(dirs).toContain(path.join(home, '.nvm'));
    expect(dirs).toContain(path.join(home, '.cargo/bin'));
    expect(dirs).toContain(path.join(home, '.local/bin'));
    expect(dirs).toContain(path.join(home, '.pyenv'));
    expect(dirs).toContain(path.join(home, 'tools/bin'));
    for (const forbidden of [home, path.join(home, '.cargo'), path.join(home, '.local'), path.join(home, 'Documents'), path.join(elsewhere, 'bin'), '/usr/bin']) {
      expect(dirs).not.toContain(forbidden);
    }
    // Nested entries are folded into their listed ancestor.
    expect(dirs).not.toContain(path.join(home, '.nvm/versions/node/v24.0.0/bin'));
  });

  it('prepares a private scratch area and redirects caches into it', async () => {
    const stateDir = path.join(home, '.mcpclaude');
    const project = path.join(home, 'tools');
    const prepared = await prepareSandbox({ projectDir: project, stateDir, home, env: { PATH: '/usr/bin' }, platform: 'linux' });
    expect(prepared.spec.projectDir).toBe(project);
    expect(prepared.spec.readWriteDirs).toEqual([path.join(stateDir, 'sandbox')]);
    expect(prepared.spec.readOnlyFiles).toEqual([path.join(home, '.gitconfig')]);
    expect(prepared.tmpDir).toBe(path.join(stateDir, 'sandbox', 'tmp'));
    expect(prepared.env['TMPDIR']).toBe(`${path.join(stateDir, 'sandbox', 'tmp')}/`);
    expect(prepared.env['DIRHELPER_USER_DIR_SUFFIX']).toBeUndefined();
    expect(prepared.env['PATH']).toBeUndefined();
    expect(prepared.env['npm_config_cache']).toBe(path.join(stateDir, 'sandbox', 'cache', 'npm'));
    expect(prepared.env['GIT_CEILING_DIRECTORIES']).toBe(home);
    expect(prepared.unsetEnv).toContain('SSH_AUTH_SOCK');
    expect(prepared.profile.defines[0]).toBe(`-DPROJECT=${project}`);
  });

  it.runIf(process.platform === 'darwin')('uses private sub-directories of the per-user temp and cache directories on macOS', async () => {
    const stateDir = path.join(home, '.mcpclaude');
    const prepared = await prepareSandbox({ projectDir: path.join(home, 'tools'), stateDir, home, env: { PATH: '/usr/bin' } });
    const suffix = prepared.env['DIRHELPER_USER_DIR_SUFFIX'] as string;
    expect(suffix).toMatch(/^mcpclaude-[0-9a-f]{12}$/);
    expect(prepared.tmpDir).toMatch(new RegExp(`^/private/var/folders/.+/T/${suffix}$`));
    expect(prepared.env['TMPDIR']).toBe(`${prepared.tmpDir}/`);
    expect(prepared.spec.readWriteDirs).toEqual([
      path.join(stateDir, 'sandbox'),
      prepared.tmpDir,
      expect.stringMatching(new RegExp(`^/private/var/folders/.+/C/${suffix}$`)),
    ]);
    expect((await stat(prepared.tmpDir)).isDirectory()).toBe(true);
    await rm(prepared.tmpDir, { recursive: true, force: true });
    await rm(prepared.spec.readWriteDirs[2] as string, { recursive: true, force: true });
  });
});
