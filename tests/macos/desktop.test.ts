import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DesktopHelper } from '../../src/desktop/helper.js';

/**
 * The real desktop helper on a real Mac (the hosted macOS runners have a logged-in desktop
 * session with Accessibility and Screen Recording available to the runner process).
 */
describe.runIf(process.platform === 'darwin')('desktop helper (macOS)', () => {
  let stateDir: string;
  let helper: DesktopHelper;

  beforeAll(async () => {
    stateDir = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-desktop-')));
    helper = new DesktopHelper({ stateDir });
  });
  afterAll(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('compiles from source with the Swift toolchain of this Mac', async () => {
    let announced = false;
    const binary = await helper.ensureBuilt(() => (announced = true));
    expect(announced).toBe(true);
    expect(binary.startsWith(path.join(stateDir, 'bin', 'mcpclaude-helper-'))).toBe(true);
    expect(await helper.isBuilt()).toBe(true);
  }, 600_000);

  it('answers basic queries', async () => {
    const [pong, permissions, displays, cursor] = (await helper.run([{ command: 'ping' }, { command: 'permissions' }, { command: 'displays' }, { command: 'cursor' }])) as [
      { pong: boolean },
      { accessibility: boolean; screen_recording: boolean },
      { displays: { index: number; main: boolean; width: number; height: number; pixel_width: number; scale: number }[] },
      { x: number; y: number },
    ];
    expect(pong).toEqual({ pong: true });
    console.log('permissions', permissions, 'displays', JSON.stringify(displays.displays), 'cursor', cursor);
    expect(typeof permissions.accessibility).toBe('boolean');
    expect(displays.displays.length).toBeGreaterThanOrEqual(1);
    expect(displays.displays[0]).toMatchObject({ index: 1, main: true });
    expect(displays.displays[0]?.width).toBeGreaterThan(300);
    expect(typeof cursor.x).toBe('number');
  });

  it('reports unknown commands and bad parameters as errors, keeping earlier results', async () => {
    await expect(helper.run([{ command: 'ping' }, { command: 'no_such_command' }])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      index: 1,
      completed: [{ pong: true }],
    });
    await expect(helper.run([{ command: 'mouse_click', params: { x: 'left' } }])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
