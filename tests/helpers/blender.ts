import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A real Blender on this machine, if there is one: MCPCLAUDE_BLENDER, the usual places, or PATH. */
export function realBlender(): string | undefined {
  const override = process.env['MCPCLAUDE_BLENDER'];
  if (override && existsSync(override)) return override;
  for (const candidate of ['/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender']) {
    if (existsSync(candidate)) return candidate;
  }
  const found = spawnSync('/bin/sh', ['-c', 'command -v blender'], { encoding: 'utf8' });
  const onPath = found.status === 0 ? found.stdout.trim() : '';
  return onPath !== '' ? onPath : undefined;
}

/** Whether a Blender window can be opened here: always on macOS, with an X or Wayland display elsewhere. */
export function canShowWindows(): boolean {
  return process.platform === 'darwin' || Boolean(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']);
}

/**
 * A stand-in for the blender executable: answers --version, records its arguments (one per
 * line) in `<dir>/argv.log`, and behaves as told by `<dir>/behaviour`:
 *   render   print two "Saved:" lines and exit 0
 *   nothing  exit 0 without doing anything
 *   crash    print an error and exit 7
 */
export async function installStubBlender(dir: string, behaviour: 'render' | 'nothing' | 'crash' = 'render'): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stub = path.join(dir, 'blender');
  await writeFile(
    stub,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Blender 9.9.1"; echo "	build date: today"; exit 0; fi
here="$(dirname "$0")"
printf '%s\\n' "$@" > "$here/argv.log"
case "$(cat "$here/behaviour")" in
  render)
    echo "Blender 9.9.1"
    echo "Fra:1 Mem:10.00M | Rendering 1 / 1 samples"
    echo "Saved: '/renders/shot_0001.png'"
    echo "Saved: '/renders/shot_0002.png'"
    echo "Blender quit"
    ;;
  crash)
    echo "Error: Cannot read file" >&2
    exit 7
    ;;
esac
exit 0
`,
  );
  await chmod(stub, 0o755);
  await writeFile(path.join(dir, 'behaviour'), behaviour);
  return stub;
}
