# invoice-allocation — BEN-04 (#35) global invoice dedup and co-insurance allocation

This is an internal port. It has no HTTP endpoint and changes nothing in OpenAPI. Callers (claim intake and Temporal activities) pass the verified tenant and actor, a semantic `operationKey` and trace ids. Production composition injects `withTenantTransaction` and `@tpa/database` `appendOutboxEvent`.

## Invoice identity
`invoiceIdentityHash` = SHA-256 of `MST|Serial|Number` (spec 01/03). Before hashing, the inputs are canonicalised: values are trimmed, the serial is upper-cased and leading zeros are stripped from the number. This makes formatting variants of one physical invoice collide. Malformed values are rejected rather than coerced. The hash identifies the invoice but contains no personal data.

## Model (migration `0012_invoice_allocation`)
| Table | Scope | Purpose |
| --- | --- | --- |
| `invoice_registry` | **global** | One row per invoice hash. The total is fixed by the first registrant. `allocated_amount` has `CHECK <= total_amount`. |
| `invoice_registry_allocations` | **global** | Global allocation ledger (tenant, allocation id, amount, co-insurance flag, `ACTIVE/RELEASED`). Each tenant may have at most one live allocation per invoice. |
| `invoice_allocations` | tenant (FORCE RLS) | The tenant's own allocation: claim, amount and co-insurance proof evidence (document id, sha256, verifier). |
| `invoice_allocation_operations` | tenant (FORCE RLS) | Semantic idempotency: key + request hash + stored result. |

## Reviewed privileged surface (least privilege)
- `tpa_app` has **no privileges** on the two global tables. They have RLS enabled with no policy, so any non-owner sees nothing.
- The only access path is two `SECURITY DEFINER` functions owned by the migration role. They pin `search_path = pg_catalog` and use schema-qualified names. `EXECUTE` is revoked from `PUBLIC` and granted only to `tpa_app`.
  - `tpa.invoice_allocate(hash, total, allocation_id, amount, co_insurance)` returns `ALLOCATED | DUPLICATE | EXCEEDS_TOTAL | TOTAL_MISMATCH`. On `ALLOCATED` it also returns the opaque registry id.
  - `tpa.invoice_release(allocation_id)` returns `RELEASED | NOT_ACTIVE | NOT_FOUND`. It only acts on the caller tenant's own ledger rows.
- The tenant always comes from `tpa.current_tenant_id()`, which is the `SET LOCAL` transaction context. It is never taken from an argument.
- The functions never return another insurer's tenant, claim, allocated or remaining amount, or proof. The co-insurance proof itself stays in the tenant table; the global ledger stores only a boolean.
- Deferred constraint triggers check at commit that each tenant row matches its global-ledger row: registry id, hash, total, amount, co-insurance flag and status. Because of this, `tpa_app` cannot:
  - insert or release a tenant row without going through the global function, or
  - leave an orphaned global allocation behind.
- All four tables refuse DELETE and TRUNCATE. Identity and total columns are immutable. The only allowed transition is `ACTIVE -> RELEASED`.

### Residual disclosure (by design)
Saying "this invoice is already claimed" (`DUPLICATE_INVOICE`) or "your total disagrees" (`INVOICE_TOTAL_MISMATCH`) necessarily reveals that the invoice exists elsewhere, because spec 03 requires FRAUD_HOLD on duplicates. `EXCEEDS_INVOICE_TOTAL` does not return the remaining amount. Repeated probing is limited by authorization and the audit trail, since every blocked attempt is audited on the claim.

## Rules
- The first allocation needs no proof.
- A second live allocation by the **same** insurer on the same invoice is always `DUPLICATE_INVOICE`.
- If **another** insurer has a live allocation, `DUPLICATE_INVOICE` is returned unless the caller provides co-insurance proof. The caller routes the claim to FRAUD_HOLD or review.
- With valid proof, the allocation succeeds only if the global `SUM(ACTIVE) + amount <= total`. Otherwise the result is `EXCEEDS_INVOICE_TOTAL` and nothing is allocated (review).
- A different extracted total for the same identity gives `INVOICE_TOTAL_MISMATCH` (review). The registered total never changes.
- Releasing (claim rejected or withdrawn) frees global capacity and is idempotent.

## Concurrency
For a given invoice, every allocate and release from **any** tenant queues on one global `FOR UPDATE` row lock. A first registration that has not yet committed blocks competing inserts on the unique hash. The global sum increases only through a conditional `UPDATE … WHERE allocated + amount <= total`. A CHECK constraint and a ledger-sum cross-check provide defence in depth. Lock order is always: tenant operation key, then global registry row, then tenant allocation row.

## Atomicity, audit and events
In one tenant transaction the service writes:
- the global ledger,
- the tenant row,
- a chained audit entry (`INVOICE_ALLOCATION`, before/after hashes),
- an `invoice.allocation-changed` outbox event, whose payload is `changeKind` only (no amounts, invoice data or PII),
- the idempotency result.

Blocked outcomes are audited as `INVOICE_CHECK` on the claim and emit no event. Any failure rolls everything back, including the global row lock and allocation.

## Boundary
All evidence is synthetic. Which documents count as valid co-insurance proof, and who may verify them, is a production policy that needs **approved contracts**. Here, proof is checked only structurally (document id, SHA-256 and verifier must all be present).
