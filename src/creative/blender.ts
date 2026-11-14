import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { assetPath } from '../assets.js';
import { ToolError } from '../core/errors.js';
import { runProgram, sleep, which } from '../core/exec.js';
import type { Runtime } from '../core/runtime.js';

/** A Blender found on this machine. */
export interface BlenderInstall {
  /** The executable. */
  path: string;
  /** The application bundle it lives in (macOS). */
  bundle?: string;
  /** "4.4.3"; undefined if the executable did not answer. */
  version: string | undefined;
}

/** What the bridge reports after running code. */
export interface BridgeResponse {
  ok: boolean;
  result?: unknown;
  stdout?: string;
  error?: string;
  traceback?: string;
  seconds?: number;
  blender_version?: string;
  /** Path of the open .blend file; empty for an unsaved scene. */
  file?: string;
  /** Path the file was saved to (headless runs with `save`). */
  saved?: string;
}

export interface BlenderSession {
  pid: number;
  port: number;
  token: string;
  blender_version: string;
  started: number;
}

export const BRIDGE_SCRIPT = assetPath('blender', 'mcpclaude_bridge.py');

const INSTALL_HINT =
  'Ask the user to install Blender (https://www.blender.org/download/ or "brew install --cask blender"). If it is installed in an unusual place, they can start mcpclaude with MCPCLAUDE_BLENDER=/path/to/blender.';

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => undefined))?.isFile() ?? false;
}

/** The executable inside a macOS application bundle, or the path itself. */
function executableOf(candidate: string): { path: string; bundle?: string } {
  if (candidate.endsWith('.app')) return { path: path.join(candidate, 'Contents', 'MacOS', 'Blender'), bundle: candidate };
  const inBundle = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(candidate);
  return inBundle?.[1] ? { path: candidate, bundle: inBundle[1] } : { path: candidate };
}

