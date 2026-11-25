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
