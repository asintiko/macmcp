import { toToolError } from '../core/errors.js';
import { runProgram } from '../core/exec.js';
import type { Runtime } from '../core/runtime.js';
import { Desktop } from '../desktop/desktop.js';
import { type DesktopDriver, MacDesktopDriver } from '../desktop/driver.js';
import type { CheckResult } from './doctor.js';
import type { Ui } from './ui.js';

/** Tool groups that use the desktop driver. */
const DESKTOP_GROUPS = ['apps', 'windows', 'computer', 'ui', 'scripting', 'after_effects', 'blender'];

const TERMINAL_NAMES: Record<string, string> = {
  Apple_Terminal: 'Terminal',
  'iTerm.app': 'iTerm',
  vscode: 'Visual Studio Code',
  WarpTerminal: 'Warp',
  ghostty: 'Ghostty',
  WezTerm: 'WezTerm',
  Hyper: 'Hyper',
  Tabby: 'Tabby',
  kitty: 'kitty',
  alacritty: 'Alacritty',
};

/** The application macOS holds responsible for mcpclaude, i.e. the one that needs the privacy permissions. */
export function terminalName(env: NodeJS.ProcessEnv): string {
  const program = env['TERM_PROGRAM'];
  if (program && TERMINAL_NAMES[program]) return TERMINAL_NAMES[program];
  if (env['KITTY_WINDOW_ID']) return 'kitty';
  if (env['ALACRITTY_WINDOW_ID'] || env['ALACRITTY_SOCKET']) return 'Alacritty';
  return program ? program.replace(/\.app$/, '') : 'your terminal application';
}

export function accessibilityFix(terminal: string): string {
  return `System Settings → Privacy & Security → Accessibility: switch on ${terminal}. It takes effect immediately.`;
}

export function screenRecordingFix(terminal: string): string {
  return `System Settings → Privacy & Security → Screen & System Audio Recording: switch on ${terminal}, then quit and reopen ${terminal}.`;
}

/**
 * Wizard hook for Full System Access on macOS: build the desktop helper if this is the first
 * run, ask macOS for the Accessibility and Screen Recording permissions, and tell the user what
 * is still missing. Problems are reported, not fatal: shell and file tools work regardless.
 */
export async function prepareDesktop(runtime: Runtime, ui: Ui): Promise<void> {
  const desktop = runtime.desktop;
  if (!desktop || runtime.mode !== 'full') return;
  if (DESKTOP_GROUPS.every((group) => runtime.disabledGroups.has(group))) return;
  const terminal = terminalName(runtime.env);

  const spinner = ui.spinner('Preparing desktop control…');
  try {
    await desktop.driver.prepare(() => spinner.update('Building the desktop helper (first run only, about half a minute)…'));
  } catch (err) {
    const failure = toToolError(err);
    spinner.stop();
    ui.warn(`Desktop control is not ready: ${failure.message.split('\n')[0]}`);
    if (failure.code === 'DEPENDENCY_MISSING') ui.info('→ Install the Xcode Command Line Tools with "xcode-select --install", then start mcpclaude again.');
    ui.info('Shell and file tools work; screen, mouse and keyboard tools report this problem to the agent until it is fixed.');
    return;
  }

  let permissions;
  try {
    // Asking makes macOS show its own dialogs once, with a button that opens the right settings page.
    permissions = await desktop.permissions(true);
  } catch (err) {
    spinner.stop();
    ui.warn(`Desktop control is not ready: ${toToolError(err).message.split('\n')[0]}`);
    return;
  }
  spinner.stop();

  if (permissions.accessibility && permissions.screen_recording) {
    ui.success('Desktop control ready: screen capture, mouse, keyboard, windows and menus.');
    return;
  }
  if (permissions.accessibility) ui.success('Accessibility access granted: mouse, keyboard, windows and menus can be controlled.');
  else {
    ui.warn('macOS has not granted Accessibility access: the agent cannot use the mouse, the keyboard, windows or menus yet.');
    ui.info(`→ ${accessibilityFix(terminal)}`);
  }
  if (permissions.screen_recording) ui.success('Screen Recording access granted: the agent can take screenshots.');
  else {
    ui.warn('macOS has not granted Screen Recording access: the agent cannot see the screen yet.');
    ui.info(`→ ${screenRecordingFix(terminal)}`);
  }
}

export interface DesktopCheckDeps {
  stateDir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Driver to examine; by default the real macOS driver. */
  driver?: DesktopDriver;
}

/** `mcpclaude doctor` checks for desktop control. They never open a permission dialog. */
export async function desktopChecks(deps: DesktopCheckDeps): Promise<CheckResult[]> {
  if (deps.platform !== 'darwin' && !deps.driver) return [{ name: 'Desktop control', status: 'skip', detail: 'macOS only' }];
  const results: CheckResult[] = [];
  const terminal = terminalName(deps.env);

  if (!deps.driver) {
    const tools = await runProgram('/usr/bin/xcode-select', ['-p'], { timeoutMs: 10_000 }).catch(() => undefined);
    if (tools?.code === 0) {
      results.push({ name: 'Xcode Command Line Tools', status: 'ok', detail: tools.stdout.trim() });
    } else {
      results.push({
        name: 'Xcode Command Line Tools',
        status: 'warn',
        detail: 'not installed; desktop control (Full System Access) needs them once, to build its helper',
        fix: 'Run: xcode-select --install',
      });
      results.push({ name: 'Desktop helper', status: 'skip', detail: 'needs the Xcode Command Line Tools' });
      return results;
    }
  }

  const driver = deps.driver ?? new MacDesktopDriver({ stateDir: deps.stateDir });
  let built = false;
  try {
    let compiled = false;
    await driver.prepare(() => (compiled = true));
    built = true;
    results.push({ name: 'Desktop helper', status: 'ok', detail: compiled ? 'compiled from source and cached' : 'built and cached' });
  } catch (err) {
    const failure = toToolError(err);
    results.push({
      name: 'Desktop helper',
      status: 'fail',
      detail: failure.message.split('\n').slice(0, 6).join(' ').slice(0, 400),
      fix: 'Check that "swiftc --version" works; reinstall the Xcode Command Line Tools if it does not.',
    });
  }
  if (!built) return results;

  try {
    const permissions = await new Desktop(driver).permissions(false);
    results.push(
      permissions.accessibility
        ? { name: 'Accessibility', status: 'ok', detail: `granted to ${terminal}: mouse, keyboard, windows and menus` }
        : { name: 'Accessibility', status: 'warn', detail: 'not granted: no mouse, keyboard, window or menu control', fix: accessibilityFix(terminal) },
    );
    results.push(
      permissions.screen_recording
        ? { name: 'Screen Recording', status: 'ok', detail: `granted to ${terminal}: screenshots` }
        : { name: 'Screen Recording', status: 'warn', detail: 'not granted: no screenshots', fix: screenRecordingFix(terminal) },
    );
  } catch (err) {
    results.push({ name: 'Desktop permissions', status: 'fail', detail: toToolError(err).message.split('\n')[0] ?? 'the desktop helper failed' });
  }
  return results;
}
