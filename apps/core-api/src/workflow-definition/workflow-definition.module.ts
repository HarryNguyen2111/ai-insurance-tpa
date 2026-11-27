import { Module, type DynamicModule } from '@nestjs/common';
import { IdentityService } from '../identity-tenant/identity.service.ts';
import { WorkflowDefinitionController, WORKFLOW_DEFINITION_API } from './workflow-definition.controller.ts';
import { WorkflowDefinitionStore, type WorkflowDefinitionApi } from './workflow-definition.store.ts';
import { workflowRuntime } from './workflow-runtime.ts';

/** Resolves the store per call so an unconfigured identity provider stays 503 PROVIDER_NOT_CONFIGURED. */
function lazyApi(identity: IdentityService): WorkflowDefinitionApi {
  const store = async () => new WorkflowDefinitionStore(identity.configuredStore(), await workflowRuntime());
  const methods = ['list', 'listVersions', 'get', 'create', 'update', 'validate', 'publish', 'revoke', 'catalog'] as const;
  // Explicit method map (not a Proxy): Nest awaits factory results, so no `then` member may exist.
  return Object.freeze(Object.fromEntries(methods.map(m => [m, async (...args: unknown[]) =>
    ((await store())[m] as (...a: unknown[]) => unknown)(...args)]))) as unknown as WorkflowDefinitionApi;
}

@Module({})
export class WorkflowDefinitionModule {
  /** `identity` is the SAME dynamic module instance the app imports (shared IdentityService/guard). */
  static register(options: { identity: DynamicModule; api?: WorkflowDefinitionApi }): DynamicModule {
    return { module: WorkflowDefinitionModule, imports: [options.identity], controllers: [WorkflowDefinitionController], providers: [
      { provide: WORKFLOW_DEFINITION_API, inject: [IdentityService], useFactory: (identity: IdentityService) => options.api ?? lazyApi(identity) },
    ] };
  }
}
