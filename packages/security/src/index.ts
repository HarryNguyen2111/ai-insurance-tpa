import { createCipheriv, createDecipheriv, createHash, createSecretKey, randomBytes, type KeyObject } from 'node:crypto';

export type PiiField = 'cccd' | 'phone' | 'bank_account';
export interface PiiContext {
  readonly tenantId: string;
  readonly recordId: string;
  readonly field: PiiField;
}
interface Envelope {
  version: 1;
  algorithm: 'AES-256-GCM';
  keyVersion: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const fields = new Set(['cccd', 'phone', 'bank_account']);
const envelopeKeys = ['algorithm', 'ciphertext', 'keyVersion', 'nonce', 'tag', 'version'];

/** No input, key material, OpenSSL cause or context is included in public errors. */
export class PiiCryptoError extends Error {
  constructor() { super('PII cryptographic operation rejected'); this.name = 'PiiCryptoError'; }
}
function reject(): never { throw new PiiCryptoError(); }
function decode(value: unknown, size?: number): Buffer {
  if (typeof value !== 'string' || !value || value.length > 8192) return reject();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (size !== undefined && bytes.length !== size)) return reject();
  return bytes;
}
function aad(context: PiiContext, keyVersion: string): Buffer {
  if (!context || typeof context.tenantId !== 'string' || typeof context.recordId !== 'string' || !identifier.test(context.tenantId) || !identifier.test(context.recordId) || !fields.has(context.field)) return reject();
  // Tuple encoding prevents delimiter ambiguities; envelope metadata is authenticated too.
  return Buffer.from(JSON.stringify(['tpa.pii', 1, 'AES-256-GCM', keyVersion, context.tenantId, context.recordId, context.field]));
}
function parse(serialized: string): Envelope {
  if (typeof serialized !== 'string' || serialized.length > 16384) return reject();
  const value = JSON.parse(serialized) as Envelope;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== envelopeKeys.join(',') ||
      value.version !== 1 || value.algorithm !== 'AES-256-GCM' ||
      typeof value.keyVersion !== 'string' || !identifier.test(value.keyVersion)) return reject();
  return value;
}

/** Exact twelve ASCII digits, including leading zeros. No implicit normalization. */
export function cccdLookupHash(cccd: string): string {
  if (typeof cccd !== 'string' || !/^[0-9]{12}$/.test(cccd)) return reject();
  return createHash('sha256').update(cccd, 'utf8').digest('hex');
}

/** Synthetic local development/test only. No production provider is implemented. */
export class PiiCryptoService {
  readonly #keys: ReadonlyMap<string, KeyObject>;
  readonly #active: string;
  private constructor(keys: Map<string, KeyObject>, active: string) {
    this.#keys = keys;
    this.#active = active;
  }

  static fromDevelopmentEnv(env: NodeJS.ProcessEnv): PiiCryptoService {
    try {
      if (!['development', 'test'].includes(env.NODE_ENV ?? '') || env.PII_DEV_KEYS_ENABLED !== 'true') return reject();
      const raw: unknown = JSON.parse(env.PII_DEV_KEYS_JSON ?? '');
      const active = env.PII_DEV_ACTIVE_KEY_VERSION;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !active || !identifier.test(active)) return reject();
      const entries = Object.entries(raw);
      if (!entries.length || entries.length > 16) return reject();
      const keys = new Map<string, KeyObject>();
      for (const [version, encoded] of entries) {
        if (!identifier.test(version)) return reject();
        const bytes = decode(encoded, 32);
        try { keys.set(version, createSecretKey(bytes)); } finally { bytes.fill(0); }
      }
      if (!keys.has(active)) return reject();
      return new PiiCryptoService(keys, active);
    } catch { return reject(); }
  }

  encrypt(plaintext: string, context: PiiContext): string {
    try {
      if (typeof plaintext !== 'string' || !plaintext || Buffer.byteLength(plaintext, 'utf8') > 4096) return reject();
      if (context.field === 'cccd') cccdLookupHash(plaintext);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.#keys.get(this.#active)!, nonce, { authTagLength: 16 });
      cipher.setAAD(aad(context, this.#active));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const envelope: Envelope = {
        version: 1, algorithm: 'AES-256-GCM', keyVersion: this.#active,
        nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
      };
      return JSON.stringify(envelope);
    } catch { return reject(); }
  }

  decrypt(serialized: string, context: PiiContext): string {
    try {
      const envelope = parse(serialized);
      const key = this.#keys.get(envelope.keyVersion);
      if (!key) return reject();
      const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.nonce, 12), { authTagLength: 16 });
      decipher.setAAD(aad(context, envelope.keyVersion));
      decipher.setAuthTag(decode(envelope.tag, 16));
      const pending = decipher.update(decode(envelope.ciphertext));
      try {
        const final = decipher.final(); // Never return unauthenticated update() output.
        return Buffer.concat([pending, final]).toString('utf8');
      } finally { pending.fill(0); }
    } catch { return reject(); }
  }

  /** Pure transformation: caller owns authorization, locking and atomic persistence. */
  reencrypt(serialized: string, context: PiiContext): string {
    return this.encrypt(this.decrypt(serialized, context), context);
  }
}
