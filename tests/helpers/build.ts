import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The end-to-end tests run the compiled CLI, so compile it once before any test starts. */
export default function setup(): void {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  execFileSync(process.execPath, [fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
}
