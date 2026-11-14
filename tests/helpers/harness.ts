import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { PermissionMode } from '../../src/core/permissions.js';
import { Runtime } from '../../src/core/runtime.js';
import { AuthGate, type AuthMode, generateAccessToken } from '../../src/server/auth.js';
import { HttpServer } from '../../src/server/http.js';
import { createToolRegistry } from '../../src/tools/index.js';
import type { ToolRegistry } from '../../src/tools/registry.js';

export type Era = 'legacy' | 'modern';
export const MODERN_PROTOCOL = '2026-07-28';

export interface CallOutcome {
  isError: boolean;
  text: string;
  data: Record<string, unknown> | undefined;
  images: { mimeType: string; data: string }[];
}

export interface ConnectOptions {
  era?: Era;
  /** Token to present; null presents none. Defaults to the server's token. */
  token?: string | null;
  /** Put the token in the URL path instead of the Authorization header. */
  viaPath?: boolean;
}

export interface Harness {
  root: string;
  projectDir: string;
  /** A directory next to the project, for "outside the project" checks. */
  outsideDir: string;
  stateDir: string;
  runtime: Runtime;
  registry: ToolRegistry;
  server: HttpServer;
  token: string;
  baseUrl: string;
  mcpUrl: string;
  connect(options?: ConnectOptions): Promise<Client>;
  /** Call a tool through a shared legacy-era client. */
  call(name: string, args?: Record<string, unknown>): Promise<CallOutcome>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Permission mode to configure; null leaves the server in the setup state. */
  mode?: PermissionMode | null;
  auth?: AuthMode;
  registry?: ToolRegistry;
  runtime?: Partial<ConstructorParameters<typeof Runtime>[0]>;
}

export function outcome(result: unknown): CallOutcome {
  const r = result as { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
  const content = r.content ?? [];
  return {
    isError: r.isError === true,
    text: content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n'),
    data: r.structuredContent,
    images: content.filter((c) => c.type === 'image').map((c) => ({ mimeType: c.mimeType ?? '', data: c.data ?? '' })),
  };
}

/** Connect the official MCP client to an endpoint URL. */
export async function openClient(url: string, options: { headers?: Record<string, string>; era?: Era } = {}): Promise<Client> {
  const client = new Client(
    { name: 'harness', version: '1.0.0' },
    { versionNegotiation: { mode: options.era === 'modern' ? { pin: MODERN_PROTOCOL } : 'legacy' } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: options.headers ?? {} } }));
  return client;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-test-')));
  const projectDir = path.join(root, 'project');
  const outsideDir = path.join(root, 'outside');
  const stateDir = path.join(root, 'state');
  await mkdir(projectDir);
  await mkdir(outsideDir);

  const authMode = options.auth ?? 'token';
  const token = generateAccessToken();
  const runtime = new Runtime({ stateDir, authMode, ...options.runtime });
  const registry = options.registry ?? createToolRegistry();
  const server = new HttpServer({
    runtime,
    registry,
    auth: new AuthGate(authMode === 'token' ? { mode: 'token', token } : { mode: 'none' }),
    port: 0,
    onError: (error) => {
      // Surface unexpected server-side errors in test output.
      console.error('[harness] server error:', error);
    },
  });
  const port = await server.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  const mcpUrl = `${baseUrl}/mcp`;

  const mode = options.mode === undefined ? 'full' : options.mode;
  if (mode !== null) await runtime.configure({ mode, projectDir });

  const clients: Client[] = [];
  const connect = async (connectOptions: ConnectOptions = {}): Promise<Client> => {
    const presented = connectOptions.token === undefined ? token : connectOptions.token;
    const url = connectOptions.viaPath && presented ? `${mcpUrl}/${presented}` : mcpUrl;
    const headers: Record<string, string> = {};
    if (!connectOptions.viaPath && presented && authMode === 'token') headers['Authorization'] = `Bearer ${presented}`;
    const client = await openClient(url, { headers, ...(connectOptions.era ? { era: connectOptions.era } : {}) });
    clients.push(client);
    return client;
  };

  let shared: Client | undefined;
  return {
    root,
    projectDir,
    outsideDir,
    stateDir,
    runtime,
    registry,
    server,
    token,
    baseUrl,
    mcpUrl,
    connect,
    async call(name, args = {}) {
      shared ??= await connect();
      return outcome(await shared.callTool({ name, arguments: args }, { timeout: 120_000 }));
    },
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
      await runtime.shutdown();
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
