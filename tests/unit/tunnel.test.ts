import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyNgrokError,
  findNgrokAuthtoken,
  looksLikeAuthtoken,
  ngrokConfigPaths,
  ngrokProvider,
  parseNgrokConfig,
  TunnelError,
} from '../../src/server/tunnel.js';

describe('classifyNgrokError', () => {
  const ngrokError = (message: string, errorCode?: string): Error => Object.assign(new Error(message), errorCode ? { errorCode } : {});

  it('recognises a missing or rejected authtoken', () => {
    const missing = classifyNgrokError(ngrokError('Usage of ngrok requires a verified account and authtoken.\n\nSign up for an account: https://…\n\nERR_NGROK_4018', 'ERR_NGROK_4018'));
    expect(missing).toMatchObject({ kind: 'auth', ngrokCode: 'ERR_NGROK_4018', message: 'ngrok needs an authtoken.' });
    expect(missing.hint).toContain('https://dashboard.ngrok.com/get-started/your-authtoken');

    for (const code of ['ERR_NGROK_105', 'ERR_NGROK_106', 'ERR_NGROK_107']) {
      expect(classifyNgrokError(ngrokError('authentication failed', code))).toMatchObject({ kind: 'auth', ngrokCode: code, message: 'ngrok rejected the authtoken.' });
    }
  });

  it('finds the ngrok code in the message when the SDK does not set errorCode', () => {
    expect(classifyNgrokError(new Error('failed to connect session: The authtoken you specified is invalid.\n\nERR_NGROK_105\n'))).toMatchObject({ kind: 'auth', ngrokCode: 'ERR_NGROK_105' });
    expect(classifyNgrokError('ERR_NGROK_108: too many sessions')).toMatchObject({ kind: 'session_limit' });
  });

  it('explains account limits and address conflicts', () => {
    const limit = classifyNgrokError(ngrokError('Your account is limited to 3 simultaneous ngrok agent sessions.', 'ERR_NGROK_108'));
    expect(limit.kind).toBe('session_limit');
    expect(limit.hint).toContain('https://dashboard.ngrok.com/agents');

    const inUse = classifyNgrokError(ngrokError('The endpoint is already online.', 'ERR_NGROK_334'));
    expect(inUse.kind).toBe('endpoint_in_use');
    expect(inUse.hint).toContain('--ngrok-domain');

    const domain = classifyNgrokError(ngrokError('Only paid plans may bind custom domains.\nUpgrade at …', 'ERR_NGROK_313'));
    expect(domain).toMatchObject({ kind: 'domain', message: 'ngrok cannot use the requested domain: Only paid plans may bind custom domains.' });
  });

  it('tells network trouble apart from unknown failures', () => {
    for (const message of ['dial tcp: lookup connect.ngrok-agent.com: no such host', 'connection refused', 'i/o timeout', 'tls: handshake failure', 'network is unreachable']) {
      const failure = classifyNgrokError(new Error(message));
      expect(failure.kind, message).toBe('network');
      expect(failure.hint).toContain('internet connection');
    }
    const unknown = classifyNgrokError(new Error('something odd\nwith details'));
    expect(unknown).toMatchObject({ kind: 'unknown', message: 'ngrok failed to start the tunnel: something odd', ngrokCode: undefined });
    expect(unknown.hint).toContain('mcpclaude doctor');
  });

  it('passes its own errors through unchanged', () => {
    const own = new TunnelError('unavailable', 'no sdk', 'reinstall');
    expect(classifyNgrokError(own)).toBe(own);
  });
});

