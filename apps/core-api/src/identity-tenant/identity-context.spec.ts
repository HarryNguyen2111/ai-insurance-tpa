import { randomBytes, randomUUID } from 'node:crypto';
import { IdentityContextCodec } from './identity-context.ts';
import { OidcVerifier } from './oidc-verifier.ts';
import { syntheticIssuer } from '../../test/fixtures/synthetic-issuer.ts';

describe('opaque server membership context', () => {
  let issuer: Awaited<ReturnType<typeof syntheticIssuer>>;
  beforeAll(async () => { issuer = await syntheticIssuer(); });
  afterAll(async () => { await issuer.close(); });
  it('binds context to exact verified identity/token and rejects tampering/key replacement', async () => {
    const verifier = new OidcVerifier(issuer.profile), codec = new IdentityContextCodec(randomBytes(32));
    const a = await verifier.verifyAuthorization(`Bearer ${await issuer.token('human-a')}`);
    const b = await verifier.verifyAuthorization(`Bearer ${await issuer.token('human-b')}`);
    const refreshed = await verifier.verifyAuthorization(`Bearer ${await issuer.token('human-a', { jti: randomUUID() })}`);
    const membership = randomUUID(), id = randomUUID(), token = codec.encode(a, membership, id);
    expect(codec.decode(a, token)).toEqual({ membershipId: membership, contextId: id });
    expect(codec.encode(a, membership, id)).toBe(token);
    expect(() => codec.decode(b, token)).toThrow();
    expect(() => codec.decode(refreshed, token)).toThrow();
    expect(() => codec.decode(a, 'x' + token.slice(1))).toThrow();
    expect(() => new IdentityContextCodec(randomBytes(32)).decode(a, token)).toThrow();
    expect(() => codec.decode({ ...a }, token)).toThrow();
    expect(() => codec.decode(a, membership)).toThrow();
  });
  it('requires a trusted 256-bit context key', () => { expect(() => new IdentityContextCodec(new Uint8Array(16))).toThrow(); });
});
