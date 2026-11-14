import * as z from 'zod';
import { ToolError } from '../core/errors.js';
import { runProgram, truncateMiddle } from '../core/exec.js';
import { LIMITS } from '../core/runtime.js';
import { type AnyTool, defineTool } from './registry.js';
import { describeProcess } from './shell.js';
import { formatDuration, parseEnvList, renderTable, resolveDirectory } from './util.js';

const SIGNALS = { TERM: 'SIGTERM', INT: 'SIGINT', HUP: 'SIGHUP', KILL: 'SIGKILL' } as const;

export function processTools(): AnyTool[] {
  const startProcess = defineTool({
    name: 'start_process',
    title: 'Start a background process',
    group: 'process',
    access: 'any',
    description: [
      'Start a long-running command in the background and return a process_id immediately: dev servers, watchers, renders, long builds.',
      'The process keeps running between tool calls. Read its output with read_process_output, send input with write_process_input, end it with stop_process.',
      'All background processes are stopped when the user quits mcpclaude.',
    ].join(' '),
    input: z.object({
      command: z.string().min(1).describe('Command line to run in a shell.'),
      cwd: z.string().optional().describe('Directory to run in. Default: the working directory.'),
      name: z.string().max(80).optional().describe('Short label shown in list_processes, for example "dev server".'),
      env: z.array(z.string()).optional().describe('Extra environment variables as NAME=value strings.'),
      shell: z.enum(['zsh', 'bash', 'sh']).optional().describe("Shell to interpret the command. Default: the user's shell."),
      wait_seconds: z.number().min(0).max(60).default(2).describe('Wait this long before returning, so early output and immediate failures are included.'),
    }),
    examples: [
      { note: 'Start a dev server and keep it running.', arguments: { command: 'npm run dev', name: 'dev server' } },
      { note: 'Start a long render and return at once.', arguments: { command: 'blender -b scene.blend -a', name: 'render', wait_seconds: 0 } },
    ],
    hints: { destructive: true, openWorld: true },
    async handler(args, { runtime, signal }) {
      const cwd = await resolveDirectory(runtime, args.cwd);
      const proc = runtime.processes.start({
        command: args.command,
        plan: runtime.shellPlan(args.command, args.shell),
        cwd,
        env: runtime.commandEnv(parseEnvList(args.env)),
        keepStdinOpen: true,
        ...(args.name ? { name: args.name } : {}),
      });
      if (args.wait_seconds > 0) await proc.wait(args.wait_seconds * 1000, signal);
      const slice = proc.output.read(0);
      proc.readCursor = slice.next;
      const output = truncateMiddle(slice.text, 10_000).text.replace(/\n$/, '');
      return {
        text: [`Started process_id "${proc.id}"${proc.pid ? ` (pid ${proc.pid})` : ''}: ${describeProcess(proc)}`, output ? `--- output so far ---\n${output}` : '(no output yet)'].join('\n'),
        data: { ...proc.info() },
      };
    },
  });

  const listProcesses = defineTool({
    name: 'list_processes',
    title: 'List managed processes',
    group: 'process',
    access: 'any',
    description:
      'List the processes started through this server (run_command hand-offs, start_process, renders) with their status, exit code, runtime and amount of output. Finished processes stay listed for a while so their output can still be read.',
    input: z.object({
      running_only: z.boolean().default(false).describe('Only show processes that are still running.'),
    }),
    examples: [{ note: 'See what is running.', arguments: { running_only: true } }],
    hints: { readOnly: true, idempotent: true },
    async handler(args, { runtime }) {
      const processes = runtime.processes.list().filter((p) => !args.running_only || p.status === 'running');
      if (processes.length === 0) return { text: 'No managed processes.', data: { processes: [] } };
      const table = renderTable(
        ['id', 'status', 'exit', 'runtime', 'output', 'name', 'command'],
        processes.map((p) => [
          p.process_id,
          p.status,
          p.signal ?? (p.exit_code === null ? '-' : String(p.exit_code)),
          formatDuration(p.runtime_seconds * 1000),
          `${p.output_chars} chars`,
          p.name ?? '-',
          p.command.length > 80 ? `${p.command.slice(0, 77)}…` : p.command,
        ]),
      );
      return { text: table, data: { processes } };
    },
  });

  const readProcessOutput = defineTool({
    name: 'read_process_output',
    title: 'Read process output',
    group: 'process',
    access: 'any',
    description: [
      'Read output of a managed process. By default returns only what was produced since your previous read, so repeated calls follow the process like `tail -f`.',
      'With wait_seconds the call blocks until there is new output or the process exits (long poll) — use this instead of sleeping.',
      'The result states whether the process is still running and its exit code once finished.',
    ].join(' '),
    input: z.object({
      process_id: z.string().describe('Id returned by run_command, start_process or a render tool, for example "p3".'),
      wait_seconds: z.number().min(0).max(LIMITS.callSeconds).default(10).describe('Maximum time to wait for new output or exit. 0 returns immediately.'),
      from_start: z.boolean().default(false).describe('Return all retained output from the beginning instead of only new output.'),
      max_chars: z.number().int().min(500).max(200_000).default(30_000).describe('Cap on returned output; the middle is cut out when exceeded.'),
    }),
    examples: [
      { note: 'Wait up to a minute for a build to produce more output or finish.', arguments: { process_id: 'p3', wait_seconds: 60 } },
      { note: 'Re-read everything a process printed.', arguments: { process_id: 'p3', from_start: true, wait_seconds: 0 } },
    ],
    hints: { readOnly: true },
    async handler(args, { runtime, signal }) {
      const proc = runtime.processes.get(args.process_id);
      const from = args.from_start ? 0 : proc.readCursor;
      if (args.wait_seconds > 0 && !args.from_start) await proc.waitForActivity(from, args.wait_seconds * 1000, signal);
      const slice = proc.output.read(from);
      proc.readCursor = slice.next;
      const cut = truncateMiddle(slice.text, args.max_chars);
      const lines = [`process_id "${proc.id}": ${describeProcess(proc)}`];
      if (slice.dropped > 0) lines.push(`(${slice.dropped} older characters are no longer retained)`);
      lines.push(cut.text ? cut.text.replace(/\n$/, '') : proc.status === 'running' ? '(no new output)' : '(no more output)');
      return {
        text: lines.join('\n'),
        data: { ...proc.info(), new_output_chars: slice.text.length, output_truncated_chars: cut.truncated },
      };
    },
  });

  const writeProcessInput = defineTool({
    name: 'write_process_input',
    title: 'Send input to a process',
    group: 'process',
    access: 'any',
    description:
      'Write text to the standard input of a process started with start_process, for example to answer a prompt or drive a REPL. A newline is appended unless append_newline is false. Set close_stdin to signal end-of-input.',
    input: z.object({
      process_id: z.string().describe('Id of a running managed process.'),
      input: z.string().default('').describe('Text to send.'),
      append_newline: z.boolean().default(true).describe('Append a newline, as pressing Enter would.'),
      close_stdin: z.boolean().default(false).describe('Close standard input after writing (end-of-file).'),
      wait_seconds: z.number().min(0).max(60).default(1).describe('Wait this long for the process to react, then include its new output.'),
    }),
    examples: [{ note: 'Answer "y" to a confirmation prompt.', arguments: { process_id: 'p2', input: 'y' } }],
    hints: { destructive: true },
    async handler(args, { runtime, signal }) {
      const proc = runtime.processes.get(args.process_id);
      const cursor = proc.output.length;
      if (args.input !== '' || args.append_newline) proc.write(args.append_newline ? `${args.input}\n` : args.input);
      if (args.close_stdin) proc.closeStdin();
      if (args.wait_seconds > 0) await proc.waitForActivity(cursor, args.wait_seconds * 1000, signal);
      const slice = proc.output.read(proc.readCursor);
      proc.readCursor = slice.next;
      const output = truncateMiddle(slice.text, 20_000).text.replace(/\n$/, '');
      return {
        text: [`Input sent to "${proc.id}": ${describeProcess(proc)}`, output || '(no new output)'].join('\n'),
        data: { ...proc.info() },
      };
    },
  });

  const stopProcess = defineTool({
    name: 'stop_process',
    title: 'Stop a process',
    group: 'process',
    access: 'any',
    description:
      'Stop a managed process and everything it started. Sends the signal to the whole process group, waits grace_seconds, then force-kills if it is still alive. Returns the final status and the last output.',
    input: z.object({
      process_id: z.string().describe('Id of the managed process to stop.'),
      signal: z.enum(['TERM', 'INT', 'HUP', 'KILL']).default('TERM').describe('Signal to send first. INT is like pressing Ctrl+C.'),
      grace_seconds: z.number().min(0).max(60).default(5).describe('Time to let the process exit before it is force-killed.'),
    }),
    examples: [{ note: 'Stop a dev server like Ctrl+C would.', arguments: { process_id: 'p1', signal: 'INT' } }],
    hints: { destructive: true, idempotent: true },
    async handler(args, { runtime }) {
      const proc = runtime.processes.get(args.process_id);
      const wasRunning = proc.status === 'running';
      await proc.stop(SIGNALS[args.signal], args.grace_seconds * 1000);
      const slice = proc.output.read(proc.readCursor);
      proc.readCursor = slice.next;
      const tail = truncateMiddle(slice.text, 5000).text.replace(/\n$/, '');
      return {
        text: [`${wasRunning ? 'Stopped' : 'Already finished'} "${proc.id}": ${describeProcess(proc)}`, tail ? `--- last output ---\n${tail}` : ''].filter(Boolean).join('\n'),
        data: { ...proc.info() },
      };
    },
  });

  const listSystemProcesses = defineTool({
    name: 'list_system_processes',
    title: 'List system processes',
    group: 'process',
    access: 'full',
    description:
      'List processes running on the Mac (like `ps`), with pid, parent pid, CPU and memory use, owner and command line. Filter by a substring of the command line and sort by CPU, memory, pid or name.',
    input: z.object({
      filter: z.string().optional().describe('Only processes whose command line contains this text (case-insensitive).'),
      sort_by: z.enum(['cpu', 'memory', 'pid', 'name']).default('cpu').describe('Sort order; cpu and memory sort highest first.'),
      limit: z.number().int().min(1).max(500).default(30).describe('Maximum number of processes to return.'),
    }),
    examples: [{ note: 'Find Blender processes.', arguments: { filter: 'blender', sort_by: 'memory' } }],
    hints: { readOnly: true },
    async handler(args) {
      const result = await runProgram('/bin/ps', ['-axo', 'pid=,ppid=,pcpu=,pmem=,rss=,user=,args='], { timeoutMs: 10_000 });
      if (result.code !== 0) throw new ToolError('FAILED', `ps failed: ${result.stderr.trim()}`);
      const needle = args.filter?.toLowerCase();
      const rows = result.stdout
        .split('\n')
        .map((line) => /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({
          pid: Number(m[1]),
          ppid: Number(m[2]),
          cpu_percent: Number(m[3]),
          memory_percent: Number(m[4]),
          memory_mb: Math.round(Number(m[5]) / 102.4) / 10,
          user: m[6] as string,
          command: m[7] as string,
        }))
        .filter((p) => !needle || p.command.toLowerCase().includes(needle));
      const sorters = {
        cpu: (a: (typeof rows)[number], b: (typeof rows)[number]) => b.cpu_percent - a.cpu_percent,
        memory: (a: (typeof rows)[number], b: (typeof rows)[number]) => b.memory_mb - a.memory_mb,
        pid: (a: (typeof rows)[number], b: (typeof rows)[number]) => a.pid - b.pid,
        name: (a: (typeof rows)[number], b: (typeof rows)[number]) => a.command.localeCompare(b.command),
      };
      const selected = rows.sort(sorters[args.sort_by]).slice(0, args.limit);
      const table = renderTable(
        ['pid', 'ppid', 'cpu%', 'mem MB', 'user', 'command'],
        selected.map((p) => [String(p.pid), String(p.ppid), p.cpu_percent.toFixed(1), p.memory_mb.toFixed(1), p.user, p.command.length > 160 ? `${p.command.slice(0, 157)}…` : p.command]),
      );
      return {
        text: `${selected.length} of ${rows.length} matching processes\n${table}`,
        data: { total_matching: rows.length, processes: selected },
      };
    },
  });

  const killProcess = defineTool({
    name: 'kill_process',
    title: 'Signal a system process',
    group: 'process',
    access: 'full',
    description:
      'Send a signal to any process by pid (like `kill`). For processes started through this server prefer stop_process, which also stops their children. Use list_system_processes to find pids.',
    input: z.object({
      pid: z.number().int().min(2).describe('Process id to signal.'),
      signal: z.enum(['TERM', 'INT', 'HUP', 'KILL']).default('TERM').describe('Signal to send. KILL cannot be caught by the process.'),
    }),
    examples: [{ note: 'Ask a process to terminate.', arguments: { pid: 4242 } }],
    hints: { destructive: true },
    async handler(args) {
      if (args.pid === process.pid) {
        throw new ToolError('PERMISSION_DENIED', 'That is the mcpclaude server itself; only the user stops it.');
      }
      try {
        process.kill(args.pid, SIGNALS[args.signal]);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') throw new ToolError('NOT_FOUND', `No process with pid ${args.pid}`);
        if (code === 'EPERM') throw new ToolError('PERMISSION_DENIED', `Not allowed to signal pid ${args.pid} (owned by another user or protected by macOS).`);
        throw err;
      }
      return { text: `Sent SIG${args.signal} to pid ${args.pid}.`, data: { pid: args.pid, signal: SIGNALS[args.signal] } };
    },
  });

  return [startProcess, listProcesses, readProcessOutput, writeProcessInput, stopProcess, listSystemProcesses, killProcess];
}
