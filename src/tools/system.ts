import { statfs } from 'node:fs/promises';
import os from 'node:os';
import * as z from 'zod';
import { runProgram, which } from '../core/exec.js';
import { platformSummary } from '../core/platform.js';
import type { Runtime } from '../core/runtime.js';
import { NAME, VERSION } from '../version.js';
import { type AnyTool, defineTool } from './registry.js';
import { formatBytes, formatDuration, renderTable } from './util.js';

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_?KEY|ACCESS_?KEY|AUTH(?!_SOCK)/i;

const DEFAULT_TOOLS = [
  'git', 'node', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'python3', 'pip3', 'uv', 'ruby', 'go', 'cargo', 'rustc', 'java', 'swift',
  'xcodebuild', 'make', 'cmake', 'docker', 'brew', 'gh', 'ffmpeg', 'ffprobe', 'magick', 'blender', 'aerender', 'code', 'jq', 'curl',
];

/** Arguments that print a version, for tools that do not understand `--version`. */
const VERSION_ARGS: Record<string, string[]> = {
  go: ['version'],
  java: ['-version'],
  xcodebuild: ['-version'],
  ffmpeg: ['-version'],
  ffprobe: ['-version'],
  aerender: ['-version'],
  magick: ['-version'],
};

async function macSysctl(names: string[]): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const result = await runProgram('/usr/sbin/sysctl', names, { timeoutMs: 5000 }).catch(() => undefined);
  for (const line of result?.stdout.split('\n') ?? []) {
    const colon = line.indexOf(':');
    if (colon > 0) values[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return values;
}

async function toolVersion(runtime: Runtime, name: string, file: string): Promise<string | undefined> {
  try {
    // Run under the same confinement as agent commands: the name comes from the agent.
    const plan = runtime.spawnPlan([file, ...(VERSION_ARGS[name] ?? ['--version'])]);
    const result = await runProgram(plan.file, plan.args, { env: runtime.commandEnv(), timeoutMs: 8000, maxOutputBytes: 64 * 1024 });
    const line = `${result.stdout}\n${result.stderr}`
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '');
    return line?.slice(0, 160);
  } catch {
    return undefined;
  }
}

