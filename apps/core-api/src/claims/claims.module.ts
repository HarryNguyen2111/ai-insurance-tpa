import { Module, type DynamicModule } from '@nestjs/common';
import { IdentityService } from '../identity-tenant/identity.service.ts';
import { workflowRuntime } from '../workflow-definition/workflow-runtime.ts';
import { notConfigured } from './claim-error.ts';
import { ClaimsController, CLAIMS_API } from './claims.controller.ts';
import { ClaimsStore, type ClaimsApi } from './claims.store.ts';
import type { ClaimPreflightGate } from './preflight-gate.ts';
@Module({})
export class ClaimsModule {
  /** Same verified identity module. No purpose or preflight gate is silently approved by environment: unconfigured is 503. */
  static register(options: { identity: DynamicModule; claimPurpose?: string; documentPurpose?: string; preflight?: ClaimPreflightGate; api?: ClaimsApi }): DynamicModule {
    return { module: ClaimsModule, imports: [options.identity], controllers: [ClaimsController], providers: [
      { provide: CLAIMS_API, inject: [IdentityService], useFactory: (identity: IdentityService): ClaimsApi => {
        if (options.api) return options.api;
        const store = async () => {
          const identities = identity.configuredStore();
          if (!options.claimPurpose || !options.documentPurpose || !options.preflight) throw notConfigured();
          return new ClaimsStore(identities, await workflowRuntime(),
            { claimPurpose: options.claimPurpose, documentPurpose: options.documentPurpose, preflight: options.preflight });
        };
        return { submit: async (...a) => (await store()).submit(...a), list: async (...a) => (await store()).list(...a),
          get: async (...a) => (await store()).get(...a), supplement: async (...a) => (await store()).supplement(...a) };
      } },
    ] };
  }
}
