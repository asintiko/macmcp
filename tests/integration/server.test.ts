import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { ToolError } from '../../src/core/errors.js';
import { sleep } from '../../src/core/exec.js';
import type { ToolCallEvent } from '../../src/core/runtime.js';
import { metaTools } from '../../src/tools/meta.js';
import { defineTool, ToolRegistry } from '../../src/tools/registry.js';
import { createHarness, type Era, type Harness, MODERN_PROTOCOL, outcome } from '../helpers/harness.js';

/** Real meta tools plus a few probes that exercise the framework. */
function testRegistry(): ToolRegistry {
  const holder: { registry?: ToolRegistry } = {};
  holder.registry = new ToolRegistry([
    ...metaTools(() => holder.registry as ToolRegistry),
    defineTool({
      name: 'echo',
      title: 'Echo',
      group: 'shell',
      access: 'any',
      description: 'Return the given text.',
      input: z.object({ text: z.string().describe('Text to return'), times: z.number().int().min(1).max(3).default(1).describe('Repeat count') }),
      examples: [{ arguments: { text: 'hi' } }],
      handler: async ({ text, times }) => ({ text: text.repeat(times), data: { length: text.length * times } }),
    }),
    defineTool({
      name: 'full_only',
      title: 'Full only',
      group: 'computer',
      access: 'full',
      description: 'A tool that needs Full System Access.',
      input: z.object({}),
      examples: [{ arguments: {} }],
      handler: async () => 'did the full-access thing',
    }),
    defineTool({
      name: 'fail',
      title: 'Fail',
      group: 'shell',
      access: 'any',
      description: 'Always fails.',
      input: z.object({ kind: z.enum(['tool', 'plain', 'fs']).describe('Which error to raise') }),
      examples: [{ arguments: { kind: 'tool' } }],
      handler: async ({ kind }) => {
        if (kind === 'tool') throw new ToolError('CONFLICT', 'nope', 'try something else');
        if (kind === 'fs') await readFile('/definitely/not/here');
        throw new Error('plain failure');
      },
    }),
    defineTool({
      name: 'picture',
      title: 'Picture',
      group: 'shell',
      access: 'any',
      description: 'Returns an image.',
      input: z.object({}),
      examples: [{ arguments: {} }],
      handler: async () => ({ text: 'one pixel', images: [{ base64: 'iVBORw0KGgo=', mimeType: 'image/png' }] }),
    }),
    defineTool({
      name: 'slow',
      title: 'Slow',
      group: 'shell',
      access: 'any',
      description: 'Reports progress, then finishes or is cancelled.',
      input: z.object({ steps: z.number().int().describe('Number of 50 ms steps') }),
      examples: [{ arguments: { steps: 2 } }],
      handler: async ({ steps }, ctx) => {
        for (let i = 0; i < steps; i++) {
          if (ctx.signal.aborted) return 'cancelled';
          await ctx.progress(`step ${i + 1}`);
          await sleep(50, ctx.signal);
        }
        return 'finished';
      },
    }),
  ]);
  return holder.registry;
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe.each<Era>(['legacy', 'modern'])('MCP endpoint (%s client)', (era) => {
  it('negotiates the expected protocol revision and lists tools with schemas', async () => {
    harness = await createHarness({ registry: testRegistry() });
    const client = await harness.connect({ era });
    const version = client.getNegotiatedProtocolVersion();
    if (era === 'modern') expect(version).toBe(MODERN_PROTOCOL);
    else expect(version).toMatch(/^2025-/);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['server_info', 'usage_guide', 'echo', 'full_only', 'fail', 'picture', 'slow']);
    const echo = tools.find((t) => t.name === 'echo');
    expect(echo?.title).toBe('Echo');
    expect(echo?.description).toBe('Return the given text.\nExample: {"text":"hi"}');
    expect(echo?.inputSchema).toMatchObject({
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string', description: 'Text to return' }, times: { type: 'integer', default: 1, description: 'Repeat count' } },
    });
    expect(echo?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.find((t) => t.name === 'full_only')?.description).toContain('Requires Full System Access mode.');
  });

  it('calls tools and returns text, structured data and images', async () => {
    harness = await createHarness({ registry: testRegistry() });
    const client = await harness.connect({ era });
    const echoed = outcome(await client.callTool({ name: 'echo', arguments: { text: 'ab', times: 2 } }));
    expect(echoed).toMatchObject({ isError: false, text: 'abab', data: { length: 4 } });
    const picture = outcome(await client.callTool({ name: 'picture', arguments: {} }));
    expect(picture.images).toEqual([{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }]);
    expect(picture.text).toBe('one pixel');
  });

  it('turns failures into error results with stable codes', async () => {
    harness = await createHarness({ registry: testRegistry() });
    const client = await harness.connect({ era });
    const call = async (kind: string): Promise<string> => {
      const result = outcome(await client.callTool({ name: 'fail', arguments: { kind } }));
      expect(result.isError).toBe(true);
      return result.text;
    };
    expect(await call('tool')).toBe('Error [CONFLICT]: nope\nHint: try something else');
    expect(await call('plain')).toBe('Error [INTERNAL]: plain failure');
    expect(await call('fs')).toBe('Error [NOT_FOUND]: No such file or directory: /definitely/not/here');
    const invalid = outcome(await client.callTool({ name: 'echo', arguments: { text: 5 } }));
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain('Invalid arguments for tool echo');
    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(/not found/i);
  });

  it('streams progress notifications', async () => {
    harness = await createHarness({ registry: testRegistry() });
    const client = await harness.connect({ era });
    const messages: string[] = [];
    const result = await client.callTool({ name: 'slow', arguments: { steps: 3 } }, { onprogress: (p) => messages.push(p.message ?? '') });
    expect(outcome(result).text).toBe('finished');
    expect(messages).toEqual(['step 1', 'step 2', 'step 3']);
  });

  it('serves informational tools during setup but refuses everything else', async () => {
    harness = await createHarness({ registry: testRegistry(), mode: null });
    const client = await harness.connect({ era });
    expect((await client.listTools()).tools).toHaveLength(7);

    const info = outcome(await client.callTool({ name: 'server_info', arguments: {} }));
    expect(info.isError).toBe(false);
    expect(info.data).toMatchObject({ status: 'setup_pending', permission_mode: null, project_directory: null });

    const refused = outcome(await client.callTool({ name: 'echo', arguments: { text: 'x' } }));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Error [SETUP_PENDING]');

    await harness.runtime.configure({ mode: 'full', projectDir: harness.projectDir });
    expect(outcome(await client.callTool({ name: 'echo', arguments: { text: 'x' } })).text).toBe('x');
  });

  it('hides Full-Access tools in Project-Only mode and explains when one is called anyway', async () => {
    harness = await createHarness({ registry: testRegistry(), mode: 'project' });
    const client = await harness.connect({ era });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('full_only');
    expect(names).toContain('echo');

    const refused = outcome(await client.callTool({ name: 'full_only', arguments: {} }));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Error [PERMISSION_DENIED]: full_only requires Full System Access');
    expect(refused.text).toContain('Project-Only Access mode');

    const info = outcome(await client.callTool({ name: 'server_info', arguments: {} }));
    expect(info.data).toMatchObject({
      status: 'ready',
      permission_mode: 'project',
      project_directory: harness.projectDir,
      working_directory: harness.projectDir,
      tool_groups: { shell: { status: 'available' }, computer: { status: 'requires Full System Access' } },
    });
  });

  it('refuses calls while paused and resumes afterwards', async () => {
    harness = await createHarness({ registry: testRegistry() });
    const client = await harness.connect({ era });
    harness.runtime.setPaused(true);
    const paused = outcome(await client.callTool({ name: 'echo', arguments: { text: 'x' } }));
    expect(paused.text).toContain('Error [PAUSED]');
    expect(outcome(await client.callTool({ name: 'server_info', arguments: {} })).data).toMatchObject({ status: 'paused' });
    harness.runtime.setPaused(false);
    expect(outcome(await client.callTool({ name: 'echo', arguments: { text: 'x' } })).isError).toBe(false);
  });
});