export function systemTools(): AnyTool[] {
  const systemInfo = defineTool({
    name: 'system_info',
    title: 'System information',
    group: 'system',
    access: 'any',
    description:
      'Describe the machine: macOS version, hardware model, CPU, memory, disk space of the project volume, uptime, user, shell, time zone and locale. Use check_tools for installed developer tools and get_environment for environment variables.',
    input: z.object({}),
    examples: [{ note: 'What machine am I on?', arguments: {} }],
    hints: { readOnly: true },
    async handler(_args, { runtime }) {
      const platform = await platformSummary(runtime.platform);
      const cpus = os.cpus();
      const mac = runtime.platform === 'darwin' ? await macSysctl(['hw.model', 'machdep.cpu.brand_string']) : {};
      const disk = await statfs(runtime.projectDir).catch(() => undefined);
      const user = os.userInfo();
      const data = {
        os: platform,
        hardware: {
          model: mac['hw.model'] ?? null,
          cpu: mac['machdep.cpu.brand_string'] ?? cpus[0]?.model ?? 'unknown',
          cpu_cores: cpus.length,
          memory_total: formatBytes(os.totalmem()),
          memory_free: formatBytes(os.freemem()),
        },
        disk: disk
          ? { volume_of: runtime.projectDir, total: formatBytes(disk.blocks * disk.bsize), free: formatBytes(disk.bavail * disk.bsize) }
          : null,
        host: { hostname: os.hostname(), uptime: formatDuration(os.uptime() * 1000), load_average: os.loadavg().map((n) => Math.round(n * 100) / 100) },
        user: { name: user.username, home: runtime.home, shell: runtime.env['SHELL'] ?? user.shell ?? null },
        locale: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: runtime.env['LANG'] ?? null, time: new Date().toISOString() },
        runtime: { server: `${NAME} ${VERSION}`, node: process.version },
      };
      return { data };
    },
  });

  const getEnvironment = defineTool({
    name: 'get_environment',
    title: 'Environment variables',
    group: 'system',
    access: 'any',
    description: [
      'Show the environment that commands started by this server receive. Without `names` it lists every variable, hiding the values of ones that look like secrets; with `names` it returns exactly those variables in full.',
      'PATH is additionally split into its entries.',
    ].join(' '),
    input: z.object({
      names: z.array(z.string()).optional().describe('Specific variables to return in full, for example ["PATH", "JAVA_HOME"].'),
    }),
    examples: [
      { note: 'List the environment.', arguments: {} },
      { note: 'Read two specific variables.', arguments: { names: ['PATH', 'NODE_ENV'] } },
    ],
    hints: { readOnly: true, idempotent: true },
    async handler(args, { runtime }) {
      const env = runtime.commandEnv();
      if (args.names && args.names.length > 0) {
        const variables: Record<string, string | null> = {};
        for (const name of args.names) variables[name] = env[name] ?? null;
        return {
          text: args.names.map((name) => `${name}=${env[name] ?? '(not set)'}`).join('\n'),
          data: { variables },
        };
      }
      const variables: Record<string, string> = {};
      for (const name of Object.keys(env).sort()) {
        const value = env[name] ?? '';
        if (SECRET_NAME.test(name)) variables[name] = `[hidden: ${value.length} chars — request it by name to see it]`;
        else variables[name] = value.length > 400 ? `${value.slice(0, 400)}… (${value.length} chars)` : value;
      }
      const pathEntries = (env['PATH'] ?? '').split(':').filter(Boolean);
      return {
        text: [
          ...Object.entries(variables)
            .filter(([name]) => name !== 'PATH')
            .map(([name, value]) => `${name}=${value}`),
          'PATH entries:',
          ...pathEntries.map((entry) => `  ${entry}`),
        ].join('\n'),
        data: { variables, path_entries: pathEntries },
      };
    },
  });

  const checkTools = defineTool({
    name: 'check_tools',
    title: 'Check installed tools',
    group: 'system',
    access: 'any',
    description:
      'Report which command-line tools are installed, where, and in which version. Without arguments it checks a standard set of developer and media tools (git, node, python3, swift, ffmpeg, blender, aerender, …); pass `tools` to check specific commands.',
    input: z.object({
      tools: z.array(z.string().regex(/^[A-Za-z0-9._+-]+$/, 'Command names only, without paths or arguments')).max(60).optional().describe('Command names to check, for example ["ffmpeg", "blender"].'),
    }),
    examples: [
      { note: 'Survey the standard toolset.', arguments: {} },
      { note: 'Check two specific tools.', arguments: { tools: ['ffmpeg', 'blender'] } },
    ],
    hints: { readOnly: true },
    async handler(args, { runtime }) {
      const names = args.tools && args.tools.length > 0 ? args.tools : DEFAULT_TOOLS;
      const env = runtime.commandEnv();
      const results = await Promise.all(
        names.map(async (name) => {
          const file = await which(name, env);
          return { name, installed: file !== undefined, path: file ?? null, version: file ? ((await toolVersion(runtime, name, file)) ?? null) : null };
        }),
      );
      const installed = results.filter((r) => r.installed);
      const missing = results.filter((r) => !r.installed).map((r) => r.name);
      const table = installed.length > 0 ? renderTable(['tool', 'path', 'version'], installed.map((r) => [r.name, r.path ?? '', r.version ?? '(version unknown)'])) : '(none of the requested tools are installed)';
      return {
        text: [table, missing.length > 0 ? `Not found on PATH: ${missing.join(', ')}` : ''].filter(Boolean).join('\n'),
        data: { tools: results },
      };
    },
  });

  return [systemInfo, getEnvironment, checkTools];
}
