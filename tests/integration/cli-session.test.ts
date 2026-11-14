import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCli } from '../../src/cli/args.js';
import { PromptCancelled } from '../../src/cli/prompts.js';
import { type Session, startSession, StartupError } from '../../src/cli/session.js';
import type { StoredConfig } from '../../src/config/store.js';
import { TunnelError } from '../../src/server/tunnel.js';
import { type Answer, captureUi, type CapturedUi, fakeTunnelProvider, type FakeTunnelProvider, ScriptedPrompter } from '../helpers/cli.js';
import { openClient, outcome } from '../helpers/harness.js';

const onMac = process.platform === 'darwin';
const NGROK_TOKEN = '2abcDEFghiJKLmnoPQRstuVWXyz_0123456789';

let root: string;
let projectDir: string;
let home: string;
let stateDir: string;
let session: Session | undefined;
const clients: Client[] = [];
const blockers: Server[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-session-')));
  projectDir = path.join(root, 'project');
  home = path.join(root, 'home');
  stateDir = path.join(root, 'state');
  await mkdir(path.join(projectDir, 'sub'), { recursive: true });
  await mkdir(home);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await session?.close();
  session = undefined;
  for (const server of blockers.splice(0)) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

interface Run {
  ui: CapturedUi;
  prompter: ScriptedPrompter;
  tunnel: FakeTunnelProvider;
  start(): Promise<Session>;
}

function prepare(argv: string[], settings: { answers?: Answer[]; interactive?: boolean; env?: NodeJS.ProcessEnv; tunnel?: FakeTunnelProvider; cwd?: string } = {}): Run {
  const ui = captureUi();
  const prompter = new ScriptedPrompter(settings.answers ?? []);
  const tunnel = settings.tunnel ?? fakeTunnelProvider();
  return {
    ui,
    prompter,
    tunnel,
    start: async () => {
      session = await startSession({
        options: parseCli(argv),
        ui: ui.ui,
        prompter,
        interactive: settings.interactive ?? true,
        env: settings.env ?? { PATH: process.env['PATH'], NGROK_AUTHTOKEN: NGROK_TOKEN },
        cwd: settings.cwd ?? projectDir,
        home,
        platform: process.platform,
        stateDir,
        tunnelProvider: tunnel,
      });
      return session;
    },
  };
}

const savedConfig = async (): Promise<StoredConfig> => JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8')) as StoredConfig;
const saveConfig = async (config: Partial<StoredConfig>): Promise<void> => {
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ version: 1, ...config }));
};

async function client(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const opened = await openClient(url, { headers });
  clients.push(opened);
  return opened;
}

