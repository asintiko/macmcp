import * as z from 'zod';
import { ToolError, toToolError } from '../core/errors.js';
import { sleep } from '../core/exec.js';
import type { Desktop, Screenshot } from '../desktop/desktop.js';
import type { Rect } from '../desktop/geometry.js';
import type { ToolContext, ToolOutput } from './registry.js';

/** The desktop of the server a tool runs on; desktop tools are only registered where one exists. */
export function desktopOf(ctx: ToolContext): Desktop {
  const desktop = ctx.runtime.desktop;
  if (!desktop) throw new ToolError('UNSUPPORTED_PLATFORM', 'Desktop control is only available on macOS.');
  return desktop;
}

export const displayParam = z
  .number()
  .int()
  .min(1)
  .max(16)
  .optional()
  .describe('Display the coordinates refer to: 1 is the main display (default). Only needed when the Mac has several displays.');

export const screenshotParam = z.boolean().default(true).describe('Include a screenshot taken right after the action, so you can check the result without another call.');

export const modifiersParam = z
  .array(z.enum(['cmd', 'shift', 'alt', 'ctrl', 'fn']))
  .optional()
  .describe('Modifier keys held during the action, for example ["cmd"] or ["shift", "alt"].');

export const applicationParams = {
  application: z
    .string()
    .optional()
    .describe('Application by name ("Safari", "Adobe After Effects 2025") or bundle id ("com.apple.Safari"). Default: the frontmost application.'),
  pid: z.number().int().optional().describe('Process id of the application, as an alternative to its name.'),
};

/** Helper parameters that select an application; empty for "the frontmost one". */
export function applicationSelector(args: { application?: string | undefined; pid?: number | undefined }): Record<string, unknown> {
  if (args.pid !== undefined) return { pid: args.pid };
  const name = args.application?.trim();
  return name ? { name } : {};
}

/** What a screenshot shows and how its pixels relate to the coordinates other tools take. */
export function describeScreenshot(shot: Screenshot, windowId?: number): string {
  if (windowId !== undefined) {
    return `Picture of window ${windowId} (${shot.width}×${shot.height}). It is for reading only: to click inside the window use a full screenshot, or the window position from list_windows.`;
  }
  if (shot.region && shot.zoom) {
    const { x, y, width, height } = shot.region;
    return [
      `Enlarged view of the area x=${x} y=${y} ${width}×${height} of display ${shot.display}, shown at ${shot.zoom}× (${shot.width}×${shot.height}).`,
      `It is for reading detail only. Coordinates for other tools are still pixels of the full screenshot: full_x = ${x} + image_x / ${shot.zoom}, full_y = ${y} + image_y / ${shot.zoom}.`,
    ].join(' ');
  }
  return `Screenshot of display ${shot.display} (${shot.width}×${shot.height}). Coordinates for click, drag, scroll and the other tools are pixels of this image.`;
}

export function screenshotData(shot: Screenshot): Record<string, unknown> {
  return {
    display: shot.display,
    width: shot.width,
    height: shot.height,
    screen: shot.screen,
    format: shot.mimeType === 'image/png' ? 'png' : 'jpeg',
    bytes: shot.bytes,
    ...(shot.region ? { region: shot.region, zoom: shot.zoom } : {}),
  };
}

export interface FinishOptions {
  screenshot: boolean;
  display?: number | undefined;
  /** Time to let the interface react before the screenshot is taken. */
  settleMs?: number;
  signal?: AbortSignal;
}

/**
 * Build the result of an action: what was done, plus (by default) a screenshot of the outcome.
 * A screenshot that cannot be taken does not turn a completed action into a failure.
 */
export async function finish(desktop: Desktop, options: FinishOptions, text: string, data: Record<string, unknown> = {}): Promise<ToolOutput> {
  if (!options.screenshot) return { text, data };
  await sleep(options.settleMs ?? 350, options.signal);
  try {
    const shot = await desktop.screenshot(options.display !== undefined ? { display: options.display } : {});
    return {
      text: `${text}\n${describeScreenshot(shot)}`,
      data: { ...data, screenshot: screenshotData(shot) },
      images: [{ base64: shot.base64, mimeType: shot.mimeType }],
    };
  } catch (err) {
    const failure = toToolError(err);
    return { text: `${text}\nThe action was carried out, but no screenshot could be taken: ${failure.message}${failure.hint ? ` ${failure.hint}` : ''}`, data };
  }
}

export function formatRect(rect: Rect): string {
  return `(${rect.x}, ${rect.y}) ${rect.width}×${rect.height}`;
}
