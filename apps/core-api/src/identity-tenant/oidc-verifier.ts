import { createHash } from 'node:crypto';
import type { createLocalJWKSet, JSONWebKeySet } from 'jose';
import { IdentityError, unavailable } from './identity-error.ts';

/** Trusted composition-root input; never populate any field from a request/token. */
export interface OidcProfile {
  issuer: string; audience: string; jwksUri: string; algorithms: readonly ('RS256' | 'ES256')[];
  mfaAcrValues: readonly string[]; mfaAmrValues: readonly string[]; mfaMaxAgeSeconds: number;
  maxTokenAgeSeconds: number; jwksCacheMs: number;
  /** Synthetic conformance only, forbidden by the verifier in NODE_ENV=production. */
  allowLoopbackHttp?: boolean;
  fetchTimeoutMs?: number;
}
const verified = new WeakSet<object>();
export interface VerifiedIdentity {
  readonly identityHash: string; readonly tokenHash: string; readonly expiresAt: number; readonly mfaValidUntil: number;
}
export function assertVerifiedIdentity(value: VerifiedIdentity, now = Date.now()): void {
  if (!value || !verified.has(value) || value.expiresAt * 1000 <= now) throw new IdentityError(401, 'UNAUTHENTICATED');
}
export const identityHash = (issuer: string, subject: string) => createHash('sha256').update(JSON.stringify([issuer, subject])).digest('hex');
const unauthenticated = () => new IdentityError(401, 'UNAUTHENTICATED');
const bounded = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
type Resolver = ReturnType<typeof createLocalJWKSet>;

