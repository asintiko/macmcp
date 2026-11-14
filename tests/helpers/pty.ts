import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface, type Interface } from 'node:readline';

const DRIVER = fileURLToPath(new URL('./pty_driver.py', import.meta.url));

/** Whether a pseudo-terminal can be driven on this machine (needs python3, present on macOS and CI). */
export const ptyAvailable = spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status === 0;

export const KEY = {
  enter: '\r',
  up: '\u001b[A',
  down: '\u001b[B',
  ctrlC: '\u0003',
  ctrlU: '\u0015',
  backspace: '\u007f',
} as const;

interface Reply {
  ok: boolean;
  match?: string;
  groups?: (string | null)[];
  error?: string;
  exit_code?: number | null;
  unread?: string;
  text?: string;
}

export interface PtyOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

/** A command running on a pseudo-terminal, driven step by step from a test. */
export class PtySession {
  private readonly driver: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly waiting: ((reply: Reply) => void)[] = [];
  private closed = false;

  constructor(argv: string[], options: PtyOptions = {}) {
    this.driver = spawn('python3', [DRIVER, JSON.stringify(argv)], {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), PTY_COLS: String(options.cols ?? 120), PTY_ROWS: String(options.rows ?? 50) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.driver.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[pty driver] ${chunk.toString()}`));
    this.lines = createInterface({ input: this.driver.stdout });
    this.lines.on('line', (line) => this.waiting.shift()?.(JSON.parse(line) as Reply));
    this.driver.on('exit', () => {
      this.closed = true;
      for (const resolve of this.waiting.splice(0)) resolve({ ok: false, error: 'driver exited' });
    });
  }

  private request(command: Record<string, unknown>): Promise<Reply> {
    if (this.closed) return Promise.resolve({ ok: false, error: 'driver exited' });
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.driver.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }

  /**
   * Wait until output that has not been matched yet contains the pattern (a literal string or
   * a regular expression in syntax shared by JavaScript and Python). Returns the capture groups.
   */
  async expect(pattern: string | RegExp, timeoutSeconds = 20): Promise<string[]> {
    const source = typeof pattern === 'string' ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern.source;
    const reply = await this.request({ op: 'expect', pattern: source, timeout: timeoutSeconds });
    if (!reply.ok) {
      throw new Error(`Terminal never showed ${String(pattern)} (${reply.error}, exit code ${reply.exit_code}). Unread output:\n${reply.unread ?? ''}`);
    }
    return [reply.match ?? '', ...(reply.groups ?? []).map((g) => g ?? '')];
  }

  async send(data: string): Promise<void> {
    // Prompts need a moment to attach their key listeners after drawing.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await this.request({ op: 'send', data });
  }

  /** Resolves with the exit code (negative signal number if killed), or null if still running. */
  async waitExit(timeoutSeconds = 20): Promise<{ code: number | null; exited: boolean; unread: string }> {
    const reply = await this.request({ op: 'wait_exit', timeout: timeoutSeconds });
    return { code: reply.exit_code ?? null, exited: reply.ok, unread: reply.unread ?? '' };
  }

  async transcript(): Promise<string> {
    return (await this.request({ op: 'transcript' })).text ?? '';
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.request({ op: 'kill' });
    this.driver.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.closed) resolve();
      else this.driver.once('exit', () => resolve());
    });
    this.lines.close();
  }
}
