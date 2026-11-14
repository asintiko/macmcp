import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERSION } from '../../src/version.js';
import { openClient, outcome } from '../helpers/harness.js';
import { KEY, ptyAvailable, PtySession } from '../helpers/pty.js';

/**
 * End-to-end: the compiled `mcpclaude` binary on a real pseudo-terminal, driven with the keys a
 * person would press, and used by the official MCP client while it runs.
 */
const CLI = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const onMac = process.platform === 'darwin';

let root: string;
let workDir: string;
let env: NodeJS.ProcessEnv;
let terminal: PtySession | undefined;
const clients: Client[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-e2e-')));
  workDir = path.join(root, 'work');
  await mkdir(path.join(workDir, 'alpha'), { recursive: true });
  await mkdir(path.join(workDir, 'beta'));
  await mkdir(path.join(root, 'home'));
  env = { PATH: process.env['PATH'], TERM: 'xterm-256color', LANG: 'en_US.UTF-8', HOME: path.join(root, 'home'), MCPCLAUDE_HOME: path.join(root, 'state') };
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await terminal?.close();
  terminal = undefined;
  await rm(root, { recursive: true, force: true });
});

function start(args: string[]): PtySession {
  terminal = new PtySession([process.execPath, CLI, ...args], { cwd: workDir, env });
  return terminal;
}

async function connectTo(url: string): Promise<Client> {
  const client = await openClient(url);
  clients.push(client);
  return client;
}

/** Number of Down presses from the first entry of the directory menu to "Type a path…". */
const downToTypePath = onMac ? 3 : 2;

