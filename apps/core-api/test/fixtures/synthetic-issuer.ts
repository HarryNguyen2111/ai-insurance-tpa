import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OidcProfile } from '../../src/identity-tenant/oidc-verifier.ts';

/** Test-only issuer. Never imported by application/runtime source. */
export async function syntheticIssuer() {
  const jose = await import('jose');
  const first = await jose.generateKeyPair('ES256'), second = await jose.generateKeyPair('ES256');
  const key1 = { ...await jose.exportJWK(first.publicKey), kid: 'first', alg: 'ES256', use: 'sig' };
  const key2 = { ...await jose.exportJWK(second.publicKey), kid: 'second', alg: 'ES256', use: 'sig' };
  const state = { keys: [key1], mode: 'ok', hits: 0, authorizationForwarded: false };
  const server = createServer((req, res) => {
    state.hits++; state.authorizationForwarded ||= req.headers.authorization !== undefined;
    if (state.mode === 'hang') return;
    if (state.mode === 'error') { res.writeHead(503).end(); return; }
    if (state.mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/forbidden' }).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(state.mode === 'oversize' ? 'x'.repeat(65537) : state.mode === 'malformed' ? '{' : JSON.stringify({ keys: state.keys }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const profile: OidcProfile = { issuer, audience: 'tpa-synthetic-api', jwksUri: `${issuer}/jwks`, algorithms: ['ES256'],
    mfaAcrValues: ['urn:synthetic:mfa'], mfaAmrValues: ['mfa'], mfaMaxAgeSeconds: 300,
    maxTokenAgeSeconds: 900, jwksCacheMs: 10000, allowLoopbackHttp: true, fetchTimeoutMs: 500 };
  return { state, profile, key1, key2,
    async token(subject = 'synthetic-human', claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, useSecondKey = false) {
      const now = Math.floor(Date.now() / 1000);
      return new jose.SignJWT({ sub: subject, iss: issuer, aud: profile.audience, iat: now, exp: now + 600,
        acr: 'urn:synthetic:mfa', amr: ['pwd', 'mfa'], auth_time: now, ...claims })
        .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: useSecondKey ? 'second' : 'first', ...header })
        // Declare test-only crit extensions to the signer so the VERIFIER's rejection is what is exercised.
        .sign(useSecondKey ? second.privateKey : first.privateKey,
          Array.isArray(header.crit) ? { crit: Object.fromEntries((header.crit as string[]).map(name => [name, true])) } : undefined);
    },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
