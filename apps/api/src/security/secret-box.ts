// Authenticated encryption for secrets persisted in Postgres (currently the CloudVision
// service-account token). AES-256-GCM with a unique random nonce per write and an
// authentication tag (tamper-evident). The master key is supplied ONLY at runtime via the
// mounted secret /run/secrets/radar_master_key — never from env, never from the database, so
// a database backup contains ciphertext alone. All operations FAIL CLOSED when the key is
// missing or invalid. Errors and this module NEVER include plaintext or ciphertext.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const MASTER_KEY_FILE = '/run/secrets/radar_master_key';
const ALGO = 'aes-256-gcm';
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

/** A sealed secret. Opaque: the three parts are meaningless without the master key. */
export interface SealedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

/** Safe error — its message never contains secret material. */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/** Derive a 32-byte key from the mounted secret's contents: a 64-char hex or base64-encoded
 *  32-byte key is used directly; any other sufficiently-long passphrase is hashed to 32 bytes.
 *  Returns null (→ fail closed) if the material is too weak to use. */
function deriveKey(raw: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = tryBase64(raw);
  if (b64 && b64.length === KEY_BYTES) return b64;
  if (Buffer.byteLength(raw, 'utf8') >= 16) return createHash('sha256').update(raw, 'utf8').digest();
  return null;
}

function tryBase64(raw: string): Buffer | null {
  if (!/^[A-Za-z0-9+/=]+$/.test(raw)) return null;
  try {
    const b = Buffer.from(raw, 'base64');
    return b.length > 0 ? b : null;
  } catch {
    return null;
  }
}

/** Load the master key from the mounted secret. Returns null when absent/unreadable/invalid
 *  — callers must then refuse to store or read encrypted secrets (fail closed). The key
 *  bytes are never logged. */
export function loadMasterKey(path: string = MASTER_KEY_FILE): Buffer | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8').trim();
    if (raw.length === 0) return null;
    return deriveKey(raw);
  } catch {
    return null;
  }
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) throw new SecretBoxError('Master key must derive to 32 bytes.');
    this.key = key;
  }

  /** Build a SecretBox from the mounted master key, or null when it is unavailable/invalid. */
  static fromMasterKey(path?: string): SecretBox | null {
    const key = loadMasterKey(path);
    return key ? new SecretBox(key) : null;
  }

  /** Encrypt a plaintext secret with a fresh random nonce. */
  seal(plaintext: string): SealedSecret {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGO, this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext, nonce, tag };
  }

  /** Decrypt a sealed secret. Throws SecretBoxError (with no secret material) if the key is
   *  wrong or the ciphertext/tag was tampered with. */
  open(sealed: SealedSecret): string {
    try {
      const decipher = createDecipheriv(ALGO, this.key, sealed.nonce);
      decipher.setAuthTag(sealed.tag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretBoxError('Unable to decrypt secret (missing/invalid key or tampered ciphertext).');
    }
  }

  /** Whether this box's key equals another's (constant-time). Used only to detect a master-key
   *  change during rotation; never exposes key bytes. */
  sameKeyAs(other: SecretBox): boolean {
    return this.key.length === other.key.length && timingSafeEqual(this.key, other.key);
  }
}
