import { ConfigStore } from '../config/store.js';
import { MODE_LABEL, type PermissionMode } from '../core/permissions.js';
import { Runtime } from '../core/runtime.js';
import { AuthGate, type AuthMode, generateAccessToken } from '../server/auth.js';
import { HttpServer } from '../server/http.js';
import { classifyNgrokError, findNgrokAuthtoken, type FoundAuthtoken, looksLikeAuthtoken, NGROK_URLS, type Tunnel, type TunnelProvider } from '../server/tunnel.js';
import { createToolRegistry } from '../tools/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { type CliOptions, DEFAULT_PORT } from './args.js';
import { pickDirectory, validateProjectDirectory } from './directory.js';
import { type ConnectionDetails, connectionInstructions } from './instructions.js';
import type { Prompter } from './prompts.js';
import type { Ui } from './ui.js';

/** A startup problem to show to the user as is (no stack trace). */
export class StartupError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'StartupError';
    this.hint = hint;
  }
}

export interface SessionDeps {
  options: CliOptions;
  ui: Ui;
  prompter: Prompter;
  /** Whether questions can be asked (standard input and output are terminals). */
  interactive: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  stateDir: string;
  tunnelProvider: TunnelProvider;
  registry?: ToolRegistry;
  /** Native folder dialog; injectable for tests. */
  finder?: () => Promise<string | undefined>;
  /** Extra preparation once the permission level is known (desktop helper, permission checks). */
  afterConfigure?: (runtime: Runtime, ui: Ui) => Promise<void>;
}

export interface Session {
  runtime: Runtime;
  server: HttpServer;
  tunnel: Tunnel | undefined;
  details: ConnectionDetails;
  close(): Promise<void>;
}

export const PERMISSION_EXPLANATION: Record<PermissionMode, string[]> = {
  project: [
    'The agent can read, create, change, delete and run files inside the project directory only.',
    'Shell commands run in a macOS sandbox that blocks reading and writing anywhere else:',
    'your documents, other projects, keys and passwords stay out of reach.',
    'No access to other applications, the screen, the mouse or the keyboard.',
  ],
  full: [
    'The agent can use this Mac the way you can, with the rights of your user account:',
    'any directory, any command or script, any application, any setting macOS lets you change.',
    'It can see the screen and control mouse and keyboard (Computer Use), for example to',
    'operate After Effects or Blender.',
    'Nothing asks for confirmation once this is enabled. Choose it only for agents and',
    'providers you trust, and keep an eye on the activity log.',
  ],
};

/**
 * The setup wizard: (1) start the server and the tunnel and show how to connect, (2) choose
 * the project directory, (3) choose the permission level. Tool calls are refused until the
 * last step has completed.
 */
