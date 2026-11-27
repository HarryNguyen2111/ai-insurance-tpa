import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { IdentityTenantModule } from './identity-tenant/identity.module';

@Module({ imports: [IdentityTenantModule.register()], controllers: [HealthController] })
export class AppModule {}
