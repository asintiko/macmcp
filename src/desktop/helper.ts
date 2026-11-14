import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativePath } from '../assets.js';
import { ToolError } from '../core/errors.js';
import { runProgram } from '../core/exec.js';

export interface HelperCommand {
  command: string;
  params?: Record<string, unknown>;
}

interface HelperReply {
  ok: boolean;
  results?: unknown[];
  index?: number;
  error?: { code?: string; message?: string };
}

export const ACCESSIBILITY_HINT =
  'Ask the user to open System Settings → Privacy & Security → Accessibility, enable the application that runs mcpclaude (Terminal, iTerm, …) and restart mcpclaude. You cannot grant this yourself.';

export const SCREEN_RECORDING_HINT =
  'Ask the user to open System Settings → Privacy & Security → Screen & System Audio Recording, enable the application that runs mcpclaude (Terminal, iTerm, …) and restart mcpclaude. You cannot grant this yourself.';

/** Error raised by a helper command, with the position of the command that failed. */
export class HelperFailure extends ToolError {
  /** Index of the failed command; the commands before it were carried out. */
  readonly index: number;
  /** Results of the commands that succeeded. */
  readonly completed: unknown[];

  constructor(error: ToolError, index: number, completed: unknown[]) {
    super(error.code, error.message, error.hint);
    this.index = index;
    this.completed = completed;
  }
}

function toToolError(code: string | undefined, message: string): ToolError {
  switch (code) {
    case 'ACCESSIBILITY_REQUIRED':
      return new ToolError('MACOS_PERMISSION_REQUIRED', message, ACCESSIBILITY_HINT);
    case 'INVALID':
      return new ToolError('INVALID_ARGUMENT', message);
    case 'NOT_FOUND':
      return new ToolError('NOT_FOUND', message);
    default:
      return new ToolError('FAILED', message);
  }
}

export interface DesktopHelperOptions {
  /** mcpclaude state directory; the binary is cached in `bin/` beneath it. */
  stateDir: string;
  /** Directory holding the Swift sources (default: the package's native/helper). */
  sourceDir?: string;
  /** Swift compiler to use (default: swiftc on PATH, through xcrun). */
  swiftc?: string;
}

/**
 * The compiled Swift helper that posts input events and talks to the Accessibility API.
 * It is built from source on the user's Mac on first use and cached, keyed by a hash of the
 * sources, so an upgrade of mcpclaude rebuilds it automatically.
 */
export class DesktopHelper {
  private readonly stateDir: string;
  private readonly sourceDir: string;
  private readonly swiftc: string;
  private readonly customCompiler: boolean;
  private building: Promise<string> | undefined;

  constructor(options: DesktopHelperOptions) {
    this.stateDir = options.stateDir;
    this.sourceDir = options.sourceDir ?? nativePath('helper');
    this.swiftc = options.swiftc ?? '/usr/bin/swiftc';
    this.customCompiler = options.swiftc !== undefined;
  }

  private async sources(): Promise<string[]> {
    const names = (await readdir(this.sourceDir).catch(() => [])).filter((name) => name.endsWith('.swift')).sort();
    if (names.length === 0) throw new ToolError('INTERNAL', `Desktop helper sources are missing from ${this.sourceDir}`);
    return names.map((name) => path.join(this.sourceDir, name));
  }

  /** Where the binary for the current sources lives (it may not exist yet). */
  async binaryPath(): Promise<string> {
    const hash = createHash('sha256');
    for (const file of await this.sources()) {
      hash.update(path.basename(file));
      hash.update(await readFile(file));
    }
    hash.update(os.arch());
    return path.join(this.stateDir, 'bin', `mcpclaude-helper-${hash.digest('hex').slice(0, 16)}`);
  }

  async isBuilt(): Promise<boolean> {
    return access(await this.binaryPath(), fsConstants.X_OK).then(
      () => true,
      () => false,
    );
  }

  /** Path of the helper binary, compiling it first if necessary (about half a minute, once). */
  ensureBuilt(onBuild?: () => void): Promise<string> {
    this.building ??= this.build(onBuild).finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  private async build(onBuild?: () => void): Promise<string> {
    const target = await this.binaryPath();
    if (await this.isBuilt()) return target;
    onBuild?.();

    // /usr/bin/swiftc is a stub that opens an installer dialog when the tools are missing.
    const tools = this.customCompiler ? { code: 0 } : await runProgram('/usr/bin/xcode-select', ['-p'], { timeoutMs: 10_000 }).catch(() => undefined);
    if (!tools || tools.code !== 0) {
      throw new ToolError(
        'DEPENDENCY_MISSING',
        'Desktop control needs the Xcode Command Line Tools to build its helper, and they are not installed.',
        'Ask the user to run "xcode-select --install" in Terminal, wait for the installation to finish and restart mcpclaude.',
      );
    }

    const binDir = path.dirname(target);
    await mkdir(binDir, { recursive: true, mode: 0o700 });
    const partial = `${target}.${process.pid}.partial`;
    const sources = await this.sources();
    const result = await runProgram(this.swiftc, ['-swift-version', '5', '-module-name', 'mcpclaude_helper', '-o', partial, ...sources], {
      timeoutMs: 10 * 60_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    if (result.timedOut || result.code !== 0) {
      await rm(partial, { force: true });
      const detail = (result.stderr || result.stdout).trim();
      throw new ToolError(
        'DEPENDENCY_MISSING',
        `The desktop helper could not be compiled${result.timedOut ? ' (timed out)' : ''}:\n${detail.slice(0, 4000)}`,
        'Check that the Xcode Command Line Tools work ("swiftc --version"); "mcpclaude doctor" repeats this check.',
      );
    }
    await rename(partial, target);

    // Binaries of earlier versions are no longer needed.
    for (const name of await readdir(binDir).catch(() => [])) {
      if (name.startsWith('mcpclaude-helper-') && path.join(binDir, name) !== target) {
        await rm(path.join(binDir, name), { force: true }).catch(() => undefined);
      }
    }
    return target;
  }

  /** Run commands in order. Rejects with a HelperFailure at the first command that fails. */
  async run(commands: HelperCommand[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown[]> {
    if (commands.length === 0) return [];
    const binary = await this.ensureBuilt();
    const result = await runProgram(binary, [], {
      input: JSON.stringify({ commands }),
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.timedOut) throw new ToolError('TIMEOUT', 'The desktop helper did not finish in time; the application it was talking to may be unresponsive.');

    let reply: HelperReply | undefined;
    const line = result.stdout.trim().split('\n').pop() ?? '';
    try {
      reply = JSON.parse(line) as HelperReply;
    } catch {
      reply = undefined;
    }
    if (!reply || typeof reply.ok !== 'boolean') {
      const detail = (result.stderr || result.stdout).trim().slice(-600);
      throw new ToolError('FAILED', `The desktop helper stopped unexpectedly (${result.signal ?? `exit ${result.code}`})${detail ? `: ${detail}` : ''}`);
    }
    if (!reply.ok) {
      throw new HelperFailure(toToolError(reply.error?.code, reply.error?.message ?? 'Desktop helper error'), reply.index ?? 0, reply.results ?? []);
    }
    return reply.results ?? [];
  }
}