export async function startSession(deps: SessionDeps): Promise<Session> {
  const { options, ui, prompter, interactive } = deps;
  const config = new ConfigStore(deps.stateDir);
  await config.load();

  // ── Step 1: remote connection ──────────────────────────────────────────────
  ui.step(1, 3, 'Remote connection');
  const authMode: AuthMode = options.noAuth ? 'none' : 'token';
  if (authMode === 'none') {
    ui.warn('Authentication is OFF (--no-auth). Anyone who learns the public URL can use this server.');
    if (interactive && !options.yes && !(await prompter.confirm({ message: 'Start without authentication?', default: false }))) {
      throw new StartupError('Cancelled.', 'Start without --no-auth to protect the server with an access token.');
    }
  }
  let token: string | undefined;
  if (authMode === 'token') {
    token = options.token ?? (options.rotateToken ? undefined : config.value.accessToken) ?? generateAccessToken();
    if (!options.token && token !== config.value.accessToken) {
      await config.update({ accessToken: token });
      ui.info(options.rotateToken ? 'Generated a new access token; URLs with the old token no longer work.' : 'Generated an access token and saved it for future runs.');
    }
  }

  const runtime = new Runtime({
    stateDir: deps.stateDir,
    authMode,
    env: deps.env,
    home: deps.home,
    platform: deps.platform,
    allowUnsandboxed: options.unsafeNoSandbox,
    ...(options.allowRead.length > 0 ? { extraReadOnly: options.allowRead } : {}),
    ...(options.allowWrite.length > 0 ? { extraReadWrite: options.allowWrite } : {}),
  });
  for (const group of options.excludeTools) runtime.disabledGroups.add(group);

  const server = new HttpServer({
    runtime,
    registry: deps.registry ?? createToolRegistry(),
    auth: new AuthGate(token ? { mode: 'token', token } : { mode: 'none' }),
    port: options.port ?? config.value.port ?? DEFAULT_PORT,
    // An explicitly requested port must be honoured or fail; the default may move.
    portFallback: options.port === undefined,
  });

  let tunnel: Tunnel | undefined;
  const close = async (): Promise<void> => {
    await tunnel?.close().catch(() => undefined);
    await runtime.shutdown().catch(() => undefined);
    await server.close().catch(() => undefined);
  };

  try {
    let port: number;
    try {
      port = await server.listen();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new StartupError(`Port ${options.port} is already in use.`, 'Choose another with --port, or omit --port to pick a free one automatically.');
      }
      throw err;
    }
    ui.success(`Local MCP server listening on http://127.0.0.1:${port}  (locked until setup is complete)`);

    if (options.noTunnel) {
      if (options.publicUrl) {
        runtime.publicBaseUrl = options.publicUrl;
        server.allowHost(new URL(options.publicUrl).hostname);
        ui.success(`Using your own public URL: ${options.publicUrl}`);
      } else {
        ui.info('No tunnel (--no-tunnel): the server is reachable from this Mac only.');
      }
    } else {
      tunnel = await openTunnel(deps, config, port);
      runtime.publicBaseUrl = tunnel.url;
      server.allowHost(new URL(tunnel.url).hostname);
      ui.success(`ngrok tunnel online: ${tunnel.url}`);
    }

    const details: ConnectionDetails = { authMode, token, publicBaseUrl: runtime.publicBaseUrl, localBaseUrl: `http://127.0.0.1:${port}` };
    ui.line();
    ui.block('Connect your AI provider', connectionInstructions(details));

    // ── Step 2: project directory ────────────────────────────────────────────
    ui.step(2, 3, 'Project directory');
    const context = { cwd: deps.cwd, home: deps.home };
    let projectDir: string;
    if (options.dir !== undefined) {
      const check = await validateProjectDirectory(options.dir, context);
      if (!check.ok) throw new StartupError(check.reason, 'Pass an existing directory with --dir.');
      for (const warning of check.warnings) ui.warn(warning);
      projectDir = check.path;
    } else if (interactive) {
      projectDir = await pickDirectory(prompter, {
        ...context,
        recent: config.value.recentDirectories ?? [],
        platform: deps.platform,
        say: (text) => ui.info(text),
        ...(deps.finder ? { finder: deps.finder } : {}),
      });
    } else {
      const check = await validateProjectDirectory(deps.cwd, context);
      if (!check.ok) throw new StartupError(check.reason, 'Pass a directory with --dir.');
      projectDir = check.path;
      ui.info('Using the current directory (pass --dir to choose another).');
    }
    ui.success(`Project directory: ${projectDir}`);

    // ── Step 3: permission level ─────────────────────────────────────────────
    ui.step(3, 3, 'Permission level');
    for (const mode of ['project', 'full'] as const) {
      ui.line();
      ui.line(`  ${ui.paint(MODE_LABEL[mode], 'bold')}${mode === 'project' ? '  (recommended)' : ''}`);
      for (const line of PERMISSION_EXPLANATION[mode]) ui.line(`    ${line}`);
    }
    ui.line();
    const mode = await choosePermissionMode(deps);
    if (mode === 'full' && authMode === 'none' && runtime.publicBaseUrl) {
      ui.warn('Full System Access without authentication: anyone with the URL controls this Mac.');
    }

    await runtime.configure({ mode, projectDir });
    if (mode === 'project') {
      const sandbox = runtime.sandboxStatus();
      if (sandbox.active) {
        ui.success('Command sandbox active (macOS Seatbelt): commands are confined to the project directory.');
      } else if (deps.platform === 'darwin' && !options.unsafeNoSandbox) {
        throw new StartupError(
          `The macOS sandbox that Project-Only mode relies on could not be applied. ${sandbox.detail}`,
          'Choose Full System Access, or pass --unsafe-no-sandbox to run commands without OS confinement.',
        );
      } else {
        ui.warn(sandbox.detail);
      }
    }
    await deps.afterConfigure?.(runtime, ui);
    await config.rememberDirectory(projectDir);
    if (options.port !== undefined) await config.update({ port: options.port });
    if (options.ngrokDomain) await config.update({ ngrokDomain: options.ngrokDomain });

    ui.line();
    ui.success(`${ui.paint('Ready.', 'bold')} ${MODE_LABEL[mode]} in ${projectDir}. Agents can use the server now.`);
    return { runtime, server, tunnel, details, close };
  } catch (err) {
    await close();
    throw err;
  }
}

