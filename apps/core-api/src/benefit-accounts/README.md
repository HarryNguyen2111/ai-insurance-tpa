# benefit-accounts — BEN-03 (#34) atomic limit reservations

Internal port (no HTTP endpoint; no OpenAPI change). Callers — EOB publish, payment and
Temporal activities — pass the verified tenant/actor, a semantic `operationKey` and trace ids.
Production composition injects `withTenantTransaction` and `@tpa/database` `appendOutboxEvent`.

## Model (migration `0010_benefit_reservations`)
| Table | Purpose |
| --- | --- |
| `benefit_accounts` | One per member/plan/benefit type/limit group (`ANNUAL`)/contract year. `limit_amount` and `clause_id` are copied from the approved BEN-01 rule version (composite FKs), never caller input. `CHECK used + reserved <= limit`. |
| `benefit_reservations` | `HELD -> CONSUMED / RELEASED / EXPIRED` only, with a DB-clock `expires_at`. One live hold per claim/account. |
| `benefit_movements` | Append-only journal (`RESERVE/CONSUME/RELEASE/EXPIRE`) with deltas and post-balances; a trigger checks each row against the locked account. |
| `benefit_operations` | Semantic idempotency: `(tenant, operation_key)` + request hash + stored result. |

All four have ENABLE+FORCE RLS on `tpa.current_tenant_id()` (SET LOCAL), have no DELETE/TRUNCATE, and only allow column-scoped UPDATE grants.

## Concurrency
- Accounts are always locked first, `ORDER BY id FOR UPDATE` (stable order, so multi-account holds cannot deadlock); reservations are locked after.
- Holds use a conditional `UPDATE ... WHERE used + reserved + amount <= limit`. The CHECK constraint and the movement cross-check are the last line of defence.
- Due holds on locked accounts are expired lazily before any acquire/consume/release. `expireDue` sweeps them for timers.
- Not enough limit returns `INSUFFICIENT_LIMIT` with the shortfall and clause and holds nothing (PT03: caller routes review). It is never an inferred rejection.

## Idempotency
The same key with the same request (actor + body; trace ids excluded) replays the stored result, including `INSUFFICIENT_LIMIT`/`NOT_ACTIVE`. A different request or operation type raises `BenefitIdempotencyConflict` (409). A concurrent same-key request blocks on the key row and then replays. Input/state errors roll back everything, including the key, so they can be retried.

## Money
NUMERIC(15,2) strings only. TS validates the canonical format. PostgreSQL NUMERIC does all
sums, comparisons and deltas, so there is no JS float math and no new dependency.

## Atomicity
Every change writes the account update, reservation, movement, chained audit (`BENEFIT_ACCOUNT`, before/after hashes)
and the `benefit.limit-changed` outbox event (aggregate = account, version = account version)
in one tenant transaction. Any failure rolls all of them back.

## Not in scope
Group/family pooled limits beyond `ANNUAL`: no approved configuration exists yet. EOB/payment wiring and HTTP endpoints are also out of scope.