/** Occupy a port so that the server cannot bind it. */
async function occupyPort(): Promise<number> {
  const server = createServer();
  blockers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

async function portIsOpen(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then(
    (response) => response.status === 200,
    () => false,
  );
}

describe('setup wizard', () => {
  it('runs the three steps in order: connection, directory, permission level', async () => {
    let urlWhenAskedForDirectory: string | undefined;
    let refusedBeforeSetup: string | undefined;
    const run = prepare([], {
      answers: [
        {
          select: 'Current directory',
          before: async () => {
            // Step 1 is complete: the URL is on screen and the endpoint answers, but tools are locked.
            const shown = run.ui.text();
            const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(shown)?.[1];
            const path = /https:\/\/fake-tunnel\.example(\/mcp\/mcp_[\w-]+)/.exec(shown)?.[1];
            urlWhenAskedForDirectory = `http://127.0.0.1:${port}${path}`;
            const early = await client(urlWhenAskedForDirectory);
            expect((await early.listTools()).tools.length).toBeGreaterThan(30);
            refusedBeforeSetup = outcome(await early.callTool({ name: 'run_command', arguments: { command: 'echo hi' } })).text;
          },
        },
        { select: 'Project-Only Access' },
      ],
    });
    const started = await run.start();
    const text = run.ui.text();

    const order = ['STEP 1/3  Remote connection', 'ngrok tunnel online: https://fake-tunnel.example', 'Connect your AI provider', 'STEP 2/3  Project directory', `Project directory: ${projectDir}`, 'STEP 3/3  Permission level', 'Ready.'];
    const positions = order.map((marker) => text.indexOf(marker));
    expect(positions.every((p) => p >= 0), text).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // Step 1: tunnel to the local port, with the public URL in the instructions.
    expect(run.tunnel.starts).toHaveLength(1);
    expect(run.tunnel.starts[0]).toMatchObject({ port: started.server.port, authtoken: NGROK_TOKEN });
    expect(started.runtime.publicBaseUrl).toBe('https://fake-tunnel.example');
    const token = (await savedConfig()).accessToken as string;
    expect(token).toMatch(/^mcp_[\w-]{43}$/);
    expect(text).toContain(`  https://fake-tunnel.example/mcp/${token}`);
    expect(text).toContain('Generated an access token and saved it for future runs.');
    expect(text).toContain('(locked until setup is complete)');
    expect(urlWhenAskedForDirectory).toBeDefined();
    expect(refusedBeforeSetup).toContain('Error [SETUP_PENDING]');

    // Step 3: both levels are explained before the question is asked.
    expect(run.prompter.asked.map((a) => a.message)).toEqual(['Which directory should the agent work in?', 'Which permission level should the agent get?']);
    expect(run.prompter.asked[1]?.choices).toEqual(['Project-Only Access (recommended)', 'Full System Access']);
    const explanation = text.slice(text.indexOf('STEP 3/3'), text.indexOf('Ready.'));
    expect(explanation).toContain('Project-Only Access  (recommended)');
    expect(explanation).toContain('inside the project directory only');
    expect(explanation).toContain('Full System Access');
    expect(explanation).toContain('Nothing asks for confirmation once this is enabled');

    // Afterwards the server works, in the chosen mode and directory.
    expect(started.runtime.mode).toBe('project');
    expect(started.runtime.projectDir).toBe(projectDir);
    expect(text).toContain(`Ready. Project-Only Access in ${projectDir}. Agents can use the server now.`);
    expect(text).toContain(onMac ? 'Command sandbox active (macOS Seatbelt)' : 'No OS sandbox on this platform');
    const later = await client(urlWhenAskedForDirectory as string);
    expect(outcome(await later.callTool({ name: 'run_command', arguments: { command: 'pwd' } })).text).toContain(projectDir);
    expect((await savedConfig()).recentDirectories).toEqual([projectDir]);
  });

  it('accepts requests addressed to the tunnel host, and only with the access token', async () => {
    const run = prepare(['--dir', projectDir, '--mode', 'project']);
    const started = await run.start();
    const token = (await savedConfig()).accessToken as string;
    const viaTunnel = (host: string, pathname: string): Promise<number> =>
      new Promise((resolve, reject) => {
        void import('node:http').then(({ request }) => {
          const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
          const req = request(
            { host: '127.0.0.1', port: started.server.port, path: pathname, method: 'POST', headers: { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) } },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            },
          );
          req.on('error', reject);
          req.end(body);
        });
      });
    expect(await viaTunnel('fake-tunnel.example', `/mcp/${token}`)).toBe(200);
    expect(await viaTunnel('fake-tunnel.example', '/mcp')).toBe(401);
    expect(await viaTunnel('fake-tunnel.example', '/mcp/mcp_wrongwrongwrongwrong')).toBe(401);
    expect(await viaTunnel('someone-else.example', `/mcp/${token}`)).toBe(403);
  });

  it('lets the user browse to the project directory or type its path', async () => {
    const browse = prepare(['--no-tunnel'], { answers: [{ select: 'Browse folders' }, { select: 'sub/' }, { select: 'Use this directory' }, { select: 'Project-Only' }] });
    expect((await browse.start()).runtime.projectDir).toBe(path.join(projectDir, 'sub'));
    await session?.close();

    const typed = prepare(['--no-tunnel'], { cwd: root, answers: [{ select: 'Type a path' }, { input: 'nowhere' }, { input: 'project/sub' }, { select: 'Project-Only' }] });
    expect((await typed.start()).runtime.projectDir).toBe(path.join(projectDir, 'sub'));
    expect(typed.prompter.asked[1]?.errors).toEqual([`Directory does not exist: ${path.join(root, 'nowhere')}`]);
    // Both directories are remembered, newest first, and offered next time.
    expect((await savedConfig()).recentDirectories).toEqual([path.join(projectDir, 'sub')]);
  });

  it('enables Full System Access only after an explicit confirmation', async () => {
    const declined = prepare(['--no-tunnel', '--dir', projectDir], {
      answers: [{ select: 'Full System Access' }, { confirm: false }, { select: 'Full System Access' }, { confirm: true }],
    });
    const started = await declined.start();
    expect(declined.prompter.asked.filter((a) => a.kind === 'confirm').map((a) => a.message)).toEqual([
      'Enable Full System Access? The agent will be able to control this Mac without asking again.',
      'Enable Full System Access? The agent will be able to control this Mac without asking again.',
    ]);
    expect(declined.ui.text()).toContain('Full System Access was not enabled.');
    expect(started.runtime.mode).toBe('full');
    expect(declined.ui.text()).toContain(`Ready. Full System Access in ${projectDir}.`);
  });

  it('asks for the same confirmation when Full System Access comes from --mode, unless --yes is given', async () => {
    const refused = prepare(['--no-tunnel', '--dir', projectDir, '--mode', 'full'], { answers: [{ confirm: false }] });
    await expect(refused.start()).rejects.toMatchObject({ name: 'StartupError', message: 'Cancelled.' });

    const confirmed = prepare(['--no-tunnel', '--dir', projectDir, '--mode', 'full'], { answers: [{ confirm: true }] });
    expect((await confirmed.start()).runtime.mode).toBe('full');
    await session?.close();

    const preApproved = prepare(['--no-tunnel', '--dir', projectDir, '--mode', 'full', '--yes']);
    expect((await preApproved.start()).runtime.mode).toBe('full');
    expect(preApproved.prompter.asked).toEqual([]);
  });

  it('stops cleanly when the user presses Ctrl+C in a question', async () => {
    const run = prepare([], { answers: [{ select: 'Current directory' }, { cancel: true }] });
    await expect(run.start()).rejects.toBeInstanceOf(PromptCancelled);
    expect(run.tunnel.closed).toBe(1);
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(run.ui.text())?.[1]);
    expect(await portIsOpen(port)).toBe(false);
  });
});

