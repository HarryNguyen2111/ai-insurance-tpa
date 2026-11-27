import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { IdentityStore } from './identity-store.ts';
import { OidcVerifier, type VerifiedIdentity } from './oidc-verifier.ts';
import { IdentityError } from './identity-error.ts';

@Injectable()
export class IdentityService implements OnApplicationShutdown {
  readonly verifier: OidcVerifier;
  readonly store?: IdentityStore;
  constructor(verifier: OidcVerifier, store?: IdentityStore) { this.verifier = verifier; this.store = store; }
  verify(header: unknown): Promise<VerifiedIdentity> { return this.verifier.verifyAuthorization(header); }
  configuredStore(): IdentityStore {
    if (!this.store) throw new IdentityError(503, 'PROVIDER_NOT_CONFIGURED');
    return this.store;
  }
  async onApplicationShutdown(): Promise<void> { await this.store?.close(); }
}