export class OidcVerifier {
  private readonly profile?: Readonly<OidcProfile>;
  private readonly now: () => number;
  private cache?: { resolver: Resolver; expires: number };
  private inFlight?: Promise<Resolver>;
  private nextRefresh = 0;
  constructor(profile?: OidcProfile, now: () => number = Date.now) {
    this.now = now;
    if (profile) {
      const p = structuredClone(profile), issuer = new URL(p.issuer), jwks = new URL(p.jwksUri);
      const validUrl = (url: URL) => !url.username && !url.password && !url.hash && !url.search;
      const secure = issuer.protocol === 'https:' && jwks.protocol === 'https:';
      const synthetic = p.allowLoopbackHttp && process.env.NODE_ENV !== 'production' && issuer.protocol === 'http:' && jwks.protocol === 'http:'
        && ['127.0.0.1', '[::1]'].includes(issuer.hostname) && issuer.origin === jwks.origin;
      if ((!secure && !synthetic) || !validUrl(issuer) || !validUrl(jwks) || !p.audience || p.audience.length > 200
        || !p.algorithms.length || p.algorithms.some(a => !['RS256', 'ES256'].includes(a))
        || !p.mfaAcrValues.length || !p.mfaAmrValues.length || [...p.mfaAcrValues, ...p.mfaAmrValues].some(s => !s || s.length > 128)
        || !bounded(p.mfaMaxAgeSeconds, 1, 3600) || !bounded(p.maxTokenAgeSeconds, 60, 3600)
        || !bounded(p.jwksCacheMs, 1, 60000) || !bounded(p.fetchTimeoutMs ?? 3000, 1, 5000)) throw new Error('Invalid trusted OIDC profile');
      this.profile = Object.freeze(p);
    }
  }
  async verifyAuthorization(header: unknown): Promise<VerifiedIdentity> {
    if (typeof header !== 'string' || header.length > 8200 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header)) throw unauthenticated();
    if (!this.profile) throw new IdentityError(503, 'PROVIDER_NOT_CONFIGURED');
    const p = this.profile, token = header.slice(7), jose = await import('jose');
    try {
      const header = jose.decodeProtectedHeader(token);
      if (Object.keys(header).some(k => !['alg', 'typ', 'kid'].includes(k)) || header.typ !== 'at+jwt'
        || !p.algorithms.includes(header.alg as 'RS256' | 'ES256') || typeof header.kid !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(header.kid)) throw unauthenticated();
      const verify = (resolver: Resolver) => jose.jwtVerify(token, resolver, {
        issuer: p.issuer, audience: p.audience, algorithms: [...p.algorithms], typ: 'at+jwt',
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp'], maxTokenAge: p.maxTokenAgeSeconds,
        clockTolerance: 0, currentDate: new Date(this.now()),
      });
      let result;
      try { result = await verify(await this.loadKeys()); }
      catch (error) {
        const code = (error as { code?: string }).code;
        if (!['ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'].includes(code ?? '')) throw error;
        result = await verify(await this.loadKeys(true));
      }
      const claims = result.payload, now = this.now() / 1000;
      if (typeof claims.sub !== 'string' || !claims.sub.length || claims.sub.length > 256 || /[\u0000-\u001f\u007f]/.test(claims.sub)
        || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat) || claims.iat! > now || claims.exp! <= claims.iat!) throw unauthenticated();
      const amr = claims.amr;
      const mfa = typeof claims.acr === 'string' && p.mfaAcrValues.includes(claims.acr) && Array.isArray(amr)
        && amr.length <= 10 && amr.every(v => typeof v === 'string' && v.length <= 128)
        && p.mfaAmrValues.every(v => amr.includes(v)) && typeof claims.auth_time === 'number'
        && Number.isSafeInteger(claims.auth_time) && claims.auth_time <= claims.iat! && claims.auth_time <= now
        && claims.auth_time + p.mfaMaxAgeSeconds > now;
      const identity: VerifiedIdentity = Object.freeze({ identityHash: identityHash(p.issuer, claims.sub),
        tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: Math.min(claims.exp!, claims.iat! + p.maxTokenAgeSeconds),
        mfaValidUntil: mfa ? (claims.auth_time as number) + p.mfaMaxAgeSeconds : 0 });
      verified.add(identity);
      return identity;
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      throw unauthenticated();
    }
  }
  private async loadKeys(force = false): Promise<Resolver> {
    const now = this.now(), p = this.profile!;
    if (!force && this.cache && now < this.cache.expires) return this.cache.resolver;
    if (this.inFlight) return this.inFlight;
    if (now < this.nextRefresh) { if (this.cache && now < this.cache.expires) return this.cache.resolver; throw unavailable(); }
    this.nextRefresh = now + 1000;
    this.inFlight = (async () => {
      try {
        const response = await fetch(p.jwksUri, { redirect: 'error', signal: AbortSignal.timeout(p.fetchTimeoutMs ?? 3000), headers: { Accept: 'application/json' } });
        if (!response.ok || !response.body) throw unavailable();
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.length; if (size > 65536) { await reader.cancel(); throw unavailable(); } chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).join() !== 'keys') throw unavailable();
        const keys = (data as JSONWebKeySet).keys;
        if (!Array.isArray(keys) || !keys.length || keys.length > 10) throw unavailable();
        const kids = new Set<string>();
        for (const key of keys) {
          if (!key || Object.keys(key).some(k => !['kty', 'kid', 'alg', 'use', 'key_ops', 'n', 'e', 'crv', 'x', 'y'].includes(k))
            || typeof key.kid !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key.kid) || kids.has(key.kid)
            || !['RSA', 'EC'].includes(key.kty ?? '') || !p.algorithms.includes(key.alg as 'RS256' | 'ES256') || key.use !== 'sig'
            || (key.key_ops && (key.key_ops.length !== 1 || key.key_ops[0] !== 'verify'))) throw unavailable();
          kids.add(key.kid);
        }
        const resolver = (await import('jose')).createLocalJWKSet(data as JSONWebKeySet);
        this.cache = { resolver, expires: this.now() + p.jwksCacheMs };
        return resolver;
      } catch { this.cache = undefined; throw unavailable(); }
      finally { this.inFlight = undefined; }
    })();
    return this.inFlight;
  }
}
