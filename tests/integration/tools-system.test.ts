import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { which } from '../../src/core/exec.js';
import type { PermissionMode } from '../../src/core/permissions.js';
import { createHarness, type Harness } from '../helpers/harness.js';

describe.each<PermissionMode>(['full', 'project'])('system and navigation tools (%s mode)', (mode) => {
  let h: Harness;
  const inProject = (...parts: string[]): string => path.join(h.projectDir, ...parts);

  beforeAll(async () => {
    h = await createHarness({
      mode,
      runtime: { env: { ...process.env, DEMO_API_KEY: 'sk-super-secret', DEMO_PLAIN: 'visible', NGROK_AUTHTOKEN: 'ngrok-secret', MCPCLAUDE_TOKEN: 'own-secret' } },
    });
    await mkdir(inProject('app', 'src'), { recursive: true });
  });
  afterAll(async () => {
    await h.close();
  });

  it('describes the machine', async () => {
    const info = await h.call('system_info');
    expect(info.isError).toBe(false);
    expect(info.data).toMatchObject({
      os: { os: process.platform === 'darwin' ? 'macOS' : 'Linux', arch: process.arch },
      hardware: { cpu_cores: expect.any(Number), memory_total: expect.stringMatching(/GB|MB/) },
      disk: { volume_of: h.projectDir, free: expect.any(String) },
      user: { name: expect.any(String) },
      runtime: { node: process.version },
    });
    if (process.platform === 'darwin') {
      const data = info.data as { os: { version: string }; hardware: { model: string } };
      expect(data.os.version).toMatch(/^\d+\.\d+/);
      expect(data.hardware.model).toBeTruthy();
    }
  });

  it('lists the environment with secrets hidden and never exposes its own secrets', async () => {
    const all = await h.call('get_environment');
    const variables = all.data?.['variables'] as Record<string, string>;
    expect(variables['DEMO_PLAIN']).toBe('visible');
    expect(variables['DEMO_API_KEY']).toBe('[hidden: 15 chars — request it by name to see it]');
    expect(variables['NGROK_AUTHTOKEN']).toBeUndefined();
    expect(variables['MCPCLAUDE_TOKEN']).toBeUndefined();
    expect(all.text).not.toContain('sk-super-secret');
    expect(all.text).not.toContain('ngrok-secret');
    expect(all.text).toContain('PATH entries:');
    expect((all.data?.['path_entries'] as string[]).length).toBeGreaterThan(0);

    const named = await h.call('get_environment', { names: ['DEMO_API_KEY', 'NOT_SET_ANYWHERE', 'NGROK_AUTHTOKEN'] });
    expect(named.text).toBe('DEMO_API_KEY=sk-super-secret\nNOT_SET_ANYWHERE=(not set)\nNGROK_AUTHTOKEN=(not set)');
    // Commands see the same environment.
    const echoed = await h.call('run_command', { command: 'echo "[$DEMO_PLAIN][${NGROK_AUTHTOKEN:-}][${MCPCLAUDE_TOKEN:-}]"' });
    expect(echoed.text).toContain('[visible][][]');
  });

  it('reports installed tools with versions and missing ones', async () => {
    const result = await h.call('check_tools', { tools: ['node', 'git', 'definitely-not-installed-xyz'] });
    const tools = result.data?.['tools'] as { name: string; installed: boolean; path: string | null; version: string | null }[];
    expect(tools.find((t) => t.name === 'node')).toMatchObject({ installed: true, version: process.version });
    expect(tools.find((t) => t.name === 'definitely-not-installed-xyz')).toEqual({ name: 'definitely-not-installed-xyz', installed: false, path: null, version: null });
    expect(result.text).toContain('Not found on PATH: definitely-not-installed-xyz');
    if (await which('git')) expect(tools.find((t) => t.name === 'git')?.version).toMatch(/^git version \d+/);

    const standard = await h.call('check_tools');
    expect((standard.data?.['tools'] as unknown[]).length).toBeGreaterThan(20);
    expect((await h.call('check_tools', { tools: ['rm -rf /'] })).isError).toBe(true);
  });

  it('tracks the working directory across calls', async () => {
    expect((await h.call('get_working_directory')).data).toEqual({ working_directory: h.projectDir, project_directory: h.projectDir, permission_mode: mode });

    const changed = await h.call('change_directory', { path: 'app' });
    expect(changed.text).toBe(`Working directory is now ${inProject('app')}`);
    expect(changed.data).toEqual({ working_directory: inProject('app'), previous: h.projectDir });

    // Relative paths and commands now resolve against the new directory.
    await h.call('write_file', { path: 'src/main.txt', content: 'hello' });
    expect((await h.call('run_command', { command: 'pwd && cat src/main.txt' })).text).toContain(`${inProject('app')}\nhello`);
    expect((await h.call('server_info')).data).toMatchObject({ working_directory: inProject('app'), project_directory: h.projectDir });

    expect((await h.call('change_directory', { path: 'src/main.txt' })).text).toContain('Error [INVALID_ARGUMENT]: Not a directory');
    expect((await h.call('change_directory', { path: 'missing' })).text).toContain('Error [NOT_FOUND]');
    expect((await h.call('change_directory', { path: '..' })).data).toMatchObject({ working_directory: h.projectDir });

    const outside = await h.call('change_directory', { path: h.outsideDir });
    if (mode === 'project') {
      expect(outside.text).toContain('Error [OUTSIDE_PROJECT]');
      expect((await h.call('change_directory', { path: '..' })).text).toContain('Error [OUTSIDE_PROJECT]');
    } else {
      expect(outside.data).toMatchObject({ working_directory: h.outsideDir });
      await h.call('change_directory', { path: h.projectDir });
    }
    expect((await h.call('get_working_directory')).data?.['working_directory']).toBe(h.projectDir);
  });

  it('summarises a project', async () => {
    await writeFile(inProject('app', 'package.json'), JSON.stringify({ name: 'demo-app', version: '1.2.3', scripts: { build: 'tsc', test: 'vitest' } }));
    await writeFile(inProject('app', 'pnpm-lock.yaml'), '');
    await writeFile(inProject('app', 'Makefile'), 'CC := cc\n\nall: build\n\nbuild:\n\t@echo building\n\nclean:\n\trm -rf out\n');
    await mkdir(inProject('app', 'shots', 'sq01'), { recursive: true });
    await writeFile(inProject('app', 'shots', 'sq01', 'shot010.aep'), 'x');
    await writeFile(inProject('app', 'shots', 'scene.blend'), 'x');

    const hasGit = Boolean(await which('git'));
    if (hasGit) {
      const init = await h.call('run_command', {
        command: 'git init -q -b main . && git add package.json && git -c user.name=t -c user.email=t@example.com commit -q -m "first commit"',
        cwd: 'app',
      });
      expect(init.text, init.text).toMatch(/^Exit code 0/);
    }

    const overview = await h.call('project_overview', { path: 'app' });
    expect(overview.isError, overview.text).toBe(false);
    expect(overview.data).toMatchObject({
      path: inProject('app'),
      technologies: ['Node.js', 'Make'],
      package: { name: 'demo-app', version: '1.2.3', manager: 'pnpm', scripts: ['build', 'test'] },
      make_targets: ['all', 'build', 'clean'],
      creative_files: ['shots/scene.blend', 'shots/sq01/shot010.aep'],
    });
    expect(overview.text).toContain('Scripts (pnpm run …): build, test');
    expect(overview.text).toMatch(/Top level \(\d+ entries\): shots\/ {2}src\/ {2}Makefile/);
    if (hasGit) {
      expect(overview.data?.['git']).toMatchObject({ branch: 'main', last_commit: expect.stringContaining('first commit') });
      expect((overview.data?.['git'] as { changed_files: number }).changed_files).toBeGreaterThan(0);
      expect(overview.text).toMatch(/Git: branch main, \d+ changed files?, last commit [0-9a-f]+ first commit/);
    }

    const bare = await h.call('project_overview', { path: 'app/src' });
    expect(bare.data).toMatchObject({ technologies: [] });
    expect(bare.text).toContain('Technologies: none detected');
  });
});
