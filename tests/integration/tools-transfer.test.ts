import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionMode } from '../../src/core/permissions.js';
import { createHarness, type Harness } from '../helpers/harness.js';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

interface Received {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** A small origin server standing in for "the internet". */
async function startOrigin(): Promise<{ server: Server; url: string; received: Received[] }> {
  const received: Received[] = [];
  const payload = Buffer.from('0123456789'.repeat(5000));
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url === '/file.bin') {
        res.writeHead(200, { 'content-type': 'application/x-test', 'content-length': payload.length });
        res.end(payload);
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: '/file.bin' });
        res.end();
      } else if (req.url === '/needs-header') {
        const ok = req.headers['x-api-key'] === 'k123';
        res.writeHead(ok ? 200 : 403);
        res.end(ok ? 'granted' : 'denied');
      } else if (req.url?.startsWith('/put-ok')) {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stored: Buffer.concat(chunks).length }));
      } else if (req.url === '/put-fail') {
        res.writeHead(500);
        res.end('storage exploded');
      } else {
        res.writeHead(404);
        res.end('not here');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

describe.each<PermissionMode>(['full', 'project'])('transfer tools (%s mode)', (mode) => {
  let h: Harness;
  let origin: Awaited<ReturnType<typeof startOrigin>>;
  const inProject = (...parts: string[]): string => path.join(h.projectDir, ...parts);

  beforeAll(async () => {
    h = await createHarness({ mode });
    origin = await startOrigin();
    await writeFile(path.join(h.outsideDir, 'secret.txt'), 'outside-secret');
  });
  afterAll(async () => {
    await h.close();
    await new Promise((resolve) => origin.server.close(resolve));
  });

  it('uploads binary data inline, in chunks, with checksum verification', async () => {
    const data = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251));
    const first = await h.call('upload_file', { path: 'up/data.bin', content_base64: data.subarray(0, 1000).toString('base64'), mode: 'create' });
    expect(first.data).toMatchObject({ bytes_written: 1000, size_bytes: 1000, sha256: sha256(data.subarray(0, 1000)) });
    await h.call('upload_file', { path: 'up/data.bin', content_base64: data.subarray(1000, 2000).toString('base64'), mode: 'append' });
    const last = await h.call('upload_file', { path: 'up/data.bin', content_base64: data.subarray(2000).toString('base64'), mode: 'append', expected_sha256: sha256(data).toUpperCase() });
    expect(last.isError).toBe(false);
    expect(await readFile(inProject('up', 'data.bin'))).toEqual(data);

    expect((await h.call('upload_file', { path: 'up/data.bin', content_base64: 'AAAA', mode: 'create' })).text).toContain('Error [ALREADY_EXISTS]');
    expect((await h.call('upload_file', { path: 'up/x.bin', content_base64: 'not base64!!' })).text).toContain('Error [INVALID_ARGUMENT]: content_base64 is not valid base64');
    const mismatch = await h.call('upload_file', { path: 'up/y.bin', content_base64: 'AAAA', expected_sha256: 'abc' });
    expect(mismatch.text).toContain('Error [FAILED]: Checksum mismatch');
  });

  it('downloads file bytes inline, whole or in chunks', async () => {
    const data = Buffer.from(Array.from({ length: 2500 }, (_, i) => (i * 7) % 256));
    await writeFile(inProject('down.bin'), data);

    const whole = JSON.parse((await h.call('download_file', { path: 'down.bin', include_sha256: true })).text);
    expect(whole).toMatchObject({ size_bytes: 2500, offset: 0, length: 2500, eof: true, sha256: sha256(data), mime_type: 'application/octet-stream' });
    expect(Buffer.from(whole.content_base64, 'base64')).toEqual(data);

    const part = JSON.parse((await h.call('download_file', { path: 'down.bin', offset: 1000, length: 1000 })).text);
    expect(part).toMatchObject({ offset: 1000, length: 1000, eof: false, next_offset: 2000 });
    expect(Buffer.from(part.content_base64, 'base64')).toEqual(data.subarray(1000, 2000));
    const tail = JSON.parse((await h.call('download_file', { path: 'down.bin', offset: 2000, length: 1000 })).text);
    expect(tail).toMatchObject({ length: 500, eof: true });
    expect((await h.call('download_file', { path: 'down.bin', offset: 9999 })).text).toContain('beyond the end of the file');
    expect((await h.call('download_file', { path: '.' })).text).toContain('Error [INVALID_ARGUMENT]: Not a regular file');
  });

  it('serves a file through a one-time download link without a token', async () => {
    const data = Buffer.from('render bytes '.repeat(1000));
    await writeFile(inProject('final render.mov'), data);
    const link = await h.call('create_download_link', { path: 'final render.mov' });
    expect(link.isError).toBe(false);
    const url = link.data?.['url'] as string;
    expect(url).toMatch(new RegExp(`^${h.baseUrl}/t/[A-Za-z0-9_-]{32}/final%20render\\.mov$`));
    expect(link.text).toContain(`curl -fL -o 'final render.mov' '${url}'`);

    // HEAD does not use up the link.
    const head = await fetch(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(data.length));

    const got = await fetch(url);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''final%20render.mov");
    expect(Buffer.from(await got.arrayBuffer())).toEqual(data);
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(`${h.baseUrl}/t/${'x'.repeat(32)}`)).status).toBe(404);
  });

  it('allows several downloads when asked and refuses uploads to a download link', async () => {
    await writeFile(inProject('multi.txt'), 'm');
    const url = (await h.call('create_download_link', { path: 'multi.txt', max_downloads: 2 })).data?.['url'] as string;
    expect((await fetch(url, { method: 'PUT', body: 'x' })).status).toBe(404);
    expect(await (await fetch(url)).text()).toBe('m');
    expect(await (await fetch(url)).text()).toBe('m');
    expect((await fetch(url)).status).toBe(404);
    expect((await h.call('create_download_link', { path: 'missing.bin' })).text).toContain('Error [NOT_FOUND]');
  });

  it('receives a file through a one-time upload link', async () => {
    const data = Buffer.from('footage '.repeat(20_000));
    const link = await h.call('create_upload_link', { path: 'footage/shot 010.mov' });
    const url = link.data?.['url'] as string;
    expect(link.text).toContain(`curl -f -T ./local-file '${url}'`);

    const put = await fetch(url, { method: 'PUT', body: data });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true, file: 'shot 010.mov', bytes: data.length, sha256: sha256(data) });
    expect(await readFile(inProject('footage', 'shot 010.mov'))).toEqual(data);
    expect((await fetch(url, { method: 'PUT', body: data })).status).toBe(404);

    expect((await h.call('create_upload_link', { path: 'footage/shot 010.mov' })).text).toContain('Error [ALREADY_EXISTS]');
    const replace = (await h.call('create_upload_link', { path: 'footage/shot 010.mov', overwrite: true })).data?.['url'] as string;
    expect((await fetch(replace, { method: 'POST', body: 'v2' })).status).toBe(200);
    expect(await readFile(inProject('footage', 'shot 010.mov'), 'utf8')).toBe('v2');
  });

  it('enforces the upload size limit and leaves no partial file', async () => {
    const url = (await h.call('create_upload_link', { path: 'footage/too-big.bin', max_bytes: 1000 })).data?.['url'] as string;
    const tooBig = await fetch(url, { method: 'PUT', body: Buffer.alloc(5000) });
    expect(tooBig.status).toBe(413);
    const leftovers = await h.call('search_files', { pattern: 'too-big*', path: 'footage', include_hidden: true });
    expect(leftovers.data?.['results']).toEqual([]);
    // A rejected upload does not consume the link.
    expect((await fetch(url, { method: 'PUT', body: Buffer.alloc(500) })).status).toBe(200);
    expect((await stat(inProject('footage', 'too-big.bin'))).size).toBe(500);
  });

  it('downloads a URL to disk, following redirects and sending headers', async () => {
    const expected = Buffer.from('0123456789'.repeat(5000));
    const result = await h.call('download_url', { url: `${origin.url}/redirect`, path: 'assets/file.bin' });
    expect(result.isError, result.text).toBe(false);
    expect(result.data).toMatchObject({ size_bytes: 50_000, sha256: sha256(expected), content_type: 'application/x-test', final_url: `${origin.url}/file.bin` });
    expect(await readFile(inProject('assets', 'file.bin'))).toEqual(expected);

    expect((await h.call('download_url', { url: `${origin.url}/file.bin`, path: 'assets/file.bin' })).text).toContain('Error [ALREADY_EXISTS]');
    expect((await h.call('download_url', { url: `${origin.url}/file.bin`, path: 'assets/file.bin', overwrite: true })).isError).toBe(false);
    expect((await h.call('download_url', { url: `${origin.url}/needs-header`, path: 'assets/h.txt', headers: ['X-Api-Key: k123'] })).isError).toBe(false);
    expect(await readFile(inProject('assets', 'h.txt'), 'utf8')).toBe('granted');
  });

  it('reports download failures and cleans up', async () => {
    expect((await h.call('download_url', { url: `${origin.url}/nope`, path: 'assets/nope.bin' })).text).toContain('Error [FAILED]: Server answered HTTP 404');
    expect((await h.call('download_url', { url: `${origin.url}/file.bin`, path: 'assets/small.bin', max_bytes: 1000 })).text).toContain('Error [TOO_LARGE]');
    expect((await h.call('download_url', { url: 'ftp://example.com/x', path: 'assets/x' })).text).toContain('Only http and https URLs are supported');
    expect((await h.call('download_url', { url: 'http://127.0.0.1:9/x', path: 'assets/x' })).text).toContain('Error [FAILED]: Request to 127.0.0.1:9 failed');
    expect((await h.call('download_url', { url: `${origin.url}/file.bin`, path: 'assets/h2.txt', headers: ['bad header'] })).text).toContain('Error [INVALID_ARGUMENT]: Invalid header');
    const leftovers = await h.call('search_files', { pattern: '*.part', path: 'assets', include_hidden: true });
    expect(leftovers.data?.['results']).toEqual([]);
  });

  it('uploads a file to a URL with the right method, length and headers', async () => {
    const data = Buffer.from('mp4 bytes '.repeat(3000));
    await writeFile(inProject('clip.mp4'), data);
    origin.received.length = 0;
    const result = await h.call('upload_to_url', { path: 'clip.mp4', url: `${origin.url}/put-ok?sig=abc`, headers: ['X-Trace: t1'] });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain(`PUT ${origin.url}/put-ok -> HTTP 201`);
    expect(result.text).not.toContain('sig=abc');
    expect(result.data).toMatchObject({ status: 201, bytes_sent: data.length, response_body: `{"stored":${data.length}}` });
    const request = origin.received[0];
    expect(request).toMatchObject({ method: 'PUT', url: '/put-ok?sig=abc' });
    expect(request?.headers).toMatchObject({ 'content-type': 'video/mp4', 'content-length': String(data.length), 'x-trace': 't1' });
    expect(request?.body).toEqual(data);

    const post = await h.call('upload_to_url', { path: 'clip.mp4', url: `${origin.url}/put-ok`, method: 'POST', content_type: 'application/octet-stream' });
    expect(post.isError).toBe(false);
    expect(origin.received[1]).toMatchObject({ method: 'POST' });
    expect(origin.received[1]?.headers['content-type']).toBe('application/octet-stream');
    const failed = await h.call('upload_to_url', { path: 'clip.mp4', url: `${origin.url}/put-fail` });
    expect(failed.text).toContain('Error [FAILED]: PUT');
    expect(failed.text).toContain('HTTP 500');
    expect(failed.text).toContain('storage exploded');
  });

  if (mode === 'project') {
    it.each([
      ['upload_file', { path: '../outside/x.bin', content_base64: 'AAAA' }],
      ['download_file', { path: '../outside/secret.txt' }],
      ['create_download_link', { path: '../outside/secret.txt' }],
      ['create_upload_link', { path: '../outside/x.bin' }],
      ['download_url', { url: 'http://127.0.0.1:9/x', path: '../outside/x.bin' }],
      ['upload_to_url', { path: '../outside/secret.txt', url: 'http://127.0.0.1:9/x' }],
    ])('%s cannot reach outside the project', async (tool, args) => {
      const result = await h.call(tool, args);
      expect(result.text).toContain('Error [OUTSIDE_PROJECT]');
    });
  }
});

describe('transfer links and server state', () => {
  it('stop working while the server is paused and use the public URL when a tunnel is up', async () => {
    const h = await createHarness({ mode: 'full' });
    try {
      await writeFile(path.join(h.projectDir, 'a.txt'), 'a');
      h.runtime.publicBaseUrl = 'https://example.ngrok-free.app';
      const link = await h.call('create_download_link', { path: 'a.txt', max_downloads: 3 });
      expect(link.data?.['url']).toMatch(/^https:\/\/example\.ngrok-free\.app\/t\/[\w-]{32}\/a\.txt$/);
      const local = link.data?.['local_url'] as string;
      expect(local.startsWith(`${h.baseUrl}/t/`)).toBe(true);

      h.runtime.setPaused(true);
      expect((await fetch(local)).status).toBe(404);
      h.runtime.setPaused(false);
      expect(await (await fetch(local)).text()).toBe('a');
    } finally {
      await h.close();
    }
  });
});
