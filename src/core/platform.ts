import os from 'node:os';
import { runProgram } from './exec.js';

let macVersion: Promise<string | undefined> | undefined;

/** macOS product version such as "15.3.1"; undefined on other systems. */
export function macosVersion(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (platform !== 'darwin') return Promise.resolve(undefined);
  macVersion ??= runProgram('/usr/bin/sw_vers', ['-productVersion'], { timeoutMs: 5000 })
    .then((result) => (result.code === 0 ? result.stdout.trim() : undefined))
    .catch(() => undefined);
  return macVersion;
}

export async function platformSummary(platform: NodeJS.Platform = process.platform): Promise<{ os: string; version: string; arch: string }> {
  if (platform === 'darwin') {
    return { os: 'macOS', version: (await macosVersion(platform)) ?? os.release(), arch: os.arch() };
  }
  return { os: platform === 'linux' ? 'Linux' : platform, version: os.release(), arch: os.arch() };
}
