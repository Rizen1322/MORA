import nodeCrypto from 'node:crypto';
import { expect, it } from 'vitest';
import { createCipheriv, createDecipheriv } from '../src/worker/shims/crypto.ts';

const key = nodeCrypto.randomBytes(32), iv = nodeCrypto.randomBytes(12);
const plain = '{"token":"y0_секрет"}';

it('seals provider secrets exactly like node:crypto AES-256-GCM, both ways', () => {
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  const n = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
  n.setAuthTag(tag);
  expect(Buffer.concat([n.update(body), n.final()]).toString('utf8')).toBe(plain);

  const e = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([e.update(plain, 'utf8'), e.final()]);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(e.getAuthTag());
  expect(Buffer.concat([d.update(sealed), d.final()]).toString('utf8')).toBe(plain);
});

it('rejects a wrong key instead of returning garbage', () => {
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const d = createDecipheriv('aes-256-gcm', nodeCrypto.randomBytes(32), iv);
  d.setAuthTag(c.getAuthTag());
  d.update(body);
  expect(() => d.final()).toThrow();
});
