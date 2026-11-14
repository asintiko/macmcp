import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ScriptOptions } from '../../src/desktop/driver.js';
import { buildAppleScript, buildScriptWrapper, jsStringLiteral } from '../../src/creative/aftereffects.js';
import type { RunResult } from '../../src/core/exec.js';
import { FakeDesktopDriver, result } from '../helpers/fake-desktop.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * After Effects cannot be installed in CI (it needs a paid licence), so these tests stand in
 * for it at its two boundaries: `osascript` (the fake desktop driver receives the AppleScript,
 * and the generated .jsx is executed here by a JavaScript engine with a small imitation of the
 * After Effects object model) and `aerender` (a shell script that records its arguments).
 * What they cannot show is that the real application accepts the same calls; that check is
 * listed as open in docs/development/PLAN.md.
 */

class CompItem {
  reflect = { name: 'CompItem' };
  numLayers = 3;
  constructor(
    public name: string,
    public id: number,
    public width = 1920,
    public height = 1080,
    public duration = 5,
    public frameRate = 25,
  ) {}
}

interface Host {
  undo: string[];
  globals: Record<string, unknown>;
  comps: CompItem[];
}

/** What a script sees as `app` and friends: enough of After Effects to exercise the wrapper. */
function hostContext(host: Host): Record<string, unknown> {
  const file = { reflect: { name: 'File' }, fsName: '/Users/me/Projects/promo.aep' };
  const project = {
    file,
    get numItems() {
      return host.comps.length + 1;
    },
    item: (index: number) => host.comps[index - 1] ?? { reflect: { name: 'FootageItem' }, name: 'clip.mov', id: 99 },
    get activeItem() {
      return host.comps[0] ?? null;
    },
    renderQueue: { numItems: 2 },
    items: {
      addComp: (name: string, width: number, height: number, _aspect: number, duration: number, frameRate: number) => {
        const comp = new CompItem(name, 100 + host.comps.length, width, height, duration, frameRate);
        host.comps.push(comp);
        return comp;
      },
    },
  };
  return {
    app: { version: '25.1x2', project, beginUndoGroup: (name: string) => host.undo.push(`begin ${name}`), endUndoGroup: () => host.undo.push('end') },
    CompItem,
    $: { global: host.globals },
    // ExtendScript has none of these; a script that uses them must fail here as it would there.
    JSON: undefined,
  };
}

/** Play the part of osascript + After Effects: run the .jsx the AppleScript points to. */
function afterEffects(host: Host, seen: { source: string; options: ScriptOptions; jsx: string }[]) {
  return (source: string, options: ScriptOptions): RunResult => {
    const file = /DoScriptFile "([^"]+)"/.exec(source)?.[1] ?? '';
    const jsx = existsSync(file) ? readFileSync(file, 'utf8') : '';
    seen.push({ source, options, jsx });
    const value = vm.runInNewContext(jsx, hostContext(host)) as unknown;
    return result({ stdout: `${String(value)}\n` });
  };
}

