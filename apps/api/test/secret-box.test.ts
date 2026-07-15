// Authenticated-encryption secret box: round-trip, unique nonce per write, tamper detection,
// wrong-key rejection, and fail-closed master-key loading. Errors never carry secret material.
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretBox, SecretBoxError, loadMasterKey } from '../src/security/secret-box.js';

const key = () => randomBytes(32);

describe('SecretBox', () => {
  it('round-trips a secret', () => {
    const box = new SecretBox(key());
    const sealed = box.seal('super-secret-token');
    expect(box.open(sealed)).toBe('super-secret-token');
  });

  it('uses a unique nonce per write (same plaintext → different ciphertext)', () => {
    const box = new SecretBox(key());
    const a = box.seal('same');
    const b = box.seal('same');
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(box.open(a)).toBe('same');
    expect(box.open(b)).toBe('same');
  });

  it('rejects a tampered ciphertext (auth tag fails)', () => {
    const box = new SecretBox(key());
    const sealed = box.seal('token');
    sealed.ciphertext[0] ^= 0xff;
    expect(() => box.open(sealed)).toThrow(SecretBoxError);
  });

  it('rejects a tampered tag', () => {
    const box = new SecretBox(key());
    const sealed = box.seal('token');
    sealed.tag[0] ^= 0xff;
    expect(() => box.open(sealed)).toThrow(SecretBoxError);
  });

  it('cannot decrypt with a different key', () => {
    const sealed = new SecretBox(key()).seal('token');
    expect(() => new SecretBox(key()).open(sealed)).toThrow(SecretBoxError);
  });

  it('an error never contains the plaintext or ciphertext', () => {
    const box = new SecretBox(key());
    const sealed = box.seal('PLAINTEXT-SECRET');
    sealed.tag[0] ^= 0xff;
    try {
      box.open(sealed);
      expect.unreachable();
    } catch (e) {
      const s = String((e as Error).message) + JSON.stringify(e);
      expect(s).not.toContain('PLAINTEXT-SECRET');
      expect(s).not.toContain(sealed.ciphertext.toString('hex'));
    }
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => new SecretBox(randomBytes(16))).toThrow(SecretBoxError);
  });
});

describe('loadMasterKey — fail closed', () => {
  it('returns null when the secret file is absent', () => {
    expect(loadMasterKey(join(tmpdir(), 'definitely-absent-radar-key'))).toBeNull();
  });

  it('loads a hex key and a base64 key to 32 bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-key-'));
    const raw = randomBytes(32);
    const hexPath = join(dir, 'hex');
    writeFileSync(hexPath, raw.toString('hex'));
    const b64Path = join(dir, 'b64');
    writeFileSync(b64Path, raw.toString('base64'));
    expect(loadMasterKey(hexPath)?.equals(raw)).toBe(true);
    expect(loadMasterKey(b64Path)?.equals(raw)).toBe(true);
  });

  it('derives a 32-byte key from a passphrase and refuses an empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-key-'));
    const pass = join(dir, 'pass');
    writeFileSync(pass, 'a-sufficiently-long-passphrase');
    expect(loadMasterKey(pass)?.length).toBe(32);
    const empty = join(dir, 'empty');
    writeFileSync(empty, '   ');
    expect(loadMasterKey(empty)).toBeNull();
  });
});
