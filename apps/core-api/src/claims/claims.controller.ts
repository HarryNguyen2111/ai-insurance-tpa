import { Controller, Get, Post, Param, Body, Req, Res, Inject, Header, UseFilters, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { IdentityExceptionFilter } from '../identity-tenant/identity.filter.ts';
import { VerifiedIdentityGuard, singleHeader, type IdentityRequest } from '../identity-tenant/identity.guard.ts';
import { IdentityError } from '../identity-tenant/identity-error.ts';
import { readIdempotencyKey } from '../idempotency/idempotency-http.ts';
import type { ClaimsApi, ClaimCall, MutationResult } from './claims.store.ts';
export const CLAIMS_API = Symbol('CLAIMS_API');
function call(req: IdentityRequest, mutation = true): ClaimCall {
  const membershipContext = singleHeader(req, 'x-membership-context');
  const key = mutation ? readIdempotencyKey(singleHeader(req, 'idempotency-key')) : undefined;
  if (!membershipContext || membershipContext.length > 8192 || mutation && !key) throw new IdentityError(422, 'VALIDATION_FAILED');
  return { identity: req.verifiedIdentity, membershipContext, ...(key ? { idempotencyKey: key } : {}) };
}
function send(res: Response, result: MutationResult) {
  res.status(result.status);
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  if (result.status === 201) res.setHeader('Location', `/v1/claims/${(result.body as { claimId: string }).claimId}`);
  return result.body;
}
/** API-C1 claim endpoints. Tenant comes only from the verified membership context; no file bytes are accepted here. */
@Controller('v1/claims')
@UseFilters(IdentityExceptionFilter)
@UseGuards(VerifiedIdentityGuard)
export class ClaimsController {
  constructor(@Inject(CLAIMS_API) private readonly api: ClaimsApi) {}
  @Post() @Header('Cache-Control', 'no-store')
  async submit(@Req() req: IdentityRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.api.submit(call(req), body));
  }
  @Get() @Header('Cache-Control', 'no-store')
  list(@Req() req: IdentityRequest) { return this.api.list(call(req, false), req.query); }
  @Get(':claimId') @Header('Cache-Control', 'no-store')
  get(@Req() req: IdentityRequest, @Param('claimId') id: string) { return this.api.get(call(req, false), id); }
  @Post(':claimId/documents') @Header('Cache-Control', 'no-store')
  async supplement(@Req() req: IdentityRequest, @Param('claimId') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.api.supplement(call(req), id, body));
  }
}
