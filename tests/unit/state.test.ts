import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, summarizeArgs } from '../../src/core/audit.js';
import { ConfigStore, stateDir } from '../../src/config/store.js';
import { TransferStore } from '../../src/core/transfers.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mcpclaude-cfg-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('stateDir', () => {
  it('honours MCPCLAUDE_HOME and defaults to ~/.mcpclaude', () => {
    expect(stateDir({ MCPCLAUDE_HOME: '/tmp/x' })).toBe('/tmp/x');
    expect(stateDir({})).toMatch(/\.mcpclaude$/);
  });
});

describe('ConfigStore', () => {
  it('starts empty when the file does not exist', async () => {
    const store = new ConfigStore(path.join(dir, 'nested'));
    expect(await store.load()).toEqual({ version: 1 });
  });

  it('persists updates with owner-only permissions', async () => {
    const store = new ConfigStore(dir);
    await store.load();
    await store.update({ accessToken: 'mcp_abcdefghijklmnop', port: 7332 });
    const info = await stat(store.file);
    expect(info.mode & 0o777).toBe(0o600);
    const again = new ConfigStore(dir);
    expect(await again.load()).toEqual({ version: 1, accessToken: 'mcp_abcdefghijklmnop', port: 7332 });
  });

  it('removes keys set to undefined', async () => {
    const store = new ConfigStore(dir);
    await store.update({ ngrokAuthtoken: 'tok', ngrokDomain: 'a.ngrok.app' });
    await store.update({ ngrokAuthtoken: undefined });
    expect(JSON.parse(await readFile(store.file, 'utf8'))).toEqual({ version: 1, ngrokDomain: 'a.ngrok.app' });
  });

  it('keeps the most recent directories first, without duplicates', async () => {
    const store = new ConfigStore(dir);
    await store.rememberDirectory('/a');
    await store.rememberDirectory('/b');
    await store.rememberDirectory('/a');
    expect(store.value.recentDirectories).toEqual(['/a', '/b']);
  });

  it('recovers from a corrupt file and keeps it aside', async () => {
    const store = new ConfigStore(dir);
    await writeFile(store.file, '{ not json');
    expect(await store.load()).toEqual({ version: 1 });
    expect(await readFile(`${store.file}.corrupt`, 'utf8')).toBe('{ not json');
  });

  it('ignores fields of the wrong type', async () => {
    const store = new ConfigStore(dir);
    await writeFile(store.file, JSON.stringify({ accessToken: 5, port: 'x', recentDirectories: ['/a', 3], extra: true }));
    expect(await store.load()).toEqual({ version: 1, recentDirectories: ['/a'] });
  });
});

describe('audit', () => {
  it('truncates long strings and masks secret-looking keys', () => {
    const summary = summarizeArgs({
      path: '/a',
      content: 'x'.repeat(1000),
      nested: { api_key: 'sk-123', list: Array.from({ length: 30 }, (_, i) => i) },
      Authorization: 'Bearer abc',
    }) as Record<string, any>;
    expect(summary['path']).toBe('/a');
    expect(summary['content']).toMatch(/^x{240}… \(1000 chars\)$/);
    expect(summary['nested']['api_key']).toBe('[redacted]');
    expect(summary['Authorization']).toBe('[redacted]');
    expect(summary['nested']['list']).toHaveLength(21);
  });

  it('appends one JSON line per record to a dated file', async () => {
    const log = new AuditLog(path.join(dir, 'logs'));
    log.record({ time: '2026-11-14T10:00:00.000Z', tool: 'a', args: {}, ok: true, durationMs: 3 });
    log.record({ time: '2026-11-14T10:00:01.000Z', tool: 'b', args: {}, ok: false, durationMs: 4, code: 'NOT_FOUND' });
    await log.flush();
    const lines = (await readFile(path.join(dir, 'logs', 'audit-2026-11-14.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).tool)).toEqual(['a', 'b']);
  });

  it('does nothing when disabled', async () => {
    const log = new AuditLog(undefined);
    log.record({ time: '2026-11-14T10:00:00.000Z', tool: 'a', args: {}, ok: true, durationMs: 3 });
    await log.flush();
  });
});

describe('TransferStore', () => {
  it('issues unguessable ids and enforces kind, uses and expiry', () => {
    let now = 1000;
    const store = new TransferStore({ now: () => now });
    const link = store.create({ kind: 'download', path: '/p/file', expiresInSeconds: 60, uses: 2 });
    expect(link.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(store.take(link.id, 'upload')).toBeUndefined();
    expect(store.take('unknown', 'download')).toBeUndefined();
    expect(store.take(link.id, 'download')?.path).toBe('/p/file');
    expect(store.take(link.id, 'download')).toBeDefined();
    expect(store.take(link.id, 'download')).toBeUndefined();
    store.restore(link);
    expect(store.take(link.id, 'download')).toBeDefined();
    store.restore(link);
    now += 61_000;
    expect(store.take(link.id, 'download')).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('caps the number of active links', () => {
    const store = new TransferStore({ maxLinks: 2 });
    store.create({ kind: 'upload', path: '/a', expiresInSeconds: 60, uses: 1 });
    store.create({ kind: 'upload', path: '/b', expiresInSeconds: 60, uses: 1 });
    expect(() => store.create({ kind: 'upload', path: '/c', expiresInSeconds: 60, uses: 1 })).toThrow(/Too many/);
  });
});
