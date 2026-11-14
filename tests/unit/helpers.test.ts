import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGlobMatcher, globToRegExp, walk, type WalkState } from '../../src/core/glob.js';
import { fitWithin, readImageInfo } from '../../src/core/image.js';
import { formatBytes, formatDuration, parseEnvList, parseHeaderList, renderTable, shellQuote, splitWords } from '../../src/tools/util.js';
import { makePng } from '../helpers/png.js';

describe('glob matching', () => {
  it.each([
    ['*.ts', 'a.ts', true],
    ['*.ts', 'a.tsx', false],
    ['*.ts', 'dir/a.ts', false],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'x/y/a.ts', true],
    ['src/**/*.ts', 'src/a.ts', true],
    ['src/**/*.ts', 'src/x/y/a.ts', true],
    ['src/**/*.ts', 'lib/a.ts', false],
    ['src/**', 'src/x/y', true],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', false],
    ['file[0-9].txt', 'file7.txt', true],
    ['file[!0-9].txt', 'file7.txt', false],
    ['*.{png,jpg}', 'x.jpg', true],
    ['*.{png,jpg}', 'x.gif', false],
    ['a.b+c(d)', 'a.b+c(d)', true],
    ['a.b', 'aXb', false],
    ['[unclosed', '[unclosed', true],
  ])('%s vs %s -> %s', (pattern, candidate, expected) => {
    expect(globToRegExp(pattern).test(candidate)).toBe(expected);
  });

  it('matches names at any depth when the pattern has no slash', () => {
    const byName = createGlobMatcher('*.aep');
    expect(byName('a/b/shot.aep')).toBe(true);
    expect(byName('shot.aep')).toBe(true);
    const byPath = createGlobMatcher('./a/*.aep');
    expect(byPath('a/shot.aep')).toBe(true);
    expect(byPath('a/b/shot.aep')).toBe(false);
    expect(createGlobMatcher('*.AEP', true)('x.aep')).toBe(true);
    expect(createGlobMatcher('*.AEP', false)('x.aep')).toBe(false);
  });
});

describe('directory walk', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mcpclaude-walk-'));
    await mkdir(path.join(root, 'a', 'b'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'm'), { recursive: true });
    await mkdir(path.join(root, '.git'), { recursive: true });
    for (const file of ['a/1.txt', 'a/b/2.txt', 'node_modules/m/3.txt', '.git/config', '.env']) await writeFile(path.join(root, file), '');
    await symlink(path.join(root, 'a'), path.join(root, 'loop'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const collect = async (options: Parameters<typeof walk>[1], state?: WalkState): Promise<string[]> => {
    const seen: string[] = [];
    for await (const entry of walk(root, options, state)) seen.push(entry.relative);
    return seen;
  };

  it('walks in sorted order, skipping hidden entries and not expanding heavy or linked directories', async () => {
    expect(await collect({})).toEqual(['a', 'a/1.txt', 'a/b', 'a/b/2.txt', 'loop', 'node_modules']);
    expect(await collect({ includeHidden: true })).toEqual(['.env', '.git', 'a', 'a/1.txt', 'a/b', 'a/b/2.txt', 'loop', 'node_modules']);
    expect(await collect({ includeHidden: true, includeHeavy: true })).toContain('node_modules/m/3.txt');
    expect(await collect({ maxDepth: 1 })).toEqual(['a', 'loop', 'node_modules']);
  });

  it('stops at the visit budget and when aborted', async () => {
    const state: WalkState = { visited: 0, exhausted: false };
    expect(await collect({ maxVisited: 2 }, state)).toEqual(['a', 'a/1.txt']);
    expect(state.exhausted).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect(await collect({ signal: controller.signal })).toEqual([]);
  });
});

describe('image headers', () => {
  it('reads PNG, GIF, JPEG and WebP dimensions', () => {
    expect(readImageInfo(makePng(321, 123))).toEqual({ format: 'png', width: 321, height: 123 });

    const gif = Buffer.alloc(16);
    gif.write('GIF89a', 0, 'latin1');
    gif.writeUInt16LE(640, 6);
    gif.writeUInt16LE(480, 8);
    expect(readImageInfo(gif)).toEqual({ format: 'gif', width: 640, height: 480 });

    // SOI, APP0 (16 bytes), SOF0 with 1080x1920
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0),
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, ...new Array<number>(12).fill(0),
    ]);
    expect(readImageInfo(jpeg)).toEqual({ format: 'jpeg', width: 1920, height: 1080 });

    const webp = Buffer.alloc(32);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8X', 12, 'latin1');
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(599, 27, 3);
    expect(readImageInfo(webp)).toEqual({ format: 'webp', width: 800, height: 600 });
  });

  it('returns undefined for anything else', () => {
    expect(readImageInfo(Buffer.from('plain text file'))).toBeUndefined();
    expect(readImageInfo(Buffer.alloc(0))).toBeUndefined();
    expect(readImageInfo(Buffer.from([0xff, 0xd8, 0xff]))).toBeUndefined();
  });

  it('fits sizes within a maximum dimension without upscaling', () => {
    expect(fitWithin(3024, 1964, 1280)).toMatchObject({ width: 1280, height: 831 });
    expect(fitWithin(1080, 1920, 1280)).toMatchObject({ width: 720, height: 1280 });
    expect(fitWithin(800, 600, 1280)).toEqual({ width: 800, height: 600, scale: 1 });
    expect(fitWithin(10_000, 1, 100)).toMatchObject({ width: 100, height: 1 });
  });
});

describe('tool utilities', () => {
  it('formats sizes and durations', () => {
    expect([0, 1023, 1024, 1536, 5 * 1024 ** 2, 123 * 1024 ** 3].map(formatBytes)).toEqual(['0 B', '1023 B', '1.0 KB', '1.5 KB', '5.0 MB', '123 GB']);
    expect([12, 1500, 61_000, 3_725_000].map(formatDuration)).toEqual(['12ms', '1.5s', '1m 1s', '1h 2m']);
  });

  it('parses environment and header lists strictly', () => {
    expect(parseEnvList(['A=1', 'B=x=y', 'EMPTY='])).toEqual({ A: '1', B: 'x=y', EMPTY: '' });
    expect(parseEnvList(undefined)).toEqual({});
    expect(() => parseEnvList(['=x'])).toThrow(/Invalid environment entry/);
    expect(() => parseEnvList(['1BAD=x'])).toThrow(/Invalid environment entry/);
    expect(parseHeaderList(['Authorization: Bearer a:b', 'X-One:1'])).toEqual({ Authorization: 'Bearer a:b', 'X-One': '1' });
    expect(() => parseHeaderList(['no colon'])).toThrow(/Invalid header/);
    expect(() => parseHeaderList(['Bad Name: x'])).toThrow(/Invalid header/);
  });

  it('splits command words with quotes and escapes', () => {
    expect(splitWords('deno run --allow-read')).toEqual(['deno', 'run', '--allow-read']);
    expect(splitWords(`"/Applications/My App/bin/tool" -x 'a b' c\\ d ""`)).toEqual(['/Applications/My App/bin/tool', '-x', 'a b', 'c d', '']);
    expect(splitWords('   ')).toEqual([]);
    expect(() => splitWords('"open')).toThrow(/Unterminated quote/);
  });

  it('quotes words for display and renders tables', () => {
    expect(shellQuote('plain-word_1.txt')).toBe('plain-word_1.txt');
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
    expect(renderTable(['id', 'name'], [['p1', 'server'], ['p10', 'x']])).toBe('id   name\np1   server\np10  x');
  });
});
