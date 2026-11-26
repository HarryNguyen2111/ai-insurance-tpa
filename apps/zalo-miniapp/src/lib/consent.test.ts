import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CONSENT_POLICY, buildConsentRequest, canSubmitClaim, consentCanonicalText } from './consent.ts';

test('declared policyHash is the sha256 of the exact versioned text shown to the user', () => {
  const digest = createHash('sha256').update(consentCanonicalText(), 'utf8').digest('hex');
  assert.equal(CONSENT_POLICY.policyHash, digest);
  assert.match(CONSENT_POLICY.policyHash, /^[a-f0-9]{64}$/);
});

test('changing any paragraph changes the hash (text is version-bound)', () => {
  const altered = { ...CONSENT_POLICY, paragraphs: [...CONSENT_POLICY.paragraphs.slice(0, -1), 'khác'] };
  const digest = createHash('sha256').update(consentCanonicalText(altered), 'utf8').digest('hex');
  assert.notEqual(digest, CONSENT_POLICY.policyHash);
});

test('acceptance builds an OpenAPI ConsentRequest; denial and pending build nothing', () => {
  const memberId = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(buildConsentRequest(memberId, 'ACCEPTED'), {
    memberId,
    purpose: CONSENT_POLICY.purpose,
    policyVersion: CONSENT_POLICY.policyVersion,
    policyHash: CONSENT_POLICY.policyHash,
    accepted: true,
  });
  assert.equal(buildConsentRequest(memberId, 'DENIED'), null);
  assert.equal(buildConsentRequest(memberId, 'PENDING'), null);
});

test('claim submission requires acceptance of the current policy version', () => {
  assert.equal(canSubmitClaim('ACCEPTED', CONSENT_POLICY.policyVersion), true);
  assert.equal(canSubmitClaim('ACCEPTED', 'synthetic-2025.01-v0'), false);
  assert.equal(canSubmitClaim('DENIED', CONSENT_POLICY.policyVersion), false);
  assert.equal(canSubmitClaim('PENDING', null), false);
});

test('consent text is labelled as a sample, not legal wording', () => {
  assert.match(consentCanonicalText(), /MẪU/);
});
