import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from './errors.js';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. */
  input?: string | Buffer;
  timeoutMs?: number;
  /** Cap for each of stdout and stderr; further output is discarded. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Raw stdout, for binary output. */
  stdoutBytes: Buffer;
  timedOut: boolean;
}

/**
 * Run a helper program (not an agent command) to completion and collect its output.
 * Resolves for any exit status; rejects only when the program cannot be started.
 */
export function runProgram(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const maxBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let timedOut = false;
    let settled = false;

    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, options.timeoutMs)
        : undefined;
    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (outSize < maxBytes) out.push(chunk);
      outSize += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errSize < maxBytes) err.push(chunk);
      errSize += chunk.length;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === 'ENOENT') {
          reject(new ToolError('DEPENDENCY_MISSING', `Program not found: ${file}`));
        } else {
          reject(error);
        }
      });
    });
    let status: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const complete = (): void => {
      finish(() => {
        // Stop listening to pipes a surviving grandchild may still hold open.
        child.stdout.destroy();
        child.stderr.destroy();
        const stdoutBytes = Buffer.concat(out);
        resolve({
          code: status?.code ?? null,
          signal: status?.signal ?? null,
          stdout: stdoutBytes.toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          stdoutBytes,
          timedOut,
        });
      });
    };
    child.on('exit', (code, signal) => {
      status = { code, signal };
      // 'close' waits for the pipes, which a surviving grandchild can hold open; do not wait for it long.
      setTimeout(complete, timedOut || options.signal?.aborted ? 0 : 300).unref();
    });
    child.on('close', (code, signal) => {
      status ??= { code, signal };
      complete();
    });
    // A program that exits without reading stdin must not crash us with EPIPE.
    child.stdin.on('error', () => undefined);
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Like runProgram, but a non-zero exit or timeout becomes a ToolError. */
export async function runProgramChecked(
  file: string,
  args: readonly string[],
  options: RunOptions & { what?: string } = {},
): Promise<RunResult> {
  const result = await runProgram(file, args, options);
  const what = options.what ?? path.basename(file);
  if (result.timedOut) throw new ToolError('TIMEOUT', `${what} timed out`);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
    throw new ToolError('FAILED', `${what} failed (exit ${result.code ?? result.signal})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

/** Locate an executable on PATH without spawning a shell. */
export async function which(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (command.includes('/')) {
    return (await isExecutable(command)) ? path.resolve(command) : undefined;
  }
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Keep the head and tail of long text, noting how much was dropped in the middle. */
export function truncateMiddle(text: string, maxChars: number): { text: string; truncated: number } {
  if (text.length <= maxChars) return { text, truncated: 0 };
  const head = Math.floor(maxChars * 0.3);
  const tail = maxChars - head;
  const dropped = text.length - maxChars;
  return {
    text: `${text.slice(0, head)}\n… [${dropped} characters truncated] …\n${text.slice(text.length - tail)}`,
    truncated: dropped,
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
