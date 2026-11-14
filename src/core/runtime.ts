import { EventEmitter } from 'node:events';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AuthMode } from '../server/auth.js';
import { Desktop } from '../desktop/desktop.js';
import { type DesktopDriver, MacDesktopDriver } from '../desktop/driver.js';
import { AuditLog } from './audit.js';
import { ToolError } from './errors.js';
import { PathPolicy, type PermissionMode } from './permissions.js';
import { ProcessManager, resolveShell, type ShellName, type SpawnPlan } from './processes.js';
import { checkSandbox, prepareSandbox, type PreparedSandbox, sandboxArgv, type SandboxCheck } from './sandbox.js';
import { TransferStore } from './transfers.js';

export type RuntimeState = 'setup' | 'ready';

export interface ToolCallEvent {
  tool: string;
  args: unknown;
  ok: boolean;
  durationMs: number;
  code?: string;
  error?: string;
  client?: string;
}

export interface RpcEvent {
  method: string;
  client?: string;
  remote?: string;
}

interface RuntimeEventMap {
  tool: [ToolCallEvent];
  rpc: [RpcEvent];
  change: [];
}

export interface RuntimeOptions {
  /** mcpclaude state directory (config, logs, scratch). */
  stateDir: string;
  authMode: AuthMode;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Write the audit log to disk (default true). */
  auditToDisk?: boolean;
  /** Run Project-Only commands without an OS sandbox if none can be applied (unsafe). */
  allowUnsandboxed?: boolean;
  /** Extra directories sandboxed commands may read / read and write. */
  extraReadOnly?: string[];
  extraReadWrite?: string[];
  /** Desktop driver; by default the macOS driver on macOS and none elsewhere. `null` disables it. */
  desktop?: DesktopDriver | null;
  /** Long edge of full screenshots in pixels (the coordinate space of the desktop tools). */
  screenshotMaxDimension?: number;
}

export interface SandboxStatus {
  /** Whether commands run inside an OS sandbox in the current mode. */
  active: boolean;
  kind: 'seatbelt' | 'none';
  detail: string;
}

/** Variables that hold mcpclaude's own secrets and must not leak into agent commands. */
const OWN_SECRET_ENV = ['NGROK_AUTHTOKEN', 'NGROK_API_KEY', 'MCPCLAUDE_TOKEN', 'MCPCLAUDE_NGROK_AUTHTOKEN'];

export const LIMITS = {
  /** Default cap on command output returned in one tool result. */
  outputChars: 30_000,
  /** Largest HTTP request body accepted on the MCP endpoint. */
  requestBodyBytes: 48 * 1024 * 1024,
  /** Largest file returned inline by read_file without an explicit range. */
  inlineReadBytes: 512 * 1024,
  /** Longest a single tool call may block: hosted clients abort calls after about 240 seconds. */
  callSeconds: 220,
  /** Largest chunk returned by download_file. */
  downloadChunkBytes: 4 * 1024 * 1024,
} as const;

/**
 * Process-wide state shared by every request: the MCP endpoint is stateless, so anything that
 * must outlive a single call lives here.
 */
export class Runtime {
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly authMode: AuthMode;
  readonly events = new EventEmitter<RuntimeEventMap>();
  readonly audit: AuditLog;
  readonly processes = new ProcessManager();
  readonly transfers = new TransferStore();
  readonly startedAt = Date.now();
  /** Screen, mouse, keyboard, applications and windows; undefined where there is no desktop driver. */
  readonly desktop: Desktop | undefined;

  state: RuntimeState = 'setup';
  paused = false;
  /** Tool groups the user switched off for this run. */
  readonly disabledGroups = new Set<string>();
  /** Public base URL of the tunnel (no trailing slash), once known. */
  publicBaseUrl: string | undefined;
  /** Local base URL of the HTTP server. */
  localBaseUrl: string | undefined;