describe('After Effects tools (application and aerender stood in for)', () => {
  let h: Harness;
  let mac: FakeDesktopDriver;
  let host: Host;
  let seen: { source: string; options: ScriptOptions; jsx: string }[];
  let home: string;
  let installDir: string;

  const running = [
    { pid: 100, name: 'Finder', bundle_id: 'com.apple.finder', path: '/System/Library/CoreServices/Finder.app' },
    { pid: 812, name: 'After Effects', bundle_id: 'com.adobe.AfterEffects', path: '/Applications/Adobe After Effects 2025/Adobe After Effects 2025.app' },
  ];
  const aerenderArgs = async (): Promise<string[]> => (await readFile(path.join(installDir, 'argv.log'), 'utf8')).split('\n').slice(0, -1);
  const behave = (behaviour: string): Promise<void> => writeFile(path.join(installDir, 'behaviour'), behaviour);

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-ae-home-')));
    mac = new FakeDesktopDriver();
    h = await createHarness({ mode: 'full', runtime: { desktop: mac, home, env: { PATH: process.env['PATH'] } } });
  });
  afterAll(async () => {
    await h.close();
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    host = { undo: [], globals: {}, comps: [new CompItem('Main', 7), new CompItem('Intro', 8, 1280, 720, 2.5, 30)] };
    seen = [];
    mac.scripts.length = 0;
    mac.handlers = { apps: () => ({ applications: running }) };
    mac.scriptResult = afterEffects(host, seen);
  });

  it('are offered only where there is a desktop to script', async () => {
    const names = (await (await h.connect()).listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['after_effects_info', 'after_effects_run_script', 'after_effects_render']));
    expect((await h.call('usage_guide', { topic: 'after-effects' })).text).toContain('ECMAScript 3');
    const info = (await h.call('server_info')).data as { tool_groups: Record<string, { status: string; tools: number }>; guides: string[] };
    expect(info.tool_groups['after_effects']).toEqual({ title: 'Adobe After Effects', tools: 3, status: 'available' });
    expect(info.tool_groups['blender']).toEqual({ title: 'Blender', tools: 4, status: 'available' });
    expect(info.guides).toEqual(['overview', 'computer-use', 'blender', 'after-effects']);
  });

  describe('after_effects_run_script', () => {
    it('sends the script to the running application and returns its value', async () => {
      const run = await h.call('after_effects_run_script', { code: 'var c = app.project.activeItem; ({ name: c.name, width: c.width, height: c.height, layers: c.numLayers })', timeout_seconds: 120 });
      expect(run.isError, run.text).toBe(false);
      expect(run.data).toEqual({
        result: { name: 'Main', width: 1920, height: 1080, layers: 3 },
        log: [],
        application: 'Adobe After Effects 2025',
        version: '25.1x2',
        project: '/Users/me/Projects/promo.aep',
      });
      expect(run.text).toMatch(/^Ran in Adobe After Effects 2025 25\.1x2 in \d+ms\.\n--- result ---\n\{\n {2}"name": "Main",/);

      // The AppleScript addresses the application by name and passes the wrapper file.
      expect(seen).toHaveLength(1);
      const [call] = seen;
      expect(call?.source.split('\n')).toEqual([
        'with timeout of 125 seconds',
        '  tell application "Adobe After Effects 2025"',
        expect.stringMatching(/^ {4}DoScriptFile ".*\/after-effects\/script-[0-9a-f]{12}\.jsx"$/),
        '  end tell',
        'end timeout',
      ]);
      expect(call?.options).toMatchObject({ language: 'applescript', timeoutMs: 130_000 });
      // The wrapper is pure ASCII and is removed afterwards.
      expect(/^[\x09\x0a\x20-\x7e]*$/.test(call?.jsx ?? 'é')).toBe(true);
      const file = /DoScriptFile "([^"]+)"/.exec(call?.source ?? '')?.[1] ?? '';
      expect(existsSync(file)).toBe(false);
    });

    it('carries every kind of value back as JSON', async () => {
      const run = await h.call('after_effects_run_script', {
        code: [
          'var comp = app.project.item(1);',
          '({',
          '  text: "Quote \\" backslash \\\\ newline \\n tab \\t — ünïcödé 日本語 😀",',
          '  numbers: [1, -2.5, 1e21, 0/0, 1/0],',
          '  flags: [true, false, null, undefined],',
          '  nested: { deep: { deeper: [ { deepest: "x" } ] } },',
          '  comp: comp,',
          '  footage: app.project.item(3),',
          '  file: app.project.file,',
          '  fn: function () { return 1; },',
          '  version: app.version',
          '})',
        ].join('\n'),
      });
      expect(run.isError, run.text).toBe(false);
      expect(run.data?.['result']).toEqual({
        text: 'Quote " backslash \\ newline \n tab \t — ünïcödé 日本語 😀',
        numbers: [1, -2.5, 1e21, null, null],
        flags: [true, false, null, null],
        nested: { deep: { deeper: [{ deepest: 'x' }] } },
        comp: { type: 'CompItem', name: 'Main', id: 7 },
        footage: { type: 'FootageItem', name: 'clip.mov', id: 99 },
        file: '/Users/me/Projects/promo.aep',
        version: '25.1x2',
      });

      expect((await h.call('after_effects_run_script', { code: '"just text"' })).text).toMatch(/--- result ---\njust text$/);
      expect((await h.call('after_effects_run_script', { code: 'app.project.numItems * 2' })).data?.['result']).toBe(6);
      const nothing = await h.call('after_effects_run_script', { code: 'var x = 1;' });
      expect(nothing.text).toMatch(/\(the script returned nothing; end it with an expression to get a value back\)$/);
    });

    it('returns log lines, and wraps the script in one undo step when asked', async () => {
      const run = await h.call('after_effects_run_script', {
        undo_group: 'Add "title"',
        code: 'log("creating", { size: [1920, 1080] });\nvar comp = app.project.items.addComp("Title", 1920, 1080, 1, 5, 25);\nlog("created", comp);\ncomp.name',
      });
      expect(run.isError, run.text).toBe(false);
      expect(run.data).toMatchObject({ result: 'Title', log: ['creating {"size":[1920,1080]}', 'created {"type":"CompItem","name":"Title","id":102}'] });
      expect(run.text).toContain('--- log ---\ncreating {"size":[1920,1080]}\ncreated');
      expect(host.undo).toEqual(['begin Add "title"', 'end']);
      expect(host.comps.map((comp) => comp.name)).toEqual(['Main', 'Intro', 'Title']);

      host.undo.length = 0;
      await h.call('after_effects_run_script', { code: '1' });
      expect(host.undo).toEqual([]);
    });

    it('reports script errors with the line, closing the undo group', async () => {
      const failed = await h.call('after_effects_run_script', { undo_group: 'Broken', code: 'log("step 1");\nvar layer = app.project.activeItem.layer(1);\nlayer.name' });
      expect(failed.isError).toBe(true);
      expect(failed.text).toMatch(/^Error \[FAILED\]: ExtendScript error in Adobe After Effects 2025: TypeError: .*layer.* is not a function/);
      expect(failed.text).toContain('--- log before the error ---\nstep 1');
      expect(failed.text).toContain('Hint: Changes made before the error are not rolled back');
      expect(host.undo).toEqual(['begin Broken', 'end']);

      const thrown = await h.call('after_effects_run_script', { code: 'throw new Error("no active composition")' });
      expect(thrown.text).toContain('ExtendScript error in Adobe After Effects 2025: Error: no active composition');
      const syntax = await h.call('after_effects_run_script', { code: 'var = ;' });
      expect(syntax.text).toMatch(/ExtendScript error in Adobe After Effects 2025: SyntaxError: /);
      // Modern JavaScript that ExtendScript does not have fails rather than silently working.
      expect((await h.call('after_effects_run_script', { code: 'JSON.stringify({})' })).isError).toBe(true);
    });

    it('runs a script file, and keeps values in $.global between calls', async () => {
      await writeFile(path.join(h.projectDir, 'count.jsx'), '$.global.calls = ($.global.calls || 0) + 1;\n$.global.calls;\n');
      expect((await h.call('after_effects_run_script', { script_path: 'count.jsx' })).data?.['result']).toBe(1);
      expect((await h.call('after_effects_run_script', { script_path: 'count.jsx' })).data?.['result']).toBe(2);
      expect((await h.call('after_effects_run_script', { code: 'var local = 5; typeof calls' })).data?.['result']).toBe('undefined');
      expect((await h.call('after_effects_run_script', {})).text).toBe('Error [INVALID_ARGUMENT]: Give either `code` or `script_path`.');
      expect((await h.call('after_effects_run_script', { code: ' ' })).text).toBe('Error [INVALID_ARGUMENT]: The script is empty.');
      expect((await h.call('after_effects_run_script', { script_path: 'missing.jsx' })).text).toContain('Error [NOT_FOUND]');
    });

    it('needs After Effects to be running, and picks the right one of several', async () => {
      mac.handlers['apps'] = () => ({ applications: [running[0]] });
      const stopped = await h.call('after_effects_run_script', { code: '1' });
      expect(stopped.text).toBe(
        'Error [FAILED]: After Effects is not running.\nHint: Start it with open_application (after_effects_info lists the installed versions), wait until it has finished loading, then try again.',
      );
      expect(seen).toEqual([]);

      mac.handlers['apps'] = () => ({
        applications: [...running, { pid: 900, name: 'After Effects (Beta)', bundle_id: 'com.adobe.AfterEffects.beta', path: '/Applications/Adobe After Effects (Beta)/Adobe After Effects (Beta).app' }],
      });
      await h.call('after_effects_run_script', { code: '1', application: 'Adobe After Effects (Beta)' });
      expect(seen[0]?.source).toContain('tell application "Adobe After Effects (Beta)"');
      await h.call('after_effects_run_script', { code: '1', application: '2025' });
      expect(seen[1]?.source).toContain('tell application "Adobe After Effects 2025"');
      expect((await h.call('after_effects_run_script', { code: '1', application: 'Adobe After Effects 2019' })).text).toBe(
        'Error [NOT_FOUND]: "Adobe After Effects 2019" is not running. Running: Adobe After Effects 2025, Adobe After Effects (Beta).',
      );
    });

    it('explains what is wrong when macOS or After Effects refuses', async () => {
      mac.scriptResult = () => result({ code: 1, stderr: '57:99: execution error: Not authorized to send Apple events to Adobe After Effects 2025. (-1743)\n' });
      const denied = await h.call('after_effects_run_script', { code: '1' });
      expect(denied.text).toContain('Error [MACOS_PERMISSION_REQUIRED]: macOS did not allow mcpclaude to control After Effects');
      expect(denied.text).toContain('Privacy & Security → Automation');

      mac.scriptResult = () => result({ code: 1, stderr: 'execution error: Adobe After Effects 2025 got an error: AppleEvent timed out. (-1712)' });
      const busy = await h.call('after_effects_run_script', { code: '1', timeout_seconds: 30 });
      expect(busy.text).toContain('Error [TIMEOUT]: After Effects did not finish the script within 30 s.');
      expect(busy.text).toContain('take a screenshot');
      mac.scriptResult = () => result({ code: null, signal: 'SIGKILL', timedOut: true });
      expect((await h.call('after_effects_run_script', { code: '1', timeout_seconds: 2 })).text).toContain('Error [TIMEOUT]: After Effects did not finish the script within 2 s.');

      mac.scriptResult = () => result({ code: 1, stderr: 'execution error: Adobe After Effects 2025 got an error: Connection is invalid. (-609)' });
      expect((await h.call('after_effects_run_script', { code: '1' })).text).toContain('Hint: It is not running any more, or still starting.');
      mac.scriptResult = () => result({ code: 1, stderr: '24:36: syntax error: Expected end of line but found “"”. (-2741)' });
      expect((await h.call('after_effects_run_script', { code: '1' })).text).toContain('Error [FAILED]: After Effects did not accept the script: 24:36: syntax error');
      mac.scriptResult = () => result({ stdout: 'missing value\n' });
      expect((await h.call('after_effects_run_script', { code: '1' })).text).toBe('Error [FAILED]: After Effects returned an unexpected answer: missing value');
    });
  });

  describe('after_effects_info and after_effects_render', () => {
    it('reports that After Effects is neither installed nor running', async () => {
      mac.handlers['apps'] = () => ({ applications: [running[0]] });
      const info = await h.call('after_effects_info');
      expect(info.text.split('\n')).toEqual([
        'After Effects is not installed on this Mac (nothing matching "Adobe After Effects" in /Applications).',
        'Running: no. Start it with open_application and wait until its window has finished loading.',
      ]);
      expect(info.data).toEqual({ installed: [], running: [], version: null, project: null });

      await writeFile(path.join(h.projectDir, 'promo.aep'), 'x');
      const render = await h.call('after_effects_render', { project: 'promo.aep' });
      expect(render.text).toContain('Error [DEPENDENCY_MISSING]: Adobe After Effects is not installed on this Mac');
      expect(render.text).toContain('app.project.renderQueue.render()');
    });

    it('finds installations and summarises the open project', async () => {
      installDir = path.join(home, 'Applications', 'Adobe After Effects 2025');
      await mkdir(path.join(installDir, 'Adobe After Effects 2025.app'), { recursive: true });
      await mkdir(path.join(installDir, 'Adobe After Effects Render Engine 2025.app'), { recursive: true });
      await mkdir(path.join(home, 'Applications', 'Adobe After Effects 2024', 'Adobe After Effects 2024.app'), { recursive: true });
      await mkdir(path.join(home, 'Applications', 'Adobe After Effects (Beta)', 'Adobe After Effects (Beta).app'), { recursive: true });
      await writeFile(
        path.join(installDir, 'aerender'),
        `#!/bin/sh
here="$(dirname "$0")"
printf '%s\\n' "$@" > "$here/argv.log"
case "$(cat "$here/behaviour")" in
  ok)
    echo "PROGRESS:  Launching After Effects..."
    echo "PROGRESS:  0:00:00:00 (1): 0 Seconds"
    echo "PROGRESS:  0:00:00:01 (2): 0 Seconds"
    echo "PROGRESS:  Finished composition “Main”."
    echo "PROGRESS:  Total Time Elapsed: 2 Seconds"
    ;;
  slow)
    echo "PROGRESS:  0:00:00:00 (1): 0 Seconds"
    sleep 30
    ;;
  error)
    echo "aerender ERROR: No comp was found with the given name."
    exit 1
    ;;
esac
exit 0
`,
      );
      await chmod(path.join(installDir, 'aerender'), 0o755);
      await behave('ok');

      const info = await h.call('after_effects_info');
      expect(info.isError, info.text).toBe(false);
      expect(info.text.split('\n')).toEqual([
        'Installed:',
        `  Adobe After Effects 2025 — ${path.join(installDir, 'Adobe After Effects 2025.app')}`,
        `  Adobe After Effects 2024 — ${path.join(home, 'Applications', 'Adobe After Effects 2024', 'Adobe After Effects 2024.app')}  (no aerender)`,
        `  Adobe After Effects (Beta) — ${path.join(home, 'Applications', 'Adobe After Effects (Beta)', 'Adobe After Effects (Beta).app')}  (no aerender)`,
        'Running: Adobe After Effects 2025 (pid 812).',
        '  Version 25.1x2; project: /Users/me/Projects/promo.aep',
        '  3 project items, 2 compositions, 2 in the render queue; active item: Main',
        '    "Main" 1920×1080, 5.00 s at 25 fps, 3 layers',
        '    "Intro" 1280×720, 2.50 s at 30 fps, 3 layers',
      ]);
      expect(info.data).toMatchObject({ running: [{ name: 'Adobe After Effects 2025', pid: 812 }], version: '25.1x2', project: { file: '/Users/me/Projects/promo.aep', items: 3, active: 'Main', renderQueue: 2 } });

      // Scripting can be unavailable while the application is running; the rest is still reported.
      mac.scriptResult = () => result({ code: 1, stderr: 'execution error: Not authorized to send Apple events to Adobe After Effects 2025. (-1743)' });
      const limited = await h.call('after_effects_info');
      expect(limited.isError).toBe(false);
      expect(limited.text).toContain('Scripting is not available right now: macOS did not allow mcpclaude to control After Effects');
    });

    it('renders with aerender and reports the outcome', async () => {
      await behave('ok');
      const project = path.join(h.projectDir, 'promo.aep');
      const queued = await h.call('after_effects_render', { project: 'promo.aep' });
      expect(queued.isError, queued.text).toBe(false);
      expect(await aerenderArgs()).toEqual(['-project', project, '-sound', 'OFF']);
      expect(queued.text).toMatch(/^aerender finished in \d+ms \(2 frames reported\)\.\nPROGRESS: {2}Launching After Effects/);
      expect(queued.data).toMatchObject({ status: 'exited', exit_code: 0, project, output: null, frames_reported: 2, application: 'Adobe After Effects 2025', aerender: path.join(installDir, 'aerender') });

      const output = path.join(h.projectDir, 'renders', 'new folder', 'main_[#####].png');
      const comp = await h.call('after_effects_render', {
        project,
        comp: 'Main',
        output: 'renders/new folder/main_[#####].png',
        render_settings_template: 'Best Settings',
        output_module_template: 'PNG Sequence',
        start_frame: 0,
        end_frame: 24,
        increment: 2,
        multi_frame_rendering: true,
        reuse: true,
        continue_on_missing_footage: true,
      });
      expect(comp.isError, comp.text).toBe(false);
      expect(await aerenderArgs()).toEqual([
        '-project', project, '-comp', 'Main', '-RStemplate', 'Best Settings', '-OMtemplate', 'PNG Sequence', '-output', output,
        '-s', '0', '-e', '24', '-i', '2', '-mfr', 'ON', '100', '-reuse', '-continueOnMissingFootage', '-sound', 'OFF',
      ]); // prettier-ignore
      expect(comp.text).toContain(`Output: ${output}`);
      // The output folder is created so that aerender can write into it.
      expect(existsSync(path.dirname(output))).toBe(true);
      await h.call('after_effects_render', { project, rq_index: 2, output: 'renders/second.mov' });
      expect(await aerenderArgs()).toEqual(['-project', project, '-rqindex', '2', '-output', path.join(h.projectDir, 'renders', 'second.mov'), '-sound', 'OFF']);
    });

    it('reports failed renders and bad arguments', async () => {
      await behave('error');
      const failed = await h.call('after_effects_render', { project: 'promo.aep', comp: 'Nope', output: 'out.mov' });
      expect(failed.isError).toBe(true);
      expect(failed.text).toContain('Error [FAILED]: aerender failed (exit code 1).\naerender ERROR: No comp was found with the given name.');
      expect(failed.text).toContain('Hint: Common causes: the composition name does not exist');

      expect((await h.call('after_effects_render', { project: 'missing.aep' })).text).toContain('Error [NOT_FOUND]: No such project file:');
      expect((await h.call('after_effects_render', { project: 'promo.aep', output: 'out.mov' })).text).toContain('Error [INVALID_ARGUMENT]: `output` needs `comp` (or `rq_index`)');
      expect((await h.call('after_effects_render', { project: 'promo.aep', application: 'Adobe After Effects 2019' })).text).toContain(
        'Error [NOT_FOUND]: No After Effects installation named "Adobe After Effects 2019".\nHint: Installed: Adobe After Effects 2025, Adobe After Effects 2024, Adobe After Effects (Beta).',
      );
      expect((await h.call('after_effects_render', { project: 'promo.aep', application: '2024' })).text).toContain('Error [DEPENDENCY_MISSING]: The After Effects installation has no aerender next to the application.');
    });

    it('hands a long render over to the background', async () => {
      await behave('slow');
      const started = await h.call('after_effects_render', { project: 'promo.aep', wait_seconds: 1 });
      expect(started.isError, started.text).toBe(false);
      expect(started.text).toMatch(/^Still rendering after 1\.0s; aerender continues in the background as process_id "p\d+"\./);
      expect(started.text).toContain('PROGRESS:  0:00:00:00 (1): 0 Seconds');
      const id = started.data?.['process_id'] as string;
      expect((await h.call('list_processes')).text).toContain('aerender promo.aep');
      const stopped = await h.call('stop_process', { process_id: id });
      expect(stopped.isError, stopped.text).toBe(false);
    });
  });
});

