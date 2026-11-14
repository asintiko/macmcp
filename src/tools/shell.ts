import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { ToolError } from '../core/errors.js';
import { truncateMiddle, which } from '../core/exec.js';
import type { ManagedProcess, SpawnPlan } from '../core/processes.js';
import type { Runtime } from '../core/runtime.js';
import { type AnyTool, defineTool, type ToolContext, type ToolOutput } from './registry.js';
import { formatDuration, parseEnvList, resolveDirectory, shellQuote, splitWords } from './util.js';

const SANDBOX_NOTE =
  'Note: this server runs in Project-Only mode. Commands are sandboxed: they can read and write the project directory and $TMPDIR, but not other user files, /tmp, other applications or the desktop.';

export const commandOptions = {
  cwd: z.string().optional().describe('Directory to run in (absolute, or relative to the working directory). Default: the working directory.'),
  timeout_seconds: z
    .number()
    .min(1)
    .max(600)
    .default(60)
    .describe('How long to wait. A command still running after this time is NOT killed: it continues in the background and a process_id is returned.'),
  env: z.array(z.string()).optional().describe('Extra environment variables as NAME=value strings.'),
  stdin: z.string().optional().describe('Text to pass to the command on standard input.'),
  max_output_chars: z.number().int().min(500).max(200_000).default(30_000).describe('Cap on returned output; the middle is cut out when exceeded.'),
};

/** Describe the state of a managed process the way every execution tool reports it. */
export function describeProcess(proc: ManagedProcess): string {
  const elapsed = formatDuration((proc.endedAt ?? Date.now()) - proc.startedAt);
  if (proc.status === 'running') return `running (${elapsed} so far)`;
  if (proc.signal) return `killed by ${proc.signal} after ${elapsed}`;
  return `exit code ${proc.exitCode} after ${elapsed}`;
}

function renderOutput(stdout: string, stderr: string, maxChars: number): { text: string; truncated: number } {
  const sections: string[] = [];
  let truncated = 0;
  // Budget is shared; stderr gets up to a third when both streams are long.
  const errBudget = stdout ? Math.min(stderr.length, Math.floor(maxChars / 3)) : maxChars;
  const outBudget = Math.max(maxChars - errBudget, Math.floor(maxChars / 3));
  if (stdout) {
    const cut = truncateMiddle(stdout, outBudget);
    truncated += cut.truncated;
    sections.push(`--- stdout ---\n${cut.text.replace(/\n$/, '')}`);
  }
  if (stderr) {
    const cut = truncateMiddle(stderr, Math.max(errBudget, 200));
    truncated += cut.truncated;
    sections.push(`--- stderr ---\n${cut.text.replace(/\n$/, '')}`);
  }
  return { text: sections.length > 0 ? sections.join('\n') : '(no output)', truncated };
}

export interface ExecutionRequest {
  /** Command line shown in listings and logs. */
  label: string;
  plan: SpawnPlan;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string | undefined;
  timeoutSeconds: number;
  maxOutputChars: number;
  /** Called when the process ends, even if that is after this call returned. */
  cleanup?: () => void;
}

/**
 * Start a command, wait up to the timeout, and report. A command that is still running is
 * left running and returned as a background process.
 */
export async function executeAndReport(runtime: Runtime, ctx: ToolContext, request: ExecutionRequest): Promise<ToolOutput> {
  const proc = runtime.processes.start({
    command: request.label,
    plan: request.plan,
    cwd: request.cwd,
    env: request.env,
    ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
  });
  if (request.cleanup) proc.onExit(request.cleanup);

  const exited = await proc.wait(request.timeoutSeconds * 1000, ctx.signal);
  const stdout = proc.output.read(0, 'stdout').text;
  const stderr = proc.output.read(0, 'stderr').text;
  const rendered = renderOutput(stdout, stderr, request.maxOutputChars);
  proc.readCursor = proc.output.length;

  const data: Record<string, unknown> = {
    status: proc.status,
    exit_code: proc.exitCode,
    signal: proc.signal,
    duration_ms: (proc.endedAt ?? Date.now()) - proc.startedAt,
    sandboxed: request.plan.sandboxed,
    output_truncated_chars: rendered.truncated,
  };

  if (!exited) {
    data['process_id'] = proc.id;
    const reason = ctx.signal.aborted ? 'The request was cancelled' : `Still running after ${formatDuration(request.timeoutSeconds * 1000)}`;
    return {
      text: [
        `${reason}; the command continues in the background as process_id "${proc.id}".`,
        'Follow it with read_process_output, send input with write_process_input, end it with stop_process.',
        rendered.text === '(no output)' ? '(no output yet)' : rendered.text,
      ].join('\n'),
      data,
    };
  }

  const lines = [`${describeProcess(proc)}`.replace(/^exit code/, 'Exit code').replace(/^killed/, 'Killed'), rendered.text];
  if (request.plan.sandboxed && proc.exitCode !== 0 && /operation not permitted|permission denied/i.test(`${stdout}${stderr}`)) {
    lines.push(SANDBOX_NOTE);
  }
  return { text: lines.join('\n'), data };
}

