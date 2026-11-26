import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNTHETIC_CLAIMS, SYNTHETIC_CLAIM_DETAILS, SYNTHETIC_ECARD, SYNTHETIC_EOBS,
} from '../fixtures/synthetic.ts';
import { CLAIM_STATUSES } from './claim-status.ts';
import { isMoney, moneyEquals, sumMoney } from './money.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;

test('claim summaries match OpenAPI ClaimSummary field rules', () => {
  for (const c of SYNTHETIC_CLAIMS) {
    assert.match(c.claimId, UUID);
    assert.match(c.memberId, UUID);
    assert.ok(isMoney(c.totalRequested), c.totalRequested);
    assert.ok((CLAIM_STATUSES as readonly string[]).includes(c.status));
    assert.match(c.visitDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isInteger(c.version) && c.version >= 1);
    assert.equal(SYNTHETIC_CLAIM_DETAILS[c.claimId]?.claim, c);
  }
});

test('EOB money is strings and conserves: requested = approved + rejected, summary = Σ lines', () => {
  for (const eob of Object.values(SYNTHETIC_EOBS)) {
    const s = eob.summary;
    for (const m of Object.values(s)) assert.ok(isMoney(m), m);
    for (const l of eob.lineItems) {
      for (const m of [l.requested, l.approved, l.rejected]) assert.ok(isMoney(m), `${l.itemName}: ${m}`);
      assert.ok(moneyEquals(sumMoney([l.approved, l.rejected]), l.requested), l.itemName);
      const expected = moneyEquals(l.rejected, '0.00') ? 'APPROVED' : moneyEquals(l.approved, '0.00') ? 'REJECTED' : 'PARTIAL';
      assert.equal(l.status, expected, l.itemName);
    }
    assert.ok(moneyEquals(sumMoney(eob.lineItems.map((l) => l.requested)), s.totalRequested));
    assert.ok(moneyEquals(sumMoney(eob.lineItems.map((l) => l.approved)), s.totalApproved));
    assert.ok(moneyEquals(sumMoney(eob.lineItems.map((l) => l.rejected)), s.totalRejected));
    const claim = SYNTHETIC_CLAIMS.find((c) => c.claimId === eob.claimId);
    assert.ok(claim && moneyEquals(claim.totalRequested, s.totalRequested));
  }
});

test('every line (esp. cut/rejected) cites a versioned clause and a Vietnamese explanation', () => {
  for (const eob of Object.values(SYNTHETIC_EOBS)) {
    assert.match(eob.eobHash, HASH);
    assert.match(eob.auditProof.hashChainTail, HASH);
    assert.equal(eob.auditProof.contractLocked, true);
    for (const ref of [eob.policyVersion, eob.benefitRuleVersion, eob.configurationVersion, eob.calculationRun]) {
      assert.match(ref.id, UUID);
      assert.match(ref.hash, HASH);
    }
    for (const l of eob.lineItems) {
      assert.ok(l.clauseCited.length > 0 && l.explanationVi.length > 0);
      assert.ok(l.contractClause.contractClauseCited.length > 0 && l.contractClause.explanationVi.length > 0);
      assert.ok(['BENEFIT_RULE', 'MEDICAL_CATALOG'].includes(l.contractClause.source));
      assert.ok(l.evidenceIds.length >= 1 && l.evidenceIds.every((e) => UUID.test(e)));
    }
  }
});

test('fixtures carry no PII-shaped data (CCCD, phone, bank account) and are visibly synthetic', () => {
  // Hashes and UUIDs are opaque identifiers whose hex digits would trip the digit-run scan; remove them first.
  const blob = JSON.stringify({ SYNTHETIC_CLAIMS, SYNTHETIC_EOBS, SYNTHETIC_ECARD })
    .replace(/[a-f0-9]{64}/g, '<hash>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
  assert.doesNotMatch(blob, /(?<![\d-])\d{9,12}(?![\d-])/, 'no CCCD/bank-like digit runs');
  assert.doesNotMatch(blob, /(?<!\d)(\+?84|0)(3|5|7|8|9)\d{8}(?!\d)/, 'no VN mobile numbers');
  assert.match(SYNTHETIC_ECARD.displayNameMasked, /\*/);
  assert.match(SYNTHETIC_ECARD.cardNumberMasked, /^MAU-/);
  for (const c of SYNTHETIC_CLAIMS) assert.match(c.claimCode, /^MAU-/);
});
