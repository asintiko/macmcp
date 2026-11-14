import { ToolError } from '../core/errors.js';
import { fitWithin } from '../core/image.js';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

/** One display as macOS reports it. Bounds are global points; the main display starts at 0,0. */
export interface DisplayInfo extends Rect {
  /** CoreGraphics display id. */
  id: number;
  /** 1-based position; 1 is the main display. */
  index: number;
  main: boolean;
  pixelWidth: number;
  pixelHeight: number;
  /** Pixels per point: 2 on Retina displays. */
  scale: number;
}

/**
 * How one display maps to the screenshots agents work with. Agents never see points: every
 * coordinate they send or receive is a pixel of the full screenshot of a display ("screenshot
 * space"), whose size depends only on the display and the server's maximum dimension.
 */
export interface ScreenGeometry {
  display: DisplayInfo;
  /** Size of a full screenshot of the display. */
  shot: Size;
  /** Points per screenshot pixel. */
  pointsPerPixel: number;
}

export const DEFAULT_MAX_DIMENSION = 1280;

export function screenGeometry(display: DisplayInfo, maxDimension: number = DEFAULT_MAX_DIMENSION): ScreenGeometry {
  const fitted = fitWithin(display.pixelWidth, display.pixelHeight, maxDimension);
  return {
    display,
    shot: { width: fitted.width, height: fitted.height },
    pointsPerPixel: display.width / fitted.width,
  };
}

/** Screenshot pixel → global point (the centre of the pixel when it covers more than one point). */
export function pointFromShot(geometry: ScreenGeometry, pixel: Point): Point {
  const { shot, display, pointsPerPixel: k } = geometry;
  if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y) || pixel.x < 0 || pixel.y < 0 || pixel.x > shot.width || pixel.y > shot.height) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `Coordinates (${pixel.x}, ${pixel.y}) are outside the screen: the screenshot of display ${display.index} is ${shot.width}×${shot.height} pixels.`,
      'Take a screenshot and use pixel coordinates from it.',
    );
  }
  // The right and bottom edges belong to the last pixel.
  const x = Math.min(pixel.x, shot.width - 1);
  const y = Math.min(pixel.y, shot.height - 1);
  const offset = k > 1 ? k / 2 : 0;
  return { x: display.x + x * k + offset, y: display.y + y * k + offset };
}

/** Global point → screenshot pixel of this display (may lie outside it for other displays). */
export function shotFromPoint(geometry: ScreenGeometry, point: Point): Point {
  const k = geometry.pointsPerPixel;
  return { x: Math.floor((point.x - geometry.display.x) / k), y: Math.floor((point.y - geometry.display.y) / k) };
}

export function rectFromShot(geometry: ScreenGeometry, rect: Rect): Rect {
  const k = geometry.pointsPerPixel;
  return { x: geometry.display.x + rect.x * k, y: geometry.display.y + rect.y * k, width: rect.width * k, height: rect.height * k };
}

export function rectToShot(geometry: ScreenGeometry, rect: Rect): Rect {
  const k = geometry.pointsPerPixel;
  const x = Math.round((rect.x - geometry.display.x) / k);
  const y = Math.round((rect.y - geometry.display.y) / k);
  return { x, y, width: Math.max(0, Math.round(rect.width / k)), height: Math.max(0, Math.round(rect.height / k)) };
}

export function sizeFromShot(geometry: ScreenGeometry, size: Size): Size {
  return { width: size.width * geometry.pointsPerPixel, height: size.height * geometry.pointsPerPixel };
}

/** Clip a screenshot-space rectangle to the screenshot; throws if nothing is left. */
export function clampShotRect(geometry: ScreenGeometry, rect: Rect): Rect {
  const x = Math.max(0, Math.min(Math.floor(rect.x), geometry.shot.width));
  const y = Math.max(0, Math.min(Math.floor(rect.y), geometry.shot.height));
  const right = Math.max(0, Math.min(Math.ceil(rect.x + rect.width), geometry.shot.width));
  const bottom = Math.max(0, Math.min(Math.ceil(rect.y + rect.height), geometry.shot.height));
  if (right - x < 1 || bottom - y < 1) {
    throw new ToolError('INVALID_ARGUMENT', `The region does not overlap the screen (${geometry.shot.width}×${geometry.shot.height} pixels).`);
  }
  return { x, y, width: right - x, height: bottom - y };
}

/** The display with the given 1-based index; the main display by default. */
export function pickDisplay(displays: DisplayInfo[], index: number | undefined): DisplayInfo {
  if (displays.length === 0) throw new ToolError('FAILED', 'macOS reports no active display.');
  if (index === undefined) return displays.find((d) => d.main) ?? (displays[0] as DisplayInfo);
  const display = displays.find((d) => d.index === index);
  if (!display) {
    throw new ToolError('INVALID_ARGUMENT', `There is no display ${index}: this Mac has ${displays.length} display${displays.length === 1 ? '' : 's'} (1 is the main one).`);
  }
  return display;
}

/** The display a global point lies on, or the nearest one. */
export function displayContaining(displays: DisplayInfo[], point: Point): DisplayInfo {
  const inside = displays.find((d) => point.x >= d.x && point.x < d.x + d.width && point.y >= d.y && point.y < d.y + d.height);
  if (inside) return inside;
  let best = displays[0] as DisplayInfo;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const dx = Math.max(display.x - point.x, 0, point.x - (display.x + display.width));
    const dy = Math.max(display.y - point.y, 0, point.y - (display.y + display.height));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = display;
      bestDistance = distance;
    }
  }
  return best;
}

export function centerOf(rect: Rect): Point {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}
