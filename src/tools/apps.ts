import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { ToolError } from '../core/errors.js';
import { sleep } from '../core/exec.js';
import type { Desktop } from '../desktop/desktop.js';
import { applicationParams, applicationSelector, desktopOf, finish, screenshotParam } from './desktop-util.js';
import { type AnyTool, defineTool } from './registry.js';
import { renderTable } from './util.js';

interface AppInfo {
  pid: number;
  name: string;
  bundle_id?: string;
  path?: string;
  active: boolean;
  hidden: boolean;
  kind: string;
  launched_at?: string;
}

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/;

/** Application bundles in the usual places, two folder levels deep (suites install into sub-folders). */
async function installedApplications(home: string): Promise<{ name: string; path: string }[]> {
  const roots = ['/Applications', '/System/Applications', path.join(home, 'Applications')];
  const found = new Map<string, string>();
  const scan = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.endsWith('.app')) {
        if (!found.has(full)) found.set(full, entry.name.slice(0, -4));
      } else if (depth < 2 && (entry.isDirectory() || entry.isSymbolicLink())) {
        await scan(full, depth + 1);
      }
    }
  };
  for (const root of roots) await scan(root, 1);
  return [...found.entries()].map(([file, name]) => ({ name, path: file })).sort((a, b) => a.name.localeCompare(b.name));
}

async function runningApplication(desktop: Desktop, selector: Record<string, unknown>): Promise<AppInfo | undefined> {
  const { applications } = await desktop.call<{ applications: AppInfo[] }>('apps', { include_background: true });
  if (typeof selector['pid'] === 'number') return applications.find((app) => app.pid === selector['pid']);
  const wanted = String(selector['name'] ?? '').toLowerCase().replace(/\.app$/, '');
  const rank = (app: AppInfo): number => (app.kind === 'regular' ? 0 : 1);
  return applications
    .filter((app) => app.name.toLowerCase() === wanted || app.bundle_id?.toLowerCase() === wanted || path.basename(app.path ?? '', '.app').toLowerCase() === wanted)
    .sort((a, b) => rank(a) - rank(b))[0];
}

function requireSelector(args: { application?: string | undefined; pid?: number | undefined }): Record<string, unknown> {
  const selector = applicationSelector(args);
  if (Object.keys(selector).length === 0) throw new ToolError('INVALID_ARGUMENT', 'Name the application with `application` or `pid`.');
  return selector;
}

