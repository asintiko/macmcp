import { ToolError } from '../../src/core/errors.js';
import type { RunResult } from '../../src/core/exec.js';
import type { CaptureOptions, DesktopDriver, EncodeOptions, ScriptOptions } from '../../src/desktop/driver.js';
import { type HelperCommand, HelperFailure } from '../../src/desktop/helper.js';
import { solidPng } from './png.js';

export interface FakeDisplay {
  id: number;
  index: number;
  main: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  pixel_width: number;
  pixel_height: number;
  scale: number;
}

type Handler = (params: Record<string, unknown>) => unknown;

/** A 1440×900-point Retina display: full screenshots come out as 1280×800. */
export const RETINA: FakeDisplay = { id: 1, index: 1, main: true, x: 0, y: 0, width: 1440, height: 900, pixel_width: 2880, pixel_height: 1800, scale: 2 };
/** A plain 1024×768 display like the one of the hosted macOS runners: screenshots are 1:1. */
export const PLAIN: FakeDisplay = { id: 1, index: 1, main: true, x: 0, y: 0, width: 1024, height: 768, pixel_width: 1024, pixel_height: 768, scale: 1 };

export function result(overrides: Partial<RunResult> = {}): RunResult {
  return { code: 0, signal: null, stdout: '', stderr: '', stdoutBytes: Buffer.alloc(0), timedOut: false, ...overrides };
}

/**
 * Stands in for the Mac: records what the tools ask for and answers from simple state, so the
 * tool logic (coordinate mapping, batching, output) can be tested on any platform.
 */
export class FakeDesktopDriver implements DesktopDriver {
  /** Every helper command received, in order. */
  readonly commands: HelperCommand[] = [];
  /** One entry per helper invocation: the commands it carried. */
  readonly invocations: HelperCommand[][] = [];
  readonly captures: CaptureOptions[] = [];
  readonly encodes: EncodeOptions[] = [];
  readonly opened: string[][] = [];
  readonly scripts: { source: string; options: ScriptOptions }[] = [];
  displays: FakeDisplay[];
  pointer = { x: 0, y: 0 };
  clipboard: string | undefined;
  /** Replace or add answers for helper commands; throw a ToolError to make one fail. */
  handlers: Record<string, Handler> = {};
  /** Result of the next `open` and `osascript` runs. */
  openResult: (args: string[]) => RunResult = () => result();
  scriptResult: (source: string, options: ScriptOptions) => RunResult = () => result();
  /** Make screen captures fail (for example: no Screen Recording permission). */
  captureError: ToolError | undefined;
  /** Artificial duration of each helper invocation. */
  delayMs = 0;

  constructor(displays: FakeDisplay[] = [RETINA]) {
    this.displays = displays;
  }

  private answer(command: HelperCommand): unknown {
    const params = command.params ?? {};
    const custom = this.handlers[command.command];
    if (custom) return custom(params);
    switch (command.command) {
      case 'displays':
        return { displays: this.displays };
      case 'permissions':
        return { accessibility: true, screen_recording: true };
      case 'cursor':
        return { ...this.pointer };
      case 'frontmost':
        return { application: { name: 'Finder', pid: 100, active: true }, window: { title: 'Desktop', window_id: 11 } };
      case 'mouse_move':
      case 'mouse_click':
      case 'mouse_down':
      case 'mouse_up':
      case 'mouse_scroll':
        if (typeof params['x'] === 'number') this.pointer = { x: params['x'], y: params['y'] as number };
        return { ...this.pointer };
      case 'mouse_drag':
        this.pointer = { x: params['to_x'] as number, y: params['to_y'] as number };
        return { ...this.pointer };
      case 'key':
      case 'key_down':
      case 'key_up':
      case 'type':
      case 'sleep':
        return {};
      case 'clipboard_get':
        return this.clipboard === undefined ? { types: [] } : { text: this.clipboard, types: ['public.utf8-plain-text'] };
      case 'clipboard_set':
        this.clipboard = params['text'] as string;
        return { characters: this.clipboard.length };
      default:
        throw new ToolError('FAILED', `The fake desktop has no answer for "${command.command}"`);
    }
  }

  async run(commands: HelperCommand[]): Promise<unknown[]> {
    this.invocations.push(commands);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const results: unknown[] = [];
    for (const [index, command] of commands.entries()) {
      this.commands.push(command);
      try {
        results.push(this.answer(command));
      } catch (err) {
        if (err instanceof ToolError) throw new HelperFailure(err, index, results);
        throw err;
      }
    }
    return results;
  }

  /** The helper commands with this name, for assertions. */
  sent(name: string): Record<string, unknown>[] {
    return this.commands.filter((command) => command.command === name).map((command) => command.params ?? {});
  }

  async capture(options: CaptureOptions): Promise<Buffer> {
    this.captures.push(options);
    if (this.captureError) throw this.captureError;
    if (options.windowId !== undefined) return solidPng(1600, 1000);
    const display = this.displays.find((d) => d.index === (options.display ?? 1)) ?? (this.displays[0] as FakeDisplay);
    if (options.region) {
      const scale = this.displays.find((d) => options.region && options.region.x >= d.x && options.region.x < d.x + d.width)?.scale ?? display.scale;
      return solidPng(Math.max(1, Math.round(options.region.width * scale)), Math.max(1, Math.round(options.region.height * scale)));
    }
    return solidPng(display.pixel_width, display.pixel_height);
  }

  async encode(_png: Buffer, options: EncodeOptions): Promise<Buffer> {
    this.encodes.push(options);
    return solidPng(options.width, options.height);
  }

  async script(source: string, options: ScriptOptions): Promise<RunResult> {
    this.scripts.push({ source, options });
    return this.scriptResult(source, options);
  }

  async open(args: string[]): Promise<RunResult> {
    this.opened.push(args);
    return this.openResult(args);
  }

  async prepare(): Promise<void> {}
}
