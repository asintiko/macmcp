import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Root of mcpclaude's own state. Overridable for tests and unusual setups. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['MCPCLAUDE_HOME'];
  return override && override.trim() !== '' ? path.resolve(override) : path.join(homedir(), '.mcpclaude');
}

export interface StoredConfig {
  version: 1;
  /** Access token agents must present (token auth mode). */
  accessToken?: string;
  /** ngrok authtoken, stored only if the user agreed to save it. */
  ngrokAuthtoken?: string;
  /** Reserved/static ngrok domain to request for the tunnel. */
  ngrokDomain?: string;
  /** Preferred local port. */
  port?: number;
  /** Most recently used project directories, newest first. */
  recentDirectories?: string[];
}

const EMPTY: StoredConfig = { version: 1 };
const MAX_RECENT = 8;

/**
 * Persists a small JSON document with owner-only permissions. Reads tolerate a missing or
 * corrupt file (the corrupt file is kept aside as config.json.corrupt).
 */
export class ConfigStore {
  readonly dir: string;
  readonly file: string;
  private data: StoredConfig = { ...EMPTY };

  constructor(dir: string = stateDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
  }

  get value(): Readonly<StoredConfig> {
    return this.data;
  }

  async load(): Promise<StoredConfig> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = { ...EMPTY };
        return this.data;
      }
      throw err;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      this.data = sanitize(parsed as Record<string, unknown>);
    } catch {
      await rename(this.file, `${this.file}.corrupt`).catch(() => undefined);
      this.data = { ...EMPTY };
    }
    return this.data;
  }

  async update(patch: Partial<StoredConfig>): Promise<StoredConfig> {
    const next: StoredConfig = { ...this.data, ...patch, version: 1 };
    for (const key of Object.keys(next) as (keyof StoredConfig)[]) {
      if (next[key] === undefined) delete next[key];
    }
    this.data = next;
    await this.save();
    return this.data;
  }

  async rememberDirectory(dir: string): Promise<void> {
    const rest = (this.data.recentDirectories ?? []).filter((d) => d !== dir);
    await this.update({ recentDirectories: [dir, ...rest].slice(0, MAX_RECENT) });
  }

  private async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
    // writeFile's mode is subject to umask and ignored for existing files.
    await chmod(this.file, 0o600).catch(() => undefined);
  }
}

function sanitize(raw: Record<string, unknown>): StoredConfig {
  const out: StoredConfig = { version: 1 };
  if (typeof raw['accessToken'] === 'string' && raw['accessToken']) out.accessToken = raw['accessToken'];
  if (typeof raw['ngrokAuthtoken'] === 'string' && raw['ngrokAuthtoken']) out.ngrokAuthtoken = raw['ngrokAuthtoken'];
  if (typeof raw['ngrokDomain'] === 'string' && raw['ngrokDomain']) out.ngrokDomain = raw['ngrokDomain'];
  const port = raw['port'];
  if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536) out.port = port;
  const recent = raw['recentDirectories'];
  if (Array.isArray(recent)) {
    out.recentDirectories = recent.filter((d): d is string => typeof d === 'string').slice(0, MAX_RECENT);
  }
  return out;
}
