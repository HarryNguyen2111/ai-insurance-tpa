import { OidcVerifier, assertVerifiedIdentity, identityHash } from './oidc-verifier.ts';
import { syntheticIssuer } from '../../test/fixtures/synthetic-issuer.ts';

describe('AUTH-01 synthetic issuer conformance (not real-provider acceptance)', () => {
  let issuer: Awaited<ReturnType<typeof syntheticIssuer>>;
  beforeAll(async () => { issuer = await syntheticIssuer(); });
  afterAll(async () => { await issuer.close(); });
  beforeEach(() => { issuer.state.mode = 'ok'; issuer.state.keys = [issuer.key1]; });
  it('verifies signed issuer/audience/expiry and derives identity without trusting role/tenant claims', async () => {
    const verifier = new OidcVerifier(issuer.profile);
    const result = await verifier.verifyAuthorization(`Bearer ${await issuer.token('synthetic-pii-marker', { roles: ['FINANCE'], tenantId: 'forged', email: 'marker@example.invalid' })}`);
    expect(result.identityHash).toBe(identityHash(issuer.profile.issuer, 'synthetic-pii-marker'));
    expect(result.mfaValidUntil).toBeGreaterThan(Date.now() / 1000);
    expect(JSON.stringify(result)).not.toMatch(/forged|FINANCE|marker@example|synthetic-pii/);
    expect(() => assertVerifiedIdentity(result)).not.toThrow();
    expect(() => assertVerifiedIdentity({ ...result })).toThrow();
    expect(issuer.state.authorizationForwarded).toBe(false);
  });
  it.each([
    { aud: 'other-api' }, { iss: 'https://untrusted.invalid' }, { exp: 1 }, { exp: undefined }, { iat: undefined },
    { iat: Math.floor(Date.now() / 1000) + 100 }, { nbf: Math.floor(Date.now() / 1000) + 100 }, { sub: '' },
  ])('rejects missing/expired/mismatched claims %#', async claims => {
    const verifier = new OidcVerifier(issuer.profile);
    await expect(verifier.verifyAuthorization(`Bearer ${await issuer.token('subject', claims)}`)).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });
  it.each([undefined, '', 'Bearer x', ['Bearer abc'], 'Bearer a.b.c, Bearer a.b.c', 'Bearer ' + 'x'.repeat(8201)])('rejects malformed bearer input %#', async value => {
    await expect(new OidcVerifier(issuer.profile).verifyAuthorization(value)).rejects.toMatchObject({ status: 401 });
  });
  it.each([{ typ: 'JWT' }, { jku: 'https://untrusted.invalid/keys' }, { jwk: { kty: 'oct', k: 'forged' } }, { crit: ['custom'], custom: true }])('rejects ID-token confusion and token-directed key sources %#', async header => {
    const before = issuer.state.hits;
    await expect(new OidcVerifier(issuer.profile).verifyAuthorization(`Bearer ${await issuer.token('subject', {}, header)}`)).rejects.toMatchObject({ status: 401 });
    expect(issuer.state.hits).toBe(before);
  });
  it('rejects unsigned/HS256 and invalid signatures', async () => {
    const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'at+jwt', kid: 'first' })).toString('base64url');
    await expect(new OidcVerifier(issuer.profile).verifyAuthorization(`Bearer ${head}.e30.Zm9yZ2Vk`)).rejects.toMatchObject({ status: 401 });
    const token = await issuer.token('subject', {}, { kid: 'first' }, true);
    await expect(new OidcVerifier(issuer.profile).verifyAuthorization(`Bearer ${token}`)).rejects.toMatchObject({ status: 401 });
  });
  it.each([{ acr: 'unknown' }, { amr: ['pwd'] }, { auth_time: undefined }, { auth_time: Math.floor(Date.now() / 1000) - 301 }, { auth_time: Math.floor(Date.now() / 1000) + 100 }])('does not infer MFA from weak/missing/stale proof %#', async claims => {
    const result = await new OidcVerifier(issuer.profile).verifyAuthorization(`Bearer ${await issuer.token('subject', claims)}`);
    expect(result.mfaValidUntil).toBe(0);
  });
  it('refreshes on rotation and stops accepting a removed key after bounded cache expiry', async () => {
    let clock = Date.now(); const verifier = new OidcVerifier(issuer.profile, () => clock);
    const old = `Bearer ${await issuer.token()}`;
    await verifier.verifyAuthorization(old);
    issuer.state.keys = [issuer.key1, issuer.key2]; clock += 1001;
    await verifier.verifyAuthorization(`Bearer ${await issuer.token('subject', {}, {}, true)}`);
    issuer.state.keys = [issuer.key2];
    clock += issuer.profile.jwksCacheMs + 1;
    await expect(verifier.verifyAuthorization(old)).rejects.toMatchObject({ status: 401 });
  });
  it.each(['error', 'redirect', 'malformed', 'oversize', 'hang'])('fails closed on JWKS %s after expiry; recovery fetch is explicit', async mode => {
    let clock = Date.now(); const verifier = new OidcVerifier(issuer.profile, () => clock);
    const token = `Bearer ${await issuer.token()}`; await verifier.verifyAuthorization(token);
    issuer.state.mode = mode; clock += issuer.profile.jwksCacheMs + 1;
    await expect(verifier.verifyAuthorization(token)).rejects.toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
    issuer.state.mode = 'ok'; clock += 1001;
    await expect(verifier.verifyAuthorization(token)).resolves.toHaveProperty('identityHash');
  });
  it('deduplicates concurrent JWKS fetches', async () => {
    const verifier = new OidcVerifier(issuer.profile), token = `Bearer ${await issuer.token()}`, before = issuer.state.hits;
    await Promise.all(Array.from({ length: 8 }, () => verifier.verifyAuthorization(token)));
    expect(issuer.state.hits - before).toBe(1);
  });
  it('default composition is provider-disabled; loopback profile cannot be used in production', async () => {
    await expect(new OidcVerifier().verifyAuthorization(`Bearer ${await issuer.token()}`)).rejects.toMatchObject({ status: 503, code: 'PROVIDER_NOT_CONFIGURED' });
    const old = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    try { expect(() => new OidcVerifier(issuer.profile)).toThrow('Invalid trusted OIDC profile'); }
    finally { process.env.NODE_ENV = old; }
  });
});