describe('non-interactive start', () => {
  it('needs --mode, and uses the current directory unless --dir is given', async () => {
    const noMode = prepare(['--no-tunnel'], { interactive: false });
    await expect(noMode.start()).rejects.toMatchObject({ message: 'No permission level given.', hint: 'Pass --mode project or --mode full.' });

    const run = prepare(['--no-tunnel', '--mode', 'project'], { interactive: false, cwd: path.join(projectDir, 'sub') });
    const started = await run.start();
    expect(started.runtime.projectDir).toBe(path.join(projectDir, 'sub'));
    expect(run.ui.text()).toContain('Using the current directory (pass --dir to choose another).');
    expect(run.prompter.asked).toEqual([]);
  });

  it('rejects a project directory that does not exist, and releases the port and the tunnel', async () => {
    const run = prepare(['--dir', path.join(root, 'missing'), '--mode', 'project'], { interactive: false });
    const failure = await run.start().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(StartupError);
    expect((failure as StartupError).message).toBe(`Directory does not exist: ${path.join(root, 'missing')}`);
    expect(run.tunnel.closed).toBe(1);
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(run.ui.text())?.[1]);
    expect(await portIsOpen(port)).toBe(false);
  });

  it('does not enable Full System Access silently for a risky directory warning', async () => {
    const run = prepare(['--no-tunnel', '--dir', home, '--mode', 'project'], { interactive: false });
    await run.start();
    expect(run.ui.text()).toContain('! This is your whole home directory');
  });
});

