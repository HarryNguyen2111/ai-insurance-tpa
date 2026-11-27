import { Module, type DynamicModule } from '@nestjs/common';
import { IdentityController } from './identity.controller.ts';
import { IdentityService } from './identity.service.ts';
import { VerifiedIdentityGuard } from './identity.guard.ts';
import { IdentityExceptionFilter } from './identity.filter.ts';
import { OidcVerifier } from './oidc-verifier.ts';
import type { IdentityStore } from './identity-store.ts';

@Module({})
export class IdentityTenantModule {
  /** Approved provider integration supplies trusted options. No provider is silently enabled by environment. */
  static register(options: { verifier?: OidcVerifier; store?: IdentityStore } = {}): DynamicModule {
    return { module: IdentityTenantModule, controllers: [IdentityController], providers: [
      { provide: IdentityService, useValue: new IdentityService(options.verifier ?? new OidcVerifier(), options.store) },
      VerifiedIdentityGuard, IdentityExceptionFilter,
    ], exports: [IdentityService, VerifiedIdentityGuard] };
  }
}
