import { ToolError } from '../core/errors.js';
import { fitWithin, readImageInfo } from '../core/image.js';
import type { DesktopDriver } from './driver.js';
import {
  clampShotRect,
  DEFAULT_MAX_DIMENSION,
  displayContaining,
  type DisplayInfo,
  pickDisplay,
  type Point,
  pointFromShot,
  type Rect,
  rectFromShot,
  rectToShot,
  type ScreenGeometry,
  screenGeometry,
  shotFromPoint,
  type Size,
} from './geometry.js';
import type { HelperCommand } from './helper.js';

export interface ScreenshotRequest {
  /** 1-based display index (default: the main display). */
  display?: number;
  /** Area to enlarge, in screenshot space. */
  region?: Rect;
  /** Capture one window instead of the screen. */
  windowId?: number;
  format?: 'jpeg' | 'png';
  /** Draw the mouse pointer (default true). */
  cursor?: boolean;
}

export interface Screenshot {
  base64: string;
  mimeType: string;
  /** Size of the returned picture. */
  width: number;
  height: number;
  bytes: number;
  display: number;
  /** Size of the full screenshot of the display: the coordinate space of every other tool. */
  screen: Size;
  /** For region and window pictures: the area shown, in screenshot space. */
  region?: Rect;
  /** For region and window pictures: picture pixels per screenshot pixel. */
  zoom?: number;
}

export interface DesktopOptions {
  /** Long edge of full screenshots, which fixes the coordinate space agents work in. */
  maxDimension?: number;
  jpegQuality?: number;
}

interface RawDisplay {
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

export interface Permissions {
  accessibility: boolean;
  screen_recording: boolean;
}

/**
 * Desktop state shared by the desktop tools of one server: the driver, the mapping between
 * screenshots and display points, and a lock so that concurrent calls cannot interleave input.
 */
export class Desktop {
  readonly driver: DesktopDriver;
  readonly maxDimension: number;
  private readonly jpegQuality: number;
  private displayCache: { at: number; displays: DisplayInfo[] } | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(driver: DesktopDriver, options: DesktopOptions = {}) {
    this.driver = driver;
    this.maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
    this.jpegQuality = options.jpegQuality ?? 80;
  }

  /** Run `task` when every earlier desktop action has finished. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Run one helper command and return its result. */
  async call<T = Record<string, unknown>>(command: string, params: Record<string, unknown> = {}, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
    const [result] = await this.driver.run([{ command, params }], options);
    return result as T;
  }

  run(commands: HelperCommand[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown[]> {
    return this.driver.run(commands, options);
  }

  permissions(prompt = false): Promise<Permissions> {
    return this.call<Permissions>('permissions', { prompt });
  }

  /** Displays as macOS reports them now (briefly cached: every coordinate conversion needs them). */
  async displays(fresh = false): Promise<DisplayInfo[]> {
    const now = Date.now();
    if (!fresh && this.displayCache && now - this.displayCache.at < 3000) return this.displayCache.displays;
    const { displays: raw } = await this.call<{ displays: RawDisplay[] }>('displays');
    const displays = raw.map((d) => ({
      id: d.id,
      index: d.index,
      main: d.main,
      x: d.x,
      y: d.y,
      width: d.width,
      height: d.height,
      pixelWidth: d.pixel_width,
      pixelHeight: d.pixel_height,
      scale: d.scale,
    }));
    if (displays.length === 0) throw new ToolError('FAILED', 'macOS reports no active display. The Mac may be asleep or have no screen attached.');
    this.displayCache = { at: now, displays };
    return displays;
  }

  async geometry(display?: number, fresh = false): Promise<ScreenGeometry> {
    return screenGeometry(pickDisplay(await this.displays(fresh), display), this.maxDimension);
  }

  /** Screenshot pixel of a display → global point. */
  async toPoint(pixel: Point, display?: number): Promise<Point> {
    return pointFromShot(await this.geometry(display), pixel);
  }

  /** Global point → the display it is on and the screenshot pixel there. */
  async fromPoint(point: Point): Promise<{ display: number } & Point> {
    const displays = await this.displays();
    const display = displayContaining(displays, point);
    return { display: display.index, ...shotFromPoint(screenGeometry(display, this.maxDimension), point) };
  }

  /** Global rectangle → the display it is (mostly) on and the rectangle in screenshot space. */
  async fromRect(rect: Rect): Promise<{ display: number } & Rect> {
    const displays = await this.displays();
    const display = displayContaining(displays, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    return { display: display.index, ...rectToShot(screenGeometry(display, this.maxDimension), rect) };
  }

  /** Where the pointer is, in screenshot space. */
  async cursor(): Promise<{ display: number } & Point> {
    return this.fromPoint(await this.call<Point>('cursor'));
  }

  async screenshot(request: ScreenshotRequest = {}): Promise<Screenshot> {
    const geometry = await this.geometry(request.display, true);
    const format = request.format ?? 'jpeg';
    const cursor = request.cursor ?? true;
    const displayIndex = geometry.display.index;

    let png: Buffer;
    let region: Rect | undefined;
    if (request.windowId !== undefined) {
      png = await this.driver.capture({ windowId: request.windowId, cursor: false });
    } else if (request.region) {
      region = clampShotRect(geometry, request.region);
      png = await this.driver.capture({ region: rectFromShot(geometry, region), cursor });
    } else {
      png = await this.driver.capture({ display: displayIndex, cursor });
    }

    const info = readImageInfo(png);
    if (!info || info.format !== 'png') throw new ToolError('FAILED', 'macOS returned a screenshot that is not a PNG image.');

    // A full screenshot always has the size that defines the coordinate space; anything else is
    // shown as large as the limit allows, so that zooming in really shows more detail.
    const target = request.windowId === undefined && !region ? { ...geometry.shot, scale: 0 } : fitWithin(info.width, info.height, this.maxDimension);
    const unchanged = format === 'png' && target.width === info.width && target.height === info.height;
    const data = unchanged ? png : await this.driver.encode(png, { width: target.width, height: target.height, format, quality: this.jpegQuality });

    const shot: Screenshot = {
      base64: data.toString('base64'),
      mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
      width: target.width,
      height: target.height,
      bytes: data.length,
      display: displayIndex,
      screen: geometry.shot,
    };
    if (region) {
      shot.region = region;
      shot.zoom = Math.round((target.width / region.width) * 1000) / 1000;
    }
    return shot;
  }
}
