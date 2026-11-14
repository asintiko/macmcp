import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { buildAppleScript, buildScriptWrapper, findAfterEffects, parseScriptReply, requireAerender, type ScriptReply } from '../creative/aftereffects.js';
import { ToolError } from '../core/errors.js';
import { truncateMiddle } from '../core/exec.js';
import { LIMITS } from '../core/runtime.js';
import type { Desktop } from '../desktop/desktop.js';
import { desktopOf } from './desktop-util.js';
import { type AnyTool, defineTool, type ToolContext } from './registry.js';
import { formatDuration, shellQuote } from './util.js';

interface RunningApp {
  pid: number;
  name: string;
  bundle_id?: string;
  path?: string;
}

const AUTOMATION_HINT =
  'Ask the user to allow it in System Settings → Privacy & Security → Automation: the application that runs mcpclaude must be allowed to control After Effects. macOS asks once; if the dialog was dismissed the switch is on that page.';

/** After Effects processes that are running now (the render engine does not count). */
async function runningAfterEffects(desktop: Desktop): Promise<RunningApp[]> {
  const { applications } = await desktop.call<{ applications: RunningApp[] }>('apps', { include_background: false });
  return applications.filter((app) => /^com\.adobe\.aftereffects/i.test(app.bundle_id ?? '') || /^Adobe After Effects/i.test(app.name)).filter((app) => !/render engine/i.test(app.name));
}

/** Name under which AppleScript reaches the running After Effects the caller means. */
async function targetApplication(desktop: Desktop, wanted: string | undefined): Promise<string> {
  const running = await runningAfterEffects(desktop);
  // The bundle name ("Adobe After Effects 2025") is what `tell application` needs.
  const names = running.map((app) => (app.path ? path.basename(app.path, '.app') : app.name));
  if (names.length === 0) {
    throw new ToolError('FAILED', 'After Effects is not running.', 'Start it with open_application (after_effects_info lists the installed versions), wait until it has finished loading, then try again.');
  }
  if (wanted === undefined) return names[0] as string;
  const key = wanted.trim().toLowerCase().replace(/\.app$/, '');
  const match = names.find((name) => name.toLowerCase() === key) ?? names.find((name) => name.toLowerCase().endsWith(` ${key}`));
  if (!match) throw new ToolError('NOT_FOUND', `"${wanted}" is not running. Running: ${names.join(', ')}.`);
  return match;
}