// Without python3 there is no pseudo-terminal; CI always has it, so never skip there.
describe.skipIf(!ptyAvailable && !process.env['CI'])('mcpclaude on a terminal', () => {
  it('walks through the wizard with the keyboard, serves an agent, pauses, resumes and quits', async () => {
    const term = start(['--no-tunnel']);

    // Step 1: the server is up and the connection URL is on screen before anything is asked.
    await term.expect(`mcpclaude ${VERSION}`);
    await term.expect('STEP 1/3');
    const [, port] = await term.expect(/Local MCP server listening on http:\/\/127\.0\.0\.1:(\d+)/);
    await term.expect('Connect your AI provider');
    const [url] = await term.expect(/http:\/\/127\.0\.0\.1:\d+\/mcp\/mcp_[A-Za-z0-9_-]+/);
    expect(url).toContain(`:${port}/mcp/`);

    // Step 2: tools are locked while the directory question is open.
    await term.expect('STEP 2/3');
    await term.expect('Which directory should the agent work in?');
    const agent = await connectTo(url as string);
    expect((await agent.listTools()).tools.length).toBeGreaterThan(30);
    expect(outcome(await agent.callTool({ name: 'run_command', arguments: { command: 'echo early' } })).text).toContain('Error [SETUP_PENDING]');

    // Browse folders… → alpha/ → Use this directory.
    await term.send(KEY.down);
    await term.send(KEY.enter);
    await term.expect(`Browse: ${workDir}`);
    await term.expect('beta/');
    await term.send(KEY.down);
    await term.send(KEY.down);
    await term.send(KEY.enter);
    await term.expect(`Browse: ${path.join(workDir, 'alpha')}  (no sub-folders)`);
    await term.send(KEY.enter);
    await term.expect(`Project directory: ${path.join(workDir, 'alpha')}`);

    // Step 3: both levels are explained, Project-Only is the default answer.
    await term.expect('STEP 3/3');
    await term.expect('Project-Only Access  (recommended)');
    await term.expect('Full System Access');
    await term.expect('Which permission level should the agent get?');
    await term.send(KEY.enter);
    await term.expect(onMac ? 'Command sandbox active (macOS Seatbelt)' : 'No OS sandbox on this platform');
    await term.expect(`Ready. Project-Only Access in ${path.join(workDir, 'alpha')}`);
    await term.expect('Keys: p pause/resume');

    // The agent works, confined to the chosen directory, and the terminal shows what it does.
    const pwd = outcome(await agent.callTool({ name: 'run_command', arguments: { command: 'pwd && echo made > note.txt' } }));
    expect(pwd.text).toContain(path.join(workDir, 'alpha'));
    expect(await readFile(path.join(workDir, 'alpha', 'note.txt'), 'utf8')).toBe('made\n');
    await term.expect(/✔ run_command \{"command":"pwd && echo made > note\.txt"\} \d+ms/);
    const outside = outcome(await agent.callTool({ name: 'read_file', arguments: { path: path.join(workDir, 'beta') } }));
    expect(outside.text).toContain('Error [OUTSIDE_PROJECT]');
    await term.expect(/✖ read_file .*OUTSIDE_PROJECT/);

    // p pauses, p resumes.
    await term.send('p');
    await term.expect('Paused: every tool call is refused until you press p again.');
    expect(outcome(await agent.callTool({ name: 'run_command', arguments: { command: 'echo paused' } })).text).toContain('Error [PAUSED]');
    await term.send('p');
    await term.expect('Resumed.');
    expect(outcome(await agent.callTool({ name: 'run_command', arguments: { command: 'echo back' } })).text).toContain('back');

    // i shows the connection details again; q stops everything.
    await term.send('i');
    await term.expect('Connection details');
    await term.expect(url as string);
    await term.send('q');
    await term.expect('Stopped. The public URL no longer works.');
    expect(await term.waitExit()).toMatchObject({ exited: true, code: 0 });
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it('validates a typed path, asks before enabling Full System Access, and stops on Ctrl+C', async () => {
    const term = start(['--no-tunnel']);
    await term.expect('Which directory should the agent work in?');
    for (let i = 0; i < downToTypePath; i++) await term.send(KEY.down);
    await term.send(KEY.enter);
    await term.expect('Path (you can drag a folder into the terminal):');

    await term.send(`nowhere${KEY.enter}`);
    await term.expect(`Directory does not exist: ${path.join(workDir, 'nowhere')}`);
    await term.send(`${KEY.backspace.repeat('nowhere'.length)}beta${KEY.enter}`);
    await term.expect(`Project directory: ${path.join(workDir, 'beta')}`);

    // Full System Access: declining returns to the choice, accepting enables it.
    await term.expect('Which permission level should the agent get?');
    await term.send(KEY.down);
    await term.send(KEY.enter);
    await term.expect('Enable Full System Access? The agent will be able to control this Mac without asking again.');
    await term.send(KEY.enter);
    await term.expect('Full System Access was not enabled.');
    await term.expect('Which permission level should the agent get?');
    await term.send(KEY.down);
    await term.send(KEY.enter);
    await term.expect('Enable Full System Access?');
    await term.send(`y${KEY.enter}`);
    await term.expect(`Ready. Full System Access in ${path.join(workDir, 'beta')}`);
    await term.expect('Keys: p pause/resume');

    const transcript = await term.transcript();
    const url = /http:\/\/127\.0\.0\.1:\d+\/mcp\/mcp_[A-Za-z0-9_-]+/.exec(transcript)?.[0] as string;
    const agent = await connectTo(url);
    const info = outcome(await agent.callTool({ name: 'server_info', arguments: {} }));
    expect(info.data).toMatchObject({ status: 'ready', permission_mode: 'full', project_directory: path.join(workDir, 'beta') });
    // Outside the project is reachable in this mode.
    expect(outcome(await agent.callTool({ name: 'list_directory', arguments: { path: workDir } })).text).toContain('alpha');

    await term.send(KEY.ctrlC);
    await term.expect('Stopped.');
    expect(await term.waitExit()).toMatchObject({ exited: true, code: 0 });
  });

  it('offers the previous project directory on the next start, and Ctrl+C in a question cancels', async () => {
    const first = start(['--no-tunnel', '--dir', 'alpha', '--mode', 'project']);
    await first.expect('Ready.');
    await first.expect('Keys: p pause/resume');
    await first.send('q');
    expect(await first.waitExit()).toMatchObject({ code: 0 });
    await first.close();

    const second = start(['--no-tunnel']);
    await second.expect('Which directory should the agent work in?');
    await second.expect(`Recent: ${path.join(workDir, 'alpha')}`);
    // The access token is reused, so a connector that was set up before keeps working.
    expect(await second.transcript()).not.toContain('Generated an access token');
    await second.send(KEY.ctrlC);
    await second.expect('Cancelled.');
    expect(await second.waitExit()).toMatchObject({ exited: true, code: 130 });
  });

  it('asks for confirmation before starting without authentication', async () => {
    const term = start(['--no-tunnel', '--no-auth', '--dir', 'alpha', '--mode', 'project']);
    await term.expect('Authentication is OFF (--no-auth)');
    await term.expect('Start without authentication?');
    await term.send(KEY.enter);
    await term.expect('Start without --no-auth to protect the server with an access token.');
    expect(await term.waitExit()).toMatchObject({ exited: true, code: 1 });
  });
});

/** Whether ngrok's agent endpoint can be reached from here. */
const ngrokReachable = await new Promise<boolean>((resolve) => {
  const socket = connect({ host: 'connect.ngrok-agent.com', port: 443 });
  const finish = (ok: boolean): void => {
    socket.destroy();
    resolve(ok);
  };
  socket.setTimeout(5000, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

describe.skipIf(!ptyAvailable && !process.env['CI'])('mcpclaude and the real ngrok agent', () => {
  it.runIf(ngrokReachable)('asks for an authtoken, and asks again when ngrok rejects it', async () => {
    const term = start(['--dir', 'alpha', '--mode', 'project']);
    await term.expect('ngrok needs a free account and an authtoken to open the tunnel.');
    await term.expect('https://dashboard.ngrok.com/get-started/your-authtoken');
    await term.expect('Paste your ngrok authtoken:');

    await term.send(`too-short${KEY.enter}`);
    await term.expect('That does not look like an ngrok authtoken');
    await term.send(`${KEY.backspace.repeat('too-short'.length)}not_a_real_token_0123456789abcdef${KEY.enter}`);
    await term.expect('Save it in the mcpclaude settings for next time?');
    await term.send(`n${KEY.enter}`);

    // The embedded agent really talks to ngrok here, which refuses the made-up token.
    await term.expect('ngrok rejected the authtoken.', 60);
    await term.expect('Paste your ngrok authtoken:');
    // The token was typed into a masked field and is never echoed.
    expect(await term.transcript()).not.toContain('not_a_real_token_0123456789abcdef');
    await term.send(KEY.ctrlC);
    await term.expect('Cancelled.');
    expect(await term.waitExit()).toMatchObject({ exited: true, code: 130 });
  });
});

describe('mcpclaude without a terminal', () => {
  const run = (args: string[], waitFor?: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let signalled = false;
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (waitFor && !signalled && stdout.includes(waitFor)) {
          signalled = true;
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  it('starts from flags alone and shuts down cleanly on SIGTERM', async () => {
    const result = await run(['--no-tunnel', '--dir', 'alpha', '--mode', 'project'], 'Press Ctrl+C to stop.');
    expect(result.stdout).toContain(`Project directory: ${path.join(workDir, 'alpha')}`);
    expect(result.stdout).toContain('Ready. Project-Only Access');
    expect(result.stdout).toContain('Signal received. Stopping the tunnel and server…');
    expect(result.stdout).toContain('Stopped. The public URL no longer works.');
    // No colours or cursor control when the output is not a terminal.
    expect(result.stdout).not.toContain('\u001b[');
    expect(result.code).toBe(0);
  });

  it('refuses to guess the permission level or the ngrok authtoken', async () => {
    const noMode = await run(['--no-tunnel', '--dir', 'alpha']);
    expect(noMode.code).toBe(1);
    expect(noMode.stderr).toContain('No permission level given.');
    expect(noMode.stderr).toContain('Pass --mode project or --mode full.');

    const noToken = await run(['--dir', 'alpha', '--mode', 'project']);
    expect(noToken.code).toBe(1);
    expect(noToken.stderr).toContain('No ngrok authtoken found.');
  });

  it('prints version, help and usage errors', async () => {
    expect(await run(['--version'])).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('mcpclaude doctor');
    const bad = await run(['--port', 'eighty']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--port must be a number between 1 and 65535');
  });
});
