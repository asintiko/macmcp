import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Absolute path of a file shipped in the package's `assets/` directory. */
export function assetPath(...segments: string[]): string {
  // src/assets.ts and dist/assets.js sit at the same depth below the package root.
  return path.join(fileURLToPath(new URL('../assets/', import.meta.url)), ...segments);
}

/** Absolute path of a file shipped in the package's `native/` directory. */
export function nativePath(...segments: string[]): string {
  return path.join(fileURLToPath(new URL('../native/', import.meta.url)), ...segments);
}