async function choosePermissionMode(deps: SessionDeps): Promise<PermissionMode> {
  const { options, prompter, interactive } = deps;
  for (;;) {
    let mode = options.mode;
    if (!mode) {
      if (!interactive) throw new StartupError('No permission level given.', 'Pass --mode project or --mode full.');
      mode = await prompter.select<PermissionMode>({
        message: 'Which permission level should the agent get?',
        choices: [
          { name: 'Project-Only Access (recommended)', value: 'project', description: 'Confined to the project directory. No desktop control.' },
          { name: 'Full System Access', value: 'full', description: 'The whole Mac, including applications and desktop control. No confirmation prompts.' },
        ],
        default: 'project',
      });
    }
    if (mode === 'project' || options.yes || !interactive) return mode;
    const confirmed = await prompter.confirm({
      message: 'Enable Full System Access? The agent will be able to control this Mac without asking again.',
      default: false,
    });
    if (confirmed) return mode;
    if (options.mode) throw new StartupError('Cancelled.', 'Start with --mode project for Project-Only Access.');
    deps.ui.info('Full System Access was not enabled.');
  }
}

async function openTunnel(deps: SessionDeps, config: ConfigStore, port: number): Promise<Tunnel> {
  const { options, ui, prompter, interactive } = deps;
  const domain = options.ngrokDomain ?? config.value.ngrokDomain;
  let found: FoundAuthtoken | undefined = await findNgrokAuthtoken({
    flag: options.ngrokAuthtoken,
    env: deps.env,
    config: config.value,
    home: deps.home,
    platform: deps.platform,
  });

  for (let attempt = 1; ; attempt++) {
    if (!found) {
      if (!interactive) {
        throw new StartupError(
          'No ngrok authtoken found.',
          `Get one at ${NGROK_URLS.authtoken} and pass it with --ngrok-authtoken or NGROK_AUTHTOKEN (or use --no-tunnel).`,
        );
      }
      ui.info('ngrok needs a free account and an authtoken to open the tunnel.');
      ui.info(`Sign up: ${NGROK_URLS.signup}`);
      ui.info(`Your authtoken: ${NGROK_URLS.authtoken}`);
      const entered = (
        await prompter.secret({
          message: 'Paste your ngrok authtoken:',
          validate: (value) => looksLikeAuthtoken(value) || 'That does not look like an ngrok authtoken (it is a long string of letters, digits and "_").',
        })
      ).trim();
      if (options.yes || (await prompter.confirm({ message: 'Save it in the mcpclaude settings for next time?', default: true }))) {
        await config.update({ ngrokAuthtoken: entered });
      }
      found = { token: entered, source: 'flag', description: 'entered just now' };
    }

    const spinner = ui.spinner(`Starting ngrok tunnel (authtoken from ${found.description})…`);
    let started = false;
    try {
      const tunnel = await deps.tunnelProvider.start({
        port,
        authtoken: found.token,
        ...(domain ? { domain } : {}),
        onStatus: (status) => {
          // The first "connected" is the start itself; later changes are worth a line.
          if (!started) return;
          if (status === 'closed') ui.warn('ngrok tunnel lost its connection; reconnecting…');
          else ui.success('ngrok tunnel reconnected.');
        },
      });
      started = true;
      spinner.stop();
      return tunnel;
    } catch (err) {
      const failure = classifyNgrokError(err);
      if (failure.kind === 'auth' && interactive && attempt < 3) {
        spinner.fail(failure.message);
        ui.info(failure.hint);
        if (found.source === 'saved') await config.update({ ngrokAuthtoken: undefined });
        found = undefined;
        continue;
      }
      spinner.stop();
      throw new StartupError(failure.message, failure.hint);
    }
  }
}
