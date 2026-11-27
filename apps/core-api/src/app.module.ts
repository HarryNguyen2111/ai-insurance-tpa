import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { IdentityTenantModule } from './identity-tenant/identity.module';
import { WorkflowDefinitionModule } from './workflow-definition/workflow-definition.module';

import { DocumentsModule } from './documents-consents/documents.module';
import { ClaimsModule } from './claims/claims.module';
import { NotificationsModule } from './notifications/notifications.module';

const identity = IdentityTenantModule.register();
@Module({ imports: [identity, WorkflowDefinitionModule.register({ identity }), DocumentsModule.register({ identity }), ClaimsModule.register({ identity }), NotificationsModule.register({ identity })], controllers: [HealthController] })
export class AppModule {}