/** Run ExtendScript in After Effects and return what the wrapper reports. */
async function runExtendScript(ctx: ToolContext, application: string, code: string, options: { undoGroup?: string | undefined; timeoutSeconds: number }): Promise<ScriptReply> {
  const desktop = desktopOf(ctx);
  const dir = path.join(ctx.runtime.scratchDir, 'after-effects');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `script-${randomBytes(6).toString('hex')}.jsx`);
  await writeFile(file, buildScriptWrapper(code, { undoGroup: options.undoGroup }));
  try {
    const run = await desktop.driver.script(buildAppleScript(application, file, options.timeoutSeconds), {
      language: 'applescript',
      args: [],
      timeoutMs: (options.timeoutSeconds + 10) * 1000,
      signal: ctx.signal,
    });
    const detail = run.stderr.trim().replace(/^\S*osascript: /, '');
    if (run.timedOut || /-1712|timed out/i.test(detail)) {
      throw new ToolError(
        'TIMEOUT',
        `After Effects did not finish the script within ${options.timeoutSeconds} s.`,
        'It may be busy, or showing a dialog (an alert from the script, a missing-footage or save prompt): take a screenshot. A script that is still running continues in After Effects.',
      );
    }
    if (run.code !== 0) {
      if (/-1743|not authori[sz]ed to send apple events/i.test(detail)) throw new ToolError('MACOS_PERMISSION_REQUIRED', `macOS did not allow mcpclaude to control After Effects: ${detail}`, AUTOMATION_HINT);
      if (/-600\b|isn.t running|-609\b|connection is invalid/i.test(detail)) {
        throw new ToolError('FAILED', `After Effects did not accept the script: ${detail}`, 'It is not running any more, or still starting. Check with after_effects_info.');
      }
      throw new ToolError('FAILED', `After Effects did not accept the script: ${detail || `osascript exited with ${run.code}`}`);
    }
    const reply = parseScriptReply(run.stdout);
    if (!reply) throw new ToolError('FAILED', `After Effects returned an unexpected answer: ${truncateMiddle(run.stdout.trim(), 600).text || '(nothing)'}`);
    return reply;
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

const PROJECT_SUMMARY = `
var __items = [], __i, __item;
for (__i = 1; __i <= app.project.numItems && __items.length < 40; __i++) {
  __item = app.project.item(__i);
  if (__item instanceof CompItem) {
    __items.push({ name: __item.name, width: __item.width, height: __item.height, duration: __item.duration, frameRate: __item.frameRate, layers: __item.numLayers });
  }
}
({
  items: app.project.numItems,
  compositions: __items,
  active: app.project.activeItem ? app.project.activeItem.name : null,
  renderQueue: app.project.renderQueue.numItems
});
`;

export function afterEffectsTools(): AnyTool[] {
  const info = defineTool({
    name: 'after_effects_info',
    title: 'After Effects: installation and project',
    group: 'after_effects',
    access: 'full',
    desktop: true,
    description: [
      'Report which Adobe After Effects versions are installed, whether one is running, and — when it is — its version, the open project, its compositions and the render queue length.',
      'Call it first: the exact application name it returns ("Adobe After Effects 2025") is what open_application, activate_application and select_menu_item need.',
    ].join(' '),
    input: z.object({}),
    examples: [{ arguments: {} }],
    hints: { readOnly: true },
    async handler(_args, ctx) {
      const desktop = desktopOf(ctx);
      const installs = await findAfterEffects(ctx.runtime);
      const running = await runningAfterEffects(desktop);
      const lines: string[] = [];
      if (installs.length === 0) lines.push('After Effects is not installed on this Mac (nothing matching "Adobe After Effects" in /Applications).');
      else lines.push('Installed:', ...installs.map((install) => `  ${install.name} — ${install.app}${install.aerender ? '' : '  (no aerender)'}`));

      let project: Record<string, unknown> | undefined;
      let version: string | undefined;
      let problem: string | undefined;
      if (running.length === 0) {
        lines.push('Running: no. Start it with open_application and wait until its window has finished loading.');
      } else {
        const application = await targetApplication(desktop, undefined);
        lines.push(`Running: ${application} (pid ${running[0]?.pid}).`);
        try {
          const reply = await runExtendScript(ctx, application, PROJECT_SUMMARY, { timeoutSeconds: 20 });
          if (reply.ok) {
            version = reply.version;
            project = { file: reply.project ?? null, ...(reply.result as Record<string, unknown>) };
            const comps = project['compositions'] as { name: string; width: number; height: number; duration: number; frameRate: number; layers: number }[];
            lines.push(
              `  Version ${version ?? 'unknown'}; project: ${reply.project ?? '(unsaved)'}`,
              `  ${String(project['items'])} project items, ${comps.length} composition${comps.length === 1 ? '' : 's'}, ${String(project['renderQueue'])} in the render queue; active item: ${project['active'] === null ? 'none' : String(project['active'])}`,
              ...comps.map((comp) => `    "${comp.name}" ${comp.width}×${comp.height}, ${comp.duration.toFixed(2)} s at ${comp.frameRate} fps, ${comp.layers} layers`),
            );
          } else {
            problem = reply.error ?? 'the script failed';
          }
        } catch (err) {
          problem = err instanceof ToolError ? `${err.message}${err.hint ? ` ${err.hint}` : ''}` : String(err);
        }
        if (problem) lines.push(`  Scripting is not available right now: ${problem}`);
      }
      return {
        text: lines.join('\n'),
        data: {
          installed: installs.map((install) => ({ name: install.name, application: install.app, aerender: install.aerender ?? null })),
          running: running.map((app) => ({ name: app.path ? path.basename(app.path, '.app') : app.name, pid: app.pid })),
          version: version ?? null,
          project: project ?? null,
          ...(problem ? { scripting_problem: problem } : {}),
        },
      };
    },
  });

  const runScript = defineTool({
    name: 'after_effects_run_script',
    title: 'After Effects: run ExtendScript',
    group: 'after_effects',
    access: 'full',
    desktop: true,
    description: [
      'Run ExtendScript (JavaScript, ECMAScript 3) inside the running After Effects and return the value of the last statement: read and change the project, compositions, layers, properties, keyframes, effects and the render queue far more exactly than through the interface.',
      'Values come back as JSON; application objects as {type, name}. Call log(...) to collect progress lines. Variables do not survive between calls (use $.global to keep one). Set undo_group so the user can undo the whole change in one step.',
      'Avoid alert() and other dialogs: they block After Effects until someone answers them. After Effects must be running (open_application). For shape, mask and footage work that needs the eye, combine with screenshot.',
    ].join(' '),
    input: z.object({
      code: z.string().optional().describe('ExtendScript source. Give either this or script_path.'),
      script_path: z.string().optional().describe('Path of a .jsx file to run instead of `code`.'),
      undo_group: z.string().max(80).optional().describe('Wrap the script in one undo step with this name, e.g. "Add title".'),
      application: z.string().optional().describe('Which running After Effects to use when several are open, e.g. "Adobe After Effects 2025". Default: the one that is running.'),
      timeout_seconds: z.number().min(1).max(LIMITS.callSeconds).default(120).describe('Stop waiting after this long.'),
    }),
    examples: [
      { note: 'Name and size of the active composition.', arguments: { code: 'var c = app.project.activeItem; ({ name: c.name, width: c.width, height: c.height, layers: c.numLayers })' } },
      {
        note: 'Create a composition with a text layer, as one undo step.',
        arguments: { undo_group: 'Add title', code: 'var comp = app.project.items.addComp("Title", 1920, 1080, 1, 5, 25);\nvar text = comp.layers.addText("Hello");\ncomp.openInViewer();\ntext.name' },
      },
    ],
    hints: { destructive: true },
    async handler(args, ctx) {
      if ((args.code === undefined) === (args.script_path === undefined)) throw new ToolError('INVALID_ARGUMENT', 'Give either `code` or `script_path`.');
      const code = args.code ?? (await readFile(await ctx.runtime.resolvePath(args.script_path as string), 'utf8'));
      if (code.trim() === '') throw new ToolError('INVALID_ARGUMENT', 'The script is empty.');
      const application = await targetApplication(desktopOf(ctx), args.application);
      const started = Date.now();
      const reply = await runExtendScript(ctx, application, code, { undoGroup: args.undo_group, timeoutSeconds: args.timeout_seconds });
      const log = (reply.log ?? []).join('\n');
      if (!reply.ok) {
        const parts = [`ExtendScript error in ${application}: ${reply.error ?? 'unknown error'}${reply.line !== undefined ? ` (line ${reply.line})` : ''}`];
        if (log) parts.push(`--- log before the error ---\n${truncateMiddle(log, 8000).text}`);
        throw new ToolError('FAILED', parts.join('\n'), 'Changes made before the error are not rolled back; the user can undo them in After Effects.');
      }
      const value = reply.result === null || reply.result === undefined ? '' : typeof reply.result === 'string' ? reply.result : JSON.stringify(reply.result, null, 2);
      const lines = [`Ran in ${application}${reply.version ? ` ${reply.version}` : ''} in ${formatDuration(Date.now() - started)}.`];
      if (value !== '') lines.push(`--- result ---\n${truncateMiddle(value, 60_000).text}`);
      if (log) lines.push(`--- log ---\n${truncateMiddle(log, 20_000).text}`);
      if (value === '' && !log) lines.push('(the script returned nothing; end it with an expression to get a value back)');
      return { text: lines.join('\n'), data: { result: reply.result ?? null, log: reply.log ?? [], application, version: reply.version ?? null, project: reply.project ?? null } };
    },
  });

  const render = defineTool({
    name: 'after_effects_render',
    title: 'After Effects: render with aerender',
    group: 'after_effects',
    access: 'full',
    desktop: true,
    description: [
      'Render a composition or the render queue of an .aep project with aerender, the command-line renderer installed with After Effects. It reads the project from disk — save it first (app.project.save() through after_effects_run_script) — and works whether or not the application is open.',
      'Without `comp`, every queued item of the render queue is rendered with its own settings. With `comp` and `output`, that composition is rendered to the given file using the templates named here or the defaults.',
      'A render still running after wait_seconds continues in the background and a process_id is returned: follow it with read_process_output (aerender prints PROGRESS lines) and stop it with stop_process.',
    ].join(' '),
    input: z.object({
      project: z.string().describe('.aep (or .aepx) project file (absolute, ~/…, or relative to the working directory).'),
      comp: z.string().optional().describe('Name of the composition to render. Default: the queued items of the render queue.'),
      output: z.string().optional().describe('Output file; for image sequences put [#####] where the frame number goes, e.g. "renders/shot_[#####].png".'),
      rq_index: z.number().int().min(1).optional().describe('Render only this item of the render queue (1 is the first).'),
      render_settings_template: z.string().optional().describe('Name of a Render Settings template, e.g. "Best Settings".'),
      output_module_template: z.string().optional().describe('Name of an Output Module template, e.g. "Lossless" or "H.264 - Match Render Settings - 15 Mbps".'),
      start_frame: z.number().int().optional().describe('First frame to render.'),
      end_frame: z.number().int().optional().describe('Last frame to render.'),
      increment: z.number().int().min(1).max(100).optional().describe('Render every n-th frame.'),
      multi_frame_rendering: z.boolean().optional().describe('Render several frames at once (After Effects 2022 and later).'),
      reuse: z.boolean().default(false).describe('Use an already running After Effects instead of starting a separate render process.'),
      continue_on_missing_footage: z.boolean().default(false).describe('Do not stop when footage is missing.'),
      application: z.string().optional().describe('Installed version to render with, e.g. "Adobe After Effects 2025". Default: the newest.'),
      wait_seconds: z.number().min(1).max(LIMITS.callSeconds).default(120).describe('How long to wait before handing the render over to the background.'),
    }),
    examples: [
      { note: 'Render everything that is queued in the project.', arguments: { project: 'promo.aep' } },
      { note: 'Render one composition to a file.', arguments: { project: 'promo.aep', comp: 'Main', output: 'renders/main.mov', output_module_template: 'Lossless' } },
    ],
    hints: { destructive: true },
    async handler(args, ctx) {
      const { runtime } = ctx;
      const project = await runtime.resolvePath(args.project);
      if (!(await stat(project).catch(() => undefined))?.isFile()) throw new ToolError('NOT_FOUND', `No such project file: ${project}`);
      if (args.output !== undefined && args.comp === undefined && args.rq_index === undefined) {
        throw new ToolError('INVALID_ARGUMENT', '`output` needs `comp` (or `rq_index`): without one, the render queue items are rendered to the files set in the project.');
      }
      const { aerender, install } = await requireAerender(runtime, args.application);
      const output = args.output !== undefined ? await runtime.resolvePath(args.output) : undefined;
      if (output) await mkdir(path.dirname(output), { recursive: true });

      const argv = ['-project', project];
      if (args.comp !== undefined) argv.push('-comp', args.comp);
      if (args.rq_index !== undefined) argv.push('-rqindex', String(args.rq_index));
      if (args.render_settings_template !== undefined) argv.push('-RStemplate', args.render_settings_template);
      if (args.output_module_template !== undefined) argv.push('-OMtemplate', args.output_module_template);
      if (output) argv.push('-output', output);
      if (args.start_frame !== undefined) argv.push('-s', String(args.start_frame));
      if (args.end_frame !== undefined) argv.push('-e', String(args.end_frame));
      if (args.increment !== undefined) argv.push('-i', String(args.increment));
      if (args.multi_frame_rendering !== undefined) argv.push('-mfr', args.multi_frame_rendering ? 'ON' : 'OFF', '100');
      if (args.reuse) argv.push('-reuse');
      if (args.continue_on_missing_footage) argv.push('-continueOnMissingFootage');
      argv.push('-sound', 'OFF');

      const started = Date.now();
      const proc = runtime.processes.start({
        command: ['aerender', ...argv].map(shellQuote).join(' '),
        plan: runtime.spawnPlan([aerender, ...argv]),
        cwd: runtime.cwd,
        env: runtime.commandEnv(),
        name: `aerender ${path.basename(project)}`,
      });
      await ctx.progress(`Rendering ${path.basename(project)} with aerender…`);
      const exited = await proc.wait(args.wait_seconds * 1000, ctx.signal);
      const log = `${proc.output.read(0, 'stdout').text}\n${proc.output.read(0, 'stderr').text}`.trim();
      proc.readCursor = proc.output.length;
      const meaningful = log.split('\n').filter((line) => line.trim() !== '');
      const tail = truncateMiddle(meaningful.slice(-14).join('\n'), 4000).text;
      const progress = meaningful.filter((line) => /^PROGRESS:\s+[\d:;.]+\s+\(\d+\)/.test(line)).length;
      const data: Record<string, unknown> = {
        status: proc.status,
        exit_code: proc.exitCode,
        project,
        output: output ?? null,
        frames_reported: progress,
        duration_ms: (proc.endedAt ?? Date.now()) - started,
        aerender,
        ...(install ? { application: install.name } : {}),
      };

      if (!exited) {
        data['process_id'] = proc.id;
        return {
          text: [
            `Still rendering after ${formatDuration(args.wait_seconds * 1000)}; aerender continues in the background as process_id "${proc.id}".`,
            'Follow it with read_process_output; stop it with stop_process.',
            tail || '(no output yet: aerender takes a while to start)',
          ].join('\n'),
          data,
        };
      }
      const failed = proc.exitCode !== 0 || /aerender ERROR|^ERROR:|After Effects error:/im.test(log);
      if (failed) {
        throw new ToolError(
          'FAILED',
          `aerender failed (${proc.signal ? `ended by ${proc.signal}` : `exit code ${proc.exitCode}`}).\n${tail}`,
          'Common causes: the composition name does not exist, a template name is wrong, footage is missing (continue_on_missing_footage), nothing is queued in the render queue, or the output folder cannot be written.',
        );
      }
      const written = output ? `\nOutput: ${output}` : '';
      return { text: `aerender finished in ${formatDuration(Date.now() - started)}${progress > 0 ? ` (${progress} frames reported)` : ''}.${written}\n${tail}`, data };
    },
  });

  return [info, runScript, render];
}