const INTERPRETERS: Record<string, { command: string; extension: string; args?: string[] }> = {
  bash: { command: '/bin/bash', extension: 'sh' },
  zsh: { command: '/bin/zsh', extension: 'zsh' },
  sh: { command: '/bin/sh', extension: 'sh' },
  python: { command: 'python3', extension: 'py' },
  // .js outside any package: Node treats it as CommonJS and switches to ESM when it sees import/export.
  node: { command: 'node', extension: 'js' },
  ruby: { command: 'ruby', extension: 'rb' },
  perl: { command: 'perl', extension: 'pl' },
  swift: { command: 'swift', extension: 'swift' },
};

export function shellTools(): AnyTool[] {
  const runCommand = defineTool({
    name: 'run_command',
    title: 'Run a shell command',
    group: 'shell',
    access: 'any',
    description: [
      'Run a shell command on the Mac and return its exit code, stdout and stderr. Use it for anything a terminal can do: build tools, git, package managers, compilers, scripts.',
      'If the command is still running when timeout_seconds elapses it is left running and a process_id is returned; poll it with read_process_output. For servers and watchers use start_process instead.',
      'Commands are not interactive: stdin is closed unless you pass stdin. In Project-Only mode they run inside an OS sandbox confined to the project directory.',
    ].join(' '),
    input: z.object({
      command: z.string().min(1).describe('Command line, as you would type it in a terminal. Pipes, redirects, && and ; are supported.'),
      ...commandOptions,
      shell: z.enum(['zsh', 'bash', 'sh']).optional().describe("Shell to interpret the command. Default: the user's shell (zsh on macOS)."),
    }),
    examples: [
      { note: 'Run the test suite of a Node project.', arguments: { command: 'npm test', timeout_seconds: 300 } },
      { note: 'Inspect git state in a sub-directory.', arguments: { command: 'git status --short && git log --oneline -5', cwd: 'packages/app' } },
    ],
    hints: { destructive: true, openWorld: true },
    async handler(args, ctx) {
      const { runtime } = ctx;
      const cwd = await resolveDirectory(runtime, args.cwd);
      return executeAndReport(runtime, ctx, {
        label: args.command,
        plan: runtime.shellPlan(args.command, args.shell),
        cwd,
        env: runtime.commandEnv(parseEnvList(args.env)),
        stdin: args.stdin,
        timeoutSeconds: args.timeout_seconds,
        maxOutputChars: args.max_output_chars,
      });
    },
  });

  const runScript = defineTool({
    name: 'run_script',
    title: 'Run a script',
    group: 'shell',
    access: 'any',
    description: [
      'Write the given source code to a temporary file and run it with an interpreter. Prefer this over run_command for multi-line programs: no shell quoting is needed.',
      'Languages: bash, zsh, sh, python (python3), node (CommonJS or ES module syntax), ruby, perl, swift. Use `interpreter` for anything else, for example "deno run" or "/opt/homebrew/bin/python3.12".',
      'Behaves like run_command for timeouts and background hand-off.',
    ].join(' '),
    input: z.object({
      language: z.enum(['bash', 'zsh', 'sh', 'python', 'node', 'ruby', 'perl', 'swift']).default('bash').describe('Language of the script.'),
      code: z.string().min(1).describe('Complete source code of the script.'),
      args: z.array(z.string()).optional().describe('Command-line arguments passed to the script.'),
      interpreter: z.string().optional().describe('Custom interpreter command that replaces the default for the language; the script path is appended.'),
      ...commandOptions,
    }),
    examples: [
      {
        note: 'Run a Python snippet.',
        arguments: { language: 'python', code: 'import json, platform\nprint(json.dumps({"python": platform.python_version()}))' },
      },
      { note: 'Run a shell script with arguments.', arguments: { language: 'bash', code: 'set -euo pipefail\nfor f in "$@"; do wc -l "$f"; done', args: ['README.md'] } },
    ],
    hints: { destructive: true, openWorld: true },
    async handler(args, ctx) {
      const { runtime } = ctx;
      const cwd = await resolveDirectory(runtime, args.cwd);
      const spec = INTERPRETERS[args.language] as { command: string; extension: string };
      const env = runtime.commandEnv(parseEnvList(args.env));

      let launcher: string[];
      if (args.interpreter) {
        launcher = splitWords(args.interpreter);
        if (launcher.length === 0) throw new ToolError('INVALID_ARGUMENT', 'interpreter is empty');
      } else {
        const resolved = await which(spec.command, env);
        if (!resolved) {
          throw new ToolError('DEPENDENCY_MISSING', `Interpreter not found on PATH: ${spec.command}`, 'Install it, or pass `interpreter` with a full path.');
        }
        launcher = [resolved];
      }

      const file = path.join(runtime.scratchDir, `script-${randomBytes(6).toString('hex')}.${spec.extension}`);
      await writeFile(file, args.code, { mode: 0o700 });
      const argv = [...launcher, file, ...(args.args ?? [])];
      return executeAndReport(runtime, ctx, {
        label: [args.interpreter ?? spec.command, `<${args.language} script>`, ...(args.args ?? []).map(shellQuote)].join(' '),
        plan: runtime.spawnPlan(argv),
        cwd,
        env,
        stdin: args.stdin,
        timeoutSeconds: args.timeout_seconds,
        maxOutputChars: args.max_output_chars,
        cleanup: () => void rm(file, { force: true }).catch(() => undefined),
      });
    },
  });

  return [runCommand, runScript];
}
