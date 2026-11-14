import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { LIMITS, type Runtime } from '../core/runtime.js';
import type { TransferLink } from '../core/transfers.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AuthGate } from './auth.js';
import { type RequestInfo, requestInfo } from './context.js';
import { createMcpEndpoint } from './mcp.js';

export interface HttpServerOptions {
  runtime: Runtime;
  registry: ToolRegistry;
  auth: AuthGate;
  /** Preferred port; 0 picks a free one. */
  port: number;
  /** Fall back to a free port when the preferred one is taken. */
  portFallback?: boolean;
  host?: string;
  /** Receives unexpected internal errors (never request content). */
  onError?: (error: Error) => void;
}

const CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/** Loopback HTTP server: auth gate, MCP endpoint, file transfer links, health check. */
export class HttpServer {
  private readonly server: Server;
  private readonly mcp: McpHttpHandler;
  private readonly mcpNode: ReturnType<typeof toNodeHandler>;
  private readonly allowedHosts = new Set<string>(LOCAL_HOSTNAMES);
  private readonly clientNames = new Map<string, string>();
  private readonly options: HttpServerOptions;
  port = 0;

  constructor(options: HttpServerOptions) {
    this.options = options;
    const report = (error: Error): void => options.onError?.(error);
    this.mcp = createMcpEndpoint(options.runtime, options.registry, report);
    this.mcpNode = toNodeHandler(this.mcp, { maxRequestBodySize: LIMITS.requestBodyBytes, onerror: report });
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        report(error instanceof Error ? error : new Error(String(error)));
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
        else res.destroy();
      });
    });
    // Uploads of large files on slow links must not hit the default five-minute limit.
    this.server.requestTimeout = 30 * 60_000;
  }

  /** Start listening; resolves with the bound port. */
  async listen(): Promise<number> {
    const host = this.options.host ?? '127.0.0.1';
    const tryListen = (port: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        this.server.once('error', onError);
        this.server.listen(port, host, () => {
          this.server.off('error', onError);
          resolve();
        });
      });
    try {
      await tryListen(this.options.port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !this.options.portFallback) throw error;
      await tryListen(0);
    }
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : this.options.port;
    this.options.runtime.localBaseUrl = `http://127.0.0.1:${this.port}`;
    return this.port;
  }

  /** Accept requests whose Host header names this public hostname (the tunnel). */
  allowHost(hostname: string): void {
    this.allowedHosts.add(hostname.toLowerCase());
  }

  async close(): Promise<void> {
    await this.mcp.close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private hostnameAllowed(value: string | undefined): boolean {
    if (!value) return false;
    const hostname = value.toLowerCase().replace(/:\d+$/, '');
    return this.allowedHosts.has(hostname);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    // DNS-rebinding and cross-site protection: only our own hostnames, and no foreign web origins.
    if (!this.hostnameAllowed(req.headers.host)) {
      sendJson(res, 403, { error: 'forbidden', message: 'Unrecognised Host header.' });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !this.originAllowed(origin)) {
      sendJson(res, 403, { error: 'forbidden', message: 'Requests from this web origin are not allowed.' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

    if (pathname === '/health') {
      sendJson(res, 200, { status: 'ok', name: 'mcpclaude' });
      return;
    }
    const transfer = /^\/t\/([A-Za-z0-9_-]{16,64})(?:\/[^/]*)?$/.exec(pathname);
    if (transfer) {
      await this.handleTransfer(req, res, transfer[1] as string);
      return;
    }
    const mcp = /^\/mcp(?:\/([^/]+))?$/.exec(pathname);
    if (mcp) {
      await this.handleMcp(req, res, mcp[1]);
      return;
    }
    sendJson(res, 404, { error: 'not_found', message: 'The MCP endpoint of this server is /mcp.' });
  }

  private originAllowed(origin: string): boolean {
    try {
      return this.hostnameAllowed(new URL(origin).host);
    } catch {
      return false;
    }
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse, pathToken: string | undefined): Promise<void> {
    const decision = this.options.auth.check(req.headers.authorization, pathToken);
    if (!decision.ok) {
      if (decision.status === 429) res.setHeader('Retry-After', String(decision.retryAfterSeconds ?? 60));
      else res.setHeader('WWW-Authenticate', 'Bearer realm="mcpclaude"');
      sendJson(res, decision.status, {
        error: decision.status === 429 ? 'too_many_requests' : 'unauthorized',
        message: `${decision.reason}. Use the connection URL printed by mcpclaude, or send "Authorization: Bearer <token>".`,
      });
      return;
    }
    // Never let the token travel further than this function.
    req.url = '/mcp';

    if (req.method !== 'POST') {
      await this.mcpNode(req, res);
      return;
    }

    let body: unknown;
    try {
      const raw = await readBody(req, LIMITS.requestBodyBytes);
      body = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        sendJson(res, 413, { jsonrpc: '2.0', error: { code: -32600, message: 'Request body too large' }, id: null });
      } else {
        sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: body is not valid JSON' }, id: null });
      }
      return;
    }

    const info = describeRequest(body, req);
    this.rememberClient(info, req);
    if (info.methods.length > 0) {
      this.options.runtime.events.emit('rpc', {
        method: info.methods.join(','),
        ...(info.client ? { client: info.client } : {}),
        ...(info.remote ? { remote: info.remote } : {}),
      });
    }
    await requestInfo.run(info, () => this.mcpNode(req, res, body));
  }

  /**
   * 2025-era clients name themselves only in `initialize`, and the endpoint keeps no
   * sessions. Remember the name per caller so later requests can be attributed in the log.
   */
  private rememberClient(info: RequestInfo, req: IncomingMessage): void {
    const agent = req.headers['user-agent'] ?? '';
    const key = `${info.remote ?? ''}|${agent}`;
    if (info.client) {
      this.clientNames.delete(key);
      this.clientNames.set(key, info.client);
      if (this.clientNames.size > 200) {
        const oldest = this.clientNames.keys().next().value;
        if (oldest !== undefined) this.clientNames.delete(oldest);
      }
      return;
    }
    const known = this.clientNames.get(key) ?? agent.split(' ')[0];
    if (known) info.client = known;
  }

  private async handleTransfer(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const runtime = this.options.runtime;
    const notFound = (): void => sendJson(res, 404, { error: 'not_found', message: 'Unknown, expired or already used transfer link.' });
    if (!runtime.configured || runtime.paused) {
      notFound();
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const link = req.method === 'GET' ? runtime.transfers.take(id, 'download') : runtime.transfers.list().find((l) => l.id === id && l.kind === 'download');
      if (!link) {
        notFound();
        return;
      }
      try {
        // Re-check at use time: the path may have changed since the link was issued.
        const file = await runtime.policy.authorize(link.path, runtime.projectDir);
        const info = await stat(file);
        if (!info.isFile()) throw new Error('not a file');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(info.size),
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        await pipeline(createReadStream(file), res);
        link.bytesTransferred += info.size;
        runtime.events.emit('tool', { tool: 'transfer:download', args: { path: file, bytes: info.size }, ok: true, durationMs: 0 });
      } catch {
        if (req.method === 'GET') runtime.transfers.restore(link);
        if (!res.headersSent) notFound();
        else res.destroy();
      }
      return;
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const link = runtime.transfers.take(id, 'upload');
      if (!link) {
        notFound();
        return;
      }
      const outcome = await this.receiveUpload(req, link);
      if (outcome.status !== 200) runtime.transfers.restore(link);
      else runtime.events.emit('tool', { tool: 'transfer:upload', args: { path: link.path, bytes: outcome.body['bytes'] }, ok: true, durationMs: 0 });
      // An unread request body would otherwise keep the connection half-open.
      if (outcome.status !== 200) res.setHeader('Connection', 'close');
      sendJson(res, outcome.status, outcome.body);
      return;
    }

    res.setHeader('Allow', 'GET, HEAD, PUT, POST');
    sendJson(res, 405, { error: 'method_not_allowed' });
  }

  private async receiveUpload(req: IncomingMessage, link: TransferLink): Promise<{ status: number; body: Record<string, unknown> }> {
    const runtime = this.options.runtime;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > link.maxBytes) {
      return { status: 413, body: { error: 'too_large', message: `Upload exceeds the limit of ${link.maxBytes} bytes.` } };
    }
    let target: string;
    try {
      target = await runtime.policy.authorize(link.path, runtime.projectDir);
    } catch {
      return { status: 404, body: { error: 'not_found', message: 'Upload destination is no longer available.' } };
    }
    if (!link.overwrite && (await exists(target))) {
      return { status: 409, body: { error: 'conflict', message: 'Destination already exists and the link does not allow overwriting.' } };
    }

    const partial = `${target}.${randomBytes(6).toString('hex')}.part`;
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > link.maxBytes) {
          callback(new BodyTooLarge());
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(req, meter, createWriteStream(partial, { flags: 'wx' }));
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined);
      if (error instanceof BodyTooLarge) {
        return { status: 413, body: { error: 'too_large', message: `Upload exceeds the limit of ${link.maxBytes} bytes.` } };
      }
      return { status: 500, body: { error: 'upload_failed', message: 'The file could not be written.' } };
    }
    link.bytesTransferred += bytes;
    return { status: 200, body: { ok: true, file: path.basename(target), bytes, sha256: hash.digest('hex') } };
  }
}

class BodyTooLarge extends Error {}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Pull the JSON-RPC methods and the client's self-description out of a request body. */
function describeRequest(body: unknown, req: IncomingMessage): RequestInfo {
  const info: RequestInfo = { methods: [] };
  for (const message of Array.isArray(body) ? body : [body]) {
    if (!message || typeof message !== 'object') continue;
    const { method, params } = message as { method?: unknown; params?: Record<string, unknown> };
    if (typeof method !== 'string') continue;
    info.methods.push(method);
    const meta = params?.['_meta'] as Record<string, unknown> | undefined;
    const client = (params?.['clientInfo'] ?? meta?.[CLIENT_INFO_KEY]) as { name?: unknown; version?: unknown } | undefined;
    if (client && typeof client.name === 'string') {
      info.client = typeof client.version === 'string' ? `${client.name} ${client.version}` : client.name;
    }
  }
  const forwarded = req.headers['x-forwarded-for'];
  const remote = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() ?? req.socket.remoteAddress;
  if (remote) info.remote = remote;
  return info;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) });
  res.end(payload);
}
