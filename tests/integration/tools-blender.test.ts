import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetPath } from '../../src/assets.js';
import { readImageInfo } from '../../src/core/image.js';
import { canShowWindows, installStubBlender, realBlender } from '../helpers/blender.js';
import { createHarness, type Harness } from '../helpers/harness.js';

const blender = realBlender();

describe('Blender tools with a stand-in executable', () => {
  let h: Harness;
  let stubDir: string;

  const argv = async (): Promise<string[]> => (await readFile(path.join(stubDir, 'argv.log'), 'utf8')).split('\n').slice(0, -1);
  const behave = (behaviour: string): Promise<void> => writeFile(path.join(stubDir, 'behaviour'), behaviour);

  beforeAll(async () => {
    stubDir = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-blender-stub-')));
    const stub = await installStubBlender(stubDir);
    h = await createHarness({ mode: 'full', runtime: { desktop: null, env: { ...process.env, MCPCLAUDE_BLENDER: stub } } });
    await writeFile(path.join(h.projectDir, 'shot.blend'), 'not really a blend file');
  });
  afterAll(async () => {
    await h.close();
    await rm(stubDir, { recursive: true, force: true });
  });

  it('are offered in Full System Access mode, also where there is no desktop', async () => {
    const names = (await (await h.connect()).listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['blender_info', 'blender_launch', 'blender_run_python', 'blender_render']));
    expect(names).not.toContain('after_effects_run_script');
    expect((await h.call('usage_guide', { topic: 'blender' })).text).toContain('blender_run_python');
  });

  it('reports the installation', async () => {
    const info = await h.call('blender_info');
    const lines = info.text.split('\n');
    // MCPCLAUDE_BLENDER comes first; a Blender that is really installed here is listed after it.
    expect(lines[0]).toBe(`Installed: Blender 9.9.1 — ${path.join(stubDir, 'blender')}`);
    for (const line of lines.slice(1, -1)) expect(line).toMatch(/^ {4}also: Blender \d+\.\d+(\.\d+)? — \//);
    expect(lines.at(-1)).toBe('Live session: none. blender_launch starts Blender with its window; blender_run_python and blender_render also work without one.');
    expect((info.data?.['installed'] as unknown[])[0]).toEqual({ version: '9.9.1', path: path.join(stubDir, 'blender'), application: null });
    expect(info.data?.['live_session']).toBeNull();
    if (process.platform === 'darwin') {
      // An application bundle and the launcher script a package manager puts on PATH are one installation.
      const apps = (info.data?.['installed'] as { application: string | null; path: string }[]).filter((install) => install.path !== path.join(stubDir, 'blender'));
      expect(apps.filter((install) => install.application === null)).toEqual([]);
    }
  });

  it('builds the render command line in the order Blender needs', async () => {
    await behave('render');
    const still = await h.call('blender_render', { blend_file: 'shot.blend', frame: 7, engine: 'CYCLES', format: 'PNG', scene: 'Main', samples: 8, resolution_x: 640, resolution_y: 360, resolution_percentage: 50 });
    expect(still.isError, still.text).toBe(false);
    const blend = path.join(h.projectDir, 'shot.blend');
    expect(await argv()).toEqual([
      '--background',
      blend,
      '--scene',
      'Main',
      '--engine',
      'CYCLES',
      '--render-output',
      path.join(h.projectDir, 'renders', 'shot_####'),
      '--use-extension',
      '1',
      '--render-format',
      'PNG',
      '--python-expr',
      'import bpy',
      'for s in bpy.data.scenes:',
      '    s.render.resolution_x = 640',
      '    s.render.resolution_y = 360',
      '    s.render.resolution_percentage = 50',
      '    s.cycles.samples = 8',
      '    setattr(s.eevee, "taa_render_samples", 8)',
      '--render-frame',
      '7',
    ]);
    expect(still.text.split('\n').slice(1)).toEqual(['  /renders/shot_0001.png', '  /renders/shot_0002.png', 'Look at a result with view_image.']);
    expect(still.text).toMatch(/^Rendered 2 files in \d/);
    expect(still.data).toMatchObject({ status: 'exited', exit_code: 0, blend_file: blend, files: ['/renders/shot_0001.png', '/renders/shot_0002.png'] });

    await h.call('blender_render', { blend_file: blend, frame_start: 1, frame_end: 48, output: 'out/frame_####' });
    expect(await argv()).toEqual(['--background', blend, '--render-output', path.join(h.projectDir, 'out', 'frame_####'), '--use-extension', '1', '--frame-start', '1', '--frame-end', '48', '--render-anim']);

    // A folder as output gets the default file name; no frame means the scene's current frame.
    await h.call('blender_render', { blend_file: blend, output: 'out/' });
    expect((await argv()).slice(2)).toEqual(['--render-output', path.join(h.projectDir, 'out', 'shot_####'), '--use-extension', '1', '--python-expr', 'import bpy; bpy.ops.render.render(write_still=True)']);
  });

  it('rejects contradictory frame arguments and missing files', async () => {
    expect((await h.call('blender_render', { blend_file: 'shot.blend', frame: 1, frame_end: 3 })).text).toBe('Error [INVALID_ARGUMENT]: Give either frame, or frame_start and frame_end.');
    expect((await h.call('blender_render', { blend_file: 'shot.blend', frame_start: 1 })).text).toBe('Error [INVALID_ARGUMENT]: Give frame_start and frame_end together.');
    expect((await h.call('blender_render', { blend_file: 'shot.blend', frame_start: 5, frame_end: 3 })).text).toBe('Error [INVALID_ARGUMENT]: frame_end is before frame_start.');
    expect((await h.call('blender_render', { blend_file: 'missing.blend' })).text).toContain('Error [NOT_FOUND]: No such file:');
  });

  it('reports a render that produced nothing', async () => {
    await behave('nothing');
    const empty = await h.call('blender_render', { blend_file: 'shot.blend', frame: 1 });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain('Error [FAILED]: The render produced no output (exit code 0).');
    expect(empty.text).toContain('Hint: Common causes: the scene has no camera');

    await behave('crash');
    const crashed = await h.call('blender_render', { blend_file: 'shot.blend', frame: 1 });
    expect(crashed.text).toContain('Error [FAILED]: The render produced no output (exit code 7).\nError: Cannot read file');
  });

  it('explains a Blender that ends before running the code', async () => {
    await behave('crash');
    const run = await h.call('blender_run_python', { code: '1 + 1', blend_file: 'shot.blend' });
    expect(run.isError).toBe(true);
    expect(run.text).toBe(`Error [FAILED]: Blender ended (exit code 7) before the code had run; it may not have been able to open ${path.join(h.projectDir, 'shot.blend')}.\nError: Cannot read file`);
    expect(await argv()).toEqual(['--background', path.join(h.projectDir, 'shot.blend'), '--python', assetPath('blender', 'mcpclaude_bridge.py'), '--', '--mcpclaude-exec', expect.stringMatching(/blender-[0-9a-f]+\/request\.json$/)]);
  });

  it('validates the arguments of blender_run_python', async () => {
    expect((await h.call('blender_run_python', {})).text).toBe('Error [INVALID_ARGUMENT]: Give either `code` or `script_path`.');
    expect((await h.call('blender_run_python', { code: 'x', script_path: 'y.py' })).text).toBe('Error [INVALID_ARGUMENT]: Give either `code` or `script_path`.');
    expect((await h.call('blender_run_python', { code: '  \n' })).text).toBe('Error [INVALID_ARGUMENT]: The code is empty.');
    expect((await h.call('blender_run_python', { code: '1', save: true })).text).toBe('Error [INVALID_ARGUMENT]: save needs blend_file: the file to save to.');
    expect((await h.call('blender_run_python', { code: '1', blend_file: 'nope.blend' })).text).toContain('Error [NOT_FOUND]: No such file:');
    expect((await h.call('blender_run_python', { code: '1', mode: 'live' })).text).toBe('Error [FAILED]: No live Blender session is running.\nHint: Start one with blender_launch, or use mode "background".');
  });

  it('says how to get Blender when it is not installed', async () => {
    const bare = await createHarness({ mode: 'full', runtime: { desktop: null, home: h.outsideDir, env: { PATH: h.outsideDir } } });
    try {
      // Only meaningful where no Blender is installed system-wide.
      const info = await bare.call('blender_info');
      if (!info.text.startsWith('Installed:')) {
        expect(info.text).toContain('Blender is not installed on this Mac');
        const run = await bare.call('blender_run_python', { code: '1' });
        expect(run.text).toContain('Error [DEPENDENCY_MISSING]: Blender was not found on this Mac.');
        expect(run.text).toContain('MCPCLAUDE_BLENDER=/path/to/blender');
      }
    } finally {
      await bare.close();
    }
  });

  it('is refused in Project-Only mode', async () => {
    const project = await createHarness({ mode: 'project', runtime: { desktop: null, allowUnsandboxed: true } });
    try {
      expect((await project.call('blender_run_python', { code: '1' })).text).toContain('Error [PERMISSION_DENIED]: blender_run_python requires Full System Access');
      expect((await (await project.connect()).listTools()).tools.map((tool) => tool.name)).not.toContain('blender_render');
    } finally {
      await project.close();
    }
  });
});

