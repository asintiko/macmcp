import { describe, expect, it } from 'vitest';
import { connectionInfo, connectionInstructions } from '../../src/cli/instructions.js';
import { formatRpcEvent, formatToolEvent } from '../../src/cli/live.js';
import { maskSecret, Ui } from '../../src/cli/ui.js';
import { captureUi } from '../helpers/cli.js';

const TOKEN = 'mcp_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

describe('connectionInfo', () => {
  it('puts the access token in the URL and offers the header form', () => {
    const info = connectionInfo({ authMode: 'token', token: TOKEN, publicBaseUrl: 'https://mac.ngrok-free.dev', localBaseUrl: 'http://127.0.0.1:7332' });
    expect(info).toEqual({
      connectionUrl: `https://mac.ngrok-free.dev/mcp/${TOKEN}`,
      endpointUrl: 'https://mac.ngrok-free.dev/mcp',
      authorization: `Bearer ${TOKEN}`,
      public: true,
    });
  });

  it('uses the bare endpoint without authentication, and the local address without a tunnel', () => {
    expect(connectionInfo({ authMode: 'none', token: undefined, publicBaseUrl: 'https://mac.ngrok-free.dev', localBaseUrl: 'http://127.0.0.1:7332' })).toEqual({
      connectionUrl: 'https://mac.ngrok-free.dev/mcp',
      endpointUrl: 'https://mac.ngrok-free.dev/mcp',
      authorization: undefined,
      public: true,
    });
    expect(connectionInfo({ authMode: 'token', token: TOKEN, publicBaseUrl: undefined, localBaseUrl: 'http://127.0.0.1:7332' })).toMatchObject({
      connectionUrl: `http://127.0.0.1:7332/mcp/${TOKEN}`,
      public: false,
    });
  });
});

describe('connectionInstructions', () => {
  it('shows the URL to paste, warns that it is a secret, and explains each provider', () => {
    const text = connectionInstructions({ authMode: 'token', token: TOKEN, publicBaseUrl: 'https://mac.ngrok-free.dev', localBaseUrl: 'http://127.0.0.1:7332' }).join('\n');
    expect(text).toContain(`  https://mac.ngrok-free.dev/mcp/${TOKEN}`);
    expect(text).toContain('treat it like a password');
    expect(text).toContain('URL     https://mac.ngrok-free.dev/mcp\n');
    expect(text).toContain(`Header  Authorization: Bearer ${TOKEN}`);
    expect(text).toContain(`claude mcp add --transport http mac https://mac.ngrok-free.dev/mcp \\\n`);
    expect(text).toContain(`--header "Authorization: Bearer ${TOKEN}"`);
    for (const provider of ['Claude (claude.ai, Desktop)', 'Claude Code', 'ChatGPT', 'docs/PROVIDERS.md']) expect(text).toContain(provider);
    expect(text).not.toContain('only works on this Mac');
    expect(text).not.toContain('Authentication is OFF');
  });

  it('warns loudly when authentication is off', () => {
    const text = connectionInstructions({ authMode: 'none', token: undefined, publicBaseUrl: 'https://mac.ngrok-free.dev', localBaseUrl: 'http://127.0.0.1:7332' }).join('\n');
    expect(text).toContain('Authentication is OFF: anyone who learns this URL can use the server.');
    expect(text).toContain('  https://mac.ngrok-free.dev/mcp\n');
    expect(text).toContain('claude mcp add --transport http mac https://mac.ngrok-free.dev/mcp\n');
    expect(text).not.toContain('Bearer');
  });

  it('says so when the URL only works locally', () => {
    const text = connectionInstructions({ authMode: 'token', token: TOKEN, publicBaseUrl: undefined, localBaseUrl: 'http://127.0.0.1:7332' }).join('\n');
    expect(text).toContain(`http://127.0.0.1:7332/mcp/${TOKEN}`);
    expect(text).toContain('this URL only works on this Mac');
    expect(text).toContain('--public-url');
  });
});

