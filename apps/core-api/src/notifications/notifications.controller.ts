import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { IdentityExceptionFilter } from '../identity-tenant/identity.filter.ts';
import { VerifiedIdentityGuard, singleHeader, type IdentityRequest } from '../identity-tenant/identity.guard.ts';
import { IdentityError } from '../identity-tenant/identity-error.ts';
import type { NotificationCall, NotificationsApi } from './notifications.store.ts';
export const NOTIFICATIONS_API = Symbol('NOTIFICATIONS_API');

/**
 * Optional X-Membership-Context (contract 1.5.0, controller D3): the store requires it for TENANT and rejects it
 * for PERSONAL. A repeated or oversized header is 422, never silently treated as absent.
 */
function call(req: IdentityRequest): NotificationCall {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'x-membership-context') count++;
  const membershipContext = singleHeader(req, 'x-membership-context');
  if (count > 1 || (count === 1 && (!membershipContext || membershipContext.length > 8192))) throw new IdentityError(422, 'VALIDATION_FAILED');
  return { identity: req.verifiedIdentity, ...(membershipContext ? { membershipContext } : {}) };
}

/** NOTIF-01 (#107) in-app inbox. Recipient, tenant and text are server-derived; the client only chooses scope/filters. */
@Controller('v1/me/notifications')
@UseFilters(IdentityExceptionFilter)
@UseGuards(VerifiedIdentityGuard)
export class NotificationsController {
  constructor(@Inject(NOTIFICATIONS_API) private readonly api: NotificationsApi) {}
  @Get() @Header('Cache-Control', 'no-store')
  list(@Req() req: IdentityRequest) { return this.api.list(call(req), req.query); }
  @Get('unread-count') @Header('Cache-Control', 'no-store')
  unreadCount(@Req() req: IdentityRequest) { return this.api.unreadCount(call(req), req.query); }
  @Post('read-all') @HttpCode(200) @Header('Cache-Control', 'no-store')
  markAllRead(@Req() req: IdentityRequest, @Body() body: unknown) { return this.api.markAllRead(call(req), body); }
  @Post(':notificationId/read') @HttpCode(200) @Header('Cache-Control', 'no-store')
  markRead(@Req() req: IdentityRequest, @Param('notificationId') id: string, @Body() body: unknown) { return this.api.markRead(call(req), id, body); }
}
