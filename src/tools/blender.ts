import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { type BlenderInstall, type BridgeResponse, findBlenderInstalls, launchBlender, liveSession, requireBlender, runHeadless, runLive } from '../creative/blender.js';
import { ToolError } from '../core/errors.js';
import { truncateMiddle } from '../core/exec.js';
import { LIMITS, type Runtime } from '../core/runtime.js';
import { type AnyTool, defineTool, type ToolOutput } from './registry.js';
import { formatDuration, shellQuote } from './util.js';

const RESULT_LIMIT = 60_000;
const OUTPUT_LIMIT = 30_000;

/** Facts about the scene of a live session, gathered through the bridge. */
const SCENE_SUMMARY = `
scene = bpy.context.scene
result = {
    "file": bpy.data.filepath,
    "unsaved_changes": bpy.data.is_dirty,
    "scene": scene.name,
    "objects": len(bpy.data.objects),
    "render_engine": scene.render.engine,
    "frame": scene.frame_current,
    "frame_range": [scene.frame_start, scene.frame_end],
    "resolution": [scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage],
}
`;

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return truncateMiddle(text, RESULT_LIMIT).text;
}

/** Turn what the bridge reported into a tool result, or into an error carrying the traceback. */
function reportRun(response: BridgeResponse, where: string, log?: string): ToolOutput {
  const stdout = truncateMiddle((response.stdout ?? '').replace(/\n$/, ''), OUTPUT_LIMIT).text;
  if (!response.ok) {
    const parts = [`Python error in Blender (${where}): ${response.error ?? 'unknown error'}`];
    if (response.traceback) parts.push(response.traceback.trimEnd());
    if (stdout) parts.push(`--- output before the error ---\n${stdout}`);
    throw new ToolError('FAILED', parts.join('\n'), 'Nothing is rolled back: check the state of the scene before running corrected code.');
  }
  const value = renderValue(response.result);
  const lines = [`Ran in Blender ${response.blender_version ?? ''} (${where}) in ${formatDuration((response.seconds ?? 0) * 1000)}.`.replace('  ', ' ')];
  if (response.saved) lines.push(`Saved ${response.saved}`);
  if (value !== '') lines.push(`--- result ---\n${value}`);
  if (stdout) lines.push(`--- output ---\n${stdout}`);
  if (value === '' && !stdout) lines.push('(no result and no output; end the code with an expression, set `result`, or print something)');
  const data: Record<string, unknown> = {
    result: response.result ?? null,
    stdout: response.stdout ?? '',
    seconds: response.seconds ?? null,
    blender_version: response.blender_version ?? null,
    file: response.file || null,
  };
  if (response.saved) data['saved'] = response.saved;
  if (log !== undefined) data['blender_log_tail'] = log.split('\n').slice(-15).join('\n');
  return { text: lines.join('\n'), data };
}

function describeInstall(install: BlenderInstall): string {
  return `Blender ${install.version ?? '(version unknown)'} — ${install.bundle ?? install.path}`;
}

/** Files in `dir` that were written at or after `since`. */
async function writtenSince(dir: string, since: number): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const info = await stat(path.join(dir, name)).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs >= since - 1000) found.push(path.join(dir, name));
  }
  return found.sort();
}

async function existingBlendFile(runtime: Runtime, input: string): Promise<string> {
  const file = await runtime.resolvePath(input);
  const info = await stat(file).catch(() => undefined);
  if (!info) throw new ToolError('NOT_FOUND', `No such file: ${file}`);
  if (!info.isFile()) throw new ToolError('INVALID_ARGUMENT', `Not a file: ${file}`);
  return file;
}