describe('authentication', () => {
  it('reuses the saved access token, and replaces it on --rotate-token', async () => {
    await saveConfig({ accessToken: 'mcp_saved_token_0123456789' });
    const reuse = prepare(['--no-tunnel', '--dir', projectDir, '--mode', 'project']);
    const first = await reuse.start();
    expect(first.details.token).toBe('mcp_saved_token_0123456789');
    expect(reuse.ui.text()).not.toContain('Generated');
    await session?.close();

    const rotate = prepare(['--no-tunnel', '--dir', projectDir, '--mode', 'project', '--rotate-token']);
    const second = await rotate.start();
    expect(second.details.token).not.toBe('mcp_saved_token_0123456789');
    expect((await savedConfig()).accessToken).toBe(second.details.token);
    expect(rotate.ui.text()).toContain('Generated a new access token; URLs with the old token no longer work.');
    const old = await fetch(`http://127.0.0.1:${second.server.port}/mcp/mcp_saved_token_0123456789`, { method: 'POST', body: '{}' });
    expect(old.status).toBe(401);
  });

  it('uses --token for this run without saving it', async () => {
    await saveConfig({ accessToken: 'mcp_saved_token_0123456789' });
    const run = prepare(['--no-tunnel', '--dir', projectDir, '--mode', 'project', '--token', 'one-off-token-0123456789']);
    const started = await run.start();
    expect(started.details.token).toBe('one-off-token-0123456789');
    expect((await savedConfig()).accessToken).toBe('mcp_saved_token_0123456789');
    const authorised = await client(`http://127.0.0.1:${started.server.port}/mcp`, { Authorization: 'Bearer one-off-token-0123456789' });
    expect(outcome(await authorised.callTool({ name: 'server_info', arguments: {} })).data).toMatchObject({ status: 'ready' });
  });

  it('turns authentication off only with --no-auth and a confirmation', async () => {
    const declined = prepare(['--no-auth', '--dir', projectDir, '--mode', 'project'], { answers: [{ confirm: false }] });
    await expect(declined.start()).rejects.toMatchObject({ message: 'Cancelled.' });
    expect(declined.prompter.asked[0]?.message).toBe('Start without authentication?');
    expect(declined.tunnel.starts).toEqual([]);

    const run = prepare(['--no-auth', '--dir', projectDir], { answers: [{ confirm: true }, { select: 'Full System Access' }, { confirm: true }] });
    const started = await run.start();
    const text = run.ui.text();
    expect(text).toContain('Authentication is OFF (--no-auth). Anyone who learns the public URL can use this server.');
    expect(text).toContain('  https://fake-tunnel.example/mcp\n');
    expect(text).toContain('Full System Access without authentication: anyone with the URL controls this Mac.');
    expect(started.details).toMatchObject({ authMode: 'none', token: undefined });
    expect((await savedConfig()).accessToken).toBeUndefined();
    const open = await client(`http://127.0.0.1:${started.server.port}/mcp`);
    expect(outcome(await open.callTool({ name: 'server_info', arguments: {} })).data).toMatchObject({ permission_mode: 'full' });
  });
});

