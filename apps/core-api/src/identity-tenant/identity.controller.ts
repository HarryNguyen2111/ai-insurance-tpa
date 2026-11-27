import { Body, Controller, Get, Header, HttpCode, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { IdentityService } from './identity.service.ts';
import { IdentityExceptionFilter } from './identity.filter.ts';
import { VerifiedIdentityGuard, singleHeader, type IdentityRequest } from './identity.guard.ts';
import { IdentityError } from './identity-error.ts';
import { UUID } from './identity-context.ts';
import { readIdempotencyKey } from '../idempotency/idempotency-http.ts';

@Controller('v1')
@UseFilters(IdentityExceptionFilter)
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}
  @Post('auth/zalo/exchange') @Header('Cache-Control', 'no-store')
  zalo(): never { throw new IdentityError(503, 'PROVIDER_NOT_CONFIGURED'); }
  @Get('me') @Header('Cache-Control', 'no-store') @UseGuards(VerifiedIdentityGuard)
  me(@Req() request: IdentityRequest) { return this.identity.configuredStore().me(request.verifiedIdentity); }
  @Get('me/memberships') @Header('Cache-Control', 'no-store') @UseGuards(VerifiedIdentityGuard)
  memberships(@Req() request: IdentityRequest) { return this.identity.configuredStore().me(request.verifiedIdentity); }
  @Post('me/membership') @HttpCode(200) @Header('Cache-Control', 'no-store') @UseGuards(VerifiedIdentityGuard)
  async select(@Req() request: IdentityRequest, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'membershipId'
      || typeof (body as { membershipId: unknown }).membershipId !== 'string' || !UUID.test((body as { membershipId: string }).membershipId)) throw new IdentityError(422, 'VALIDATION_FAILED');
    const key = readIdempotencyKey(singleHeader(request, 'idempotency-key'));
    if (!key) throw new IdentityError(422, 'VALIDATION_FAILED');
    const result = await this.identity.configuredStore().select(request.verifiedIdentity, (body as { membershipId: string }).membershipId, key);
    if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
    response.status(200);
    return result.view;
  }
}