describe.runIf(blender)('Blender tools with a real Blender (headless)', () => {
  let h: Harness;
  const scene = (): string => path.join(h.projectDir, 'scene.blend');

  beforeAll(async () => {
    h = await createHarness({ mode: 'full', runtime: { desktop: null, env: { ...process.env, MCPCLAUDE_BLENDER: blender } } });
  }, 120_000);
  afterAll(async () => {
    await h.close();
  });

  it('finds Blender and its version', async () => {
    const info = await h.call('blender_info');
    expect(info.text).toMatch(/^Installed: Blender \d+\.\d+(\.\d+)? — /);
    console.log(`[blender] ${info.text.split('\n')[0]}`);
  }, 120_000);

  it('runs Python and returns the value, the output and the arguments', async () => {
    const run = await h.call('blender_run_python', {
      factory_settings: true,
      args: ['alpha', 'beta'],
      code: ['import bpy', 'print("hello from", bpy.app.version_string)', 'cube = bpy.data.objects["Cube"]', 'cube.location.x = 2.5', '{"names": sorted(o.name for o in bpy.data.objects), "cube": cube, "location": cube.location, "args": args, "matrix_rows": len(cube.matrix_world)}'].join('\n'),
    });
    expect(run.isError, run.text).toBe(false);
    expect(run.data?.['result']).toEqual({ names: ['Camera', 'Cube', 'Light'], cube: { type: 'Object', name: 'Cube' }, location: [2.5, 0, 0], args: ['alpha', 'beta'], matrix_rows: 4 });
    expect(run.data?.['stdout']).toMatch(/^hello from \d+\.\d+/);
    expect(run.text).toMatch(/^Ran in Blender \d+\.\d+(\.\d+)?( \w+)* \(background, startup scene\) in /);
    expect(run.text).toContain('--- result ---\n{\n  "names": [');
    expect(run.text).toContain('--- output ---\nhello from');

    const explicit = await h.call('blender_run_python', { factory_settings: true, code: 'x = 20\nresult = x + 22' });
    expect(explicit.data?.['result']).toBe(42);
    const silent = await h.call('blender_run_python', { factory_settings: true, code: 'x = 1' });
    expect(silent.text).toContain('(no result and no output; end the code with an expression, set `result`, or print something)');
  }, 120_000);

  it('returns Python errors with a traceback that points into the code', async () => {
    const failed = await h.call('blender_run_python', { factory_settings: true, code: 'import bpy\nprint("before")\ndef pick():\n    return bpy.data.objects["Nope"]\npick()' });
    expect(failed.isError).toBe(true);
    expect(failed.text).toMatch(/^Error \[FAILED\]: Python error in Blender \(background, startup scene\): KeyError: /);
    expect(failed.text).toContain('File "<mcpclaude>", line 5, in <module>\n    pick()');
    expect(failed.text).toContain('File "<mcpclaude>", line 4, in pick\n    return bpy.data.objects["Nope"]');
    expect(failed.text).toContain('--- output before the error ---\nbefore');
    expect(failed.text).not.toContain('mcpclaude_bridge.py');

    const syntax = await h.call('blender_run_python', { factory_settings: true, code: 'x = (1,\n' });
    expect(syntax.text).toMatch(/Python error in Blender .*: SyntaxError: /);
    expect((await h.call('blender_run_python', { factory_settings: true, code: 'import sys\nsys.exit(3)' })).text).toContain('SystemExit: 3');
  }, 120_000);

  it('creates a file, changes it and reads the change back', async () => {
    // The scene of the usage guide: it must keep working as written.
    const guide = await readFile(assetPath('guides', 'blender.md'), 'utf8');
    const example = /```python\n([\s\S]*?)```/.exec(guide)?.[1] ?? '';
    expect(example).toContain('bpy.data.objects.new("Ico", mesh)');
    const created = await h.call('blender_run_python', { blend_file: 'scene.blend', save: true, factory_settings: true, code: example });
    expect(created.isError, created.text).toBe(false);
    expect(created.data?.['result']).toEqual(['Camera', 'Ico', 'Sun']);
    expect(created.data?.['saved']).toBe(scene());
    expect(created.text).toContain(`(background, new file ${scene()})`);
    expect((await stat(scene())).size).toBeGreaterThan(10_000);

    await writeFile(path.join(h.projectDir, 'tweak.py'), 'import bpy\nbpy.data.objects["Ico"].location.z = 1.5\nbpy.context.scene.frame_end = 3\n"moved"\n');
    const changed = await h.call('blender_run_python', { blend_file: 'scene.blend', save: true, script_path: 'tweak.py' });
    expect(changed.data).toMatchObject({ result: 'moved', saved: scene(), file: scene() });

    const read = await h.call('blender_run_python', { blend_file: scene(), code: '[round(bpy.data.objects["Ico"].location.z, 3), bpy.context.scene.frame_end, bpy.data.filepath]' });
    expect(read.data?.['result']).toEqual([1.5, 3, scene()]);
    // Without save nothing is written.
    await h.call('blender_run_python', { blend_file: scene(), code: 'bpy.data.objects["Ico"].location.z = 99' });
    expect((await h.call('blender_run_python', { blend_file: scene(), code: 'bpy.data.objects["Ico"].location.z' })).data?.['result']).toBe(1.5);
  }, 240_000);

  it('stops a background run that takes too long', async () => {
    const slow = await h.call('blender_run_python', { factory_settings: true, code: 'import time\ntime.sleep(60)', timeout_seconds: 3 });
    expect(slow.text).toContain('Error [TIMEOUT]: Blender did not finish within 3 s and was stopped.');
  }, 60_000);

  it('renders a still image and an animation', async () => {
    const still = await h.call('blender_render', { blend_file: 'scene.blend', frame: 1, engine: 'CYCLES', format: 'PNG', samples: 1, resolution_x: 64, resolution_y: 48, resolution_percentage: 100, wait_seconds: 200 });
    expect(still.isError, still.text).toBe(false);
    const file = path.join(h.projectDir, 'renders', 'scene_0001.png');
    expect(still.data).toMatchObject({ status: 'exited', exit_code: 0, files: [file] });
    expect(readImageInfo(await readFile(file))).toEqual({ format: 'png', width: 64, height: 48 });
    const viewed = await h.call('view_image', { path: file });
    expect(viewed.images).toHaveLength(1);

    const animation = await h.call('blender_render', { blend_file: 'scene.blend', frame_start: 2, frame_end: 3, engine: 'CYCLES', format: 'JPEG', samples: 1, resolution_x: 32, resolution_y: 32, resolution_percentage: 100, output: 'anim/f_###', wait_seconds: 200 });
    expect(animation.isError, animation.text).toBe(false);
    expect(animation.data?.['files']).toEqual([path.join(h.projectDir, 'anim', 'f_002.jpg'), path.join(h.projectDir, 'anim', 'f_003.jpg')]);
    expect(readImageInfo(await readFile(path.join(h.projectDir, 'anim', 'f_003.jpg')))).toEqual({ format: 'jpeg', width: 32, height: 32 });
    expect(animation.text).toMatch(/^Rendered 2 files in /);
  }, 480_000);

  it('hands a long render over to the background', async () => {
    const started = await h.call('blender_render', { blend_file: 'scene.blend', frame_start: 1, frame_end: 250, engine: 'CYCLES', samples: 64, resolution_x: 640, resolution_y: 480, resolution_percentage: 100, output: 'long/f_####', wait_seconds: 1 });
    expect(started.isError, started.text).toBe(false);
    expect(started.text).toMatch(/^Still rendering after 1\.0s; the render continues in the background as process_id "p\d+"\./);
    const id = started.data?.['process_id'] as string;
    const listed = await h.call('list_processes');
    expect(listed.text).toContain('render scene.blend');
    let log = '';
    const deadline = Date.now() + 180_000;
    while (!log.includes("Saved: '") && Date.now() < deadline) log += (await h.call('read_process_output', { process_id: id, wait_seconds: 20 })).text;
    expect(log).toContain(`Saved: '${path.join(h.projectDir, 'long', 'f_0001.png')}'`);
    expect((await h.call('stop_process', { process_id: id })).isError).toBe(false);
  }, 240_000);

  it('explains a render without a camera', async () => {
    await h.call('blender_run_python', { blend_file: 'nocam.blend', save: true, factory_settings: true, code: 'bpy.data.objects.remove(bpy.data.objects["Camera"])' });
    const failed = await h.call('blender_render', { blend_file: 'nocam.blend', frame: 1, engine: 'CYCLES', samples: 1, resolution_x: 32, resolution_y: 32, wait_seconds: 200 });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('Error [FAILED]: The render produced no output');
    expect(failed.text).toMatch(/no camera/i);
  }, 240_000);
});

