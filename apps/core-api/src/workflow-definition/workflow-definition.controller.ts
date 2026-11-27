import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { IdentityExceptionFilter } from '../identity-tenant/identity.filter.ts';
import { VerifiedIdentityGuard, singleHeader, type IdentityRequest } from '../identity-tenant/identity.guard.ts';
import { UUID } from '../identity-tenant/identity-context.ts';
import { readIdempotencyKey } from '../idempotency/idempotency-http.ts';
import { hidden, invalidRequest } from './workflow-error.ts';
import type { PageQuery, WorkflowCall, WorkflowDefinitionApi, WorkflowMutationResult } from './workflow-definition.store.ts';

export const WORKFLOW_DEFINITION_API = Symbol('WORKFLOW_DEFINITION_API');
const VERSION = /^[1-9][0-9]{0,9}$/;

function call(request: IdentityRequest, mutation: boolean): WorkflowCall {
  const membershipContext = singleHeader(request, 'x-membership-context');
  if (!membershipContext || membershipContext.length > 8192) throw invalidRequest();
  if (!mutation) return { identity: request.verifiedIdentity, membershipContext };
  const key = readIdempotencyKey(singleHeader(request, 'idempotency-key'));
  if (!key) throw invalidRequest();
  return { identity: request.verifiedIdentity, membershipContext, idempotencyKey: key };
}
/** Malformed ids are indistinguishable from inaccessible objects (404, no existence leak). */
function definitionId(value: string): string { if (!UUID.test(value)) throw hidden(); return value; }
function versionNo(value: string): number {
  const n = VERSION.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n > 2147483647) throw hidden();
  return n;
}
function page(query: Record<string, unknown>): PageQuery {
  const keys = Object.keys(query);
  if (keys.some(k => k !== 'limit' && k !== 'cursor')) throw invalidRequest(); // no tenant/filter selectors
  const limit = query.limit === undefined ? 20 : typeof query.limit === 'string' && /^[1-9][0-9]?$/.test(query.limit) ? Number(query.limit) : NaN;
  if (!(limit >= 1 && limit <= 50)) throw invalidRequest();
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length < 1 || query.cursor.length > 2048)) throw invalidRequest();
  return { limit, ...(query.cursor !== undefined ? { cursor: query.cursor as string } : {}) };
}
function send(response: Response, result: WorkflowMutationResult) {
  response.status(result.status);
  if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
  return result.body;
}

/** VWF-03 (#80) definitions API (spec 14 §5, API 1.4.0). No tenantId is accepted or returned. */
@Controller('v1')
@UseFilters(IdentityExceptionFilter)
@UseGuards(VerifiedIdentityGuard)
export class WorkflowDefinitionController {
  constructor(@Inject(WORKFLOW_DEFINITION_API) private readonly api: WorkflowDefinitionApi) {}

  @Get('admin/workflow-definitions') @Header('Cache-Control', 'no-store')
  list(@Req() req: IdentityRequest, @Query() query: Record<string, unknown>) { return this.api.list(call(req, false), page(query)); }

  @Post('admin/workflow-definitions') @Header('Cache-Control', 'no-store')
  async create(@Req() req: IdentityRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.api.create(call(req, true), body));
  }

  @Get('admin/workflow-definitions/:definitionId/versions') @Header('Cache-Control', 'no-store')
  versions(@Req() req: IdentityRequest, @Param('definitionId') id: string, @Query() query: Record<string, unknown>) {
    return this.api.listVersions(call(req, false), definitionId(id), page(query));
  }

  @Get('admin/workflow-definitions/:definitionId/versions/:versionNo') @Header('Cache-Control', 'no-store')
  get(@Req() req: IdentityRequest, @Param('definitionId') id: string, @Param('versionNo') no: string) {
    return this.api.get(call(req, false), definitionId(id), versionNo(no));
  }

  @Put('admin/workflow-definitions/:definitionId/versions/:versionNo') @Header('Cache-Control', 'no-store')
  async update(@Req() req: IdentityRequest, @Param('definitionId') id: string, @Param('versionNo') no: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.api.update(call(req, true), definitionId(id), versionNo(no), body));
  }

  @Post('admin/workflow-definitions/:definitionId/versions/:versionNo/validate') @HttpCode(200) @Header('Cache-Control', 'no-store')
  async validate(@Req() req: IdentityRequest, @Param('definitionId') id: string, @Param('versionNo') no: string, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.api.validate(call(req, true), definitionId(id), versionNo(no)));
  }

  @Post('admin/workflow-definitions/:definitionId/versions/:versionNo/publish') @HttpCode(200) @Header('Cache-Control', 'no-store')
  async publish(@Req() req: IdentityRequest, @Param('definitionId') id: string, @Param('versionNo') no: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.api.publish(call(req, true), definitionId(id), versionNo(no), body));
  }

  @Post('admin/workflow-definitions/:definitionId/versions/:versionNo/revoke') @HttpCode(200) @Header('Cache-Control', 'no-store')
  async revoke(@Req() req: IdentityRequest, @Param('definitionId') id: string, @Param('versionNo') no: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.api.revoke(call(req, true), definitionId(id), versionNo(no), body));
  }

  @Get('workflow/action-catalogs/:catalogVersion') @Header('Cache-Control', 'no-store')
  catalog(@Req() req: IdentityRequest, @Param('catalogVersion') no: string) { return this.api.catalog(call(req, false), versionNo(no)); }
}
