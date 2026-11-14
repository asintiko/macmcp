import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, HELP, parseCli, UsageError } from '../../src/cli/args.js';
import { TOOL_GROUPS } from '../../src/tools/registry.js';

const usage = (argv: string[]): string => {
  try {
    parseCli(argv);
  } catch (err) {
    if (err instanceof UsageError) return err.message;
    throw err;
  }
  throw new Error(`Expected a usage error for: ${argv.join(' ')}`);
};

describe('parseCli', () => {
  it('starts the wizard with safe defaults when given nothing', () => {
    expect(parseCli([])).toEqual({
      command: 'start',
      yes: false,
      noAuth: false,
      rotateToken: false,
      noTunnel: false,
      excludeTools: [],
      allowRead: [],
      allowWrite: [],
      unsafeNoSandbox: false,
      format: 'text',
      reset: false,
      showToken: false,
      offline: false,
    });
  });

  it('recognises the sub-commands, help and version', () => {
    for (const command of ['start', 'doctor', 'tools', 'config'] as const) expect(parseCli([command]).command).toBe(command);
    expect(parseCli(['--help']).command).toBe('help');
    expect(parseCli(['-h']).command).toBe('help');
    expect(parseCli(['doctor', '--help']).command).toBe('help');
    expect(parseCli(['--version']).command).toBe('version');
    expect(parseCli(['-v']).command).toBe('version');
    expect(usage(['serve'])).toContain('Unknown command "serve"');
    expect(usage(['start', 'again'])).toContain('Unexpected argument: again');
    expect(usage(['--frobnicate'])).toMatch(/Unknown option '--frobnicate'/);
  });

  it('reads the setup options', () => {
    const options = parseCli(['-d', '~/proj', '-m', 'full', '-y', '-p', '8123']);
    expect(options).toMatchObject({ dir: '~/proj', mode: 'full', yes: true, port: 8123 });
    expect(parseCli(['--dir', '/x', '--mode', 'project']).mode).toBe('project');
    expect(usage(['--mode', 'admin'])).toBe('--mode must be "project" or "full", got "admin".');
    for (const port of ['0', '65536', '80.5', 'http']) expect(usage(['--port', port])).toContain('--port must be a number between 1 and 65535');
  });

  it('reads the connection options', () => {
    expect(parseCli(['--no-auth']).noAuth).toBe(true);
    expect(parseCli(['--rotate-token']).rotateToken).toBe(true);
    expect(parseCli(['--token', 'my-own-token-1234567']).token).toBe('my-own-token-1234567');
    expect(usage(['--token', 'short'])).toContain('--token must be 16-128 characters');
    expect(usage(['--token', 'has spaces in it and more'])).toContain('--token must be');
    expect(usage(['--token', 'my-own-token-1234567', '--no-auth'])).toBe('--token and --no-auth cannot be combined.');
    expect(parseCli(['--ngrok-authtoken', 'abc']).ngrokAuthtoken).toBe('abc');
    expect(parseCli(['--no-tunnel'])).toMatchObject({ noTunnel: true });
  });

  it('normalises --public-url to an origin and turns the ngrok tunnel off', () => {
    expect(parseCli(['--public-url', 'https://mac.example.com/some/path?x=1'])).toMatchObject({ publicUrl: 'https://mac.example.com', noTunnel: true });
    expect(parseCli(['--public-url', 'http://10.0.0.5:8080/']).publicUrl).toBe('http://10.0.0.5:8080');
    expect(usage(['--public-url', 'mac.example.com'])).toContain('--public-url is not a valid URL');
    expect(usage(['--public-url', 'ftp://mac.example.com'])).toBe('--public-url must start with https:// or http://.');
  });

  it('accepts an ngrok domain with or without a scheme', () => {
    expect(parseCli(['--ngrok-domain', 'my-mac.ngrok.app']).ngrokDomain).toBe('my-mac.ngrok.app');
    expect(parseCli(['--ngrok-domain', 'https://my-mac.ngrok-free.dev/mcp']).ngrokDomain).toBe('my-mac.ngrok-free.dev');
    expect(usage(['--ngrok-domain', 'not a domain'])).toContain('--ngrok-domain is not a valid host name');
  });

  it('collects tool groups to switch off and refuses unknown ones', () => {
    expect(parseCli(['--exclude-tools', 'computer,ui', '--exclude-tools', 'blender, computer']).excludeTools).toEqual(['computer', 'ui', 'blender']);
    expect(usage(['--exclude-tools', 'mouse'])).toContain('Unknown tool group "mouse"');
    expect(usage(['--exclude-tools', 'meta'])).toContain('cannot be switched off');
  });

  it('collects sandbox additions', () => {
    expect(parseCli(['--allow-read', '/a', '--allow-read', '/b', '--allow-write', '/c', '--unsafe-no-sandbox'])).toMatchObject({
      allowRead: ['/a', '/b'],
      allowWrite: ['/c'],
      unsafeNoSandbox: true,
    });
  });

  it('reads the options of tools, config and doctor', () => {
    expect(parseCli(['tools', '--format', 'markdown', '--output', 'docs/TOOLS.md'])).toMatchObject({ command: 'tools', format: 'markdown', output: 'docs/TOOLS.md' });
    expect(parseCli(['tools', '--format', 'json']).format).toBe('json');
    expect(usage(['tools', '--format', 'yaml'])).toBe('--format must be text, markdown or json, got "yaml".');
    expect(parseCli(['config', '--reset', '--show-token'])).toMatchObject({ command: 'config', reset: true, showToken: true });
    expect(parseCli(['doctor', '--offline'])).toMatchObject({ command: 'doctor', offline: true });
  });
});

describe('help text', () => {
  it('documents every option, sub-command and tool group', () => {
    const flags = [
      '--dir', '--mode', '--yes', '--no-auth', '--token', '--rotate-token', '--port', '--ngrok-authtoken', '--ngrok-domain', '--no-tunnel',
      '--public-url', '--exclude-tools', '--allow-read', '--allow-write', '--unsafe-no-sandbox', '--format', '--output', '--reset',
      '--show-token', '--offline', '--help', '--version',
    ];
    for (const flag of flags) expect(HELP, flag).toContain(flag);
    for (const command of ['mcpclaude doctor', 'mcpclaude tools', 'mcpclaude config']) expect(HELP).toContain(command);
    for (const group of Object.keys(TOOL_GROUPS).filter((g) => g !== 'meta')) expect(HELP, group).toContain(group);
    expect(HELP).toContain(String(DEFAULT_PORT));
    expect(HELP).toContain('Project-Only Access');
    expect(HELP).toContain('Full System Access');
  });

  it('fits an 80-column terminal', () => {
    for (const line of HELP.split('\n')) expect(line.length, line).toBeLessThanOrEqual(80);
  });
});
