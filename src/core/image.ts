export interface ImageInfo {
  format: 'png' | 'jpeg' | 'gif' | 'webp';
  width: number;
  height: number;
}

export const IMAGE_MIME: Record<ImageInfo['format'], string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Read format and pixel size from the header of a PNG, JPEG, GIF or WebP file. */
export function readImageInfo(data: Buffer): ImageInfo | undefined {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.readUInt32BE(4) === 0x0d0a1a0a) {
    return { format: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 10 && (data.toString('latin1', 0, 6) === 'GIF87a' || data.toString('latin1', 0, 6) === 'GIF89a')) {
    return { format: 'gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (data.length >= 30 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = data.toString('latin1', 12, 16);
    if (chunk === 'VP8X') {
      return { format: 'webp', width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8 ') {
      return { format: 'webp', width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = data.readUInt32LE(21);
      return { format: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return undefined;
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1] as number;
      // Standalone markers carry no length.
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        offset += marker === 0xff ? 1 : 2;
        continue;
      }
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return { format: 'jpeg', height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      offset += 2 + data.readUInt16BE(offset + 2);
    }
  }
  return undefined;
}

/** Largest size with the same aspect ratio whose long edge does not exceed `maxDimension`. */
export function fitWithin(width: number, height: number, maxDimension: number): { width: number; height: number; scale: number } {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}
