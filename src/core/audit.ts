import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface AuditRecord {
  time: string;
  tool: string;
  args: unknown;
  ok: boolean;
  durationMs: number;
  code?: string;
  error?: string;
  mode?: string;
  client?: string;
}

const SECRET_KEY = /token|password|passwd|secret|authorization|api[_-]?key/i;
const MAX_STRING = 240;
const MAX_ITEMS = 20;

/** Shrink tool arguments for logs: long strings are cut, secret-looking keys are masked. */
export function summarizeArgs(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[…]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => summarizeArgs(v, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`… (${value.length - MAX_ITEMS} more)`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : summarizeArgs(v, depth + 1);
  }
  return out;
}

/** Append-only JSON-lines log of every tool call, one file per day. */
export class AuditLog {
  private readonly dir: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private dirReady = false;

  /** Pass `undefined` to disable writing (records are then only emitted as events). */
  constructor(dir: string | undefined) {
    this.dir = dir;
  }

  record(record: AuditRecord): void {
    if (!this.dir) return;
    const dir = this.dir;
    const file = path.join(dir, `audit-${record.time.slice(0, 10)}.jsonl`);
    const line = `${JSON.stringify(record)}\n`;
    this.queue = this.queue
      .then(async () => {
        if (!this.dirReady) {
          await mkdir(dir, { recursive: true, mode: 0o700 });
          this.dirReady = true;
        }
        await appendFile(file, line, { mode: 0o600 });
      })
      // Auditing must never break a tool call.
      .catch(() => undefined);
  }

  flush(): Promise<void> {
    return this.queue;
  }
}