/** Places where Blender is usually installed, most specific first. */
async function candidates(runtime: Runtime): Promise<{ path: string; bundle?: string }[]> {
  const found: { path: string; bundle?: string }[] = [];
  const override = runtime.env['MCPCLAUDE_BLENDER']?.trim();
  if (override) found.push(executableOf(path.resolve(override)));

  if (runtime.platform === 'darwin') {
    for (const root of ['/Applications', path.join(runtime.home, 'Applications')]) {
      const names = (await readdir(root).catch(() => [])).filter((name) => /^blender.*\.app$/i.test(name));
      // "Blender.app" before versioned copies, newer versions before older ones.
      names.sort((a, b) => (a.toLowerCase() === 'blender.app' ? -1 : b.toLowerCase() === 'blender.app' ? 1 : b.localeCompare(a, undefined, { numeric: true })));
      for (const name of names) found.push(executableOf(path.join(root, name)));
    }
  }
  const onPath = await which('blender', runtime.env);
  if (onPath) found.push(executableOf(onPath));
  if (runtime.platform !== 'darwin') {
    for (const file of ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', '/opt/blender/blender']) found.push({ path: file });
  }
  return found;
}

const versionCache = new Map<string, Promise<string | undefined>>();

/** Ask an executable for its version. The first start after installation can take a while on macOS. */
export function blenderVersion(binary: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  let pending = versionCache.get(binary);
  if (!pending) {
    pending = runProgram(binary, ['--version'], { timeoutMs: 90_000, env, maxOutputBytes: 64 * 1024 })
      .then((result) => /Blender\s+(\d+\.\d+(?:\.\d+)?)/.exec(result.stdout)?.[1])
      .catch(() => undefined);
    versionCache.set(binary, pending);
    // A failure is not remembered: Blender may be installed or repaired meanwhile.
    void pending.then((version) => {
      if (version === undefined) versionCache.delete(binary);
    });
  }
  return pending;
}

/** Every Blender on this machine, the preferred one first. */
export async function findBlenderInstalls(runtime: Runtime): Promise<BlenderInstall[]> {
  const installs: BlenderInstall[] = [];
  const seen = new Set<string>();
  for (const candidate of await candidates(runtime)) {
    if (!(await isFile(candidate.path))) continue;
    const real = await realpath(candidate.path).catch(() => candidate.path);
    if (seen.has(real)) continue;
    seen.add(real);
    installs.push({ ...candidate, version: await blenderVersion(candidate.path, runtime.commandEnv()) });
  }
  return installs;
}

/** The Blender to use, or an error that says how to get one. */
export async function requireBlender(runtime: Runtime): Promise<BlenderInstall> {
  for (const candidate of await candidates(runtime)) {
    if (await isFile(candidate.path)) return { ...candidate, version: await blenderVersion(candidate.path, runtime.commandEnv()) };
  }
  throw new ToolError('DEPENDENCY_MISSING', 'Blender was not found on this Mac.', INSTALL_HINT);
}

// ── Headless runs ────────────────────────────────────────────────────────────────────────────

export interface HeadlessOptions {
  binary: string;
  code: string;
  /** .blend file to open before the code runs. */
  blendFile?: string | undefined;
  /** Values available to the code as the list `args`. */
  args?: string[] | undefined;
  /** Save the .blend file after the code ran without error. */
  save?: boolean | undefined;
  /** Where to save when no file was opened. */
  saveAs?: string | undefined;
  /** Ignore the user's preferences, startup file and add-ons. */
  factorySettings?: boolean | undefined;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export interface HeadlessResult extends BridgeResponse {
  /** What Blender itself printed (operators and render progress write here, not to Python's stdout). */
  log: string;
}

/** Run Python in a new background Blender and return what the bridge reports. */
export async function runHeadless(runtime: Runtime, options: HeadlessOptions): Promise<HeadlessResult> {
  const dir = path.join(runtime.scratchDir, `blender-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const codeFile = path.join(dir, 'code.py');
  const requestFile = path.join(dir, 'request.json');
  const resultFile = path.join(dir, 'result.json');
  try {
    await writeFile(codeFile, options.code);
    await writeFile(
      requestFile,
      JSON.stringify({ code_file: codeFile, result_file: resultFile, args: options.args ?? [], save: options.save === true, ...(options.saveAs ? { save_as: options.saveAs } : {}) }),
    );
    const argv = ['--background'];
    if (options.factorySettings) argv.push('--factory-startup');
    if (options.blendFile) argv.push(options.blendFile);
    argv.push('--python', BRIDGE_SCRIPT, '--', '--mcpclaude-exec', requestFile);

    const run = await runProgram(options.binary, argv, {
      cwd: runtime.cwd,
      env: runtime.commandEnv(),
      timeoutMs: options.timeoutMs,
      maxOutputBytes: 2 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const log = `${run.stdout}${run.stderr ? `\n${run.stderr}` : ''}`.trim();
    if (run.timedOut) {
      throw new ToolError(
        'TIMEOUT',
        `Blender did not finish within ${Math.round(options.timeoutMs / 1000)} s and was stopped.`,
        'Raise timeout_seconds, or for long jobs use blender_render (renders continue in the background) or start_process with "blender --background --python script.py".',
      );
    }
    if (options.signal?.aborted) throw new ToolError('CANCELLED', 'The request was cancelled; Blender was stopped.');
    const raw = await readFile(resultFile, 'utf8').catch(() => undefined);
    if (raw === undefined) {
      const tail = log.split('\n').slice(-25).join('\n');
      throw new ToolError(
        'FAILED',
        `Blender ended (${run.signal ?? `exit code ${run.code}`}) before the code had run${options.blendFile ? `; it may not have been able to open ${options.blendFile}` : ''}.${tail ? `\n${tail}` : ''}`,
      );
    }
    return { ...(JSON.parse(raw) as BridgeResponse), log };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── Live sessions ────────────────────────────────────────────────────────────────────────────

export function sessionFile(runtime: Runtime): string {
  return path.join(runtime.stateDir, 'blender-session.json');
}

async function readSession(runtime: Runtime): Promise<BlenderSession | undefined> {
  try {
    const parsed = JSON.parse(await readFile(sessionFile(runtime), 'utf8')) as Partial<BlenderSession>;
    if (typeof parsed.port === 'number' && typeof parsed.token === 'string' && typeof parsed.pid === 'number') return parsed as BlenderSession;
  } catch {
    // No session, or a file that is still being written.
  }
  return undefined;
}

/** Send one request to the bridge inside a running Blender and wait for its answer. */
export function bridgeRequest(session: BlenderSession, request: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: session.port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      action();
    };
    const timer = setTimeout(() => finish(() => reject(new ToolError('TIMEOUT', `Blender did not answer within ${Math.round(timeoutMs / 1000)} s.`))), timeoutMs);
    const onAbort = (): void => finish(() => reject(new ToolError('CANCELLED', 'The request was cancelled')));
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...request, token: session.token })}\n`));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', (error: NodeJS.ErrnoException) => finish(() => reject(error)));
    socket.on('close', () =>
      finish(() => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        } catch {
          reject(new ToolError('FAILED', 'Blender closed the connection without a complete answer; it may have quit or crashed.'));
        }
      }),
    );
  });
}

