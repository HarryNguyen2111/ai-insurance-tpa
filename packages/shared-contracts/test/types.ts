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
