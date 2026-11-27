import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { IdentityError } from './identity-error.ts';
import { assertVerifiedIdentity, type VerifiedIdentity } from './oidc-verifier.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Clients treat this as opaque. MAC binds the random server context to one verified access token. */
export class IdentityContextCodec {
  private readonly key: Buffer;
  constructor(key: Uint8Array) { if (key.length !== 32) throw new Error('A trusted context key is required'); this.key = Buffer.from(key); }
  createId(): string { return randomUUID(); }
  encode(identity: VerifiedIdentity, membershipId: string, contextId: string): string {
    assertVerifiedIdentity(identity);
    if (!UUID.test(membershipId) || !UUID.test(contextId)) throw new IdentityError(403, 'FORBIDDEN');
    const body = Buffer.from(JSON.stringify([membershipId, contextId])).toString('base64url');
    return `${body}.${this.mac(identity, body).toString('base64url')}`;
  }
  decode(identity: VerifiedIdentity, token: unknown): { membershipId: string; contextId: string } {
    assertVerifiedIdentity(identity);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{90,200}\.[A-Za-z0-9_-]{43}$/.test(token)) throw new IdentityError(403, 'FORBIDDEN');
    const [body, raw] = token.split('.'), mac = Buffer.from(raw, 'base64url'), expected = this.mac(identity, body);
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) throw new IdentityError(403, 'FORBIDDEN');
    let data: unknown;
    try { data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new IdentityError(403, 'FORBIDDEN'); }
    if (!Array.isArray(data) || data.length !== 2 || !data.every(v => typeof v === 'string' && UUID.test(v))) throw new IdentityError(403, 'FORBIDDEN');
    return { membershipId: data[0], contextId: data[1] };
  }
  private mac(identity: VerifiedIdentity, body: string): Buffer {
    return createHmac('sha256', this.key).update(JSON.stringify(['membership-context-v1', body, identity.identityHash, identity.tokenHash])).digest();
  }
}