describe('authentication', () => {
  it('rejects requests without or with a wrong token', async () => {
    harness = await createHarness({ registry: testRegistry() });
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

    const missing = await post(harness.mcpUrl, init);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer realm="mcpclaude"');
    expect(await missing.json()).toMatchObject({ error: 'unauthorized' });

    const wrong = await post(harness.mcpUrl, init, { authorization: 'Bearer mcp_wrongwrongwrongwrong' });
    expect(wrong.status).toBe(401);
    const wrongPath = await post(`${harness.mcpUrl}/mcp_wrongwrongwrongwrong`, init);
    expect(wrongPath.status).toBe(401);
    await expect(harness.connect({ token: null })).rejects.toThrow();
  });

  it('accepts the token in the header or in the URL path', async () => {
    harness = await createHarness({ registry: testRegistry() });
    const viaHeader = await harness.connect();
    expect(outcome(await viaHeader.callTool({ name: 'echo', arguments: { text: 'h' } })).text).toBe('h');
    const viaPath = await harness.connect({ viaPath: true });
    expect(outcome(await viaPath.callTool({ name: 'echo', arguments: { text: 'p' } })).text).toBe('p');
    const modernViaPath = await harness.connect({ viaPath: true, era: 'modern' });
    expect(outcome(await modernViaPath.callTool({ name: 'echo', arguments: { text: 'm' } })).text).toBe('m');
  });

  it('throttles repeated wrong tokens', async () => {
    harness = await createHarness({ registry: testRegistry() });
    let last = 0;
    for (let i = 0; i < 21; i++) {
      const response = await post(harness.mcpUrl, {}, { authorization: 'Bearer mcp_wrongwrongwrongwrong' });
      last = response.status;
      if (last === 429) expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    expect(last).toBe(429);
  });

  it('is open in no-auth mode, with or without a path segment', async () => {
    harness = await createHarness({ registry: testRegistry(), auth: 'none' });
    const client = await harness.connect({ token: null });
    expect(outcome(await client.callTool({ name: 'echo', arguments: { text: 'open' } })).text).toBe('open');
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    expect((await post(`${harness.mcpUrl}/anything`, init)).status).toBe(200);
  });
});

describe('HTTP surface', () => {
  it('answers health checks and unknown paths without authentication details', async () => {
    harness = await createHarness({ registry: testRegistry() });
    const health = await fetch(`${harness.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', name: 'mcpclaude' });
    expect(health.headers.get('cache-control')).toBe('no-store');

    for (const p of ['/', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/mcp/a/b']) {
      const response = await fetch(`${harness.baseUrl}${p}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBe('application/json');
    }
  });

  it('rejects unknown Host headers and foreign web origins, and accepts registered public hosts', async () => {
    harness = await createHarness({ registry: testRegistry(), auth: 'none' });
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const { request } = await import('node:http');
    const withHost = (host: string, origin?: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const payload = JSON.stringify(init);
        const req = request(
          `${harness?.mcpUrl}`,
          {
            method: 'POST',
            headers: {
              host,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'content-length': Buffer.byteLength(payload),
              ...(origin ? { origin } : {}),
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(payload);
      });

    expect(await withHost('evil.example.com')).toBe(403);
    expect(await withHost('abc.ngrok-free.app')).toBe(403);
    harness.server.allowHost('abc.ngrok-free.app');
    expect(await withHost('abc.ngrok-free.app')).toBe(200);
    expect(await withHost('ABC.ngrok-free.app:443')).toBe(200);
    expect(await withHost('abc.ngrok-free.app', 'https://evil.example.com')).toBe(403);
    expect(await withHost('abc.ngrok-free.app', 'https://abc.ngrok-free.app')).toBe(200);
  });

  it('answers malformed JSON with a JSON-RPC parse error and GET with 405', async () => {
    harness = await createHarness({ registry: testRegistry() });
    const auth = { authorization: `Bearer ${harness.token}` };
    const bad = await post(harness.mcpUrl, '{not json', auth);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: -32700 } });
    const get = await fetch(harness.mcpUrl, { headers: { ...auth, accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
  });
});

describe('audit trail', () => {
  it('emits an event and writes a log line per tool call, with the client name and without secrets', async () => {
    harness = await createHarness({ registry: testRegistry(), mode: 'project' });
    const events: ToolCallEvent[] = [];
    harness.runtime.events.on('tool', (event) => events.push(event));
    const rpc: string[] = [];
    harness.runtime.events.on('rpc', (event) => rpc.push(event.method));

    await harness.call('echo', { text: 'x'.repeat(500) });
    await harness.call('fail', { kind: 'tool' });
    await harness.call('full_only');

    expect(rpc).toContain('initialize');
    expect(rpc.filter((m) => m === 'tools/call')).toHaveLength(3);
    expect(events.map((e) => [e.tool, e.ok, e.code])).toEqual([
      ['echo', true, undefined],
      ['fail', false, 'CONFLICT'],
      ['full_only', false, 'PERMISSION_DENIED'],
    ]);
    expect(events[0]?.client).toBe('harness 1.0.0');
    expect(JSON.stringify(events[0]?.args)).toContain('(500 chars)');

    await harness.runtime.audit.flush();
    const logDir = path.join(harness.stateDir, 'logs');
    const [file] = await readdir(logDir);
    const lines = (await readFile(path.join(logDir, file as string), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ tool: 'echo', ok: true, mode: 'project', client: 'harness 1.0.0' });
    expect(JSON.stringify(lines)).not.toContain(harness.token);
  });
});
