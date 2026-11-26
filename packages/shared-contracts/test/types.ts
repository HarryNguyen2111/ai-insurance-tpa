import type { components, paths } from '../src/index.js';
import { validate } from '../src/index.js';
const money: components['schemas']['Money'] = '720000.00';
// @ts-expect-error Monetary JSON numbers are forbidden.
const invalidMoney: components['schemas']['Money'] = 720000;
const request: paths['/v1/claims']['post']['requestBody']['content']['application/json'] = {
  memberId: '00000000-0000-4000-8000-000000000001', benefitType: 'OUTPATIENT', visitDate: '2026-11-25',
  totalRequested: money, consentAccepted: true, consentId: '00000000-0000-4000-8000-000000000002',
  documentIds: ['00000000-0000-4000-8000-000000000003'], preflightId: '00000000-0000-4000-8000-000000000004', expectedPreflightVersion: 1,
};
validate('ClaimSubmit', request);
void invalidMoney;
const binding: components['schemas']['EobBinding'] = {eobVersion: 1, eobHash: 'a'.repeat(64)};
const confirmation: paths['/v1/claims/{claimId}/otp/verify']['post']['requestBody']['content']['application/json'] = {
  expectedAggregateVersion: 1, eob: binding, challengeId: '00000000-0000-4000-8000-000000000001', code: 'synthetic-proof',
};
validate('OtpVerifyRequest', confirmation);
// @ts-expect-error EOB version/hash binding is mandatory.
const unbound: components['schemas']['OtpChallengeRequest'] = {expectedAggregateVersion: 1};
// @ts-expect-error Payment amounts remain decimal strings.
const floatPayment: components['schemas']['PaymentIntent']['amount'] = 100;
// @ts-expect-error Tenant selectors cannot be supplied by clients.
const unsafeSearch: components['schemas']['ClaimSearchQuery'] = {tenantId: 'untrusted'};
void unbound; void floatPayment; void unsafeSearch;
const createWorkspace: paths['/v1/admin/workspaces']['post']['requestBody']['content']['application/json'] = {
  displayName: 'Bảo hiểm Mẫu', shortName: 'BHM', slug: 'bao-hiem-mau', orgType: 'INSURER',
  initialAdminPrincipalId: '00000000-0000-4000-8000-000000000030',
};
validate('WorkspaceCreateRequest', createWorkspace);
// @ts-expect-error The first administrator is mandatory (decided OD-05).
const noAdmin: components['schemas']['WorkspaceCreateRequest'] = {displayName: 'X Y', shortName: 'XY', slug: 'x-y', orgType: 'INSURER'};
// @ts-expect-error Slug cannot be changed through profile updates (decided OD-02).
const slugEdit: components['schemas']['WorkspaceProfileUpdateRequest'] = {expectedVersion: 1, displayName: 'X Y', shortName: 'XY', orgType: 'INSURER', slug: 'moi'};
// @ts-expect-error Theme radius is a closed allowlist.
const badRadius: components['schemas']['WorkspaceTheme'] = {primaryColor: '#0f766e', radius: 'XL', mode: 'LIGHT', sidebarStyle: 'LIGHT'};
const workspaceResult: paths['/v1/admin/workspaces/{workspaceId}/theme']['put']['responses']['200']['content']['application/json']['warnings'] = [];
void noAdmin; void slugEdit; void badRadius; void workspaceResult;
