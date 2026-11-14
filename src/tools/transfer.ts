import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as z from 'zod';
import { ToolError } from '../core/errors.js';
import { LIMITS, type Runtime } from '../core/runtime.js';
import type { TransferLink } from '../core/transfers.js';
import { guessMime } from './files.js';
import { type AnyTool, defineTool } from './registry.js';
import { formatBytes, parseHeaderList } from './util.js';

const MAX_UPLOAD_CHUNK_BYTES = 24 * 1024 * 1024;

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

function parseHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ToolError('INVALID_ARGUMENT', `Not a valid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError('INVALID_ARGUMENT', `Only http and https URLs are supported, got ${url.protocol}`);
  }
  return url;
}

function linkUrls(runtime: Runtime, link: TransferLink): { url: string; local_url: string | undefined } {
  const suffix = `/t/${link.id}/${encodeURIComponent(path.basename(link.path))}`;
  const local = runtime.localBaseUrl ? `${runtime.localBaseUrl}${suffix}` : undefined;
  const url = runtime.publicBaseUrl ? `${runtime.publicBaseUrl}${suffix}` : local;
  if (!url) throw new ToolError('FAILED', 'The server has no reachable URL yet.');
  return { url, local_url: runtime.publicBaseUrl ? local : undefined };
}

export function transferTools(): AnyTool[] {
  const uploadFile = defineTool({
    name: 'upload_file',
    title: 'Upload a file to the Mac',
    group: 'transfer',
    access: 'any',
    description: [
      'Write binary data (base64) to a file on the Mac. Use it for small files you hold in memory: images, archives, fonts, binaries.',
      'For larger files send several chunks: the first with mode "overwrite" or "create", the rest with mode "append"; the result reports the size and SHA-256 so far. For big files, create_upload_link is far more efficient because the data does not pass through the conversation.',
    ].join(' '),
    input: z.object({
      path: z.string().describe('Destination file on the Mac.'),
      content_base64: z.string().describe('File content, or one chunk of it, encoded as base64.'),
      mode: z.enum(['overwrite', 'create', 'append']).default('overwrite').describe('"create" fails if the file exists; "append" adds this chunk to the end.'),
      expected_sha256: z.string().optional().describe('Hex SHA-256 the complete file must have after this write; a mismatch is reported as an error.'),
    }),
    examples: [
      { note: 'Upload a tiny text file as binary.', arguments: { path: 'assets/hello.txt', content_base64: 'aGVsbG8K' } },
      { note: 'Append the next chunk of a larger upload.', arguments: { path: 'assets/logo.png', content_base64: 'iVBORw0KGgo=', mode: 'append' } },
    ],
    hints: { destructive: true },
    async handler(args, { runtime }) {
      const file = await runtime.resolvePath(args.path);
      if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(args.content_base64.replace(/\s+/g, ''))) {
        throw new ToolError('INVALID_ARGUMENT', 'content_base64 is not valid base64.');
      }
      const bytes = Buffer.from(args.content_base64, 'base64');
      if (bytes.length > MAX_UPLOAD_CHUNK_BYTES) {
        throw new ToolError('TOO_LARGE', `Chunk is ${formatBytes(bytes.length)}; the limit is ${formatBytes(MAX_UPLOAD_CHUNK_BYTES)} per call.`, 'Send smaller chunks with mode "append", or use create_upload_link.');
      }
      await mkdir(path.dirname(file), { recursive: true });
      const flag = args.mode === 'append' ? 'a' : args.mode === 'create' ? 'wx' : 'w';
      let handle;
      try {
        handle = await open(file, flag);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new ToolError('ALREADY_EXISTS', `File already exists: ${file}`, 'Use mode "overwrite" or "append".');
        throw err;
      }
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      const size = (await stat(file)).size;
      const sha256 = await sha256File(file);
      if (args.expected_sha256 && args.expected_sha256.toLowerCase() !== sha256) {
        throw new ToolError('FAILED', `Checksum mismatch for ${file}: expected ${args.expected_sha256.toLowerCase()}, file has ${sha256} (${size} bytes).`, 'The file was written but does not match; upload it again.');
      }
      return {
        text: `Wrote ${formatBytes(bytes.length)} to ${file} (${args.mode}). File is now ${formatBytes(size)}, sha256 ${sha256}.`,
        data: { path: file, bytes_written: bytes.length, size_bytes: size, sha256 },
      };
    },
  });

  const downloadFile = defineTool({
    name: 'download_file',
    title: 'Download a file from the Mac',
    group: 'transfer',
    access: 'any',
    description: [
      'Return the bytes of a file on the Mac as base64, whole or in chunks (offset/length). The result is JSON with content_base64, the total size and whether the end of the file was reached.',
      'Base64 through the conversation is only practical for small files. For anything large use create_download_link and fetch the URL with curl from your own environment. To look at an image use view_image instead.',
    ].join(' '),
    input: z.object({
      path: z.string().describe('File on the Mac to download.'),
      offset: z.number().int().min(0).default(0).describe('Byte offset to start at.'),
      length: z.number().int().min(1).max(LIMITS.downloadChunkBytes).default(262_144).describe('Maximum number of bytes to return in this call.'),
      include_sha256: z.boolean().default(false).describe('Also compute the SHA-256 of the whole file.'),
    }),
    examples: [
      { note: 'Fetch a small file.', arguments: { path: 'out/report.pdf' } },
      { note: 'Fetch the second 256 KiB chunk.', arguments: { path: 'out/archive.zip', offset: 262_144 } },
    ],
    hints: { readOnly: true, idempotent: true },
    async handler(args, { runtime }) {
      const file = await runtime.resolvePath(args.path);
      const info = await stat(file);
      if (!info.isFile()) throw new ToolError('INVALID_ARGUMENT', `Not a regular file: ${file}`);
      if (args.offset > info.size) throw new ToolError('INVALID_ARGUMENT', `offset ${args.offset} is beyond the end of the file (${info.size} bytes).`);
      const length = Math.min(args.length, info.size - args.offset);
      const buffer = Buffer.alloc(length);
      const handle = await open(file, 'r');
      try {
        await handle.read(buffer, 0, length, args.offset);
      } finally {
        await handle.close();
      }
      const end = args.offset + length;
      const result: Record<string, unknown> = {
        path: file,
        size_bytes: info.size,
        mime_type: guessMime(file),
        offset: args.offset,
        length,
        eof: end >= info.size,
        ...(end < info.size ? { next_offset: end } : {}),
        ...(args.include_sha256 ? { sha256: await sha256File(file) } : {}),
        content_base64: buffer.toString('base64'),
      };
      // Text only: the payload would otherwise be delivered twice.
      return { text: JSON.stringify(result) };
    },
  });

  const linkOptions = {
    expires_in_seconds: z.number().int().min(30).max(86_400).default(900).describe('How long the link stays valid.'),
  };

  const createDownloadLink = defineTool({
    name: 'create_download_link',
    title: 'Create a download link',
    group: 'transfer',
    access: 'any',
    description: [
      'Create a temporary HTTPS URL from which a file on the Mac can be downloaded with a plain GET (curl, wget, a browser) — no token needed, the URL itself is the secret.',
      'Use it to pull renders, exports and archives into your own environment without sending them through the conversation. The link expires and stops working after max_downloads uses.',
    ].join(' '),
    input: z.object({
      path: z.string().describe('File on the Mac to share.'),
      ...linkOptions,
      max_downloads: z.number().int().min(1).max(100).default(1).describe('How many times the file may be downloaded.'),
    }),
    examples: [{ note: 'Get a URL for a finished render.', arguments: { path: 'renders/final.mp4', expires_in_seconds: 600 } }],
    hints: { openWorld: true },
    async handler(args, { runtime }) {
      const file = await runtime.resolvePath(args.path);
      const info = await stat(file);
      if (!info.isFile()) throw new ToolError('INVALID_ARGUMENT', `Not a regular file: ${file}`);
      const link = runtime.transfers.create({ kind: 'download', path: file, expiresInSeconds: args.expires_in_seconds, uses: args.max_downloads });
      const urls = linkUrls(runtime, link);
      return {
        text: [
          `Download link for ${file} (${formatBytes(info.size)}), valid ${args.expires_in_seconds}s, ${args.max_downloads} download${args.max_downloads === 1 ? '' : 's'}:`,
          urls.url,
          `Example: curl -fL -o '${path.basename(file)}' '${urls.url}'`,
        ].join('\n'),
        data: { ...urls, path: file, size_bytes: info.size, expires_at: new Date(link.expiresAt).toISOString(), max_downloads: args.max_downloads },
      };
    },
  });

  const createUploadLink = defineTool({
    name: 'create_upload_link',
    title: 'Create an upload link',
    group: 'transfer',
    access: 'any',
    description: [
      'Create a temporary HTTPS URL that accepts one file upload (HTTP PUT or POST with the raw file as the body) and stores it at the given path on the Mac.',
      'Use it to push assets from your own environment to the Mac without sending them through the conversation, e.g. `curl -T file URL`. The response is JSON with the byte count and SHA-256.',
    ].join(' '),
    input: z.object({
      path: z.string().describe('Where to store the uploaded file on the Mac.'),
      ...linkOptions,
      max_bytes: z.number().int().min(1).max(50 * 1024 ** 3).default(2 * 1024 ** 3).describe('Largest upload accepted, in bytes.'),
      overwrite: z.boolean().default(false).describe('Allow replacing an existing file at the destination.'),
    }),
    examples: [{ note: 'Prepare to receive a footage file.', arguments: { path: 'footage/shot_010.mov', expires_in_seconds: 1800 } }],
    hints: { openWorld: true, destructive: true },
    async handler(args, { runtime }) {
      const file = await runtime.resolvePath(args.path);
      const existing = await stat(file).catch(() => undefined);
      if (existing?.isDirectory()) throw new ToolError('INVALID_ARGUMENT', `Destination is a directory: ${file}`, 'Give the full file path including the file name.');
      if (existing && !args.overwrite) throw new ToolError('ALREADY_EXISTS', `Destination already exists: ${file}`, 'Set overwrite to true to replace it.');
      await mkdir(path.dirname(file), { recursive: true });
      const link = runtime.transfers.create({
        kind: 'upload',
        path: file,
        expiresInSeconds: args.expires_in_seconds,
        uses: 1,
        maxBytes: args.max_bytes,
        overwrite: args.overwrite,
      });
      const urls = linkUrls(runtime, link);
      return {
        text: [
          `Upload link for ${file}, valid ${args.expires_in_seconds}s, up to ${formatBytes(args.max_bytes)}:`,
          urls.url,
          `Example: curl -f -T ./local-file '${urls.url}'`,
        ].join('\n'),
        data: { ...urls, path: file, expires_at: new Date(link.expiresAt).toISOString(), max_bytes: args.max_bytes },
      };
    },
  });

  const downloadUrl = defineTool({
    name: 'download_url',
    title: 'Download a URL to the Mac',
    group: 'transfer',
    access: 'any',
    description:
      'Make the Mac download a file from the internet (http/https) and save it at the given path. Redirects are followed. Use it for assets, installers, datasets and model files; the data never passes through the conversation.',
    input: z.object({
      url: z.string().describe('http(s) URL to fetch.'),
      path: z.string().describe('Where to save the file on the Mac.'),
      overwrite: z.boolean().default(false).describe('Replace an existing file.'),
      headers: z.array(z.string()).optional().describe('Extra request headers as "Name: value" strings.'),
      max_bytes: z.number().int().min(1).max(100 * 1024 ** 3).default(5 * 1024 ** 3).describe('Abort if the download exceeds this size.'),
      timeout_seconds: z.number().min(1).max(LIMITS.callSeconds).default(200).describe('Abort if the download takes longer than this. For downloads that need more time, run curl with start_process.'),
    }),
    examples: [{ note: 'Fetch a texture into the project.', arguments: { url: 'https://example.com/textures/wood.jpg', path: 'assets/textures/wood.jpg' } }],
    hints: { openWorld: true, destructive: true },
    async handler(args, { runtime, signal }) {
      const url = parseHttpUrl(args.url);
      const headers = parseHeaderList(args.headers);
      const file = await runtime.resolvePath(args.path);
      const existing = await stat(file).catch(() => undefined);
      if (existing?.isDirectory()) throw new ToolError('INVALID_ARGUMENT', `Destination is a directory: ${file}`, 'Give the full file path including the file name.');
      if (existing && !args.overwrite) throw new ToolError('ALREADY_EXISTS', `File already exists: ${file}`, 'Set overwrite to true to replace it.');
      await mkdir(path.dirname(file), { recursive: true });

      const started = Date.now();
      let response: Response;
      try {
        response = await fetch(url, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.any([signal, AbortSignal.timeout(args.timeout_seconds * 1000)]),
        });
      } catch (err) {
        throw new ToolError('FAILED', `Request to ${url.host} failed: ${describeFetchError(err)}`);
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new ToolError('FAILED', `Server answered HTTP ${response.status} ${response.statusText} for ${url.href}`);
      }
      const partial = `${file}.${randomBytes(6).toString('hex')}.part`;
      const hash = createHash('sha256');
      let bytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > args.max_bytes) {
            callback(new ToolError('TOO_LARGE', `Download exceeded max_bytes (${formatBytes(args.max_bytes)}).`));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(partial));
        await rename(partial, file);
      } catch (err) {
        await rm(partial, { force: true }).catch(() => undefined);
        if (err instanceof ToolError) throw err;
        throw new ToolError('FAILED', `Download failed after ${formatBytes(bytes)}: ${describeFetchError(err)}`);
      }
      const sha256 = hash.digest('hex');
      return {
        text: `Downloaded ${url.href} -> ${file} (${formatBytes(bytes)} in ${((Date.now() - started) / 1000).toFixed(1)}s), sha256 ${sha256}.`,
        data: { path: file, size_bytes: bytes, sha256, content_type: response.headers.get('content-type'), final_url: response.url },
      };
    },
  });

  const uploadToUrl = defineTool({
    name: 'upload_to_url',
    title: 'Upload a file from the Mac to a URL',
    group: 'transfer',
    access: 'any',
    description:
      'Make the Mac send a file as the body of an HTTP PUT or POST request, for example to a pre-signed storage URL or an API endpoint. Returns the HTTP status and the beginning of the response body.',
    input: z.object({
      path: z.string().describe('File on the Mac to send.'),
      url: z.string().describe('http(s) URL to send the file to.'),
      method: z.enum(['PUT', 'POST']).default('PUT').describe('HTTP method.'),
      headers: z.array(z.string()).optional().describe('Extra request headers as "Name: value" strings.'),
      content_type: z.string().optional().describe('Content-Type header. Default: guessed from the file extension.'),
      timeout_seconds: z.number().min(1).max(LIMITS.callSeconds).default(200).describe('Abort if the upload takes longer than this. For uploads that need more time, run curl with start_process.'),
    }),
    examples: [{ note: 'Send a render to a pre-signed URL.', arguments: { path: 'renders/final.mp4', url: 'https://storage.example.com/bucket/final.mp4?signature=abc' } }],
    hints: { openWorld: true },
    async handler(args, { runtime, signal }) {
      const url = parseHttpUrl(args.url);
      const file = await runtime.resolvePath(args.path);
      const info = await stat(file);
      if (!info.isFile()) throw new ToolError('INVALID_ARGUMENT', `Not a regular file: ${file}`);
      const headers: Record<string, string> = {
        'Content-Type': args.content_type ?? guessMime(file),
        ...parseHeaderList(args.headers),
        'Content-Length': String(info.size),
      };

      const result = await new Promise<{ status: number; statusText: string; body: string }>((resolve, reject) => {
        const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = send(url, { method: args.method, headers, signal, timeout: args.timeout_seconds * 1000 }, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            if (size < 64 * 1024) chunks.push(chunk);
            size += chunk.length;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
        pipeline(createReadStream(file), req).catch(reject);
      }).catch((err: unknown) => {
        throw new ToolError('FAILED', `Upload to ${url.host} failed: ${describeFetchError(err)}`);
      });

      const snippet = result.body.trim().slice(0, 2000);
      const ok = result.status >= 200 && result.status < 300;
      const text = `${args.method} ${url.origin}${url.pathname} -> HTTP ${result.status} ${result.statusText} (${formatBytes(info.size)} sent)${snippet ? `\n--- response ---\n${snippet}` : ''}`;
      if (!ok) throw new ToolError('FAILED', text);
      return { text, data: { status: result.status, bytes_sent: info.size, response_body: snippet } };
    },
  });

  return [uploadFile, downloadFile, createDownloadLink, createUploadLink, downloadUrl, uploadToUrl];
}

function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (err.name === 'TimeoutError') return 'timed out';
  if (err.name === 'AbortError') return 'cancelled';
  return cause instanceof Error && cause.message ? `${err.message} (${cause.message})` : err.message;
}
