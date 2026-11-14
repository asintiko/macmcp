import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Native test tools for the macOS suites (sources in tests/helpers/native):
 *
 * - `click-recorder`: a window that logs every mouse event it receives, so that a test can
 *   check which button, how many clicks, which modifiers and which position macOS delivered;
 * - `virtual-display`: adds a display (optionally a Retina one) to the Mac while it runs.
 */
const run = promisify(execFile);

function source(name: string): string {
  return fileURLToPath(new URL(`./native/${name}`, import.meta.url));
}

async function compile(compiler: string, args: string[], what: string): Promise<void> {
  try {
    await run(compiler, args, { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    const failure = err as { stderr?: string; message: string };
    throw new Error(`Could not compile ${what}: ${failure.stderr?.trim() || failure.message}`);
  }
}

/** Compile the click recorder to `output`. */
export async function buildClickRecorder(output: string): Promise<string> {
  await compile('/usr/bin/swiftc', ['-swift-version', '5', '-module-name', 'click_recorder', '-o', output, source('click-recorder.swift')], 'the click recorder');
  return output;
}

/** Compile the virtual display tool to `output`. */
export async function buildVirtualDisplay(output: string): Promise<string> {
  await compile('/usr/bin/clang', ['-fobjc-arc', '-framework', 'Cocoa', '-framework', 'CoreGraphics', '-o', output, source('virtual-display.m')], 'the virtual display tool');
  return output;
}

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MouseEventRecord {
  kind: 'down' | 'up' | 'scroll';
  /** 0 = left, 1 = right, 2 = middle. */
  button: number;
  clicks: number;
  modifiers: string[];
  /** Position in global display points, origin at the top-left of the main display. */
  x: number;
  y: number;
}

interface ReadyRecord extends Frame {
  kind: 'ready';
  pid: number;
  scale: number;
  screen: number;
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

/** A running click recorder window. */
export class ClickRecorder {
  private skipped = 0;

  private constructor(
    private readonly child: ChildProcess,
    private readonly logFile: string,
    /** Content area of the window in global display points, as the application itself reports it. */
    readonly content: Frame,
    readonly pid: number,
    /** Pixels per point of the display the window is on (2 on a Retina display). */
    readonly scale: number,
  ) {}

  /** Open the recorder with its content area at `frame` (global display points). */
  static async start(binary: string, logFile: string, frame: Frame): Promise<ClickRecorder> {
    const child = spawn(binary, [logFile, String(frame.x), String(frame.y), String(frame.width), String(frame.height)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    try {
      const ready = await waitFor(
        'the click recorder window',
        async () => {
          if (child.exitCode !== null) throw new Error(`The click recorder exited with code ${child.exitCode}: ${stderr.trim()}`);
          return (await ClickRecorder.read(logFile)).find((entry): entry is ReadyRecord => entry.kind === 'ready');
        },
        30_000,
      );
      return new ClickRecorder(child, logFile, { x: ready.x, y: ready.y, width: ready.width, height: ready.height }, ready.pid, ready.scale);
    } catch (err) {
      await stop(child);
      throw err;
    }
  }

  private static async read(logFile: string): Promise<(MouseEventRecord | ReadyRecord)[]> {
    const text = await readFile(logFile, 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as MouseEventRecord | ReadyRecord);
  }

  /** Mouse events received since the last `forget()`, oldest first. */
  async events(): Promise<MouseEventRecord[]> {
    const all = (await ClickRecorder.read(this.logFile)).filter((entry): entry is MouseEventRecord => entry.kind !== 'ready');
    return all.slice(this.skipped);
  }

  /** Ignore everything received so far. */
  async forget(): Promise<void> {
    this.skipped += (await this.events()).length;
  }

  stop(): Promise<void> {
    return stop(this.child);
  }
}

/** A virtual display that exists until `stop()` is called. */
export class VirtualDisplay {
  private constructor(
    private readonly child: ChildProcess,
    /** CoreGraphics display id. */
    readonly id: number,
  ) {}

  /** Add a display of `width`×`height` points; with `hiDPI` it has twice as many pixels each way. */
  static async start(binary: string, options: { width: number; height: number; hiDPI: boolean }): Promise<VirtualDisplay> {
    const child = spawn(binary, [String(options.width), String(options.height), options.hiDPI ? '1' : '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    try {
      const id = await waitFor(
        'the virtual display',
        async () => {
          const match = /^display (\d+)$/m.exec(stdout);
          if (match) return Number(match[1]);
          if (child.exitCode !== null) throw new Error(`The virtual display tool exited with code ${child.exitCode}: ${stderr.trim()}`);
          return undefined;
        },
        30_000,
      );
      return new VirtualDisplay(child, id);
    } catch (err) {
      await stop(child);
      throw err;
    }
  }

  stop(): Promise<void> {
    return stop(this.child);
  }
}
