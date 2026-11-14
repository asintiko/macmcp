import * as z from 'zod';
import { ToolError } from '../core/errors.js';
import { truncateMiddle } from '../core/exec.js';
import { LIMITS } from '../core/runtime.js';
import { ACCESSIBILITY_HINT } from '../desktop/helper.js';
import { desktopOf } from './desktop-util.js';
import { type AnyTool, defineTool } from './registry.js';

const AUTOMATION_HINT =
  'Ask the user to allow it in System Settings → Privacy & Security → Automation (the application that runs mcpclaude must be allowed to control the target application), then try again. You cannot grant this yourself.';

/** Turn an osascript failure into an error an agent can act on. */
function scriptError(stderr: string, timedOut: boolean, seconds: number): ToolError {
  const detail = stderr.trim().replace(/^\S*osascript: /, '') || 'osascript failed without a message';
  if (timedOut) {
    return new ToolError(
      'TIMEOUT',
      `The script did not finish within ${seconds} s and was stopped.`,
      'The target application may be busy or showing a dialog, or macOS may be waiting for the user to allow automation. Take a screenshot to check.',
    );
  }
  if (/-1743|not authori[sz]ed to send apple events/i.test(detail)) return new ToolError('MACOS_PERMISSION_REQUIRED', detail, AUTOMATION_HINT);
  if (/-1719|-25211|not allowed assistive access/i.test(detail)) return new ToolError('MACOS_PERMISSION_REQUIRED', detail, ACCESSIBILITY_HINT);
  if (/-600\b|isn.t running/i.test(detail)) return new ToolError('FAILED', detail, 'The application is not running: start it with open_application first.');
  return new ToolError('FAILED', detail);
}

export function scriptingTools(): AnyTool[] {
  const runAppleScript = defineTool({
    name: 'run_applescript',
    title: 'Run AppleScript or JXA',
    group: 'scripting',
    access: 'full',
    desktop: true,
    description: [
      'Run AppleScript, or JavaScript for Automation with language "javascript", and return its result. Many applications can be scripted directly — Finder, Safari, Mail, Music, Keynote, Photoshop, After Effects (DoScript) — which is faster and more exact than clicking.',
      'The script is passed as is, so no shell quoting is needed. `args` are available as `on run argv` (AppleScript) or `function run(argv)` (JavaScript).',
      'The first time a script controls another application, macOS asks the user for permission; until they allow it the call fails with MACOS_PERMISSION_REQUIRED.',
    ].join(' '),
    input: z.object({
      script: z.string().min(1).describe('Source code of the script.'),
      language: z.enum(['applescript', 'javascript']).default('applescript').describe('Scripting language.'),
      args: z.array(z.string()).optional().describe('Arguments passed to the run handler of the script.'),
      timeout_seconds: z.number().min(1).max(LIMITS.callSeconds).default(60).describe('Stop the script if it runs longer than this.'),
    }),
    examples: [
      { note: 'Ask Finder which folder its front window shows.', arguments: { script: 'tell application "Finder" to get POSIX path of (target of front window as alias)' } },
      { note: 'JavaScript for Automation.', arguments: { language: 'javascript', script: 'Application("System Events").processes.whose({frontmost: true})[0].name()' } },
    ],
    hints: { destructive: true, openWorld: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      const result = await desktop.driver.script(args.script, {
        language: args.language,
        args: args.args ?? [],
        timeoutMs: args.timeout_seconds * 1000,
        signal: ctx.signal,
      });
      if (result.timedOut || result.code !== 0) throw scriptError(result.stderr, result.timedOut, args.timeout_seconds);
      const output = truncateMiddle(result.stdout.replace(/\n$/, ''), 60_000);
      // JXA writes console.log to standard error.
      const log = result.stderr.trim();
      const text = [output.text === '' ? '(the script returned nothing)' : output.text, log ? `--- log ---\n${truncateMiddle(log, 8000).text}` : ''].filter(Boolean).join('\n');
      return { text, data: { result: output.text, truncated_chars: output.truncated, ...(log ? { log: log.slice(0, 8000) } : {}) } };
    },
  });

  const getClipboard = defineTool({
    name: 'get_clipboard',
    title: 'Read the clipboard',
    group: 'scripting',
    access: 'full',
    desktop: true,
    description: 'Return the text on the macOS clipboard, for example after copying a selection with press_key "cmd+c" — a dependable way to read text out of an application. Reports which kinds of data are on the clipboard when it holds no text.',
    input: z.object({
      max_chars: z.number().int().min(100).max(1_000_000).default(100_000).describe('Cap on the returned text.'),
    }),
    examples: [{ arguments: {} }],
    hints: { readOnly: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      const clip = await desktop.call<{ text?: string; types: string[] }>('clipboard_get');
      if (clip.text === undefined) {
        const kinds = clip.types.length > 0 ? `It holds: ${clip.types.join(', ')}.` : 'It is empty.';
        return { text: `The clipboard contains no text. ${kinds}`, data: { text: null, types: clip.types } };
      }
      const cut = truncateMiddle(clip.text, args.max_chars);
      return { text: cut.text, data: { text: cut.text, characters: clip.text.length, truncated_chars: cut.truncated, types: clip.types } };
    },
  });

  const setClipboard = defineTool({
    name: 'set_clipboard',
    title: 'Put text on the clipboard',
    group: 'scripting',
    access: 'full',
    desktop: true,
    description: 'Replace the content of the macOS clipboard with the given text. Followed by press_key "cmd+v" this pastes long or complex text into an application much faster and more reliably than type_text.',
    input: z.object({ text: z.string().max(5_000_000).describe('Text to place on the clipboard.') }),
    examples: [{ arguments: { text: 'Lower third — Jane Doe, Director' } }],
    hints: { destructive: true },
    async handler(args, ctx) {
      const desktop = desktopOf(ctx);
      await desktop.call('clipboard_set', { text: args.text });
      return { text: `Copied ${args.text.length} characters to the clipboard.`, data: { characters: args.text.length } };
    },
  });

  return [runAppleScript, getClipboard, setClipboard];
}