export function blenderTools(): AnyTool[] {
  const blenderInfo = defineTool({
    name: 'blender_info',
    title: 'Blender: installation and session',
    group: 'blender',
    access: 'full',
    description: [
      'Report which Blender is installed (version and location) and whether a live session started with blender_launch is running, including its open file, scene, frame range and render settings.',
      'Call it before other Blender tools to learn the version: the Python API differs between major versions.',
    ].join(' '),
    input: z.object({}),
    examples: [{ arguments: {} }],
    hints: { readOnly: true },
    async handler(_args, ctx) {
      const installs = await findBlenderInstalls(ctx.runtime);
      const lines: string[] = [];
      if (installs.length === 0) lines.push('Blender is not installed on this Mac (not in /Applications, ~/Applications or on PATH).');
      else lines.push(...installs.map((install, index) => `${index === 0 ? 'Installed:' : '    also:'} ${describeInstall(install)}`));

      const live = await liveSession(ctx.runtime);
      let scene: Record<string, unknown> | undefined;
      if (!live) {
        lines.push('Live session: none. blender_launch starts Blender with its window; blender_run_python and blender_render also work without one.');
      } else if (live.busy) {
        lines.push(`Live session: Blender ${live.session.blender_version} (pid ${live.session.pid}) is busy running code.`);
      } else {
        const summary = await runLive(live.session, SCENE_SUMMARY, [], 8000, ctx.signal, true).catch(() => undefined);
        scene = summary?.ok ? (summary.result as Record<string, unknown>) : undefined;
        lines.push(`Live session: Blender ${live.session.blender_version} (pid ${live.session.pid}) is running.`);
        if (scene) {
          const range = scene['frame_range'] as number[];
          const resolution = scene['resolution'] as number[];
          lines.push(
            `  File: ${scene['file'] || '(unsaved scene)'}${scene['unsaved_changes'] ? '  — has unsaved changes' : ''}`,
            `  Scene "${String(scene['scene'])}": ${String(scene['objects'])} objects, frame ${String(scene['frame'])} of ${range[0]}-${range[1]}, ${resolution[0]}×${resolution[1]} at ${resolution[2]}%, engine ${String(scene['render_engine'])}`,
          );
        }
      }
      return {
        text: lines.join('\n'),
        data: {
          installed: installs.map((install) => ({ version: install.version ?? null, path: install.path, application: install.bundle ?? null })),
          live_session: live ? { pid: live.session.pid, blender_version: live.session.blender_version, busy: live.busy, ...(scene ?? {}) } : null,
        },
      };
    },
  });

  const blenderLaunch = defineTool({
    name: 'blender_launch',
    title: 'Blender: start a live session',
    group: 'blender',
    access: 'full',
    description: [
      'Start Blender with its window, optionally opening a .blend file, and connect to it: afterwards blender_run_python runs code inside that session, so every change is visible in the interface and can be combined with screenshots, clicks and keys.',
      'Use a live session when the work should be seen or continued by hand; for batch jobs and renders the headless tools are faster and do not need it. If a session is already running it is reported and left as it is.',
    ].join(' '),
    input: z.object({
      blend_file: z.string().optional().describe('.blend file to open (absolute, ~/…, or relative to the working directory). Default: the startup scene.'),
      factory_settings: z.boolean().default(false).describe('Start with factory settings, ignoring the preferences, startup file and add-ons of the user.'),
      wait_seconds: z.number().min(5).max(200).default(60).describe('How long to wait for Blender to come up.'),
    }),
    examples: [
      { note: 'Start Blender with the default scene.', arguments: {} },
      { note: 'Open a project in the interface.', arguments: { blend_file: '~/Projects/robot/robot.blend' } },
    ],
    async handler(args, ctx) {
      const existing = await liveSession(ctx.runtime);
      if (existing) {
        const note = args.blend_file
          ? ' The file was NOT opened: do it in the session with blender_run_python (bpy.ops.wm.open_mainfile(filepath=…)); unsaved changes of the current scene would be lost.'
          : '';
        return {
          text: `A live Blender ${existing.session.blender_version} session is already running (pid ${existing.session.pid}).${note}`,
          data: { started: false, pid: existing.session.pid, blender_version: existing.session.blender_version },
        };
      }
      const install = await requireBlender(ctx.runtime);
      const blendFile = args.blend_file !== undefined ? await existingBlendFile(ctx.runtime, args.blend_file) : undefined;
      await ctx.progress('Starting Blender…');
      const live = await launchBlender(ctx.runtime, { install, blendFile, factorySettings: args.factory_settings, waitSeconds: args.wait_seconds, signal: ctx.signal });
      return {
        text: [
          `Blender ${live.session.blender_version} is running (pid ${live.session.pid})${blendFile ? ` with ${blendFile}` : ''} and connected.`,
          'blender_run_python now runs inside this session. Take a screenshot to see the window.',
        ].join('\n'),
        data: { started: true, pid: live.session.pid, blender_version: live.session.blender_version, file: blendFile ?? null },
      };
    },
  });

  const blenderRunPython = defineTool({
    name: 'blender_run_python',
    title: 'Blender: run Python',
    group: 'blender',
    access: 'full',
    description: [
      'Run Python with the Blender API (bpy) and return the value of the code, what it printed, or the traceback. The value is the variable `result` if the code sets it, otherwise the value of the last line when that is an expression; `bpy` is already imported and `args` holds the strings passed in `args`.',
      'Mode "background" starts a headless Blender for this one call — open a file with blend_file and set save to keep the changes. Mode "live" runs inside the session started by blender_launch, on its current scene, and each call is one undo step for the user. "auto" (default) uses the live session when one is running and no blend_file is given.',
      'Datablocks come back as {type, name}, vectors and matrices as lists. This is the precise way to build and edit scenes; use screenshots and mouse only for what the API cannot do.',
    ].join(' '),
    input: z.object({
      code: z.string().optional().describe('Python source to run. Give either this or script_path.'),
      script_path: z.string().optional().describe('Path of a Python file to run instead of `code`.'),
      mode: z.enum(['auto', 'background', 'live']).default('auto').describe('Where to run: a headless Blender, the live session, or whichever fits.'),
      blend_file: z.string().optional().describe('Background mode: .blend file to open first. With save, a file that does not exist yet is created.'),
      save: z.boolean().default(false).describe('Background mode: save blend_file after the code ran without error.'),
      args: z.array(z.string()).optional().describe('Strings available to the code as the list `args`.'),
      factory_settings: z.boolean().default(false).describe('Background mode: ignore the preferences, startup file and add-ons of the user.'),
      timeout_seconds: z.number().min(1).max(LIMITS.callSeconds).default(120).describe('Stop waiting after this long. A background Blender is then ended; a live session keeps running the code.'),
    }),
    examples: [
      { note: 'List the objects of a file.', arguments: { blend_file: 'scene.blend', code: '[(o.name, o.type) for o in bpy.data.objects]' } },
      {
        note: 'Change a file and save it.',
        arguments: { blend_file: 'scene.blend', save: true, code: 'bpy.data.objects["Cube"].scale = (2, 2, 2)\nresult = "scaled"' },
      },
      { note: 'Add an object in the live session.', arguments: { mode: 'live', code: 'bpy.ops.mesh.primitive_monkey_add(location=(0, 0, 2))\nbpy.context.object.name' } },
    ],
    hints: { destructive: true },
    async handler(args, ctx) {
      if ((args.code === undefined) === (args.script_path === undefined)) throw new ToolError('INVALID_ARGUMENT', 'Give either `code` or `script_path`.');
      const code = args.code ?? (await readFile(await ctx.runtime.resolvePath(args.script_path as string), 'utf8'));
      if (code.trim() === '') throw new ToolError('INVALID_ARGUMENT', 'The code is empty.');

      const live = args.mode === 'background' || (args.mode === 'auto' && args.blend_file !== undefined) ? undefined : await liveSession(ctx.runtime);
      if (args.mode === 'live' && !live) {
        throw new ToolError('FAILED', 'No live Blender session is running.', 'Start one with blender_launch, or use mode "background".');
      }
      if (live) {
        if (args.blend_file !== undefined || args.save) {
          throw new ToolError(
            'INVALID_ARGUMENT',
            'blend_file and save apply to background mode only.',
            'In the live session open and save files from the code: bpy.ops.wm.open_mainfile(filepath=…), bpy.ops.wm.save_mainfile().',
          );
        }
        const response = await runLive(live.session, code, args.args ?? [], args.timeout_seconds * 1000, ctx.signal);
        return reportRun(response, `live session, ${response.file ? response.file : 'unsaved scene'}`);
      }

      const install = await requireBlender(ctx.runtime);
      let blendFile: string | undefined;
      let saveAs: string | undefined;
      if (args.blend_file !== undefined) {
        const resolved = await ctx.runtime.resolvePath(args.blend_file);
        if (await stat(resolved).catch(() => undefined)) blendFile = resolved;
        else if (args.save) saveAs = resolved;
        else throw new ToolError('NOT_FOUND', `No such file: ${resolved}`, 'Pass save: true to create a new file at this path from the startup scene.');
      } else if (args.save) {
        throw new ToolError('INVALID_ARGUMENT', 'save needs blend_file: the file to save to.');
      }
      const response = await runHeadless(ctx.runtime, {
        binary: install.path,
        code,
        blendFile,
        saveAs,
        save: args.save,
        args: args.args,
        factorySettings: args.factory_settings,
        timeoutMs: args.timeout_seconds * 1000,
        signal: ctx.signal,
      });
      return reportRun(response, `background, ${blendFile ?? (saveAs ? `new file ${saveAs}` : 'startup scene')}`, response.log);
    },
  });

  const blenderRender = defineTool({
    name: 'blender_render',
    title: 'Blender: render',
    group: 'blender',
    access: 'full',
    description: [
      'Render a still frame or an animation of a .blend file with a headless Blender, using the settings saved in the file unless overridden here. Returns the image files that were written.',
      'A render that is still running after wait_seconds continues in the background and a process_id is returned: follow it with read_process_output (each finished frame prints a "Saved:" line) and stop it with stop_process.',
      'Give `frame` for one image, or frame_start and frame_end for a range; with neither, the current frame of the scene is rendered. Save the file first if it is open with unsaved changes in a live session: the render reads it from disk.',
    ].join(' '),
    input: z.object({
      blend_file: z.string().describe('.blend file to render (absolute, ~/…, or relative to the working directory).'),
      output: z
        .string()
        .optional()
        .describe('Output path without extension; "#" characters are replaced by the frame number (appended if absent). Default: renders/<file name>_#### next to the .blend file.'),
      frame: z.number().int().optional().describe('Render this single frame.'),
      frame_start: z.number().int().optional().describe('First frame of an animation range.'),
      frame_end: z.number().int().optional().describe('Last frame of an animation range.'),
      scene: z.string().optional().describe('Scene to render. Default: the active scene of the file.'),
      engine: z.string().optional().describe('Render engine, e.g. CYCLES, BLENDER_EEVEE_NEXT (BLENDER_EEVEE before 4.2 and from 5.0), BLENDER_WORKBENCH. Default: as saved in the file.'),
      format: z.enum(['PNG', 'JPEG', 'OPEN_EXR', 'OPEN_EXR_MULTILAYER', 'TIFF', 'BMP', 'TGA', 'WEBP', 'FFMPEG']).optional().describe('Output file format. Default: as saved in the file.'),
      resolution_x: z.number().int().min(4).max(32_768).optional().describe('Width in pixels (before resolution_percentage).'),
      resolution_y: z.number().int().min(4).max(32_768).optional().describe('Height in pixels (before resolution_percentage).'),
      resolution_percentage: z.number().int().min(1).max(1000).optional().describe('Scale of the resolution in percent; 25 or 50 gives fast previews.'),
      samples: z.number().int().min(1).max(100_000).optional().describe('Render samples (Cycles and EEVEE); few samples give fast, noisy previews.'),
      wait_seconds: z.number().min(1).max(LIMITS.callSeconds).default(120).describe('How long to wait before handing the render over to the background.'),
    }),
    examples: [
      { note: 'A quick preview of frame 1.', arguments: { blend_file: 'scene.blend', frame: 1, resolution_percentage: 25, samples: 16 } },
      { note: 'Render an animation range to a folder.', arguments: { blend_file: 'shots/sq01.blend', frame_start: 1, frame_end: 48, output: 'renders/sq01/frame_####' } },
    ],
    hints: { destructive: true },
    async handler(args, ctx) {
      const { runtime } = ctx;
      const blendFile = await existingBlendFile(runtime, args.blend_file);
      const ranged = args.frame_start !== undefined || args.frame_end !== undefined;
      if (ranged && args.frame !== undefined) throw new ToolError('INVALID_ARGUMENT', 'Give either frame, or frame_start and frame_end.');
      if (ranged && (args.frame_start === undefined || args.frame_end === undefined)) throw new ToolError('INVALID_ARGUMENT', 'Give frame_start and frame_end together.');
      if (ranged && (args.frame_end as number) < (args.frame_start as number)) throw new ToolError('INVALID_ARGUMENT', 'frame_end is before frame_start.');
      const install = await requireBlender(runtime);

      const stem = path.basename(blendFile, path.extname(blendFile));
      let output = args.output !== undefined ? await runtime.resolvePath(args.output) : path.join(path.dirname(blendFile), 'renders', `${stem}_####`);
      if (args.output !== undefined && (args.output.endsWith('/') || (await stat(output).catch(() => undefined))?.isDirectory())) output = path.join(output, `${stem}_####`);

      // Blender applies its arguments in order: everything that configures the render comes before -f / -a.
      const argv = ['--background', blendFile];
      if (args.scene !== undefined) argv.push('--scene', args.scene);
      if (args.engine !== undefined) argv.push('--engine', args.engine);
      argv.push('--render-output', output, '--use-extension', '1');
      if (args.format !== undefined) argv.push('--render-format', args.format);
      const overrides: string[] = [];
      if (args.resolution_x !== undefined) overrides.push(`s.render.resolution_x = ${args.resolution_x}`);
      if (args.resolution_y !== undefined) overrides.push(`s.render.resolution_y = ${args.resolution_y}`);
      if (args.resolution_percentage !== undefined) overrides.push(`s.render.resolution_percentage = ${args.resolution_percentage}`);
      if (args.samples !== undefined) {
        overrides.push(`s.cycles.samples = ${args.samples}`, `setattr(s.eevee, "taa_render_samples", ${args.samples})`);
      }
      if (overrides.length > 0) {
        argv.push('--python-expr', ['import bpy', 'for s in bpy.data.scenes:', ...overrides.map((line) => `    ${line}`)].join('\n'));
      }
      if (ranged) argv.push('--frame-start', String(args.frame_start), '--frame-end', String(args.frame_end), '--render-anim');
      else if (args.frame !== undefined) argv.push('--render-frame', String(args.frame));
      else argv.push('--python-expr', 'import bpy; bpy.ops.render.render(write_still=True)');

      const started = Date.now();
      const proc = runtime.processes.start({
        command: ['blender', ...argv].map(shellQuote).join(' '),
        plan: runtime.spawnPlan([install.path, ...argv]),
        cwd: runtime.cwd,
        env: runtime.commandEnv(),
        name: `render ${path.basename(blendFile)}`,
      });
      await ctx.progress(`Rendering ${path.basename(blendFile)}…`);
      const exited = await proc.wait(args.wait_seconds * 1000, ctx.signal);
      const log = proc.output.read(0).text;
      proc.readCursor = proc.output.length;
      let saved = [...log.matchAll(/^Saved: '(.+)'\s*$/gm)].map((match) => match[1] as string);
      const tail = truncateMiddle(log.split('\n').filter((line) => line.trim() !== '').slice(-12).join('\n'), 3000).text;
      const data: Record<string, unknown> = { status: proc.status, exit_code: proc.exitCode, blend_file: blendFile, output, files: saved, duration_ms: (proc.endedAt ?? Date.now()) - started };

      if (!exited) {
        data['process_id'] = proc.id;
        return {
          text: [
            `Still rendering after ${formatDuration(args.wait_seconds * 1000)}; the render continues in the background as process_id "${proc.id}".`,
            'Follow it with read_process_output (a "Saved:" line appears for each finished frame); stop it with stop_process.',
            saved.length > 0 ? `Finished so far: ${saved.length} file${saved.length === 1 ? '' : 's'}, latest ${saved[saved.length - 1]}` : 'No frame has finished yet.',
            tail,
          ].join('\n'),
          data,
        };
      }
      // Movie formats write one file and print no "Saved:" lines.
      if (saved.length === 0 && proc.exitCode === 0) {
        saved = (await writtenSince(path.dirname(output), started)).filter((file) => path.basename(file).startsWith(path.basename(output).replace(/#+.*$/, '')));
        data['files'] = saved;
      }
      if (proc.exitCode !== 0 || saved.length === 0) {
        throw new ToolError(
          'FAILED',
          `The render produced no output (${proc.signal ? `ended by ${proc.signal}` : `exit code ${proc.exitCode}`}).\n${tail}`,
          'Common causes: the scene has no camera, the engine name does not exist in this Blender version, or the output folder cannot be written.',
        );
      }
      const shown = saved.length <= 6 ? saved : [...saved.slice(0, 3), `… ${saved.length - 5} more …`, ...saved.slice(-2)];
      return {
        text: [`Rendered ${saved.length} file${saved.length === 1 ? '' : 's'} in ${formatDuration(Date.now() - started)}:`, ...shown.map((file) => `  ${file}`), 'Look at a result with view_image.'].join('\n'),
        data,
      };
    },
  });

  return [blenderInfo, blenderLaunch, blenderRunPython, blenderRender];
}