describe('ngrok tunnel', () => {
  it('asks for the authtoken once when none is found, and saves it if the user agrees', async () => {
    const run = prepare(['--dir', projectDir, '--mode', 'project'], {
      env: {},
      answers: [{ secret: 'oops' }, { secret: `  ${NGROK_TOKEN}  ` }, { confirm: true }],
    });
    await run.start();
    expect(run.prompter.asked[0]).toMatchObject({ kind: 'secret', message: 'Paste your ngrok authtoken:' });
    expect(run.prompter.asked[0]?.errors[0]).toContain('does not look like an ngrok authtoken');
    expect(run.ui.text()).toContain('https://dashboard.ngrok.com/signup');
    expect(run.ui.text()).toContain('https://dashboard.ngrok.com/get-started/your-authtoken');
    expect(run.tunnel.starts[0]?.authtoken).toBe(NGROK_TOKEN);
    expect((await savedConfig()).ngrokAuthtoken).toBe(NGROK_TOKEN);
    // The token is typed into a hidden field and never printed.
    expect(run.ui.text()).not.toContain(NGROK_TOKEN);
    await session?.close();

    const next = prepare(['--dir', projectDir, '--mode', 'project'], { env: {} });
    await next.start();
    expect(next.prompter.asked).toEqual([]);
    expect(next.tunnel.starts[0]?.authtoken).toBe(NGROK_TOKEN);
  });

  it('does not save the authtoken when the user declines', async () => {
    const run = prepare(['--dir', projectDir, '--mode', 'project'], { env: {}, answers: [{ secret: NGROK_TOKEN }, { confirm: false }] });
    await run.start();
    expect((await savedConfig()).ngrokAuthtoken).toBeUndefined();
  });

  it('asks again when ngrok rejects the token, and forgets a saved token that no longer works', async () => {
    await saveConfig({ ngrokAuthtoken: 'saved_but_revoked_token_0123456789' });
    const rejected = new TunnelError('auth', 'ngrok rejected the authtoken.', 'Copy the current token.', 'ERR_NGROK_105');
    const run = prepare(['--dir', projectDir, '--mode', 'project'], {
      env: {},
      tunnel: fakeTunnelProvider({ failures: [rejected] }),
      answers: [{ secret: NGROK_TOKEN }, { confirm: true }],
    });
    await run.start();
    expect(run.tunnel.starts.map((s) => s.authtoken)).toEqual(['saved_but_revoked_token_0123456789', NGROK_TOKEN]);
    expect(run.ui.text()).toContain('✖ ngrok rejected the authtoken.');
    expect(run.ui.text()).toContain('Copy the current token.');
    expect((await savedConfig()).ngrokAuthtoken).toBe(NGROK_TOKEN);
  });

  it('gives up after three rejected tokens', async () => {
    const rejected = (): TunnelError => new TunnelError('auth', 'ngrok rejected the authtoken.', 'Copy the current token.', 'ERR_NGROK_105');
    const run = prepare(['--dir', projectDir, '--mode', 'project'], {
      tunnel: fakeTunnelProvider({ failures: [rejected(), rejected(), rejected()] }),
      answers: [{ secret: NGROK_TOKEN }, { confirm: false }, { secret: NGROK_TOKEN }, { confirm: false }],
    });
    await expect(run.start()).rejects.toMatchObject({ name: 'StartupError', message: 'ngrok rejected the authtoken.' });
    expect(run.tunnel.starts).toHaveLength(3);
  });

  it('explains what to do when there is no authtoken and nobody to ask', async () => {
    const run = prepare(['--dir', projectDir, '--mode', 'project'], { env: {}, interactive: false });
    const failure = (await run.start().catch((err: unknown) => err)) as StartupError;
    expect(failure.message).toBe('No ngrok authtoken found.');
    expect(failure.hint).toContain('--ngrok-authtoken');
    expect(failure.hint).toContain('--no-tunnel');
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(run.ui.text())?.[1]);
    expect(await portIsOpen(port)).toBe(false);
  });

  it('reports other tunnel failures with their remedy instead of retrying', async () => {
    const limit = Object.assign(new Error('Your account is limited to 3 simultaneous ngrok agent sessions.'), { errorCode: 'ERR_NGROK_108' });
    const run = prepare(['--dir', projectDir, '--mode', 'project'], { tunnel: fakeTunnelProvider({ failures: [limit] }) });
    const failure = (await run.start().catch((err: unknown) => err)) as StartupError;
    expect(failure.message).toBe('Your ngrok account already has the maximum number of agent sessions running.');
    expect(failure.hint).toContain('https://dashboard.ngrok.com/agents');
    expect(run.tunnel.starts).toHaveLength(1);
  });

  it('takes the authtoken from --ngrok-authtoken first, and passes a reserved domain on', async () => {
    const run = prepare(['--dir', projectDir, '--mode', 'project', '--ngrok-authtoken', 'flag_token_0123456789abcdefgh', '--ngrok-domain', 'my-mac.ngrok.app'], {
      tunnel: fakeTunnelProvider({ url: (options) => `https://${options.domain}` }),
    });
    const started = await run.start();
    expect(run.tunnel.starts[0]).toMatchObject({ authtoken: 'flag_token_0123456789abcdefgh', domain: 'my-mac.ngrok.app' });
    expect(started.runtime.publicBaseUrl).toBe('https://my-mac.ngrok.app');
    expect((await savedConfig()).ngrokDomain).toBe('my-mac.ngrok.app');
    // The flag is not written to disk.
    expect((await savedConfig()).ngrokAuthtoken).toBeUndefined();
  });

  it('reports a lost and restored connection while running', async () => {
    const run = prepare(['--dir', projectDir, '--mode', 'project']);
    await run.start();
    run.ui.clear();
    run.tunnel.starts[0]?.onStatus?.('closed');
    run.tunnel.starts[0]?.onStatus?.('connected');
    expect(run.ui.text()).toBe('! ngrok tunnel lost its connection; reconnecting…\n✔ ngrok tunnel reconnected.\n');
  });

  it('is skipped with --no-tunnel, and replaced by --public-url', async () => {
    const local = prepare(['--no-tunnel', '--dir', projectDir, '--mode', 'project']);
    const first = await local.start();
    expect(local.tunnel.starts).toEqual([]);
    expect(first.runtime.publicBaseUrl).toBeUndefined();
    expect(local.ui.text()).toContain('No tunnel (--no-tunnel): the server is reachable from this Mac only.');
    expect(local.ui.text()).toContain('this URL only works on this Mac');
    await session?.close();

    const own = prepare(['--public-url', 'https://mac.example.com/', '--dir', projectDir, '--mode', 'project']);
    const second = await own.start();
    expect(own.tunnel.starts).toEqual([]);
    expect(second.runtime.publicBaseUrl).toBe('https://mac.example.com');
    expect(own.ui.text()).toContain(`  https://mac.example.com/mcp/${second.details.token}`);
  });
});

