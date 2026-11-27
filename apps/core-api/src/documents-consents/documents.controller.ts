import { Controller, Get, Post, Param, Body, Req, Res, Inject, Header, UseFilters, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { IdentityExceptionFilter } from '../identity-tenant/identity.filter.ts';
import { VerifiedIdentityGuard, singleHeader, type IdentityRequest } from '../identity-tenant/identity.guard.ts';
import { IdentityError } from '../identity-tenant/identity-error.ts';
import { readIdempotencyKey } from '../idempotency/idempotency-http.ts';
import type { DocumentsApi, DocumentCall, MutationResult } from './documents.store.ts';
export const DOCUMENTS_API = Symbol('DOCUMENTS_API');
function call(req: IdentityRequest, mutation = true): DocumentCall {
  const membershipContext = singleHeader(req, 'x-membership-context');
  const key = mutation ? readIdempotencyKey(singleHeader(req, 'idempotency-key')) : undefined;
  if (!membershipContext || membershipContext.length > 8192 || mutation && !key) throw new IdentityError(422, 'VALIDATION_FAILED');
  return { identity: req.verifiedIdentity, membershipContext, ...(key ? { idempotencyKey: key } : {}) };
}
function send(res: Response, result: MutationResult) {
  res.status(result.status);
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  if (result.status === 202) {
    res.setHeader('Retry-After','2');
    res.setHeader('Location', `/v1/documents/${(result.body as { documentId: string }).documentId}`);
  }
  return result.body;
}
@Controller('v1')
@UseFilters(IdentityExceptionFilter)
@UseGuards(VerifiedIdentityGuard)
export class DocumentsController {
  constructor(@Inject(DOCUMENTS_API) private readonly api: DocumentsApi) {}
  @Post('consents') @Header('Cache-Control','no-store')
  async consent(@Req() req: IdentityRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.api.consent(call(req), body));
  }
  @Post('claims/upload-url') @Header('Cache-Control','no-store')
  async presign(@Req() req: IdentityRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.api.presign(call(req), body));
  }
  @Post('uploads/:uploadId/complete') @Header('Cache-Control','no-store')
  async complete(@Req() req: IdentityRequest, @Param('uploadId') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.api.complete(call(req), id, body));
  }
  @Get('documents/:documentId') @Header('Cache-Control','no-store')
  get(@Req() req: IdentityRequest, @Param('documentId') id: string) { return this.api.get(call(req, false), id); }
}
