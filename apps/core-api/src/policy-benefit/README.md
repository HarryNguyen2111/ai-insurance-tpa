# BEN-01 immutable policy configuration

This internal core-api repository stores approved synthetic/technical snapshots.
It has no HTTP endpoint, policy administrator role implementation or contract
approval authority. The application composition must inject the existing
`withTenantTransaction` helper and a `SourceApprovalVerifier`; approval defaults
to deny, including verifier failure. The verifier must establish tenant/object
permission, source-document/configuration versions and hashes, exact clause text,
applicability, member/guardian references, and actual owner approval. A client flag
or self-supplied UUID/hash is not approval. No production verifier is provided.

`createPolicy` commits its immutable policy/clauses/endorsements plus audit in one
tenant transaction. Clauses and endorsements cannot be appended after that
transaction. `createRule` and `createCoverage` append separately approved versions,
validate exact referenced hashes/version numbers and use composite tenant FKs.
All six tables reject UPDATE/DELETE/TRUNCATE, even before a version is used.
Changes require new version IDs/numbers; no effective dates are silently edited.
Member/plan/source IDs are opaque references because their ingestion/identity
modules are not implemented here; the verifier must resolve them before real use.

`resolve` accepts trusted claim context and selects inclusive ISO-date coverage.
It returns `CONFIGURED` with immutable policy/rule/coverage references and terms,
or `REVIEW` with fixed reason codes. CONFIGURED is not coverage eligibility,
benefit approval, a rejection, STP execution, an EOB or a payment decision.
Overlapping effective policies/rules/coverages always route review; latest ID,
version, insertion time or incidental query order never breaks a tie. Tenant
configuration writes/selections serialize with a transaction advisory lock so
selection cannot race a version insert. An endorsement's position in the complete
explicit `precedence` list determines priority (first wins per term); only
endorsements effective on the visit date contribute terms. No money arithmetic
occurs: amounts remain validated decimal strings and NUMERIC(15,2), percentages
NUMERIC(5,2), with no float conversion or inferred defaults.

The internal `EdgeTerms` snapshot makes original-spec settings explicit and
clause-bound: hospital-income NIGHTS/FULL_24H, admission-overlap human review,
daycare hour/surgery conversion, pre/post days and versioned ICD grouping,
EMR stamp waiver, normal/maximum prescription days and interim receipt evidence,
original-document and dual-approval thresholds, minor age and verified guardian
payee mode. Missing applicable terms route review; hospital/admission/prescription/
pre-post/minor applicability flags must come from trusted claim facts. Original
and dual-approval settings are required for every selection. The fixture's 24h,
±30 days, 5/30 days, thresholds and guardian policy are synthetic examples, not
universal policy/legal decisions. This module stores/selects configuration only;
it does not calculate admission nights, deduplicate admissions, group actual ICDs,
check document evidence, verify a real payee, or adjudicate claims.

`resolveAndPin` stores exact version IDs plus resolved snapshot hash and visit date
and trusted selection context for a claim reference, with audit in the same commit. Concurrent same-claim pins
serialize and repeat without another audit. A different snapshot for an already
pinned claim returns review; it never overwrites the original. It does not mutate
claim state or publish a domain event, so no new event contract is invented.
Future claim/calculation code must use these immutable references and commit its
business state, audit and outbox together. Identity/API/idempotency wiring and
benefit calculation remain separate tasks.

Verification: core Jest tests cover source approval/copy integrity, reference
validation, inclusive dates, explicit priority, ambiguous versions, no float
money, each original edge-term omission, and unchanged golden monetary fixture
mapping only. They do not execute TC01–TC06 waterfall/preflight expectations.
`pnpm db:test:integration` runs the PG16 suite through the actual repository and
app role: migration, NUMERIC roundtrip, concurrent pin/audit, immutable used
versions, overlap review, every edge omission, RLS/composite references and audit
rollback. These are focused PT01/PT02-related assertions, not complete platform
or production acceptance. No real PII or actual contract is seeded.