describe('After Effects tools where they cannot work', () => {
  it('do not exist without a desktop, and are refused in Project-Only mode', async () => {
    const bare = await createHarness({ mode: 'full', runtime: { desktop: null } });
    try {
      expect((await (await bare.connect()).listTools()).tools.map((tool) => tool.name)).not.toContain('after_effects_run_script');
      expect((await bare.call('after_effects_run_script', { code: '1' })).text).toContain('Error [UNSUPPORTED_PLATFORM]');
    } finally {
      await bare.close();
    }
    const project = await createHarness({ mode: 'project', runtime: { desktop: new FakeDesktopDriver(), allowUnsandboxed: true } });
    try {
      expect((await project.call('after_effects_render', { project: 'x.aep' })).text).toContain('Error [PERMISSION_DENIED]: after_effects_render requires Full System Access');
    } finally {
      await project.close();
    }
  });
});

describe('ExtendScript wrapper', () => {
  it('escapes any source text into an ASCII string literal', () => {
    const source = 'a "quoted" \\ back\nline\r\ttab   sep é 日本 😀 \u0000';
    const literal = jsStringLiteral(source);
    expect(/^[\x20-\x7e]*$/.test(literal)).toBe(true);
    expect(vm.runInNewContext(literal)).toBe(source);
  });

  it('builds AppleScript that survives quotes in names and paths', () => {
    expect(buildAppleScript('After "Effects"', '/tmp/a "b"\\c.jsx', 0.5).split('\n').slice(0, 3)).toEqual([
      'with timeout of 6 seconds',
      '  tell application "After \\"Effects\\""',
      '    DoScriptFile "/tmp/a \\"b\\"\\\\c.jsx"',
    ]);
  });

  it('uses only syntax that ECMAScript 3 has', () => {
    const wrapper = buildScriptWrapper('1 + 1', { undoGroup: 'x' });
    for (const modern of [/=>/, /\blet\s/, /\bconst\s/, /`/, /\.\.\./, /\bJSON\./, /\.(map|forEach|filter|indexOf|includes|trim|padStart)\(/, /,\s*[}\]]/]) {
      expect(modern.test(wrapper), String(modern)).toBe(false);
    }
    expect(JSON.parse(vm.runInNewContext(wrapper, { app: { beginUndoGroup() {}, endUndoGroup() {}, version: '1' } }) as string)).toMatchObject({ ok: true, result: 2, version: '1', project: null });
  });
});