describe('activity lines', () => {
  it('shows tool, arguments and duration for a successful call', () => {
    const { ui } = captureUi(100);
    const line = formatToolEvent({ tool: 'run_command', args: { command: 'npm test' }, ok: true, durationMs: 1530 }, ui);
    expect(line).toMatch(/^\d\d:\d\d:\d\d ✔ run_command \{"command":"npm test"\} 1\.5s$/);
  });

  it('shows the error code and message for a failed call', () => {
    const { ui } = captureUi(100);
    const line = formatToolEvent({ tool: 'read_file', args: { path: '/etc/passwd' }, ok: false, durationMs: 3, code: 'OUTSIDE_PROJECT', error: 'Path is outside the project directory' }, ui);
    expect(line).toMatch(/^\d\d:\d\d:\d\d ✖ read_file \{"path":"\/etc\/passwd"\} OUTSIDE_PROJECT: Path is outside the project directory$/);
  });

  it('keeps an entry on one terminal line', () => {
    const { ui } = captureUi(60);
    const line = formatToolEvent({ tool: 'write_file', args: { path: 'a.txt', content: 'x'.repeat(500) }, ok: true, durationMs: 12 }, ui);
    expect(line.length).toBeLessThanOrEqual(60);
    expect(line).toContain('…');
    expect(line.endsWith(' 12ms')).toBe(true);
    expect(formatToolEvent({ tool: 'server_info', args: {}, ok: true, durationMs: 1 }, ui)).toMatch(/✔ server_info 1ms$/);
  });

  it('announces clients and tool listings, and stays quiet about other protocol traffic', () => {
    const { ui } = captureUi();
    expect(formatRpcEvent({ method: 'initialize', client: 'claude-ai 1.0', remote: '203.0.113.7' }, ui)).toMatch(/● client connected: claude-ai 1\.0 \(203\.0\.113\.7\)$/);
    expect(formatRpcEvent({ method: 'server/discover' }, ui)).toMatch(/● client connected: unknown client$/);
    expect(formatRpcEvent({ method: 'tools/list', client: 'ChatGPT' }, ui)).toMatch(/● ChatGPT listed the tools$/);
    expect(formatRpcEvent({ method: 'tools/call', client: 'ChatGPT' }, ui)).toBeUndefined();
    expect(formatRpcEvent({ method: 'notifications/initialized' }, ui)).toBeUndefined();
  });
});

describe('Ui', () => {
  it('writes plain text when colours are off and ANSI codes when they are on', () => {
    const plain = captureUi();
    plain.ui.success('done');
    plain.ui.warn('careful');
    plain.ui.error('broken');
    plain.ui.step(2, 3, 'Project directory');
    expect(plain.text()).toBe('✔ done\n! careful\n✖ broken\n\nSTEP 2/3  Project directory\n');

    let out = '';
    const coloured = new Ui({ stream: { write: (text: string) => (out += text), isTTY: true, columns: 80 }, env: { TERM: 'xterm-256color' } });
    expect(coloured.color).toBe(true);
    coloured.success('done');
    expect(out).toBe('\u001b[32m✔\u001b[0m done\n');
    expect(new Ui({ stream: { write: () => true, isTTY: true }, env: { NO_COLOR: '1' } }).color).toBe(false);
    expect(new Ui({ stream: { write: () => true, isTTY: true }, env: { TERM: 'dumb' } }).color).toBe(false);
    expect(new Ui({ stream: { write: () => true, isTTY: false }, env: {} }).color).toBe(false);
  });

  it('draws blocks without a right border so long URLs can be copied', () => {
    const { ui, text } = captureUi(60);
    ui.block('Title', ['https://example.com/a-very-long-url-that-must-not-be-broken-by-any-border-characters', 'second']);
    const lines = text().trimEnd().split('\n');
    expect(lines[0]).toMatch(/^┌─ Title ─+$/);
    expect(lines[1]).toBe('│ https://example.com/a-very-long-url-that-must-not-be-broken-by-any-border-characters');
    expect(lines[2]).toBe('│ second');
    expect(lines[3]).toMatch(/^└─+$/);
    expect((lines[0] as string).length).toBeLessThanOrEqual(60);
  });

  it('prints a spinner as plain result lines when the output is not a terminal', () => {
    const { ui, text } = captureUi();
    ui.spinner('Working…').succeed('Worked');
    ui.spinner('Trying…').fail();
    ui.spinner('Quiet…').stop();
    expect(text()).toBe('✔ Worked\n✖ Trying…\n');
  });

  it('animates a spinner on a terminal and clears it when done', async () => {
    let out = '';
    const ui = new Ui({ stream: { write: (text: string) => (out += text), isTTY: true, columns: 80 }, color: false, env: {} });
    const spinner = ui.spinner('Connecting…');
    await new Promise((resolve) => setTimeout(resolve, 200));
    spinner.update('Still connecting…');
    await new Promise((resolve) => setTimeout(resolve, 120));
    spinner.succeed('Connected');
    expect(out).toContain('⠋ Connecting…');
    expect(out).toContain('Still connecting…');
    expect(out.endsWith('\r\u001b[2K✔ Connected\n')).toBe(true);
  });

  it('masks secrets for display', () => {
    expect(maskSecret(TOKEN)).toBe('mcp_0123…FG');
    expect(maskSecret('short')).toBe('•••••');
    expect(maskSecret(TOKEN)).not.toContain(TOKEN.slice(10, 30));
  });
});
