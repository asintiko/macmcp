import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProgram } from './exec.js';
import { isWithin } from './permissions.js';

/**
 * macOS Seatbelt (`sandbox-exec`) confinement for Project-Only mode.
 *
 * The profile denies everything by default and then allows: process creation, network over
 * IP, reads of system/toolchain locations, and reads+writes of the project directory and a
 * private scratch area. User data outside the project (home directories, other volumes,
 * shared temp directories, keychains, app preferences) stays unreadable, and indirect escape
 * routes (Apple events, LaunchServices, launchd jobs, arbitrary unix sockets) stay closed.
 */

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export interface SandboxSpec {
  /** Real path of the project directory (read + write). */
  projectDir: string;
  /** Real paths of additional read+write directories (scratch, caches, user additions). */
  readWriteDirs: string[];
  /** Real paths of additional read-only directories (toolchains, user additions). */
  readOnlyDirs: string[];
  /** Real paths of single read-only files (for example ~/.gitconfig). */
  readOnlyFiles: string[];
}

export interface SeatbeltProfile {
  profile: string;
  /** `-DKEY=value` arguments that bind the path parameters used by the profile. */
  defines: string[];
}

/** Services command-line tools need for user lookup, logging, DNS, TLS trust and file events. */
const MACH_SERVICES = [
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership',
  'com.apple.system.notification_center',
  'com.apple.system.logger',
  'com.apple.logd',
  'com.apple.logd.events',
  'com.apple.diagnosticd',
  'com.apple.bsd.dirhelper',
  'com.apple.SecurityServer',
  'com.apple.securityd.xpc',
  'com.apple.trustd',
  'com.apple.trustd.agent',
  'com.apple.ocspd',
  'com.apple.networkd',
  'com.apple.dnssd.service',
  'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.DNSConfiguration',
  'com.apple.CoreServices.coreservicesd',
  'com.apple.lsd.mapdb',
  'com.apple.FSEvents',
  'com.apple.PowerManagement.control',
  'com.apple.distributed_notifications@Uv3',
];

/** Locations every program may read: the OS, installed software and device nodes. */
const SYSTEM_READ_SUBPATHS = [
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library',
  '/opt',
  '/Applications',
  '/nix',
  '/dev',
  '/private/etc',
  '/private/var/db',
  '/private/var/select',
  '/private/var/run',
];

/** Single entries needed to walk from `/` to the allowed subtrees. */
const SYSTEM_READ_LITERALS = ['/', '/tmp', '/var', '/etc', '/private', '/private/var'];

const DEVICE_WRITE_LITERALS = ['/dev/null', '/dev/zero', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/dtracehelper', '/dev/ptmx'];

function paramRules(kind: 'subpath' | 'literal', prefix: string, values: string[], defines: string[]): string[] {
  return values.map((value, index) => {
    const key = `${prefix}_${index}`;
    defines.push(`-D${key}=${value}`);
    return `(${kind} (param "${key}"))`;
  });
}

function quoted(kind: 'subpath' | 'literal', values: string[]): string[] {
  return values.map((value) => `(${kind} ${JSON.stringify(value)})`);
}

/** Render the profile. All paths in `spec` must already be symlink-free. */
export function buildSeatbeltProfile(spec: SandboxSpec): SeatbeltProfile {
  const defines: string[] = [`-DPROJECT=${spec.projectDir}`];
  const project = '(subpath (param "PROJECT"))';
  const readWrite = paramRules('subpath', 'RW', spec.readWriteDirs, defines);
  const readOnly = paramRules('subpath', 'RO', spec.readOnlyDirs, defines);
  const readOnlyFiles = paramRules('literal', 'ROF', spec.readOnlyFiles, defines);

  const block = (head: string, rules: string[]): string => `(${head}\n${rules.map((r) => `  ${r}`).join('\n')})`;

  const profile = [
    '(version 1)',
    '(deny default)',
    '',
    '; processes: run and signal only what lives inside this sandbox',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow ipc-posix-sem)',
    '(allow ipc-posix-shm)',
    '(allow pseudo-tty)',
    '(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))',
    block('allow mach-lookup', MACH_SERVICES.map((name) => `(global-name ${JSON.stringify(name)})`)),
    '',
    '; network: IP sockets freely; unix sockets only for DNS and inside writable directories',
    '(allow system-socket)',
    '(allow network-outbound (remote ip "*:*"))',
    '(allow network-inbound (local ip "*:*"))',
    '(allow network-bind (local ip "*:*"))',
    '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
    block('allow network*', [project, ...readWrite]),
    '',
    '; reads: system and toolchains, the project, the private scratch area',
    '(allow file-read-metadata (vnode-type DIRECTORY))',
    '(allow file-read-metadata (vnode-type SYMLINK))',
    '(allow file-map-executable)',
    block('allow file-read*', [
      ...quoted('literal', SYSTEM_READ_LITERALS),
      ...quoted('subpath', SYSTEM_READ_SUBPATHS),
      project,
      ...readWrite,
      ...readOnly,
      ...readOnlyFiles,
    ]),
    '',
    '; writes: only the project and the private scratch area',
    block('allow file-write*', [project, ...readWrite, ...quoted('literal', DEVICE_WRITE_LITERALS), '(regex #"^/dev/fd/[0-9]+$")', '(regex #"^/dev/ttys[0-9]+$")']),
    block('allow file-ioctl', [...quoted('literal', ['/dev/null', '/dev/tty', '/dev/ptmx', '/dev/urandom', '/dev/random']), '(regex #"^/dev/ttys[0-9]+$")']),
    '',
    '; the project root itself cannot be removed or renamed away',
    '(deny file-write-unlink (require-all (literal (param "PROJECT")) (vnode-type DIRECTORY)))',
    '',
  ].join('\n');

  return { profile, defines };
}

