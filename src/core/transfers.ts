import { randomBytes } from 'node:crypto';
import { ToolError } from './errors.js';

export type TransferKind = 'download' | 'upload';

export interface TransferLink {
  id: string;
  kind: TransferKind;
  /** Authorised absolute path on this machine. */
  path: string;
  createdAt: number;
  expiresAt: number;
  /** Remaining number of times the link can be used. */
  remainingUses: number;
  /** Upload size cap in bytes. */
  maxBytes: number;
  /** Uploads may replace an existing file. */
  overwrite: boolean;
  /** Bytes transferred so far, across uses. */
  bytesTransferred: number;
}

export interface CreateTransferOptions {
  kind: TransferKind;
  path: string;
  expiresInSeconds: number;
  uses: number;
  maxBytes?: number;
  overwrite?: boolean;
}

/**
 * Short-lived capability URLs for moving files over plain HTTP instead of through the
 * model's context. Links are unguessable, expire, and are limited to a number of uses.
 */
export class TransferStore {
  private readonly links = new Map<string, TransferLink>();
  private readonly maxLinks: number;
  private readonly now: () => number;

  constructor(options: { maxLinks?: number; now?: () => number } = {}) {
    this.maxLinks = options.maxLinks ?? 200;
    this.now = options.now ?? Date.now;
  }

  create(options: CreateTransferOptions): TransferLink {
    this.prune();
    if (this.links.size >= this.maxLinks) {
      throw new ToolError('CONFLICT', 'Too many active transfer links', 'Wait for existing links to expire.');
    }
    const now = this.now();
    const link: TransferLink = {
      id: randomBytes(24).toString('base64url'),
      kind: options.kind,
      path: options.path,
      createdAt: now,
      expiresAt: now + options.expiresInSeconds * 1000,
      remainingUses: options.uses,
      maxBytes: options.maxBytes ?? Number.MAX_SAFE_INTEGER,
      overwrite: options.overwrite ?? false,
      bytesTransferred: 0,
    };
    this.links.set(link.id, link);
    return link;
  }

  /** Reserve one use of a link. Returns undefined for unknown, expired or exhausted links. */
  take(id: string, kind: TransferKind): TransferLink | undefined {
    this.prune();
    const link = this.links.get(id);
    if (!link || link.kind !== kind || link.remainingUses <= 0) return undefined;
    link.remainingUses -= 1;
    return link;
  }

  /** Give a use back, for example when an upload failed before completing. */
  restore(link: TransferLink): void {
    if (this.links.has(link.id)) link.remainingUses += 1;
  }

  list(): TransferLink[] {
    this.prune();
    return [...this.links.values()];
  }

  private prune(): void {
    const now = this.now();
    for (const [id, link] of this.links) {
      // Exhausted links linger briefly so that an in-flight use can still be restored.
      if (link.expiresAt <= now) this.links.delete(id);
    }
  }
}