export interface LiveStatus {
  session: BlenderSession;
  /** The bridge is running code right now. */
  busy: boolean;
}

/** The Blender started by blender_launch, if it is still running and answering. */
export async function liveSession(runtime: Runtime): Promise<LiveStatus | undefined> {
  const session = await readSession(runtime);
  if (!session) return undefined;
  try {
    const pong = await bridgeRequest(session, { op: 'ping' }, 4000);
    if (pong['ok'] === true && pong['pid'] === session.pid) return { session, busy: pong['busy'] === true };
  } catch (err) {
    if (err instanceof ToolError && err.code === 'TIMEOUT') {
      throw new ToolError('TIMEOUT', 'The running Blender does not answer; it may be frozen or showing a modal dialog.', 'Take a screenshot to see what Blender is doing.');
    }
    // Connection refused: that Blender is gone.
  }
  await rm(sessionFile(runtime), { force: true }).catch(() => undefined);
  return undefined;
}

/**
 * Run code inside the live session. Unless `readOnly` is set the bridge records an undo step
 * afterwards, so the user can undo what the code did.
 */
export async function runLive(session: BlenderSession, code: string, args: string[], timeoutMs: number, signal?: AbortSignal, readOnly = false): Promise<BridgeResponse> {
  try {
    return (await bridgeRequest(session, { op: 'exec', code, args, undo: !readOnly }, timeoutMs, signal)) as unknown as BridgeResponse;
  } catch (err) {
    if (err instanceof ToolError && err.code === 'TIMEOUT') {
      throw new ToolError(
        'TIMEOUT',
        `The code did not finish within ${Math.round(timeoutMs / 1000)} s. It keeps running inside Blender, which does not respond to anything else until it is done.`,
        'Check with blender_info or a screenshot. For long renders use blender_render instead.',
      );
    }
    if (err instanceof ToolError) throw err;
    throw new ToolError('FAILED', `The connection to Blender was lost (${(err as Error).message}); it may have quit or crashed.`);
  }
}

export interface LaunchOptions {
  install: BlenderInstall;
  blendFile?: string | undefined;
  factorySettings?: boolean | undefined;
  waitSeconds: number;
  signal?: AbortSignal | undefined;
}

/** Start Blender with its window and the bridge, and wait until the bridge answers. */
export async function launchBlender(runtime: Runtime, options: LaunchOptions): Promise<LiveStatus> {
  const file = sessionFile(runtime);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await rm(file, { force: true });

  const args: string[] = [];
  if (options.factorySettings) args.push('--factory-startup');
  if (options.blendFile) args.push(options.blendFile);
  args.push('--python', BRIDGE_SCRIPT, '--', '--mcpclaude-serve', file);

  let exited: string | undefined;
  if (runtime.platform === 'darwin' && options.install.bundle) {
    // Through LaunchServices, so that Blender starts as a regular application in front.
    const opened = await runProgram('/usr/bin/open', ['-n', '-a', options.install.bundle, '--args', ...args], { timeoutMs: 60_000 });
    if (opened.code !== 0) throw new ToolError('FAILED', `Blender could not be started: ${(opened.stderr || opened.stdout).trim() || `open exited with ${opened.code}`}`);
  } else {
    const child = spawn(options.install.path, args, { cwd: runtime.cwd, env: runtime.commandEnv(), detached: true, stdio: 'ignore' });
    child.on('error', (error) => (exited = error.message));
    child.on('exit', (code, signal) => (exited = signal ?? `exit code ${code}`));
    child.unref();
  }

  const deadline = Date.now() + options.waitSeconds * 1000;
  while (Date.now() < deadline && !options.signal?.aborted) {
    const live = await liveSession(runtime).catch(() => undefined);
    if (live) return live;
    if (exited !== undefined) {
      throw new ToolError('FAILED', `Blender ended right after starting (${exited}).`, 'Run "blender --version" with run_command to see whether it starts at all; a display is required for the interface.');
    }
    await sleep(300, options.signal);
  }
  throw new ToolError(
    'TIMEOUT',
    `Blender was started but its bridge did not answer within ${options.waitSeconds} s.`,
    'It may still be loading (first start, large file) or showing a dialog: take a screenshot, then call blender_info to see whether the session is up.',
  );
}
