import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type AuthMode = 'token' | 'none';

const TOKEN_PREFIX = 'mcp_';

/** 256 bits of randomness, URL-safe so it can be used as a path segment. */
export function generateAccessToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** Tokens must survive being pasted into a URL path unescaped. */
export function isValidAccessToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(token);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison that does not leak the length of either side. */
export function tokensEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export type AuthDecision =
  | { ok: true; via: 'header' | 'path' | 'none' }
  | { ok: false; status: 401 | 429; reason: string; retryAfterSeconds?: number };

export interface AuthGateOptions {
  mode: AuthMode;
  token?: string;
  /** Failed attempts tolerated per window before every attempt is refused. */
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
}

/**
 * Decides whether a request to the MCP endpoint is authenticated.
 *
 * Token mode accepts the token either in `Authorization: Bearer <token>` or as the path
 * segment after the endpoint (`/mcp/<token>`), for clients that can only store a URL.
 */
export class AuthGate {
  readonly mode: AuthMode;
  private readonly token: string | undefined;
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private failures: number[] = [];

  constructor(options: AuthGateOptions) {
    this.mode = options.mode;
    this.token = options.token;
    this.maxFailures = options.maxFailures ?? 20;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    if (this.mode === 'token' && (!this.token || !isValidAccessToken(this.token))) {
      throw new Error('Token auth requires a valid access token (16-128 URL-safe characters).');
    }
  }

  check(authorizationHeader: string | undefined, pathToken: string | undefined): AuthDecision {
    if (this.mode === 'none') return { ok: true, via: 'none' };

    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
    if (this.failures.length >= this.maxFailures) {
      const oldest = this.failures[0] ?? now;
      return {
        ok: false,
        status: 429,
        reason: 'Too many failed authentication attempts',
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      };
    }

    const expected = this.token as string;
    const bearer = parseBearer(authorizationHeader);
    if (bearer !== undefined && tokensEqual(bearer, expected)) return { ok: true, via: 'header' };
    if (pathToken !== undefined && tokensEqual(pathToken, expected)) return { ok: true, via: 'path' };

    const presented = bearer !== undefined || pathToken !== undefined;
    // Only count wrong credentials: a missing header is how well-behaved clients probe.
    if (presented) this.failures.push(now);
    return { ok: false, status: 401, reason: presented ? 'Invalid access token' : 'Missing access token' };
  }
}

function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : undefined;
}

/** Replace a token with a short fingerprint for logs and UI. */
export function redactToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join(`${token.slice(0, 8)}…`);
}
