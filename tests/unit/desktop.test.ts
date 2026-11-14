import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nativePath } from '../../src/assets.js';
import { ToolError } from '../../src/core/errors.js';
import {
  clampShotRect,
  displayContaining,
  type DisplayInfo,
  pickDisplay,
  pointFromShot,
  rectFromShot,
  rectToShot,
  screenGeometry,
  shotFromPoint,
} from '../../src/desktop/geometry.js';
import { DesktopHelper, HelperFailure } from '../../src/desktop/helper.js';
import { parseKeyCombo, parseKeySequence, parseModifiers } from '../../src/desktop/keys.js';

const retina: DisplayInfo = { id: 1, index: 1, main: true, x: 0, y: 0, width: 1440, height: 900, pixelWidth: 2880, pixelHeight: 1800, scale: 2 };
const plain: DisplayInfo = { id: 1, index: 1, main: true, x: 0, y: 0, width: 1024, height: 768, pixelWidth: 1024, pixelHeight: 768, scale: 1 };
const second: DisplayInfo = { id: 2, index: 2, main: false, x: 1440, y: -90, width: 1920, height: 1080, pixelWidth: 1920, pixelHeight: 1080, scale: 1 };

describe('screenshot geometry', () => {
  it('sizes full screenshots by the long edge and never enlarges them', () => {
    expect(screenGeometry(retina, 1280)).toMatchObject({ shot: { width: 1280, height: 800 }, pointsPerPixel: 1.125 });
    expect(screenGeometry(plain, 1280)).toMatchObject({ shot: { width: 1024, height: 768 }, pointsPerPixel: 1 });
    expect(screenGeometry(second, 1280)).toMatchObject({ shot: { width: 1280, height: 720 }, pointsPerPixel: 1.5 });
    expect(screenGeometry(retina, 2000).shot).toEqual({ width: 2000, height: 1250 });
    const portrait: DisplayInfo = { ...plain, width: 768, height: 1024, pixelWidth: 1536, pixelHeight: 2048, scale: 2 };
    expect(screenGeometry(portrait, 1280).shot).toEqual({ width: 960, height: 1280 });
  });

  it('maps screenshot pixels to display points and back', () => {
    const g = screenGeometry(retina, 1280);
    expect(pointFromShot(g, { x: 640, y: 400 })).toEqual({ x: 720.5625, y: 450.5625 });
    expect(shotFromPoint(g, { x: 720.5625, y: 450.5625 })).toEqual({ x: 640, y: 400 });
    // Every pixel survives the round trip, also when the system rounds the point.
    for (const pixel of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 333, y: 777 }, { x: 1279, y: 799 }]) {
      const point = pointFromShot(g, pixel);
      expect(shotFromPoint(g, point)).toEqual(pixel);
      expect(shotFromPoint(g, { x: Math.round(point.x), y: Math.round(point.y) })).toEqual(pixel);
    }
  });

  it('is the identity on a display whose screenshot is not scaled', () => {
    const g = screenGeometry(plain, 1280);
    expect(pointFromShot(g, { x: 100, y: 200 })).toEqual({ x: 100, y: 200 });
    expect(shotFromPoint(g, { x: 100, y: 200 })).toEqual({ x: 100, y: 200 });
  });

  it('offsets coordinates on secondary displays', () => {
    const g = screenGeometry(second, 1280);
    expect(pointFromShot(g, { x: 0, y: 0 })).toEqual({ x: 1440.75, y: -89.25 });
    expect(pointFromShot(g, { x: 100, y: 60 })).toEqual({ x: 1590.75, y: 0.75 });
    expect(shotFromPoint(g, { x: 1590.75, y: 0.75 })).toEqual({ x: 100, y: 60 });
  });

  it('rejects coordinates outside the screenshot and accepts its far edges', () => {
    const g = screenGeometry(retina, 1280);
    expect(pointFromShot(g, { x: 1280, y: 800 })).toEqual(pointFromShot(g, { x: 1279, y: 799 }));
    for (const pixel of [{ x: -1, y: 10 }, { x: 10, y: 801 }, { x: 2000, y: 10 }, { x: Number.NaN, y: 10 }]) {
      expect(() => pointFromShot(g, pixel)).toThrow(/outside the screen: the screenshot of display 1 is 1280×800 pixels/);
    }
  });

  it('converts rectangles both ways and clips regions to the screen', () => {
    const g = screenGeometry(retina, 1280);
    expect(rectToShot(g, { x: 112.5, y: 225, width: 450, height: 337.5 })).toEqual({ x: 100, y: 200, width: 400, height: 300 });
    expect(rectFromShot(g, { x: 100, y: 200, width: 400, height: 300 })).toEqual({ x: 112.5, y: 225, width: 450, height: 337.5 });
    expect(rectToShot(screenGeometry(second, 1280), { x: 1440, y: -90, width: 960, height: 540 })).toEqual({ x: 0, y: 0, width: 640, height: 360 });
    expect(clampShotRect(g, { x: -10, y: -10, width: 50, height: 50 })).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    expect(clampShotRect(g, { x: 1200, y: 700, width: 500, height: 500 })).toEqual({ x: 1200, y: 700, width: 80, height: 100 });
    expect(() => clampShotRect(g, { x: 1300, y: 0, width: 50, height: 50 })).toThrow(/does not overlap the screen/);
  });

  it('picks displays by index and by position', () => {
    expect(pickDisplay([second, retina], undefined)).toBe(retina);
    expect(pickDisplay([retina, second], 2)).toBe(second);
    expect(() => pickDisplay([retina], 2)).toThrow(/There is no display 2: this Mac has 1 display /);
    expect(() => pickDisplay([], undefined)).toThrow(/no active display/);
    expect(displayContaining([retina, second], { x: 2000, y: 100 })).toBe(second);
    expect(displayContaining([retina, second], { x: 10, y: 10 })).toBe(retina);
    expect(displayContaining([retina, second], { x: -50, y: 2000 })).toBe(retina);
  });
});

