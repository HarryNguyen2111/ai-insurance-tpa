# API-01 durable idempotency (synthetic technical foundation, #22)

`@tpa/database/idempotency` stores request idempotency in
`tpa.idempotency_records` (migration `0004`). No endpoint uses it yet; effects in
tests are synthetic. `apps/core-api/src/idempotency` maps outcomes onto the
OpenAPI 1.3.0 HTTP contract.

## Namespace and request hash

Primary key: `(tenant_id, actor_type, actor_id, operation, idempotency_key)`.
Tenant comes only from the `withTenantTransaction` context (`SET LOCAL` via
`set_config(..., true)`), enforced by FORCE RLS. Actor (`USER|SERVICE|SYSTEM` +
opaque internal UUID) and `operation` (operationId style, e.g. `createClaim`)
come from the verified principal/route, never the body. The key follows
`IdempotencyKeyValue` (16–100 of `[A-Za-z0-9._:-]`); clients should use random
keys. Keys and payloads are never logged or echoed in errors.

`request_hash` = SHA-256 of canonical JSON v1 `{"request":<request>,"version":"1"}`:
object keys sorted by UTF-16 code unit, no whitespace, standard JSON string
escaping, no Unicode normalisation, arrays keep order. Only strings, booleans,
null, safe integers, arrays and plain objects are accepted; floats are rejected
(money travels as strings, so `"720000.00"` and `"720000.0"` differ). The raw
request is never stored. The caller decides what `request` covers (body plus
semantically relevant route parameters).

## Outcomes

| Stored state for the namespace | Same hash | Different hash |
| --- | --- | --- |
| none | `acquired` → run effect → `executed` | — |
| `COMPLETED`, within retention | `replayed` (original status/body) | `conflict` (409 `IDEMPOTENCY_CONFLICT`) |
| `IN_PROGRESS`, live lease | `in_progress` (409 `OPERATION_IN_PROGRESS`, `Retry-After`) | `conflict` |
| `IN_PROGRESS`, lease lapsed or released | takeover → `executed` (attempt + 1) | `conflict` |
| past `expires_at` or `EXPIRED` | `expired` (409 `IDEMPOTENCY_CONFLICT`, new key required) | `conflict` |

Authorization must be re-checked for the current principal before replaying.
Responses are `Cache-Control: no-store`.

## Ownership, concurrency and crash semantics

`executeIdempotent` uses two tenant transactions:

1. **Claim**: `INSERT ... ON CONFLICT DO NOTHING` creates an `IN_PROGRESS` row
   with a random owner token and lease. A concurrent first insert waits on the
   uncommitted unique key (no duplicate row); if the first claim rolls back the
   key is free again.
2. **Owned effect**: `SELECT ... FOR UPDATE` on the row *with the caller's token*,
   run the effect through the same transaction, then mark `COMPLETED` with the
   response. Effect and completion commit atomically; there is no committed
   effect without a stored response, and vice versa.

- Crash after claim, before effect: the row stays `IN_PROGRESS`; retries get
  `in_progress` until the lease lapses, then exactly one retry takes over.
- Crash during the effect: PostgreSQL rolls back the effect; same as above.
- Crash after commit (response lost): retries replay the stored response.
- A stalled owner whose lease was taken over is fenced by its token
  (`IdempotencyOwnershipLostError`, rolled back); a takeover that races a
  still-running owner waits on that owner's row lock and then replays.
- A thrown effect error rolls back, then ownership is released best effort, so a
  same-payload retry runs immediately (if the release is lost, lease expiry
  recovers). The key stays bound to its first payload hash.
- Only deterministic outcomes are stored: status 200–499 with a canonical JSON
  body ≤ 60 000 bytes. 5xx/transient failures are thrown, never replayed.

The effect MUST write only through the provided transaction. External effects
(bank, OTP provider, Temporal) are outside this guarantee: later work (OTP and
payment, P2-01) must combine `beginIdempotent`/`runOwnedEffect` with their own
semantic keys (e.g. payout key) and UNKNOWN reconciliation. This does not claim
exactly-once delivery across PostgreSQL/Kafka/Temporal/banks.

## Retention

`expires_at = created_at + retention`, retention 24 h (default, contract minimum)
to 90 days, set from the server clock (an insert trigger overrides `created_at`).
`expireIdempotencyRecords(tx, limit)` (tenant scoped) turns due rows into
`EXPIRED` tombstones: response status/body are dropped, namespace + hash stay, so
a reused key keeps answering 409 and never repeats a side effect. Live leased
attempts are skipped. Physical deletion of tombstones needs a separately approved
retention policy; the app role has no DELETE/TRUNCATE grant and a guard trigger
rejects deletes, namespace/hash/retention changes and invalid state transitions
for every role, including the table owner.

## Verification

- `pnpm --filter @tpa/database test`: canonical hash vector, validation, executor
  control flow (fake transaction).
- `pnpm db:test:integration` → `test/idempotency.integration.test.ts` (PT22):
  real PG16 + PgBouncer 1.26.1 transaction pool, concurrent duplicates, SIGKILL
  crash at three points, lease fencing, failure, retention and actor/tenant/RLS
  boundaries. Requires Docker.
