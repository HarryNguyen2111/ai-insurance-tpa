import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { IdentityService } from './identity.service.ts';
import { IdentityError } from './identity-error.ts';
import type { VerifiedIdentity } from './oidc-verifier.ts';

export interface IdentityRequest extends Request { verifiedIdentity: VerifiedIdentity }
export function singleHeader(request: Request, name: string): string | undefined {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === name) count++;
  if (count > 1) return undefined;
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}
@Injectable()
export class VerifiedIdentityGuard implements CanActivate {
  constructor(private readonly identity: IdentityService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    // Client tenant assertions are never used to select scope.
    if (request.headers['x-tenant-id'] !== undefined) throw new IdentityError(403, 'FORBIDDEN');
    request.verifiedIdentity = await this.identity.verify(singleHeader(request, 'authorization'));
    return true;
  }
}