describe('local port', () => {
  it('fails when an explicitly requested port is taken', async () => {
    const port = await occupyPort();
    const run = prepare(['--no-tunnel', '--dir', projectDir, '--mode', 'project', '--port', String(port)]);
    await expect(run.start()).rejects.toMatchObject({ name: 'StartupError', message: `Port ${port} is already in use.` });
  });

  it('moves to a free port when the default or saved one is taken', async () => {
    const port = await occupyPort();
    await saveConfig({ port });
    const run = prepare(['--no-tunnel', '--dir', projectDir, '--mode', 'project']);
    const started = await run.start();
    expect(started.server.port).not.toBe(port);
    expect(await portIsOpen(started.server.port)).toBe(true);
    expect(run.ui.text()).toContain(`listening on http://127.0.0.1:${started.server.port}`);
  });
});

describe('restrictions and shutdown', () => {
  it('switches off tool groups named in --exclude-tools', async () => {
    const run = prepare(['--no-tunnel', '--dir', projectDir, '--mode', 'full', '--yes', '--exclude-tools', 'shell,transfer']);
    const started = await run.start();
    const opened = await client(`http://127.0.0.1:${started.server.port}/mcp/${started.details.token}`);
    const names = (await opened.listTools()).tools.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('run_command');
    expect(names).not.toContain('download_url');
    const refused = outcome(await opened.callTool({ name: 'run_command', arguments: { command: 'true' } }));
    expect(refused.text).toContain('Error [PERMISSION_DENIED]: The "shell" tool group was disabled by the user');
  });

  it('closes the tunnel, the server and running commands', async () => {
    const run = prepare(['--dir', projectDir, '--mode', 'full', '--yes']);
    const started = await run.start();
    const opened = await client(`http://127.0.0.1:${started.server.port}/mcp/${started.details.token}`);
    const background = outcome(await opened.callTool({ name: 'start_process', arguments: { command: 'sleep 300', wait_seconds: 0 } }));
    expect(background.isError).toBe(false);
    expect(started.runtime.processes.runningCount).toBe(1);

    await started.close();
    expect(run.tunnel.closed).toBe(1);
    expect(started.runtime.processes.runningCount).toBe(0);
    expect(await portIsOpen(started.server.port)).toBe(false);
  });
});
