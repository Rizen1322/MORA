import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { sha1, md5 } from '@noble/hashes/legacy.js';
import { gcm } from '@noble/ciphers/aes.js';

/** node:crypto as far as the server uses it: hashes, random values, UUIDs, AES-GCM for secrets. */

const algos = { sha256, sha1, md5 } as const;
type Algo = keyof typeof algos;

class Hash {
  private h: ReturnType<(typeof algos)[Algo]['create']>;
  constructor(alg: string) {
    const a = algos[alg.toLowerCase().replace('-', '') as Algo];
    if (!a) throw new Error(`хеш ${alg} не поддерживается`);
    this.h = a.create();
  }
  update(data: string | Uint8Array, enc?: BufferEncoding): this {
    this.h.update(typeof data === 'string' ? Buffer.from(data, enc ?? 'utf8') : data);
    return this;
  }
  digest(enc?: BufferEncoding): Buffer | string {
    const out = Buffer.from(this.h.digest());
    return enc ? out.toString(enc) : out;
  }
}

export function createHash(alg: string): Hash { return new Hash(alg); }
export function randomBytes(n: number): Buffer {
  const b = Buffer.alloc(n);
  crypto.getRandomValues(b);
  return b;
}
export function randomUUID(): string { return crypto.randomUUID(); }
export function randomInt(min: number, max?: number): number {
  if (max === undefined) { max = min; min = 0; }
  return min + Math.floor(Math.random() * (max - min));
}
/**
 * AES-256-GCM for provider secrets (apps/server/src/providers/base.ts), keyed by the app's Keychain key.
 * GCM needs the whole message for its tag: update() buffers, final() does the work.
 */
class Gcm {
  private parts: Uint8Array[] = [];
  private tag: Uint8Array | null = null;
  constructor(private decrypt: boolean, alg: string, private key: Uint8Array, private iv: Uint8Array) {
    if (alg.toLowerCase() !== 'aes-256-gcm' || key.length !== 32) throw new Error(`шифр ${alg} не поддерживается`);
  }
  update(data: string | Uint8Array, enc?: BufferEncoding): Buffer {
    this.parts.push(typeof data === 'string' ? Buffer.from(data, enc ?? 'utf8') : data);
    return Buffer.alloc(0);
  }
  final(): Buffer {
    const all = Buffer.concat(this.parts);
    if (this.decrypt) {
      if (!this.tag) throw new Error('нет тега аутентификации');
      return Buffer.from(gcm(this.key, this.iv).decrypt(Buffer.concat([all, this.tag])));
    }
    const sealed = gcm(this.key, this.iv).encrypt(all);
    this.tag = sealed.subarray(sealed.length - 16);
    return Buffer.from(sealed.subarray(0, sealed.length - 16));
  }
  getAuthTag(): Buffer { if (!this.tag) throw new Error('тег ещё не готов'); return Buffer.from(this.tag); }
  setAuthTag(tag: Uint8Array): this { this.tag = tag; return this; }
}
export function createCipheriv(alg: string, key: Uint8Array, iv: Uint8Array): Gcm { return new Gcm(false, alg, key, iv); }
export function createDecipheriv(alg: string, key: Uint8Array, iv: Uint8Array): Gcm { return new Gcm(true, alg, key, iv); }
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export default { createHash, randomBytes, randomUUID, randomInt, createCipheriv, createDecipheriv, timingSafeEqual };