// On macOS the live session is part of tests/macos/computer-use.test.ts: a Blender window that
// opens while that suite types into another application would take its keyboard focus.
describe.runIf(blender && canShowWindows() && process.platform !== 'darwin')('Blender tools with a real Blender (live session)', () => {
  let h: Harness;
  let pid = 0;

  beforeAll(async () => {
    h = await createHarness({ mode: 'full', runtime: { desktop: null, env: { ...process.env, MCPCLAUDE_BLENDER: blender } } });
  }, 120_000);
  afterAll(async () => {
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await h.close();
  });

  it('starts Blender with its window and connects to it', async () => {
    const launched = await h.call('blender_launch', { factory_settings: true, wait_seconds: 180 });
    expect(launched.isError, launched.text).toBe(false);
    expect(launched.text).toMatch(/^Blender \d+\.\d+(\.\d+)?( \w+)* is running \(pid \d+\) and connected\./);
    pid = launched.data?.['pid'] as number;
    expect(launched.data).toMatchObject({ started: true });

    const info = await h.call('blender_info');
    expect(info.text).toMatch(/Live session: Blender [\d.]+( \w+)* \(pid \d+\) is running\./);
    expect(info.text).toMatch(/File: \(unsaved scene\)/);
    expect(info.text).toMatch(/Scene "Scene": 3 objects, frame 1 of 1-250, 1920×1080 at 100%, engine \w+/);
    expect(info.data?.['live_session']).toMatchObject({ pid, busy: false, objects: 3, scene: 'Scene' });

    const again = await h.call('blender_launch', { wait_seconds: 5 });
    expect(again.text).toMatch(/^A live Blender [\d.]+( \w+)* session is already running \(pid \d+\)\.$/);
    expect(again.data).toMatchObject({ started: false, pid });
  }, 240_000);

  it('runs code inside the session, where state persists and operators have a viewport', async () => {
    const added = await h.call('blender_run_python', { code: 'bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 3))\nbpy.context.object.name = "Ball"\n[bpy.context.area.type, bpy.context.object.name]' });
    expect(added.isError, added.text).toBe(false);
    expect(added.data?.['result']).toEqual(['VIEW_3D', 'Ball']);
    expect(added.text).toMatch(/\(live session, unsaved scene\)/);

    const later = await h.call('blender_run_python', { mode: 'live', code: 'print("still here")\nball = bpy.data.objects["Ball"]\n{"z": ball.location.z, "count": len(bpy.data.objects), "dirty": bpy.data.is_dirty}' });
    expect(later.data).toMatchObject({ result: { z: 3, count: 4, dirty: true }, stdout: 'still here\n' });

    const failed = await h.call('blender_run_python', { mode: 'live', code: 'bpy.data.objects["Missing"].name' });
    expect(failed.text).toMatch(/^Error \[FAILED\]: Python error in Blender \(live session, unsaved scene\): KeyError: /);
    // Each call is one undo step for the user, and the file is known to have unsaved changes.
    const undone = await h.call('blender_run_python', { mode: 'live', code: 'bpy.data.objects["Ball"].location.z = 9' });
    expect(undone.isError, undone.text).toBe(false);
    expect((await h.call('blender_run_python', { mode: 'live', code: 'bpy.ops.ed.undo()\nbpy.data.objects["Ball"].location.z' })).data?.['result']).toBe(3);
    expect((await h.call('blender_info')).text).toContain('File: (unsaved scene)  — has unsaved changes');
    // The session survives errors, and a script that calls sys.exit.
    await h.call('blender_run_python', { mode: 'live', code: 'import sys\nsys.exit(0)' });
    expect((await h.call('blender_run_python', { mode: 'live', code: 'len(bpy.data.objects)' })).data?.['result']).toBe(4);
  }, 120_000);

  it('keeps headless runs separate from the session', async () => {
    const headless = await h.call('blender_run_python', { mode: 'background', factory_settings: true, code: 'len(bpy.data.objects)' });
    expect(headless.data?.['result']).toBe(3);
    expect((await h.call('blender_run_python', { mode: 'live', code: '1', blend_file: 'x.blend' })).text).toContain('Error [INVALID_ARGUMENT]: blend_file and save apply to background mode only.');

    const file = path.join(h.projectDir, 'live.blend');
    const saved = await h.call('blender_run_python', { code: `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(file)})\nbpy.data.filepath` });
    expect(saved.data?.['result']).toBe(file);
    expect((await h.call('blender_info')).text).toContain(`File: ${file}`);
    // The saved file can be read by a headless run while the session stays open.
    expect((await h.call('blender_run_python', { blend_file: file, code: 'sorted(o.name for o in bpy.data.objects)' })).data?.['result']).toEqual(['Ball', 'Camera', 'Cube', 'Light']);
  }, 120_000);

  it('reports a code run that outlasts the timeout, and a session that has ended', async () => {
    const slow = await h.call('blender_run_python', { mode: 'live', code: 'import time\ntime.sleep(4)\n"done"', timeout_seconds: 1 });
    expect(slow.text).toContain('Error [TIMEOUT]: The code did not finish within 1 s. It keeps running inside Blender');
    await new Promise((resolve) => setTimeout(resolve, 4500));
    expect((await h.call('blender_run_python', { mode: 'live', code: '"back"' })).data?.['result']).toBe('back');

    process.kill(pid, 'SIGKILL');
    pid = 0;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await h.call('blender_info')).text).toContain('Live session: none.');
    expect((await h.call('blender_run_python', { mode: 'live', code: '1' })).text).toContain('Error [FAILED]: No live Blender session is running.');
  }, 120_000);
});