  private policyValue: PathPolicy | undefined;
  private cwdValue: string | undefined;
  private sandbox: PreparedSandbox | undefined;
  private sandboxCheck: SandboxCheck | undefined;
  private readonly options: RuntimeOptions;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.stateDir = options.stateDir;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
    this.authMode = options.authMode;
    this.audit = new AuditLog(options.auditToDisk === false ? undefined : path.join(options.stateDir, 'logs'));
    this.events.setMaxListeners(0);
    const driver = options.desktop === null ? undefined : (options.desktop ?? (this.platform === 'darwin' ? new MacDesktopDriver({ stateDir: this.stateDir }) : undefined));
    this.desktop = driver
      ? new Desktop(driver, options.screenshotMaxDimension !== undefined ? { maxDimension: options.screenshotMaxDimension } : {})
      : undefined;
  }

  /** Called once the user has chosen a directory and a permission level. */
  async configure(settings: { mode: PermissionMode; projectDir: string }): Promise<void> {
    const real = await realpath(path.resolve(settings.projectDir));
    if (!(await stat(real)).isDirectory()) throw new Error(`Not a directory: ${settings.projectDir}`);
    await mkdir(path.join(this.stateDir, 'tmp'), { recursive: true, mode: 0o700 });

    this.sandbox = undefined;
    this.sandboxCheck = undefined;
    if (settings.mode === 'project' && this.platform === 'darwin') {
      const prepareOptions: Parameters<typeof prepareSandbox>[0] = {
        projectDir: real,
        stateDir: this.stateDir,
        home: this.home,
        env: this.env,
        platform: this.platform,
      };
      if (this.options.extraReadOnly) prepareOptions.extraReadOnly = this.options.extraReadOnly;
      if (this.options.extraReadWrite) prepareOptions.extraReadWrite = this.options.extraReadWrite;
      this.sandbox = await prepareSandbox(prepareOptions);
      this.sandboxCheck = await checkSandbox(this.sandbox.profile);
    }
    this.policyValue = new PathPolicy(settings.mode, real);
    this.cwdValue = real;
    this.state = 'ready';
    this.events.emit('change');
  }

  get configured(): boolean {
    return this.policyValue !== undefined;
  }

  /** Whether desktop control (screenshots, input, windows) exists on this host. */
  get desktopAvailable(): boolean {
    return this.desktop !== undefined;
  }

  get policy(): PathPolicy {
    if (!this.policyValue) throw setupPending();
    return this.policyValue;
  }

  get mode(): PermissionMode {
    return this.policy.mode;
  }

  get projectDir(): string {
    return this.policy.projectDir;
  }

  /** Default working directory for relative paths and commands. */
  get cwd(): string {
    if (!this.cwdValue) throw setupPending();
    return this.cwdValue;
  }

  setCwd(dir: string): void {
    this.cwdValue = dir;
  }

  /** Resolve and authorise a path given by the agent. */
  resolvePath(input: string, options?: { followFinal?: boolean }): Promise<string> {
    return this.policy.authorize(input, this.cwd, options);
  }

  /** Directory for temporary files that commands in the current mode can read and write. */
  get scratchDir(): string {
    return this.sandbox ? this.sandbox.tmpDir : path.join(this.stateDir, 'tmp');
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.events.emit('change');
  }

  sandboxStatus(): SandboxStatus {
    if (!this.configured || this.mode === 'full') {
      return { active: false, kind: 'none', detail: 'Not used in Full System Access mode.' };
    }
    if (this.platform !== 'darwin') {
      return {
        active: false,
        kind: 'none',
        detail: 'No OS sandbox on this platform: commands are limited by working directory and path checks only.',
      };
    }
    if (this.sandboxCheck?.ok) {
      return { active: true, kind: 'seatbelt', detail: 'Commands run under macOS Seatbelt, confined to the project directory.' };
    }
    return {
      active: false,
      kind: 'none',
      detail: `Seatbelt sandbox unavailable: ${this.sandboxCheck?.detail ?? 'unknown error'}`,
    };
  }

  /**
   * How to execute `argv` on behalf of the agent. In Project-Only mode on macOS the command
   * is wrapped in the Seatbelt sandbox; if that is impossible the call is refused.
   */
  spawnPlan(argv: string[]): SpawnPlan {
    const [file, ...args] = argv;
    if (!file) throw new ToolError('INVALID_ARGUMENT', 'Empty command');
    if (this.mode === 'full' || this.platform !== 'darwin') return { file, args, sandboxed: false };
    if (this.sandbox && this.sandboxCheck?.ok) {
      return { ...sandboxArgv(this.sandbox.profile, argv), sandboxed: true };
    }
    if (this.options.allowUnsandboxed) return { file, args, sandboxed: false };
    throw new ToolError(
      'FAILED',
      `Commands are disabled: the macOS sandbox required for Project-Only mode could not be applied (${this.sandboxCheck?.detail ?? 'not initialised'}).`,
      'Ask the user to restart mcpclaude in Full System Access mode, or with --unsafe-no-sandbox to accept unconfined commands.',
    );
  }

  /** Spawn plan for a shell command line. */
  shellPlan(command: string, shell?: ShellName): SpawnPlan {
    const shellPath = resolveShell(shell, this.env);
    const sandboxed = this.mode === 'project' && this.platform === 'darwin';
    // Inside the sandbox ~/.zshenv is unreadable; skip startup files (the environment is inherited anyway).
    const flags = sandboxed && path.basename(shellPath) === 'zsh' ? ['-f'] : [];
    return this.spawnPlan([shellPath, ...flags, '-c', command]);
  }

  /** Environment for agent commands: ours minus our secrets, plus sandbox redirections. */
  commandEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.env };
    for (const key of OWN_SECRET_ENV) delete env[key];
    // Pagers and credential prompts would block forever without a terminal.
    env['PAGER'] = 'cat';
    env['GIT_PAGER'] = 'cat';
    env['GIT_TERMINAL_PROMPT'] = '0';
    if (this.sandbox && this.sandboxCheck?.ok) {
      for (const key of this.sandbox.unsetEnv) delete env[key];
      Object.assign(env, this.sandbox.env);
    }
    return { ...env, ...extra };
  }

  /** Throws unless tools may run right now. */
  assertOperational(): void {
    if (this.state !== 'ready' || !this.configured) throw setupPending();
    if (this.paused) {
      throw new ToolError('PAUSED', 'The user has paused this server.', 'Wait for the user to resume it in the mcpclaude terminal.');
    }
  }

  async shutdown(): Promise<void> {
    await this.processes.stopAll();
    await this.audit.flush();
  }
}

function setupPending(): ToolError {
  return new ToolError(
    'SETUP_PENDING',
    'mcpclaude setup is not finished: the user is still choosing the project directory and permission level in the terminal.',
    'Try again in a moment.',
  );
}