describe('key combinations', () => {
  it('parses shortcuts with modifiers in any spelling', () => {
    expect(parseKeyCombo('cmd+shift+s')).toEqual({ modifiers: ['cmd', 'shift'], char: 's', label: 'cmd+shift+s' });
    expect(parseKeyCombo('Command+S')).toEqual({ modifiers: ['cmd'], char: 's', label: 'cmd+s' });
    expect(parseKeyCombo(' ctrl + option + Delete ')).toEqual({ modifiers: ['alt', 'ctrl'], code: 51, label: 'alt+ctrl+delete' });
    expect(parseKeyCombo('shift+cmd+shift+z').modifiers).toEqual(['cmd', 'shift']);
    expect(parseKeyCombo('fn+f5')).toEqual({ modifiers: ['fn'], code: 96, label: 'fn+f5' });
  });

  it('knows the named keys', () => {
    for (const [name, code] of [['return', 36], ['Enter', 36], ['tab', 48], ['space', 49], ['escape', 53], ['esc', 53], ['delete', 51], ['backspace', 51], ['forwarddelete', 117], ['left', 123], ['right', 124], ['down', 125], ['up', 126], ['home', 115], ['end', 119], ['pageup', 116], ['pagedown', 121], ['f1', 122], ['F12', 111]] as const) {
      expect(parseKeyCombo(name), name).toMatchObject({ modifiers: [], code });
    }
  });

  it('treats anything else as the character on the key', () => {
    expect(parseKeyCombo('a')).toEqual({ modifiers: [], char: 'a', label: 'a' });
    expect(parseKeyCombo('A')).toEqual({ modifiers: [], char: 'A', label: 'A' });
    expect(parseKeyCombo('7').char).toBe('7');
    expect(parseKeyCombo('é').char).toBe('é');
    expect(parseKeyCombo('cmd+,').char).toBe(',');
    expect(parseKeyCombo('cmd++')).toEqual({ modifiers: ['cmd'], char: '+', label: 'cmd++' });
    expect(parseKeyCombo('cmd+plus').char).toBe('+');
    expect(parseKeyCombo('+').char).toBe('+');
    expect(parseKeyCombo('cmd+minus').char).toBe('-');
    expect(parseKeyCombo('alt+slash').char).toBe('/');
  });

  it('accepts a modifier on its own, to hold it', () => {
    expect(parseKeyCombo('shift')).toEqual({ modifiers: [], code: 56, label: 'shift' });
    expect(parseKeyCombo('command').code).toBe(55);
    expect(parseKeyCombo('option').code).toBe(58);
  });

  it('explains what is wrong with a combination', () => {
    expect(() => parseKeyCombo('')).toThrow('Empty key combination');
    expect(() => parseKeyCombo('cmd+')).toThrow('Malformed key combination "cmd+"');
    expect(() => parseKeyCombo('hyper+s')).toThrow('Unknown modifier "hyper" in "hyper+s"');
    expect(() => parseKeyCombo('s+cmd')).toThrow('Unknown modifier "s"');
    expect(() => parseKeyCombo('cmd+banana')).toThrow('Unknown key "banana" in "cmd+banana"');
    expect(() => parseKeyCombo('cmd+banana')).toThrow(ToolError);
  });

  it('splits sequences on spaces and normalises modifier lists', () => {
    expect(parseKeySequence('cmd+a  cmd+c').map((k) => k.label)).toEqual(['cmd+a', 'cmd+c']);
    expect(parseKeySequence('down down return').map((k) => k.code)).toEqual([125, 125, 36]);
    expect(() => parseKeySequence('   ')).toThrow('No keys given');
    expect(parseModifiers(['Option', 'command', 'cmd'])).toEqual(['cmd', 'alt']);
    expect(parseModifiers(undefined)).toEqual([]);
    expect(() => parseModifiers(['hyper'])).toThrow('Unknown modifier "hyper"');
  });
});

