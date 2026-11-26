import assert from 'node:assert/strict';
import { createHash, randomBytes, createCipheriv } from 'node:crypto';
import test from 'node:test';
import { PiiCryptoService, PiiCryptoError, cccdLookupHash, type PiiContext } from '../src/index.ts';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');
const context: PiiContext = { tenantId: 'tenant-a', recordId: 'member-a', field: 'cccd' };
const cccd = '000123456789';
function env(keys: Record<string, string> = { old: k1 }, active = 'old'): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', PII_DEV_KEYS_ENABLED: 'true', PII_DEV_KEYS_JSON: JSON.stringify(keys), PII_DEV_ACTIVE_KEY_VERSION: active };
}
const service = PiiCryptoService.fromDevelopmentEnv(env());
const rejected = (fn: () => unknown) => assert.throws(fn, { name: 'PiiCryptoError', message: 'PII cryptographic operation rejected' });

test('authenticated versioned round trips all fields with independent random nonces', () => {
  for (const [field, value] of [['cccd', cccd], ['phone', '+84-SYNTHETIC-PHONE'], ['bank_account', 'SYNTHETIC-BANK-00001']] as const) {
    const ctx = { ...context, field };
    const ciphertext = service.encrypt(value, ctx);
    assert.equal(service.decrypt(ciphertext, ctx), value);
    assert.equal(ciphertext.includes(value), false);
    const envelope = JSON.parse(ciphertext);
    assert.equal(envelope.version, 1);
    assert.equal(envelope.algorithm, 'AES-256-GCM');
    assert.equal(envelope.keyVersion, 'old');
    assert.equal(Buffer.from(envelope.nonce, 'base64').length, 12);
    assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);
    assert.notEqual(ciphertext, service.encrypt(value, ctx));
  }
  const nonces = new Set(Array.from({ length: 256 }, () => JSON.parse(service.encrypt(cccd, context)).nonce));
  assert.equal(nonces.size, 256);
});

test('independent Node GCM implementation verifies exact authenticated tuple', () => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(k1, 'base64'), nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(['tpa.pii', 1, 'AES-256-GCM', 'old', 'tenant-a', 'member-a', 'cccd'])));
  const ciphertext = Buffer.concat([cipher.update(cccd), cipher.final()]);
  const envelope = JSON.stringify({ version: 1, algorithm: 'AES-256-GCM', keyVersion: 'old', nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
  assert.equal(service.decrypt(envelope, context), cccd);
});

test('every authenticated component rejects tampering, short tags and wrong keys', () => {
  const original = JSON.parse(service.encrypt(cccd, context));
  for (const field of ['nonce', 'ciphertext', 'tag']) {
    const bytes = Buffer.from(original[field], 'base64');
    bytes[0] ^= 1;
    rejected(() => service.decrypt(JSON.stringify({ ...original, [field]: bytes.toString('base64') }), context));
  }
  for (const patch of [{ version: 2 }, { algorithm: 'AES-128-GCM' }, { keyVersion: 'missing' }, { tag: Buffer.alloc(8).toString('base64') }, { extra: 'ignored?' }, { nonce: '!!!' }, { ciphertext: '' }]) {
    rejected(() => service.decrypt(JSON.stringify({ ...original, ...patch }), context));
  }
  const wrong = PiiCryptoService.fromDevelopmentEnv(env({ old: k2 }));
  rejected(() => wrong.decrypt(JSON.stringify(original), context));
  // Even an alias for the same key cannot replace an authenticated key version.
  const alias = PiiCryptoService.fromDevelopmentEnv(env({ old: k1, alias: k1 }));
  rejected(() => alias.decrypt(JSON.stringify({ ...original, keyVersion: 'alias' }), context));
});

test('tenant, record, field swaps and missing/ambiguous contexts are rejected', () => {
  const envelope = service.encrypt(cccd, context);
  for (const ctx of [{ ...context, tenantId: 'tenant-b' }, { ...context, recordId: 'member-b' }, { ...context, field: 'phone' as const }]) {
    rejected(() => service.decrypt(envelope, ctx));
  }
  for (const ctx of [{ ...context, tenantId: '' }, { ...context, tenantId: undefined }, { ...context, recordId: undefined }, { ...context, field: 'other' }, { ...context, recordId: 'a|b' }, null]) {
    rejected(() => service.encrypt(cccd, ctx as PiiContext));
    rejected(() => service.decrypt(envelope, ctx as PiiContext));
  }
});

test('old/new dual reads, new writes and re-encryption preserve exact lookup across key retirement', () => {
  const oldEnvelope = service.encrypt(cccd, context);
  const rotating = PiiCryptoService.fromDevelopmentEnv(env({ old: k1, next: k2 }, 'next'));
  assert.equal(rotating.decrypt(oldEnvelope, context), cccd);
  const migrated = rotating.reencrypt(oldEnvelope, context);
  assert.equal(JSON.parse(migrated).keyVersion, 'next');
  assert.equal(JSON.parse(rotating.encrypt(cccd, context)).keyVersion, 'next');
  const retired = PiiCryptoService.fromDevelopmentEnv(env({ next: k2 }, 'next'));
  assert.equal(retired.decrypt(migrated, context), cccd);
  rejected(() => retired.decrypt(oldEnvelope, context));
  rejected(() => service.decrypt(migrated, context));
  assert.equal(cccdLookupHash(rotating.decrypt(oldEnvelope, context)), cccdLookupHash(retired.decrypt(migrated, context)));
  assert.equal(cccdLookupHash(cccd), createHash('sha256').update('000123456789').digest('hex'));
  for (const value of ['123456789', ' 000123456789', '000123456789 ', '０００１２３４５６７８９']) rejected(() => cccdLookupHash(value));
});

test('development configuration requires explicit opt-in, exact key size and a valid active version', () => {
  for (const patch of [{ NODE_ENV: 'production' }, { NODE_ENV: 'staging' }, { NODE_ENV: undefined }, { PII_DEV_KEYS_ENABLED: undefined }, { PII_DEV_KEYS_ENABLED: 'false' }, { PII_DEV_KEYS_JSON: undefined }, { PII_DEV_KEYS_JSON: '{SYNTHETIC-SECRET' }, { PII_DEV_ACTIVE_KEY_VERSION: 'missing' }, { PII_DEV_KEYS_JSON: JSON.stringify({ old: randomBytes(16).toString('base64') }) }, { PII_DEV_KEYS_JSON: JSON.stringify({ old: k1 + '\n' }) }, { PII_DEV_KEYS_JSON: '[]' }]) {
    rejected(() => PiiCryptoService.fromDevelopmentEnv({ ...env(), ...patch }));
  }
  assert.ok(PiiCryptoService.fromDevelopmentEnv({ ...env(), NODE_ENV: 'development' }));
});

test('malformed data and failure objects never echo plaintext, keys or supplied context', () => {
  const marker = 'SYNTHETIC-SECRET-MARKER';
  for (const input of [marker, 'null', '[]', '{}', '"' + marker + '"', 'x'.repeat(17000)]) {
    try { service.decrypt(input, context); assert.fail('must reject'); }
    catch (error) {
      assert.ok(error instanceof PiiCryptoError);
      assert.equal(String(error).includes(marker), false);
      assert.equal(String(error).includes(k1), false);
      assert.equal('cause' in error, false);
    }
  }
  rejected(() => service.encrypt('', context));
  rejected(() => service.encrypt('x'.repeat(4097), { ...context, field: 'phone' }));
});