/** Command line that runs `argv` inside the sandbox. */
export function sandboxArgv(profile: SeatbeltProfile, argv: string[]): { file: string; args: string[] } {
  return { file: SANDBOX_EXEC, args: ['-p', profile.profile, ...profile.defines, '--', ...argv] };
}

/** Toolchain installations in the home directory that are safe and useful to read. */
const HOME_TOOLCHAIN_DIRS = [
  '.nvm',
  '.volta',
  '.fnm',
  '.asdf',
  '.pyenv',
  '.rbenv',
  '.rvm',
  '.rustup',
  '.sdkman',
  '.bun',
  '.deno',
  '.dotnet',
  '.swiftly',
  '.juliaup',
  '.ghcup',
  '.nix-profile',
  '.local/bin',
  '.local/share/mise',
  '.local/share/fnm',
  '.local/share/uv',
  '.cargo/bin',
  'go/bin',
  'miniconda3',
  'miniforge3',
  'mambaforge',
  'anaconda3',
  'Library/Python',
  'Library/Application Support/fnm',
  'Library/Android/sdk',
];

const HOME_READ_FILES = ['.gitconfig', '.gitignore_global', '.config/git/config', '.config/git/ignore', '.CFUserTextEncoding'];

/** PATH entries whose parent holds unrelated user data and must not be opened wholesale. */
const MIXED_PARENTS = new Set(['.local', '.cargo', '.config', 'Library', 'go']);


async function realIfExists(target: string, kind: 'dir' | 'file'): Promise<string | undefined> {
  try {
    const real = await realpath(target);
    const info = await stat(real);
    return (kind === 'dir' ? info.isDirectory() : info.isFile()) ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read-only locations inside the home directory that development tools need: every PATH
 * entry under home, the installation prefix around it when it looks like a toolchain, and a
 * list of well-known version-manager directories.
 */
export async function detectToolchainDirs(env: NodeJS.ProcessEnv, home: string): Promise<string[]> {
  const found = new Set<string>();
  const homeReal = (await realIfExists(home, 'dir')) ?? home;

  for (const entry of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!entry) continue;
    const real = await realIfExists(entry, 'dir');
    if (!real || real === homeReal || !isWithin(homeReal, real)) continue;
    found.add(real);
    const parent = path.dirname(real);
    const isBinDir = ['bin', 'sbin', 'shims'].includes(path.basename(real));
    if (isBinDir && parent !== homeReal && !MIXED_PARENTS.has(path.basename(parent)) && existsSync(path.join(parent, 'lib'))) {
      found.add(parent);
    }
  }
  for (const relative of HOME_TOOLCHAIN_DIRS) {
    const real = await realIfExists(path.join(homeReal, relative), 'dir');
    if (real && isWithin(homeReal, real) && real !== homeReal) found.add(real);
  }
  // Drop directories already covered by a listed ancestor.
  const all = [...found].sort();
  return all.filter((dir) => !all.some((other) => other !== dir && isWithin(other, dir)));
}

export interface PreparedSandbox {
  spec: SandboxSpec;
  profile: SeatbeltProfile;
  /** Environment overrides for sandboxed commands (private TMPDIR, redirected caches). */
  env: Record<string, string>;
  /** Variables removed from the environment of sandboxed commands. */
  unsetEnv: string[];
  /** Private temporary directory of sandboxed commands; also readable and writable from here. */
  tmpDir: string;
}

export interface PrepareSandboxOptions {
  projectDir: string;
  /** mcpclaude state directory; the cache area is created beneath it. */
  stateDir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  extraReadOnly?: string[];
  extraReadWrite?: string[];
}

/**
 * macOS gives every user a temporary and a cache directory (/var/folders/…/T and …/C) that
 * Apple's own tools use regardless of TMPDIR: mktemp, xcrun, sips, anything built on
 * NSTemporaryDirectory. They are shared with all the user's applications, so the sandbox
 * keeps them closed and instead points those tools at private sub-directories through
 * DIRHELPER_USER_DIR_SUFFIX, the mechanism the system uses for sandboxed apps.
 */
async function darwinPrivateDirs(suffix: string): Promise<{ tmp: string; cache: string } | undefined> {
  const dirs: string[] = [];
  for (const name of ['DARWIN_USER_TEMP_DIR', 'DARWIN_USER_CACHE_DIR']) {
    const env = { ...process.env };
    delete env['DIRHELPER_USER_DIR_SUFFIX'];
    const result = await runProgram('/usr/bin/getconf', [name], { timeoutMs: 5000, env }).catch(() => undefined);
    const base = result?.code === 0 ? result.stdout.trim() : '';
    const real = base ? await realIfExists(base, 'dir') : undefined;
    if (!real) return undefined;
    const dir = path.join(real, suffix);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { mode: 0o700 });
    dirs.push(dir);
  }
  return { tmp: dirs[0] as string, cache: dirs[1] as string };
}

