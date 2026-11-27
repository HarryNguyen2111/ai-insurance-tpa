# @tpa/domain — BEN-02 Decimal waterfall (#33)

Pure, deterministic Smart Reimbursement waterfall (`@tpa/domain/waterfall`) per
`docs/ai-specs/03` §2 and the original edge cases in §3.2–3.4. No I/O, clock,
database, HTTP endpoint, event or workflow; callers (future adjudication/EOB task)
own persistence, reservations, audit and outbox in one tenant transaction.

## Money
`decimal.js` via an isolated `Decimal.clone` (global config untouched),
`ROUND_HALF_UP` to whole VND, output strings with two decimals (`"720000.00"`).
Inputs must be NUMERIC(15,2) / NUMERIC(5,2) strings; JS numbers and unscaled
strings throw `WaterfallInputError`. Copay rounding is capped at the
post-deductible amount, so rounding never approves more than was claimed.

## `calculateWaterfallEOB(input)`
1. **Eligibility gate** — normal/special waiting days, provider blacklist, used >
   annual limit, rule clause presence. Any gap or unmet waiting period returns
   `calculation: null` + `reviewReasons` (YELLOW_REVIEW): no rejection or amount is
   inferred (TC06). Premium-paid/effective-date selection is BEN-01's
   `selectConfiguration` (REVIEW reasons there). A blacklisted provider with an
   approved exclusion clause yields a full-rejection *proposal* for human review;
   without the clause it routes review. HOSPITAL_INCOME is not line-calculated here.
2. **Line filter** — `SUPPLEMENT_TPCN`/`COSMETIC` rejected with `TPCN_EXCLUDED`
   only when the line carries an approved exclusion clause; otherwise
   `PENDING_REVIEW` (`MISSING_EXCLUSION_CLAUSE`). `PRICE_ANOMALY` (> 1.30 ×
   reference) and `ICD_MISMATCH` are signals that block STP, never money cuts.
3. **Deductible → copay → per-visit cap → annual cap**, consuming the deductible
   and limits in the given invoice line order (stable, documented ordering).
   Every reduction records its step, amount and the cited clause; each non-APPROVED
   line has `contract_clause_cited` and `explanationVi`.
4. **STP** — the five GREEN_STP gates produce `stp.eligible` + `blockers`
   (including TC03 limit-capped and TC05 merged summary). Execution is separate:
   `stp.humanApprovalRequired` is false only for eligible **and**
   `stpExecutionMode === 'ENABLED'`; SHADOW (production default) and DISABLED
   always need a person (PT23 at unit level).

Output carries `engineVersion`, the immutable `ruleVersion` reference and SHA-256
`inputHash`/`outputHash` (canonical JSON) for reproducible EOB snapshots.

## Edge helpers (`edge.ts`)
`hospitalIncomeDays` (NIGHTS in the plan's UTC offset or FULL_24H =
floor(hours/24)), `admissionOverlaps` (closed intervals → review list),
`daycareBenefit` (< maxHours without surgery certificate → OUTPATIENT or review),
`prePostAdmissionSuggestion` (± days window + same group from one versioned ICD
grouping → merge *suggestion*). Term shapes match BEN-01 #32 `EdgeTerms`; a missing
term routes review. Values used in tests are synthetic examples, not contract or
legal decisions.

## Not in scope
Wiring to `PolicyBenefitRepository`/claims, benefit reservations/concurrency
(DB task), EOB persistence/versioning, TC04 preflight (owned by the preflight
task), real contract terms.

## Verification
`pnpm --filter @tpa/domain test` (Node 24 `node --test`): golden runner reads
`docs/ai-specs/04-golden-test-cases.json` directly and asserts TC01/02/03/05/06
unchanged expectations (TC04 inventoried as owned elsewhere); unit boundary tests;
500 seeded property cases against an independent BigInt-cents oracle; PT23 SHADOW
unit test; edge-case tests. These are unit-level mappings, not integration/E2E
platform acceptance.
