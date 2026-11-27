# CLM-02 (#37) claim submit/list/detail/supplement and atomic transitions

Implements the existing API-C1 operations `submitClaim` (`POST /v1/claims`), `listClaims` (`GET /v1/claims`),
`getClaim` (`GET /v1/claims/{claimId}`) and `supplementClaim` (`POST /v1/claims/{claimId}/documents`). No OpenAPI
change. Migration `0015_claims` adds `tpa.claims` and append-only `tpa.claim_documents` (FORCE RLS, tenant
USING/WITH CHECK, composite tenant FKs to `consent_records` and `document_versions`).

## Invariants
- Tenant only from the verified membership context (AUTH-01); every query runs in `withTenantTransaction` (SET LOCAL).
- Submit/supplement require `Idempotency-Key`: durable tenant/actor/operation/key request hash (API-01). Same body
  replays the original 201/200, changed body 409 `IDEMPOTENCY_CONFLICT`, concurrent same key waits and replays.
  `claims.submission_hash` (SHA-256 of operation/actor/key, never the raw key) is a backstop after retention lapses.
- Money is the OpenAPI `Money` string, stored `NUMERIC(15,2)` and returned as NUMERIC text; never a JS number.
- Business state + `audit_logs` (hash chain) + outbox (`claim.submitted` empty payload, `claim.state-changed`
  status codes only) commit in one tenant transaction; any failure rolls back all three and the idempotency record.
- Documents: the DOC-01 consumer gate (`lockConsumableDocument`) — uploader-owned, member-related, consent still
  current, scan CLEAN — is reused inside the claim transaction. A document is evidence for exactly one claim
  (per-document advisory lock + unique constraint). No bytes, storage keys or URLs pass through core-api.
- Submit verifies: owner/verified-guardian relation (staff cannot submit), current consent for the configured
  claim purpose (`consentId`), a provisioned BEN-01 coverage for the member, and the preflight reference.
  Date/benefit applicability is NOT decided at intake: `PolicyBenefitRepository.resolveAndPin` pins versions later
  and missing/ambiguous configuration routes review (spec 03 §5). No eligibility rejection is inferred here.
- Reads: owner/guardian, or staff (`CLAIM_REVIEWER`/`INSURER_REVIEWER`) with an explicit active READ assignment.
  Everything else, including other tenants, is 404. Detail reads are audited. List allows only
  `cursor/limit/status/memberId`; the opaque keyset cursor (createdAt+claimId) is bound to membership and filters.
- Transitions: `transitionClaim(tx, runtime, command)` for trusted callers (Temporal activities, #38) inside their
  tenant transaction: row lock, `expectedVersion`, spec-03 graph (`claim-state.ts`, mirrored by
  `tpa.claim_transition_allowed` and enforced by the `claims_guard` trigger), stable `commandId` replay without a
  second audit/event. Evidence-gated targets (EOB_READY, OTP_SIGNED, PAYOUT_PROCESSING, PAID) and service moves into
  SUBMITTED are refused until their owners (#40/#41/#43/#45) add gated entry points. Entering SUPPLEMENT_REQUIRED
  needs a caller-computed future deadline (no 15-day constant is invented here).
- Supplement: only SUPPLEMENT_REQUIRED before its deadline, owner/guardian only, expected version under row lock,
  CLEAN documents; moves to SUBMITTED for re-processing. Repeated commands never repeat the transition.

## Provisioning boundary
`ClaimsModule.register({ identity, claimPurpose, documentPurpose, preflight })`. The default app registers it
unconfigured and answers 503 `PROVIDER_NOT_CONFIGURED`: no consent purpose is defaulted and preflight (CLM-01 #36)
is not implemented here. `ClaimPreflightGate` is the seam #36 must implement inside the submit transaction;
tests use a synthetic gate only.

## Verification
`claims.spec.ts`/`claims-http.spec.ts` (Jest) and `test/claims.pg.test.mjs` (Docker PG16, real migrations,
unprivileged `tpa_app`): PT01/PT17/PT22 scoped synthetic subsets plus concurrency, rollback and DB-trigger guards.
These are not full platform acceptance (Kafka/Temporal/index/DLQ paths belong to their owning tasks).
