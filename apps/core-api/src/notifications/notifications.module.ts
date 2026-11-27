import { Module, type DynamicModule } from '@nestjs/common';
import { IdentityService } from '../identity-tenant/identity.service.ts';
import { workflowRuntime } from '../workflow-definition/workflow-runtime.ts';
import { NotificationsController, NOTIFICATIONS_API } from './notifications.controller.ts';
import { NotificationsStore, type NotificationsApi } from './notifications.store.ts';

@Module({})
export class NotificationsModule {
  /** Same verified identity module; an unconfigured identity store is 503 PROVIDER_NOT_CONFIGURED, never a fake inbox. */
  static register(options: { identity: DynamicModule; api?: NotificationsApi }): DynamicModule {
    return { module: NotificationsModule, imports: [options.identity], controllers: [NotificationsController], providers: [
      { provide: NOTIFICATIONS_API, inject: [IdentityService], useFactory: (identity: IdentityService): NotificationsApi => {
        if (options.api) return options.api;
        const store = async () => new NotificationsStore(identity.configuredStore(), await workflowRuntime());
        return { list: async (...a) => (await store()).list(...a), unreadCount: async (...a) => (await store()).unreadCount(...a),
          markRead: async (...a) => (await store()).markRead(...a), markAllRead: async (...a) => (await store()).markAllRead(...a) };
      } },
    ] };
  }
}
