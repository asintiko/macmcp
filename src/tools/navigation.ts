import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { ToolError } from '../core/errors.js';
import { runProgram } from '../core/exec.js';
import { walk } from '../core/glob.js';
import { MODE_LABEL } from '../core/permissions.js';
import type { Runtime } from '../core/runtime.js';
import { type AnyTool, defineTool } from './registry.js';

const MARKERS: [file: string, label: string][] = [
  ['package.json', 'Node.js'],
  ['pyproject.toml', 'Python'],
  ['requirements.txt', 'Python'],
  ['setup.py', 'Python'],
  ['Pipfile', 'Python'],
  ['Cargo.toml', 'Rust'],
  ['go.mod', 'Go'],
  ['Gemfile', 'Ruby'],
  ['pom.xml', 'Java (Maven)'],
  ['build.gradle', 'Java/Kotlin (Gradle)'],
  ['build.gradle.kts', 'Java/Kotlin (Gradle)'],
  ['Package.swift', 'Swift package'],
  ['CMakeLists.txt', 'CMake'],
  ['Makefile', 'Make'],
  ['Dockerfile', 'Docker'],
  ['docker-compose.yml', 'Docker Compose'],
  ['compose.yaml', 'Docker Compose'],
];

const LOCKFILES: [file: string, manager: string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

const CREATIVE_EXTENSIONS = new Set(['.aep', '.aepx', '.blend', '.prproj', '.psd', '.ai', '.c4d', '.fcpxml', '.drp']);

/** Run git under the same confinement as agent commands: repository config can name programs to execute. */
async function git(runtime: Runtime, dir: string, args: string[]): Promise<string | undefined> {
  try {
    const plan = runtime.spawnPlan(['git', '-C', dir, ...args]);
    const result = await runProgram(plan.file, plan.args, { env: runtime.commandEnv(), timeoutMs: 10_000 });
    return result.code === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function navigationTools(): AnyTool[] {
  const getWorkingDirectory = defineTool({
    name: 'get_working_directory',
    title: 'Show the working directory',
    group: 'navigation',
    access: 'any',
    description:
      'Return the current working directory (where relative paths and commands are resolved), the project directory chosen by the user, and the permission level.',
    input: z.object({}),
    examples: [{ note: 'Where am I?', arguments: {} }],
    hints: { readOnly: true, idempotent: true },
    async handler(_args, { runtime }) {
      return {
        text: `Working directory: ${runtime.cwd}\nProject directory: ${runtime.projectDir}\nPermission level: ${MODE_LABEL[runtime.mode]}`,
        data: { working_directory: runtime.cwd, project_directory: runtime.projectDir, permission_mode: runtime.mode },
      };
    },
  });

  const changeDirectory = defineTool({
    name: 'change_directory',
    title: 'Change the working directory',
    group: 'navigation',
    access: 'any',
    description:
      'Change the working directory used for relative paths and as the default directory of commands. The change is shared by all later calls until the server restarts. In Project-Only mode the directory must be inside the project.',
    input: z.object({
      path: z.string().describe('Directory to switch to (absolute, ~/…, or relative to the current working directory).'),
    }),
    examples: [
      { note: 'Work inside a sub-project.', arguments: { path: 'packages/renderer' } },
      { note: 'Go back to the project root.', arguments: { path: '~/Projects/film' } },
    ],
    hints: { idempotent: true },
    async handler(args, { runtime }) {
      const dir = await runtime.resolvePath(args.path);
      const info = await stat(dir).catch(() => undefined);
      if (!info) throw new ToolError('NOT_FOUND', `Directory does not exist: ${dir}`);
      if (!info.isDirectory()) throw new ToolError('INVALID_ARGUMENT', `Not a directory: ${dir}`);
      const previous = runtime.cwd;
      runtime.setCwd(dir);
      return { text: `Working directory is now ${dir}`, data: { working_directory: dir, previous } };
    },
  });

  const projectOverview = defineTool({
    name: 'project_overview',
    title: 'Project overview',
    group: 'navigation',
    access: 'any',
    description:
      'Summarise a project directory in one call: detected technologies, package scripts and Makefile targets, git branch and pending changes, creative project files (After Effects, Blender, Premiere, …) and the top-level layout. Use it to get oriented before working.',
    input: z.object({
      path: z.string().default('.').describe('Directory to summarise. Default: the working directory.'),
    }),
    examples: [{ note: 'Get oriented in the current project.', arguments: {} }],
    hints: { readOnly: true, idempotent: true },
    async handler(args, { runtime, signal }) {
      const dir = await runtime.resolvePath(args.path);
      if (!(await stat(dir)).isDirectory()) throw new ToolError('INVALID_ARGUMENT', `Not a directory: ${dir}`);
      const names = new Set(await readdir(dir));
      const lines: string[] = [`Project: ${dir}`];
      const data: Record<string, unknown> = { path: dir };

      const technologies = [...new Set(MARKERS.filter(([file]) => names.has(file)).map(([, label]) => label))];
      if ([...names].some((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'))) technologies.push('Xcode');
      data['technologies'] = technologies;
      lines.push(`Technologies: ${technologies.length > 0 ? technologies.join(', ') : 'none detected'}`);

      if (names.has('package.json')) {
        try {
          const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string; scripts?: Record<string, string> };
          const manager = LOCKFILES.find(([file]) => names.has(file))?.[1] ?? 'npm';
          const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 40);
          data['package'] = { name: pkg.name, version: pkg.version, manager, scripts };
          lines.push(`Package: ${pkg.name ?? '(unnamed)'}${pkg.version ? `@${pkg.version}` : ''} (package manager: ${manager})`);
          if (scripts.length > 0) lines.push(`Scripts (${manager} run …): ${scripts.join(', ')}`);
        } catch {
          lines.push('Package: package.json could not be parsed');
        }
      }
      if (names.has('Makefile')) {
        const targets = [...(await readFile(path.join(dir, 'Makefile'), 'utf8')).matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/gm)].map((m) => m[1] as string);
        const unique = [...new Set(targets)].slice(0, 40);
        data['make_targets'] = unique;
        if (unique.length > 0) lines.push(`Make targets: ${unique.join(', ')}`);
      }

      const branch = await git(runtime, dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (branch !== undefined) {
        const status = (await git(runtime, dir, ['status', '--porcelain'])) ?? '';
        const changed = status === '' ? 0 : status.split('\n').length;
        const last = await git(runtime, dir, ['log', '-1', '--format=%h %s (%cr)']);
        const remote = await git(runtime, dir, ['remote', 'get-url', 'origin']);
        data['git'] = { branch, changed_files: changed, last_commit: last, remote };
        lines.push(`Git: branch ${branch}, ${changed === 0 ? 'clean' : `${changed} changed file${changed === 1 ? '' : 's'}`}${last ? `, last commit ${last}` : ''}`);
      }

      const creative: string[] = [];
      for await (const entry of walk(dir, { maxDepth: 4, maxVisited: 20_000, signal })) {
        if (entry.dirent.isFile() && CREATIVE_EXTENSIONS.has(path.extname(entry.dirent.name).toLowerCase())) {
          creative.push(entry.relative);
          if (creative.length >= 30) break;
        }
      }
      data['creative_files'] = creative;
      if (creative.length > 0) lines.push(`Creative project files: ${creative.join(', ')}`);

      const top = await readdir(dir, { withFileTypes: true });
      const layout = top
        .filter((d) => !d.name.startsWith('.') || ['.github', '.env.example'].includes(d.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .slice(0, 60)
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
      data['top_level'] = layout;
      lines.push(`Top level (${top.length} entries): ${layout.join('  ')}`);
      return { text: lines.join('\n'), data };
    },
  });

  return [getWorkingDirectory, changeDirectory, projectOverview];
}
