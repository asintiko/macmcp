import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ToolError } from './errors.js';

export type OutputStream = 'stdout' | 'stderr';
export type ShellName = 'zsh' | 'bash' | 'sh';
export type ProcessStatus = 'running' | 'exited' | 'killed';

interface Chunk {
  stream: OutputStream;
  text: string;
  /** Absolute offset of this chunk in the combined output. */
  offset: number;
}

export interface OutputSlice {
  text: string;
  /** Offset the text actually starts at (later than requested if old output was dropped). */
  from: number;
  /** Offset to pass next time to continue reading. */
  next: number;
  /** Characters that were requested but are no longer retained. */
  dropped: number;
}

/**
 * Bounded record of a process's output. Offsets are absolute positions in the combined
 * stdout+stderr stream, so readers can resume from a cursor even after old output is dropped.
 */
export class OutputBuffer {
  private chunks: Chunk[] = [];
  private total = 0;
  private held = 0;

  constructor(private readonly limit: number) {}

  append(stream: OutputStream, text: string): void {
    if (text === '') return;
    this.chunks.push({ stream, text, offset: this.total });
    this.total += text.length;
    this.held += text.length;
    while (this.held > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift() as Chunk;
      this.held -= dropped.text.length;
    }
    const first = this.chunks[0];
    if (first && this.held > this.limit) {
      const cut = this.held - this.limit;
      first.text = first.text.slice(cut);
      first.offset += cut;
      this.held -= cut;
    }
  }

  /** Total characters ever written. */
  get length(): number {
    return this.total;
  }

  read(from = 0, stream?: OutputStream): OutputSlice {
    const earliest = this.chunks[0]?.offset ?? this.total;
    const start = Math.min(Math.max(from, earliest), this.total);
    let text = '';
    for (const chunk of this.chunks) {
      if (chunk.offset + chunk.text.length <= start) continue;
      if (stream && chunk.stream !== stream) continue;
      text += chunk.offset >= start ? chunk.text : chunk.text.slice(start - chunk.offset);
    }
    return { text, from: start, next: this.total, dropped: Math.max(0, start - Math.max(0, from)) };
  }
}

export function resolveShell(name: ShellName | undefined, env: NodeJS.ProcessEnv): string {
  if (name) {
    const candidate = `/bin/${name}`;
    if (!existsSync(candidate)) throw new ToolError('DEPENDENCY_MISSING', `Shell not available: ${candidate}`);
    return candidate;
  }
  const preferred = env['SHELL'];
  if (preferred && ['zsh', 'bash', 'sh'].includes(path.basename(preferred)) && existsSync(preferred)) return preferred;
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(candidate)) return candidate;
  }
  throw new ToolError('DEPENDENCY_MISSING', 'No POSIX shell found in /bin');
}

export interface ProcessInfo {
  process_id: string;
  name?: string;
  command: string;
  cwd: string;
  pid?: number;
  status: ProcessStatus;
  exit_code: number | null;
  signal: string | null;
  started_at: string;
  ended_at?: string;
  runtime_seconds: number;
  output_chars: number;
  sandboxed: boolean;
}

export interface SpawnPlan {
  file: string;
  args: string[];
  sandboxed: boolean;
}

export interface StartRequest {
  /** Human-readable command line, shown in listings. */
  command: string;
  /** Program and arguments to execute (already wrapped for the sandbox if needed). */
  plan: SpawnPlan;
  cwd: string;
  env: NodeJS.ProcessEnv;
  name?: string;
  /** Written to stdin right after start. */
  stdin?: string;
  /** Leave stdin open for later input instead of closing it. */
  keepStdinOpen?: boolean;
}

/** A command started by an agent, running in its own process group. */
export class ManagedProcess {
  readonly output: OutputBuffer;
  readonly startedAt = Date.now();
  endedAt: number | undefined;
  status: ProcessStatus = 'running';
  exitCode: number | null = null;
  signal: string | null = null;
  /** How far `read_process_output` has delivered output. */
  readCursor = 0;

  private readonly child: ChildProcess;
  private readonly emitter = new EventEmitter();
  private stdinOpen: boolean;

