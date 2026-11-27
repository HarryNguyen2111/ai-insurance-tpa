import { Module, type DynamicModule } from '@nestjs/common';
import { IdentityService } from '../identity-tenant/identity.service.ts';
import { IdentityError } from '../identity-tenant/identity-error.ts';
import { workflowRuntime } from '../workflow-definition/workflow-runtime.ts';
import { DocumentsController, DOCUMENTS_API } from './documents.controller.ts';
import { DocumentsStore, type DocumentsApi } from './documents.store.ts';
import type { DocumentStorage } from './storage.ts';
@Module({})
export class DocumentsModule {
  /** Same verified identity module. No storage/provider/purpose is silently approved by environment. */
  static register(options: { identity: DynamicModule; storage?: DocumentStorage; uploadPurpose?: string; api?: DocumentsApi }): DynamicModule {
    return { module: DocumentsModule, imports: [options.identity], controllers: [DocumentsController], providers: [
      { provide: DOCUMENTS_API, inject: [IdentityService], useFactory: (identity: IdentityService): DocumentsApi => {
        if (options.api) return options.api;
        const store = async () => {
          const identities = identity.configuredStore();
          if (!options.storage || !options.uploadPurpose) throw new IdentityError(503, 'PROVIDER_NOT_CONFIGURED');
          return new DocumentsStore(identities, await workflowRuntime(), options.storage, options.uploadPurpose);
        };
        return { consent: async (...a) => (await store()).consent(...a), presign: async (...a) => (await store()).presign(...a),
          complete: async (...a) => (await store()).complete(...a), get: async (...a) => (await store()).get(...a) };
      } },
    ] };
  }
}