describe('ngrok authtoken discovery', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'mcpclaude-ngrok-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('reads the token from ngrok CLI config files of both formats', () => {
    expect(parseNgrokConfig('version: "3"\nagent:\n    authtoken: 2abcDEF_token-123\n')).toBe('2abcDEF_token-123');
    expect(parseNgrokConfig('version: "2"\nauthtoken: "quoted_token_456" # mine\nregion: eu\n')).toBe('quoted_token_456');
    expect(parseNgrokConfig("authtoken: 'single'\n")).toBe('single');
    expect(parseNgrokConfig('version: "3"\nagent:\n  connect_timeout: 30s\n')).toBeUndefined();
    expect(parseNgrokConfig('# authtoken: commented_out\n')).toBeUndefined();
  });

  it('knows where the ngrok CLI keeps its configuration', () => {
    expect(ngrokConfigPaths('/Users/me', 'darwin', {})).toEqual([
      '/Users/me/Library/Application Support/ngrok/ngrok.yml',
      '/Users/me/.config/ngrok/ngrok.yml',
      '/Users/me/.ngrok2/ngrok.yml',
    ]);
    expect(ngrokConfigPaths('/home/me', 'linux', { XDG_CONFIG_HOME: '/cfg' })).toEqual(['/cfg/ngrok/ngrok.yml', '/home/me/.config/ngrok/ngrok.yml', '/home/me/.ngrok2/ngrok.yml']);
  });

  it('prefers the flag, then the environment, then saved settings, then the ngrok CLI config', async () => {
    const file = path.join(home, 'Library', 'Application Support', 'ngrok', 'ngrok.yml');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'version: "3"\nagent:\n  authtoken: from_ngrok_cli\n');
    const base = { home, platform: 'darwin' as const };
    const saved = { version: 1 as const, ngrokAuthtoken: 'from_settings' };

    expect(await findNgrokAuthtoken({ ...base, flag: ' from_flag ', env: { NGROK_AUTHTOKEN: 'from_env' }, config: saved })).toEqual({ token: 'from_flag', source: 'flag', description: '--ngrok-authtoken' });
    expect(await findNgrokAuthtoken({ ...base, env: { NGROK_AUTHTOKEN: 'from_env' }, config: saved })).toMatchObject({ token: 'from_env', source: 'environment' });
    expect(await findNgrokAuthtoken({ ...base, env: { NGROK_AUTHTOKEN: '  ' }, config: saved })).toMatchObject({ token: 'from_settings', source: 'saved' });
    expect(await findNgrokAuthtoken({ ...base, env: {}, config: { version: 1 } })).toEqual({ token: 'from_ngrok_cli', source: 'ngrok-config', description: file });
    // The macOS location is not consulted on other systems.
    expect(await findNgrokAuthtoken({ home, platform: 'linux', env: {}, config: { version: 1 } })).toBeUndefined();
  });

  it('catches obvious paste mistakes', () => {
    expect(looksLikeAuthtoken('2abcDEFghiJKLmnoPQRstuVWXyz_1234567890abcdefgh')).toBe(true);
    expect(looksLikeAuthtoken('  2abcDEFghiJKLmnoPQRstuVWXyz_12  ')).toBe(true);
    expect(looksLikeAuthtoken('too-short')).toBe(false);
    expect(looksLikeAuthtoken('ngrok config add-authtoken 2abcDEFghiJKLmnoPQRstuVWXyz')).toBe(false);
    expect(looksLikeAuthtoken('')).toBe(false);
  });
});

/** Whether ngrok's agent endpoint can be reached from here (it cannot in offline sandboxes). */
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

describe('embedded ngrok agent (real SDK)', () => {
  it('loads on this platform', async () => {
    const sdk = await import('@ngrok/ngrok');
    expect(typeof sdk.forward).toBe('function');
    expect(typeof sdk.disconnect).toBe('function');
  });

  it.runIf(ngrokReachable)('reports a rejected authtoken as an authentication problem', async () => {
    const attempt = ngrokProvider.start({ port: 9, authtoken: 'not_a_real_token_0123456789abcdef' });
    await expect(attempt).rejects.toBeInstanceOf(TunnelError);
    await expect(attempt).rejects.toMatchObject({ kind: 'auth', message: 'ngrok rejected the authtoken.' });
    const failure = await attempt.catch((err: TunnelError) => err);
    expect((failure as TunnelError).ngrokCode).toMatch(/^ERR_NGROK_10[567]$/);
  });
});