describe('desktop helper build and protocol', () => {
  let root: string;
  let sourceDir: string;
  let stateDir: string;
  let compiler: string;
  let log: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mcpclaude-helper-'));
    sourceDir = path.join(root, 'src');
    stateDir = path.join(root, 'state');
    compiler = path.join(root, 'fake-swiftc');
    log = path.join(root, 'compiler.log');
    await mkdir(sourceDir);
    await writeFile(path.join(sourceDir, 'main.swift'), '// main');
    await writeFile(path.join(sourceDir, 'Support.swift'), '// support');
    await writeFile(path.join(sourceDir, 'notes.txt'), 'not a source');
    // Stands in for swiftc: "compiles" a script that records its request and plays back a reply.
    await writeFile(
      compiler,
      `#!/bin/sh
echo "$@" >> '${log}'
if [ -f '${root}/fail-compile' ]; then echo "main.swift:3:1: error: expected declaration" >&2; exit 1; fi
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift; fi
  shift
done
cat > "$out" <<'EOF'
#!/bin/sh
cat > "$0.request"
if [ -f "$0.reply" ]; then cat "$0.reply"; else echo '{"ok":true,"results":[{"pong":true}]}'; fi
EOF
chmod +x "$out"
`,
    );
    await chmod(compiler, 0o755);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const helper = (): DesktopHelper => new DesktopHelper({ stateDir, sourceDir, swiftc: compiler });
  const compilations = async (): Promise<string[]> => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);

  it('compiles the sources once and reuses the binary', async () => {
    const first = helper();
    expect(await first.isBuilt()).toBe(false);
    let announced = 0;
    const binary = await first.ensureBuilt(() => (announced += 1));
    expect(binary).toMatch(/state\/bin\/mcpclaude-helper-[0-9a-f]{16}$/);
    expect(await first.isBuilt()).toBe(true);
    await first.ensureBuilt(() => (announced += 1));
    await helper().ensureBuilt(() => (announced += 1));
    expect(announced).toBe(1);

    const runs = await compilations();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain('-swift-version 5 -module-name mcpclaude_helper -o');
    // Sources in a stable order, and only Swift files.
    expect(runs[0]?.endsWith(`${path.join(sourceDir, 'Support.swift')} ${path.join(sourceDir, 'main.swift')}`)).toBe(true);
  });

  it('builds only once when several calls arrive together', async () => {
    const shared = helper();
    const paths = await Promise.all([shared.ensureBuilt(), shared.ensureBuilt(), shared.run([{ command: 'ping' }])]);
    expect(paths[0]).toBe(paths[1]);
    expect(await compilations()).toHaveLength(1);
  });

  it('rebuilds when the sources change and removes the old binary', async () => {
    const before = await helper().ensureBuilt();
    await writeFile(path.join(sourceDir, 'main.swift'), '// main, changed');
    const after = await helper().ensureBuilt();
    expect(after).not.toBe(before);
    expect(await compilations()).toHaveLength(2);
    expect(await readdir(path.join(stateDir, 'bin'))).toEqual([path.basename(after)]);
  });

  it('reports compiler output when the build fails', async () => {
    await writeFile(path.join(root, 'fail-compile'), '');
    const failure = await helper().ensureBuilt().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ToolError);
    expect(failure).toMatchObject({ code: 'DEPENDENCY_MISSING' });
    expect((failure as ToolError).message).toContain('main.swift:3:1: error: expected declaration');
    expect((failure as ToolError).hint).toContain('mcpclaude doctor');
    expect(await readdir(path.join(stateDir, 'bin'))).toEqual([]);
    // A later attempt compiles again rather than remembering the failure.
    await rm(path.join(root, 'fail-compile'));
    await expect(helper().ensureBuilt()).resolves.toMatch(/mcpclaude-helper-/);
  });

  it('sends commands as JSON on standard input and returns their results', async () => {
    const built = helper();
    const results = await built.run([{ command: 'mouse_click', params: { x: 10.5, y: 20, button: 'left' } }, { command: 'cursor' }]);
    expect(results).toEqual([{ pong: true }]);
    const request = JSON.parse(await readFile(`${await built.binaryPath()}.request`, 'utf8'));
    expect(request).toEqual({ commands: [{ command: 'mouse_click', params: { x: 10.5, y: 20, button: 'left' } }, { command: 'cursor' }] });
    expect(await built.run([])).toEqual([]);
  });

  it('turns helper errors into tool errors that say what the user must do', async () => {
    const built = helper();
    const binary = await built.ensureBuilt();
    const reply = async (error: { code: string; message: string }, index = 1): Promise<HelperFailure> => {
      await writeFile(`${binary}.reply`, JSON.stringify({ ok: false, index, results: [{ done: true }], error }));
      return built.run([{ command: 'a' }, { command: 'b' }]).catch((err: unknown) => err) as Promise<HelperFailure>;
    };

    const denied = await reply({ code: 'ACCESSIBILITY_REQUIRED', message: 'macOS has not granted Accessibility access' });
    expect(denied).toBeInstanceOf(HelperFailure);
    expect(denied).toMatchObject({ code: 'MACOS_PERMISSION_REQUIRED', index: 1, completed: [{ done: true }] });
    expect(denied.hint).toContain('Privacy & Security → Accessibility');

    expect(await reply({ code: 'INVALID', message: 'bad' })).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'bad' });
    expect(await reply({ code: 'NOT_FOUND', message: 'gone' })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await reply({ code: 'FAILED', message: 'nope' }, 0)).toMatchObject({ code: 'FAILED', index: 0 });
    expect(await reply({ code: 'SOMETHING_NEW', message: 'odd' })).toMatchObject({ code: 'FAILED' });
  });

  it('reports a helper that dies without a proper answer', async () => {
    const built = helper();
    const binary = await built.ensureBuilt();
    await writeFile(`${binary}.reply`, 'Fatal error: unexpectedly found nil\n');
    await expect(built.run([{ command: 'ping' }])).rejects.toMatchObject({ code: 'FAILED', message: expect.stringContaining('stopped unexpectedly') });
  });

  it('ships Swift sources for the real helper', async () => {
    const names = (await readdir(nativePath('helper'))).filter((name) => name.endsWith('.swift')).sort();
    expect(names).toEqual(['Accessibility.swift', 'Apps.swift', 'Input.swift', 'Support.swift', 'main.swift']);
    await expect(new DesktopHelper({ stateDir }).binaryPath()).resolves.toMatch(/mcpclaude-helper-[0-9a-f]{16}$/);
  });
});