/** Create the private scratch directories and compute the profile for a project directory. */
export async function prepareSandbox(options: PrepareSandboxOptions): Promise<PreparedSandbox> {
  const scratchRoot = path.join(options.stateDir, 'sandbox');
  await rm(scratchRoot, { recursive: true, force: true });
  await mkdir(path.join(scratchRoot, 'tmp'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(scratchRoot, 'cache'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(scratchRoot, 'npmrc'), '', { mode: 0o600 });
  const scratchReal = await realpath(scratchRoot);
  const cacheReal = path.join(scratchReal, 'cache');

  // One suffix per installation, so a restart reuses and cleans the same directories.
  const suffix = `mcpclaude-${createHash('sha256').update(scratchReal).digest('hex').slice(0, 12)}`;
  const darwin = (options.platform ?? process.platform) === 'darwin' ? await darwinPrivateDirs(suffix) : undefined;
  const tmpDir = darwin?.tmp ?? path.join(scratchReal, 'tmp');

  const readWriteDirs = [scratchReal, ...(darwin ? [darwin.tmp, darwin.cache] : [])];
  for (const dir of options.extraReadWrite ?? []) {
    const real = await realIfExists(dir, 'dir');
    if (real) readWriteDirs.push(real);
  }
  const readOnlyDirs = await detectToolchainDirs(options.env, options.home);
  for (const dir of options.extraReadOnly ?? []) {
    const real = await realIfExists(dir, 'dir');
    if (real) readOnlyDirs.push(real);
  }
  const readOnlyFiles: string[] = [];
  for (const relative of HOME_READ_FILES) {
    const real = await realIfExists(path.join(options.home, relative), 'file');
    if (real) readOnlyFiles.push(real);
  }

  const spec: SandboxSpec = { projectDir: options.projectDir, readWriteDirs, readOnlyDirs, readOnlyFiles };
  const env: Record<string, string> = {
    TMPDIR: `${tmpDir}/`,
    ...(darwin ? { DIRHELPER_USER_DIR_SUFFIX: suffix } : {}),
    XDG_CACHE_HOME: cacheReal,
    npm_config_cache: path.join(cacheReal, 'npm'),
    npm_config_userconfig: path.join(scratchReal, 'npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_store_dir: path.join(cacheReal, 'pnpm-store'),
    YARN_CACHE_FOLDER: path.join(cacheReal, 'yarn'),
    BUN_INSTALL_CACHE_DIR: path.join(cacheReal, 'bun'),
    PIP_CACHE_DIR: path.join(cacheReal, 'pip'),
    UV_CACHE_DIR: path.join(cacheReal, 'uv'),
    GOCACHE: path.join(cacheReal, 'go-build'),
    GOMODCACHE: path.join(cacheReal, 'go-mod'),
    GOPATH: path.join(cacheReal, 'go'),
    CARGO_HOME: path.join(cacheReal, 'cargo'),
    // Stop git from walking above the project into directories it may not read.
    GIT_CEILING_DIRECTORIES: path.dirname(options.projectDir),
    HOMEBREW_NO_AUTO_UPDATE: '1',
  };
  return {
    spec,
    profile: buildSeatbeltProfile(spec),
    env,
    // The ssh-agent socket would let commands authenticate as the user elsewhere.
    unsetEnv: ['SSH_AUTH_SOCK'],
    tmpDir,
  };
}

export interface SandboxCheck {
  ok: boolean;
  detail?: string;
}

/** Confirm that the profile loads on this machine by running `/usr/bin/true` inside it. */
export async function checkSandbox(profile: SeatbeltProfile): Promise<SandboxCheck> {
  if (!existsSync(SANDBOX_EXEC)) return { ok: false, detail: `${SANDBOX_EXEC} not found` };
  try {
    const { file, args } = sandboxArgv(profile, ['/usr/bin/true']);
    const result = await runProgram(file, args, { timeoutMs: 15_000 });
    if (result.code === 0) return { ok: true };
    return { ok: false, detail: (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 600) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
