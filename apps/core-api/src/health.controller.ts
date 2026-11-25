import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  // Process liveness only; no dependency or platform readiness assertion.
  @Get()
  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
