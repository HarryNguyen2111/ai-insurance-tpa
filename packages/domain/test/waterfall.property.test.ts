import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateWaterfallEOB, type WaterfallInput } from '../src/waterfall/index.ts';
import { base, line } from './fixtures/input.ts';

/** Seeded PRNG: reproducible cases, no new dependency. */
function mulberry32(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const cents = (s: string) => BigInt(s.replace('.', ''));
const text = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;
const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));

/** Independent integer-cents oracle of spec 03 step 3 (no decimal.js). */
function oracle(input: WaterfallInput): bigint[] {
  const r = input.rule, bp = cents(r.copayInsurerPct); // "80.00" -> 8000 basis points
  let ded = cents(r.deductiblePerClaim), visit = r.perVisitLimit === null ? null : cents(r.perVisitLimit);
  let annual = cents(r.annualLimit) - cents(input.usedAnnualAmount);
  return input.lines.map(l => {
    if (['SUPPLEMENT_TPCN', 'COSMETIC'].includes(l.category)) return 0n;
    const req = cents(l.requestedAmount), d = min(req, ded); ded -= d;
    const n = (req - d) * bp, unit = 1_000_000n; // cents*bp per whole VND = 100 * 10000
    let amount = min(((2n * n + unit) / (2n * unit)) * 100n, req - d); // ROUND_HALF_UP to whole VND, never above claim
    if (visit !== null) { amount = min(amount, visit); visit -= amount; }
    amount = min(amount, annual); annual -= amount;
    return amount;
  });
}

test('500 seeded random claims match the integer oracle and conservation invariants', () => {
  const rand = mulberry32(20261127);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const vnd = (lo: number, hi: number) => text(BigInt(int(lo, hi)) * 100n);
  for (let k = 0; k < 500; k++) {
    const n = int(1, 8);
    // A third of cases force exact half-VND copay results (odd VND x 50%/10%) to pin HALF_UP.
    const half = k % 3 === 0;
    const amount = () => (half ? text(BigInt(int(0, 2_000_000) * 2 + 1) * 100n) : text(BigInt(int(0, 300_000_000))));
    const ls = Array.from({ length: n }, (_, i) => line(`L${i + 1}`, amount(),
      rand() < 0.15 ? { category: rand() < 0.5 ? 'SUPPLEMENT_TPCN' : 'COSMETIC', exclusionClauseCited: 'Synthetic 5.3' } : {}));
    const annual = int(0, 20_000_000);
    const input = base({ lines: ls, usedAnnualAmount: vnd(0, annual) }, {
      annualLimit: text(BigInt(annual) * 100n), perVisitLimit: rand() < 0.3 ? null : vnd(0, 5_000_000),
      copayInsurerPct: half ? (rand() < 0.5 ? '50.00' : '10.00') : text(BigInt(int(0, 10000))),
      deductiblePerClaim: half ? '0.00' : vnd(0, 1_000_000),
    });
    const r = calculateWaterfallEOB(input);
    const again = calculateWaterfallEOB(structuredClone(input));
    assert.equal(r.outputHash, again.outputHash, `case ${k} deterministic`);
    const t = r.calculation!.totals, expected = oracle(input);
    let approved = 0n;
    r.calculation!.lines.forEach((l, i) => {
      for (const v of [l.requested, l.approved, l.rejected, l.pendingReview]) assert.match(v, /^\d+\.\d{2}$/);
      assert.equal(cents(l.approved), expected[i], `case ${k} line ${l.lineId}`);
      assert.equal(cents(l.approved) + cents(l.rejected) + cents(l.pendingReview), cents(l.requested));
      assert.ok(cents(l.approved) <= cents(l.requested), `case ${k} approved <= requested`);
      if (cents(l.requested) % 100n === 0n) assert.equal(cents(l.approved) % 100n, 0n, 'whole VND');
      if (l.status !== 'APPROVED') assert.ok(l.contractClauseCited && l.explanationVi);
      const reduced = l.reductions.reduce((s, x) => s + cents(x.amount), 0n);
      assert.equal(reduced, cents(l.rejected), `case ${k} reductions explain the full cut`);
      approved += cents(l.approved);
    });
    assert.equal(cents(t.totalApproved), approved);
    assert.equal(cents(t.totalApproved) + cents(t.totalRejected) + cents(t.totalPendingReview), cents(t.totalRequested));
    assert.equal(cents(t.remainingAnnualLimitAfter), cents(input.rule.annualLimit) - cents(input.usedAnnualAmount) - approved);
    assert.ok(cents(t.remainingAnnualLimitAfter) >= 0n);
    if (input.rule.perVisitLimit !== null) assert.ok(approved <= cents(input.rule.perVisitLimit));
  }
});