  constructor(
    readonly id: string,
    private readonly request: StartRequest,
    bufferChars: number,
  ) {
    this.output = new OutputBuffer(bufferChars);
    this.emitter.setMaxListeners(0);
    this.child = spawn(request.plan.file, request.plan.args, {
      cwd: request.cwd,
      env: request.env,
      // Own process group, so the whole tree can be signalled.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stdinOpen = true;

    this.pipe('stdout');
    this.pipe('stderr');

    let finalizeTimer: NodeJS.Timeout | undefined;
    const finalize = (): void => {
      if (finalizeTimer) clearTimeout(finalizeTimer);
      if (this.status !== 'running') return;
      this.status = this.signal ? 'killed' : 'exited';
      this.endedAt = Date.now();
      this.stdinOpen = false;
      this.emitter.emit('exit');
      this.emitter.emit('activity');
    };
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      this.output.append('stderr', `Failed to start process: ${error.message}\n`);
      this.exitCode = 127;
      finalize();
    });
    this.child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.signal = signal;
      // 'close' waits for the pipes; a lingering grandchild can hold them open forever.
      finalizeTimer = setTimeout(finalize, 300);
    });
    this.child.on('close', finalize);

    this.child.stdin?.on('error', () => undefined);
    if (request.stdin !== undefined) this.child.stdin?.write(request.stdin);
    if (!request.keepStdinOpen) this.closeStdin();
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private pipe(stream: OutputStream): void {
    const decoder = new StringDecoder('utf8');
    const source = stream === 'stdout' ? this.child.stdout : this.child.stderr;
    source?.on('data', (chunk: Buffer) => {
      this.output.append(stream, decoder.write(chunk));
      this.emitter.emit('activity');
    });
    source?.on('end', () => {
      this.output.append(stream, decoder.end());
    });
  }

  /** Resolves true once the process has exited, false on timeout or abort. */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return this.until('exit', () => this.status !== 'running', timeoutMs, signal);
  }

  /** Run a callback once the process has exited, however long that takes. */
  onExit(callback: () => void): void {
    if (this.status !== 'running') callback();
    else this.emitter.once('exit', callback);
  }

  /** Resolves when there is output beyond `offset`, the process exits, or time runs out. */
  async waitForActivity(offset: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await this.until('activity', () => this.output.length > offset || this.status !== 'running', timeoutMs, signal);
  }

  private until(event: 'exit' | 'activity', ready: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (ready()) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (value: boolean): void => {
        clearTimeout(timer);
        this.emitter.off(event, onEvent);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onEvent = (): void => {
        if (ready()) done(true);
      };
      const onAbort = (): void => done(false);
      const timer = setTimeout(() => done(ready()), timeoutMs);
      this.emitter.on(event, onEvent);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  write(input: string): void {
    if (this.status !== 'running') throw new ToolError('CONFLICT', `Process ${this.id} is not running`);
    if (!this.stdinOpen || !this.child.stdin) {
      throw new ToolError('CONFLICT', `Standard input of process ${this.id} is closed`);
    }
    this.child.stdin.write(input);
  }

  closeStdin(): void {
    if (!this.stdinOpen) return;
    this.stdinOpen = false;
    this.child.stdin?.end();
  }

  /** Signal the whole process group. */
  kill(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined || this.status !== 'running') return;
    try {
      process.kill(-pid, signal);
    } catch {
      this.child.kill(signal);
    }
  }

  /** Ask the process to stop, escalating to SIGKILL after the grace period. */
  async stop(signal: NodeJS.Signals = 'SIGTERM', graceMs = 5000): Promise<void> {
    if (this.status !== 'running') return;
    this.kill(signal);
    if (await this.wait(graceMs)) return;
    this.kill('SIGKILL');
    await this.wait(3000);
  }

  info(): ProcessInfo {
    const end = this.endedAt ?? Date.now();
    const info: ProcessInfo = {
      process_id: this.id,
      command: this.request.command,
      cwd: this.request.cwd,
      status: this.status,
      exit_code: this.exitCode,
      signal: this.signal,
      started_at: new Date(this.startedAt).toISOString(),
      runtime_seconds: Math.round((end - this.startedAt) / 100) / 10,
      output_chars: this.output.length,
      sandboxed: this.request.plan.sandboxed,
    };
    if (this.request.name) info.name = this.request.name;
    if (this.child.pid !== undefined) info.pid = this.child.pid;
    if (this.endedAt !== undefined) info.ended_at = new Date(this.endedAt).toISOString();
    return info;
  }
}

export interface ProcessManagerOptions {
  maxRunning?: number;
  maxFinished?: number;
  bufferChars?: number;
}

/** Owns every command the agent starts, foreground or background. */
export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private sequence = 0;
  private readonly maxRunning: number;
  private readonly maxFinished: number;
  private readonly bufferChars: number;

  constructor(options: ProcessManagerOptions = {}) {
    this.maxRunning = options.maxRunning ?? 24;
    this.maxFinished = options.maxFinished ?? 40;
    this.bufferChars = options.bufferChars ?? 4_000_000;
  }

  start(request: StartRequest): ManagedProcess {
    const all = [...this.processes.values()];
    if (all.filter((p) => p.status === 'running').length >= this.maxRunning) {
      throw new ToolError(
        'CONFLICT',
        `Too many running processes (${this.maxRunning})`,
        'Stop some with stop_process before starting more; list_processes shows what is running.',
      );
    }
    // Forget the oldest finished processes so the table stays bounded.
    const finished = all.filter((p) => p.status !== 'running');
    for (const old of finished.slice(0, Math.max(0, finished.length - this.maxFinished + 1))) {
      this.processes.delete(old.id);
    }
    const proc = new ManagedProcess(`p${++this.sequence}`, request, this.bufferChars);
    this.processes.set(proc.id, proc);
    return proc;
  }

  get(id: string): ManagedProcess {
    const proc = this.processes.get(id);
    if (!proc) {
      throw new ToolError('NOT_FOUND', `Unknown process_id: ${id}`, 'Use list_processes to see the processes this server manages.');
    }
    return proc;
  }

  list(): ProcessInfo[] {
    return [...this.processes.values()].map((p) => p.info());
  }

  get runningCount(): number {
    return [...this.processes.values()].filter((p) => p.status === 'running').length;
  }

  async stopAll(graceMs = 2000): Promise<void> {
    await Promise.all([...this.processes.values()].map((p) => p.stop('SIGTERM', graceMs)));
  }
}
