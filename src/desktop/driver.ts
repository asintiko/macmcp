import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../core/errors.js';
import { runProgram, type RunResult, sleep } from '../core/exec.js';
import type { Rect } from './geometry.js';
import { DesktopHelper, type HelperCommand } from './helper.js';

export interface CaptureOptions {
  /** 1-based display index for a whole-display capture (default: the main display). */
  display?: number;
  /** Area to capture, in global points. */
  region?: Rect;
  /** Capture one window (without its shadow) instead of a display. */
  windowId?: number;
  /** Draw the mouse pointer into the picture. */
  cursor?: boolean;
}

export interface EncodeOptions {
  width: number;
  height: number;
  format: 'png' | 'jpeg';
  /** JPEG quality, 1-100. */
  quality: number;
}

export interface ScriptOptions {
  language: 'applescript' | 'javascript';
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Everything the desktop tools need from the operating system. The macOS implementation is
 * below; tests substitute a fake so that the tool logic can be exercised on any platform.
 */
export interface DesktopDriver {
  /** Run helper commands in order; rejects with a ToolError (HelperFailure) at the first failure. */
  run(commands: HelperCommand[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown[]>;
  /** Capture the screen as a PNG at the display's native resolution. */
  capture(options: CaptureOptions): Promise<Buffer>;
  /** Scale a PNG to the given pixel size and encode it. */
  encode(png: Buffer, options: EncodeOptions): Promise<Buffer>;
  /** Run AppleScript or JavaScript for Automation. */
  script(source: string, options: ScriptOptions): Promise<RunResult>;
  /** Open applications, documents and URLs through LaunchServices (`open`). */
  open(args: string[]): Promise<RunResult>;
  /** Get ready for use; reports once if that takes a while (compiling the helper). */
  prepare(onSlow?: () => void): Promise<void>;
}

const SCREENCAPTURE = '/usr/sbin/screencapture';
/** How often a capture of the screen is tried before giving up, and the pause in between. */
const CAPTURE_ATTEMPTS = 3;
const CAPTURE_RETRY_MS = 400;
const SIPS = '/usr/bin/sips';
const OSASCRIPT = '/usr/bin/osascript';
const OPEN = '/usr/bin/open';

export class MacDesktopDriver implements DesktopDriver {
  readonly helper: DesktopHelper;
  private readonly tmpDir: string;
  private readonly screencapture: string;

  /** `screencapture` replaces the system tool (tests). */
  constructor(options: { stateDir: string; helper?: DesktopHelper; screencapture?: string }) {
    this.helper = options.helper ?? new DesktopHelper({ stateDir: options.stateDir });
    this.tmpDir = path.join(options.stateDir, 'tmp');
    this.screencapture = options.screencapture ?? SCREENCAPTURE;
  }

  async prepare(onSlow?: () => void): Promise<void> {
    await this.helper.ensureBuilt(onSlow);
  }

  run(commands: HelperCommand[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown[]> {
    return this.helper.run(commands, options);
  }

  private async scratch(extension: string): Promise<string> {
    await mkdir(this.tmpDir, { recursive: true, mode: 0o700 });
    return path.join(this.tmpDir, `shot-${randomBytes(6).toString('hex')}.${extension}`);
  }

  async capture(options: CaptureOptions): Promise<Buffer> {
    const args = ['-x', '-t', 'png'];
    if (options.cursor) args.push('-C');
    if (options.windowId !== undefined) {
      args.push('-o', '-l', String(options.windowId));
    } else if (options.region) {
      const { x, y, width, height } = options.region;
      args.push(`-R${Math.round(x)},${Math.round(y)},${Math.max(1, Math.round(width))},${Math.max(1, Math.round(height))}`);
    } else {
      args.push('-D', String(options.display ?? 1));
    }
    // macOS now and then refuses a capture of the screen for a moment ("could not create image
    // from display") while an application starts or the displays, Spaces or full-screen windows
    // change. A window that cannot be captured, on the other hand, is usually simply gone.
    const attempts = options.windowId === undefined ? CAPTURE_ATTEMPTS : 1;
    let detail = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const file = await this.scratch('png');
      try {
        const result = await runProgram(this.screencapture, [...args, file], { timeoutMs: 30_000 });
        const data = await readFile(file).catch(() => undefined);
        if (result.code === 0 && data && data.length > 0) return data;
        detail = (result.stderr || result.stdout).trim();
      } finally {
        await rm(file, { force: true }).catch(() => undefined);
      }
      if (attempt < attempts) await sleep(CAPTURE_RETRY_MS);
    }
    if (options.windowId !== undefined) {
      throw new ToolError(
        'FAILED',
        `Window ${options.windowId} could not be captured${detail ? ` (${detail})` : ''}.`,
        'It may be closed, minimised or on another Space: check list_windows, or take a normal screenshot.',
      );
    }
    // Whether Screen Recording access is there at all is checked before a capture is attempted
    // (Desktop.screenshot), so this is something else.
    throw new ToolError(
      'FAILED',
      `The screen could not be captured${detail ? ` (${detail})` : ''}.`,
      'macOS refuses this for a moment while displays, Spaces or full-screen windows change: wait a second and try again. If it keeps failing, the display may be asleep or locked.',
    );
  }

  async encode(png: Buffer, options: EncodeOptions): Promise<Buffer> {
    const source = await this.scratch('png');
    const target = await this.scratch(options.format === 'jpeg' ? 'jpg' : 'png');
    try {
      await writeFile(source, png);
      const args = ['-s', 'format', options.format];
      if (options.format === 'jpeg') args.push('-s', 'formatOptions', String(Math.round(options.quality)));
      // sips takes the height first.
      args.push('-z', String(options.height), String(options.width), source, '--out', target);
      const result = await runProgram(SIPS, args, { timeoutMs: 30_000 });
      const data = await readFile(target).catch(() => undefined);
      if (result.code !== 0 || !data || data.length === 0) {
        throw new ToolError('FAILED', `The screenshot could not be converted: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
      }
      return data;
    } finally {
      await rm(source, { force: true }).catch(() => undefined);
      await rm(target, { force: true }).catch(() => undefined);
    }
  }

  script(source: string, options: ScriptOptions): Promise<RunResult> {
    // The script is read from standard input, so no quoting is involved.
    const args = ['-l', options.language === 'javascript' ? 'JavaScript' : 'AppleScript', '-', ...options.args];
    return runProgram(OSASCRIPT, args, {
      input: source,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: 4 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  open(args: string[]): Promise<RunResult> {
    return runProgram(OPEN, args, { timeoutMs: 60_000 });
  }
}
