import { describe, expect, it } from 'vitest';
import { AuthGate, generateAccessToken, isValidAccessToken, redactToken, tokensEqual } from '../../src/server/auth.js';

describe('access tokens', () => {
  it('generates distinct URL-safe tokens', () => {
    const a = generateAccessToken();
    const b = generateAccessToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^mcp_[A-Za-z0-9_-]{43}$/);
    expect(isValidAccessToken(a)).toBe(true);
    expect(encodeURIComponent(a)).toBe(a);
  });

  it('rejects tokens that are too short or not URL-safe', () => {
    expect(isValidAccessToken('short')).toBe(false);
    expect(isValidAccessToken('has/slash/in/it/0000000')).toBe(false);
    expect(isValidAccessToken('has space in it 0000000')).toBe(false);
  });

  it('compares tokens of any length without throwing', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
    expect(tokensEqual('', 'abc')).toBe(false);
  });

  it('redacts tokens in text', () => {
    const token = generateAccessToken();
    const text = redactToken(`url https://x/mcp/${token} end`, token);
    expect(text).not.toContain(token);
    expect(text).toContain(token.slice(0, 8));
  });
});

describe('AuthGate', () => {
  const token = generateAccessToken();

  it('requires a valid token in token mode', () => {
    expect(() => new AuthGate({ mode: 'token' })).toThrow();
    expect(() => new AuthGate({ mode: 'token', token: 'bad token' })).toThrow();
  });

  it('accepts the token as a bearer header or as a path segment', () => {
    const gate = new AuthGate({ mode: 'token', token });
    expect(gate.check(`Bearer ${token}`, undefined)).toEqual({ ok: true, via: 'header' });
    expect(gate.check(`bearer   ${token}`, undefined)).toEqual({ ok: true, via: 'header' });
    expect(gate.check(undefined, token)).toEqual({ ok: true, via: 'path' });
  });

  it('rejects missing and wrong tokens with 401', () => {
    const gate = new AuthGate({ mode: 'token', token });
    expect(gate.check(undefined, undefined)).toMatchObject({ ok: false, status: 401, reason: 'Missing access token' });
    expect(gate.check('Bearer nope', undefined)).toMatchObject({ ok: false, status: 401, reason: 'Invalid access token' });
    expect(gate.check(`Basic ${token}`, undefined)).toMatchObject({ ok: false, status: 401 });
    expect(gate.check(undefined, `${token}x`)).toMatchObject({ ok: false, status: 401 });
  });

  it('throttles after repeated wrong tokens and recovers when the window passes', () => {
    let now = 1_000_000;
    const gate = new AuthGate({ mode: 'token', token, maxFailures: 3, windowMs: 10_000, now: () => now });
    for (let i = 0; i < 3; i++) expect(gate.check('Bearer wrong', undefined)).toMatchObject({ status: 401 });
    // Even the right token is refused while throttled.
    expect(gate.check(`Bearer ${token}`, undefined)).toMatchObject({ ok: false, status: 429, retryAfterSeconds: 10 });
    now += 10_001;
    expect(gate.check(`Bearer ${token}`, undefined)).toEqual({ ok: true, via: 'header' });
  });

  it('does not count requests without credentials as failures', () => {
    const gate = new AuthGate({ mode: 'token', token, maxFailures: 2 });
    for (let i = 0; i < 10; i++) expect(gate.check(undefined, undefined)).toMatchObject({ status: 401 });
    expect(gate.check(`Bearer ${token}`, undefined)).toEqual({ ok: true, via: 'header' });
  });

  it('lets everything through in no-auth mode', () => {
    const gate = new AuthGate({ mode: 'none' });
    expect(gate.check(undefined, undefined)).toEqual({ ok: true, via: 'none' });
    expect(gate.check('Bearer whatever', 'anything')).toEqual({ ok: true, via: 'none' });
  });
});
