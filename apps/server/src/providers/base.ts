import crypto from 'node:crypto';
import { q, type Db } from '../db.ts';
import type { Capabilities, ConfigField, ProviderInfo, ProviderStatus } from './types.ts';

// The desktop shell passes a key protected by the OS (DPAPI). Remove it from the
// environment at once so ffmpeg/Python child processes never inherit it.
const SECRET_KEY = /^[0-9a-f]{64}$/i.test(process.env.AUTOMIX_SECRET_KEY ?? '') ? Buffer.from(process.env.AUTOMIX_SECRET_KEY!, 'hex') : null;
delete process.env.AUTOMIX_SECRET_KEY;
const ENC = 'enc1:';

export function sealSecret(plain: string, key: Buffer | null = SECRET_KEY): string {
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ENC + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

/** null when the value is sealed with a key this process does not have. */
export function openSecret(stored: string, key: Buffer | null = SECRET_KEY): string | null {
  if (!stored.startsWith(ENC)) return stored;
  if (!key) return null;
  try {
    const raw = Buffer.from(stored.slice(ENC.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Persistence of provider configuration. Secrets stay in the local DB and are never returned by the API. */
export class ProviderStore {
  constructor(private readonly db: Db) {
    if (!SECRET_KEY) return;
    // Seal plain-text secrets left by the browser version or an imported library.
    for (const row of q(db, "SELECT id, secret FROM providers WHERE secret IS NOT NULL AND secret NOT LIKE 'enc1:%'").all() as { id: string; secret: string }[]) {
      q(db, 'UPDATE providers SET secret = ? WHERE id = ?').run(sealSecret(row.secret), row.id);
    }
  }

  load(id: string): { config: Record<string, string>; secret: Record<string, string>; enabled: boolean } {
    const row = q(this.db, 'SELECT config, secret, enabled FROM providers WHERE id = ?').get(id) as
      | { config: string; secret: string | null; enabled: number }
      | undefined;
    if (!row) return { config: {}, secret: {}, enabled: false };
    const secret = row.secret ? openSecret(row.secret) : null;
    return { config: JSON.parse(row.config || '{}'), secret: secret ? JSON.parse(secret) : {}, enabled: !!row.enabled };
  }

  save(id: string, config: Record<string, string>, secret: Record<string, string>, enabled: boolean): void {
    q(
      this.db,
      'INSERT INTO providers(id, config, secret, enabled, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, secret = excluded.secret, enabled = excluded.enabled, updated_at = excluded.updated_at',
    ).run(id, JSON.stringify(config), Object.keys(secret).length ? sealSecret(JSON.stringify(secret)) : null, enabled ? 1 : 0, Date.now());
  }

  clear(id: string): void {
    q(this.db, 'DELETE FROM providers WHERE id = ?').run(id);
  }
}

export interface InfoParts {
  id: string;
  name: string;
  kind: ProviderInfo['kind'];
  official: boolean;
  caps: Capabilities;
  notes: string[];
  docs: string[];
  fields?: ConfigField[];
}

export function makeInfo(p: InfoParts, status: ProviderStatus, statusText: string, extra: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    official: p.official,
    capabilities: p.caps,
    status,
    statusText,
    notes: p.notes,
    docs: p.docs,
    configFields: p.fields ?? [],
    config: {},
    hasSecret: false,
    checkedAt: Date.now(),
    ...extra,
  };
}

/** Caches a live status check for a while so the sources page stays fast. */
export class StatusCache {
  private value: ProviderInfo | null = null;
  private at = 0;
  constructor(private readonly ttlMs = 60000) {}
  async get(force: boolean, fn: () => Promise<ProviderInfo>): Promise<ProviderInfo> {
    if (!force && this.value && Date.now() - this.at < this.ttlMs) return this.value;
    this.value = await fn();
    this.at = Date.now();
    return this.value;
  }
  reset(): void {
    this.value = null;
  }
}