export function appTools(): AnyTool[] {
  const listApplications = defineTool({
    name: 'list_applications',
    title: 'List applications',
    group: 'apps',
    access: 'full',
    desktop: true,
    description: [
      'List the applications that are running, with their process id, bundle id and which one is frontmost.',
      'Set `installed` to also list the applications installed on the Mac (from /Applications, /System/Applications and ~/Applications), to find the exact name to open.',
    ].join(' '),
    input: z.object({
      include_background: z.boolean().default(false).describe('Also list menu-bar and background applications that have no Dock icon.'),
      installed: z.boolean().default(false).describe('Also list installed applications that are not running.'),
    }),
    examples: [
      { note: 'What is running?', arguments: {} },
      { note: 'Find out how an installed application is called.', arguments: { installed: true } },
    ],
    hints: { readOnly: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      const { applications, frontmost } = await desktop.call<{ applications: AppInfo[]; frontmost?: AppInfo }>('apps', { include_background: args.include_background });
      const rows = applications.map((app) => [
        app.pid === frontmost?.pid ? '*' : '',
        app.name,
        String(app.pid),
        app.bundle_id ?? '-',
        [app.hidden ? 'hidden' : '', app.kind !== 'regular' ? app.kind : ''].filter(Boolean).join(' ') || '-',
      ]);
      const lines = [renderTable(['', 'application', 'pid', 'bundle id', 'state'], rows), frontmost ? `* frontmost: ${frontmost.name}` : ''];
      const data: Record<string, unknown> = { running: applications, frontmost: frontmost?.name ?? null };
      if (args.installed) {
        const installed = await installedApplications(ctx.runtime.home);
        const running = new Set(applications.map((app) => app.path));
        data['installed'] = installed;
        lines.push('', `Installed (${installed.length}):`, ...installed.map((app) => `  ${app.name}${running.has(app.path) ? '  (running)' : ''}  —  ${app.path}`));
      }
      return { text: lines.filter((line, index) => line !== '' || index > 1).join('\n'), data };
    },
  });

  const openApplication = defineTool({
    name: 'open_application',
    title: 'Open an application',
    group: 'apps',
    access: 'full',
    desktop: true,
    description: [
      'Launch an application, or bring it to the front if it is already running, and wait until it is ready. Give its name as shown in the Applications folder ("Blender", "Adobe After Effects 2025"), its bundle id, or the path of the .app.',
      'Large applications take a while to finish starting after their window appears: follow up with wait or screenshot. To open a document use open_path.',
    ].join(' '),
    input: z.object({
      application: z.string().min(1).describe('Application name, bundle id ("com.apple.TextEdit") or path to the .app bundle.'),
      arguments: z.array(z.string()).optional().describe('Command-line arguments passed to the application when it is launched.'),
      new_instance: z.boolean().default(false).describe('Start another instance even if the application is already running.'),
      background: z.boolean().default(false).describe('Launch without bringing the application to the front.'),
      wait_seconds: z.number().min(0).max(120).default(20).describe('How long to wait for the application to appear.'),
      screenshot: screenshotParam,
    }),
    examples: [
      { note: 'Start Blender.', arguments: { application: 'Blender' } },
      { note: 'Bring Finder to the front.', arguments: { application: 'com.apple.finder' } },
    ],
    hints: { destructive: false },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const target = args.application.trim();
        const openArgs: string[] = [];
        if (args.new_instance) openArgs.push('-n');
        if (args.background) openArgs.push('-g');
        let selector: Record<string, unknown>;
        if (target.includes('/') || target.startsWith('~')) {
          const bundle = await ctx.runtime.resolvePath(target);
          if (!(await stat(bundle).catch(() => undefined))) throw new ToolError('NOT_FOUND', `No application at ${bundle}`);
          openArgs.push(bundle);
          selector = { name: path.basename(bundle, '.app') };
        } else if (BUNDLE_ID.test(target)) {
          openArgs.push('-b', target);
          selector = { name: target };
        } else {
          openArgs.push('-a', target.replace(/\.app$/i, ''));
          selector = { name: target };
        }
        if (args.arguments && args.arguments.length > 0) openArgs.push('--args', ...args.arguments);

        const result = await desktop.driver.open(openArgs);
        if (result.code !== 0) {
          const detail = (result.stderr || result.stdout).trim();
          if (/unable to find application|can.t be found|does not exist|LSCopyApplicationURLsForBundleIdentifier/i.test(detail)) {
            throw new ToolError('NOT_FOUND', `macOS found no application "${target}".`, 'list_applications with installed: true shows the names of the installed applications.');
          }
          throw new ToolError('FAILED', `The application could not be opened: ${detail || `open exited with ${result.code}`}`);
        }

        const deadline = Date.now() + args.wait_seconds * 1000;
        let app = await runningApplication(desktop, selector);
        while (!app && Date.now() < deadline && !ctx.signal.aborted) {
          await sleep(300, ctx.signal);
          app = await runningApplication(desktop, selector);
        }
        if (!app) {
          return finish(desktop, { screenshot: args.screenshot, signal: ctx.signal }, `Asked macOS to open ${target}; it has not appeared among the running applications after ${args.wait_seconds} s. It may still be starting.`, {
            running: false,
          });
        }
        let front = app.active;
        if (!args.background && !front) {
          const activated = await desktop.call<AppInfo>('app_activate', { pid: app.pid }).catch(() => undefined);
          front = activated?.active ?? false;
        }
        const state = args.background ? 'running in the background' : front ? 'frontmost' : 'running, but another application is in front';
        return finish(desktop, { screenshot: args.screenshot, settleMs: 600, signal: ctx.signal }, `${app.name} (pid ${app.pid}) is ${state}.`, {
          running: true,
          name: app.name,
          pid: app.pid,
          bundle_id: app.bundle_id ?? null,
          frontmost: front,
        });
      });
    },
  });

  const activateApplication = defineTool({
    name: 'activate_application',
    title: 'Switch to an application',
    group: 'apps',
    access: 'full',
    desktop: true,
    description: 'Bring a running application to the front so that it receives keyboard input, like clicking its Dock icon. Fails if the application is not running: use open_application to start it.',
    input: z.object({ ...applicationParams, screenshot: screenshotParam }),
    examples: [{ note: 'Switch to After Effects.', arguments: { application: 'Adobe After Effects 2025' } }],
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const app = await desktop.call<AppInfo>('app_activate', requireSelector(args));
        const text = app.active
          ? `${app.name} (pid ${app.pid}) is now frontmost.`
          : `${app.name} (pid ${app.pid}) did not come to the front; a dialog of another application may be holding the focus.`;
        return finish(desktop, { screenshot: args.screenshot, signal: ctx.signal }, text, { name: app.name, pid: app.pid, frontmost: app.active });
      });
    },
  });

  const quitApplication = defineTool({
    name: 'quit_application',
    title: 'Quit an application',
    group: 'apps',
    access: 'full',
    desktop: true,
    description: [
      'Ask an application to quit, as Quit in its menu would. An application with unsaved changes shows a dialog and keeps running: look at the screen and answer it.',
      '`force` ends it immediately without saving anything — only for applications that are stuck.',
    ].join(' '),
    input: z.object({
      ...applicationParams,
      force: z.boolean().default(false).describe('Kill the application without letting it save.'),
      wait_seconds: z.number().min(0).max(60).default(10).describe('How long to wait for it to exit.'),
      screenshot: screenshotParam,
    }),
    examples: [{ note: 'Quit TextEdit.', arguments: { application: 'TextEdit' } }],
    hints: { destructive: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const result = await desktop.call<AppInfo & { terminated: boolean; requested: boolean }>(
          'app_quit',
          { ...requireSelector(args), force: args.force, wait_seconds: args.wait_seconds },
          { timeoutMs: (args.wait_seconds + 30) * 1000, signal: ctx.signal },
        );
        const text = result.terminated
          ? `${result.name} has quit.`
          : `${result.name} was asked to quit but is still running after ${args.wait_seconds} s. It is probably showing a dialog (unsaved changes?) — look at the screen.`;
        return finish(desktop, { screenshot: args.screenshot, signal: ctx.signal }, text, { name: result.name, pid: result.pid, terminated: result.terminated });
      });
    },
  });

  const openPath = defineTool({
    name: 'open_path',
    title: 'Open a file, folder or URL',
    group: 'apps',
    access: 'full',
    desktop: true,
    description: [
      'Open a document, folder or URL the way double-clicking it in Finder would: with its default application, or with the application you name. Use it to load a project file into After Effects or Blender, show a folder in Finder, or open a web page.',
      '`reveal` selects the item in a Finder window instead of opening it.',
    ].join(' '),
    input: z.object({
      target: z.string().min(1).describe('File or folder path (absolute, ~/…, or relative to the working directory) or a URL such as https://example.com.'),
      application: z.string().optional().describe('Application to open it with (name or bundle id). Default: the default application for that kind of item.'),
      reveal: z.boolean().default(false).describe('Show the item in Finder instead of opening it.'),
      background: z.boolean().default(false).describe('Do not bring the application to the front.'),
      screenshot: screenshotParam,
    }),
    examples: [
      { note: 'Open a project in After Effects.', arguments: { target: '~/Projects/title.aep', application: 'Adobe After Effects 2025' } },
      { note: 'Show a rendered file in Finder.', arguments: { target: 'renders/final.mov', reveal: true } },
      { note: 'Open a web page in the default browser.', arguments: { target: 'https://www.blender.org/download/' } },
    ],
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      return desktop.exclusive(async () => {
        const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(args.target) || /^(mailto|tel):/i.test(args.target);
        let target = args.target;
        if (!isUrl) {
          target = await ctx.runtime.resolvePath(args.target);
          if (!(await stat(target).catch(() => undefined))) throw new ToolError('NOT_FOUND', `No such file or directory: ${target}`);
        } else if (args.reveal) {
          throw new ToolError('INVALID_ARGUMENT', 'Only files and folders can be revealed in Finder.');
        }
        const openArgs: string[] = [];
        if (args.reveal) openArgs.push('-R');
        if (args.background) openArgs.push('-g');
        if (args.application) {
          const application = args.application.trim();
          openArgs.push(BUNDLE_ID.test(application) ? '-b' : '-a', application.replace(/\.app$/i, ''));
        }
        openArgs.push(target);
        const result = await desktop.driver.open(openArgs);
        if (result.code !== 0) {
          const detail = (result.stderr || result.stdout).trim();
          if (args.application && /unable to find application|can.t be found/i.test(detail)) {
            throw new ToolError('NOT_FOUND', `macOS found no application "${args.application}".`, 'list_applications with installed: true shows the names of the installed applications.');
          }
          throw new ToolError('FAILED', `${target} could not be opened: ${detail || `open exited with ${result.code}`}`);
        }
        const how = args.reveal ? 'Revealed in Finder' : args.application ? `Opened with ${args.application}` : 'Opened';
        return finish(desktop, { screenshot: args.screenshot, settleMs: 1200, signal: ctx.signal }, `${how}: ${target}`, { target, url: isUrl });
      });
    },
  });

  return [listApplications, openApplication, activateApplication, quitApplication, openPath];
}
