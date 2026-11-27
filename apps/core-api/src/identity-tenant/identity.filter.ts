import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityError } from './identity-error.ts';

@Catch()
export class IdentityExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const safe = error instanceof IdentityError ? error : new IdentityError(503, 'DEPENDENCY_UNAVAILABLE');
    host.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store');
    host.switchToHttp().getResponse<Response>().status(safe.status).json({ code: safe.code, messageVi: safe.message, correlationId: randomUUID() });
  }
}
