# ledger — PAY-01 (#44) balanced immutable journal and protected float balances

Internal port (no HTTP endpoint; no OpenAPI change). Callers such as payment intents, reconciliation
and Temporal activities pass the verified tenant/actor, a semantic `idempotencyKey` and trace ids.
Production composition injects `withTenantTransaction` and `@tpa/database` `appendOutboxEvent`.
Synthetic funds only: nothing here talks to a bank or performs a payout.

## Model (migration `0014_ledger_journal`)
| Table | Purpose |
| --- | --- |
| `ledger_accounts` | One per tenant/purpose/currency. `SETTLEMENT_BANK` is an asset (debit-normal); `INSURER_FLOAT` and `PAYOUT_CLEARING` are liabilities (credit-normal). `balance`, `debit_total`, `credit_total` and `version` are a projection of the journal lines. `CHECK (balance >= 0)` and `CHECK balance = totals`. |
| `journal_entries` | Append-only header: `FLOAT_TOPUP`, `PAYOUT_COMMIT`, `PAYOUT_SETTLE` or `REVERSAL` (with `reverses_entry_id` + `reason_code`). Always `POSTED`. Unique `(tenant, idempotency_key)` with a request hash. |
| `journal_lines` | Append-only `DEBIT`/`CREDIT` lines, NUMERIC(15,2) `amount > 0`. Composite FK `(tenant, account, currency)`. `balance_after` and `account_version` are set by the trigger from the locked account row. |

All three tables have ENABLE+FORCE RLS on `tpa.current_tenant_id()` (SET LOCAL) and only SELECT/INSERT grants.
(`UPDATE (version)` exists only so `SELECT ... FOR UPDATE` can lock accounts. The guard rejects every direct update.)

## Database-enforced invariants (hold even for raw SQL from `tpa_app`)
- **Balanced:** a `DEFERRABLE INITIALLY DEFERRED` constraint trigger checks each entry at COMMIT. An entry needs at least 2 lines, and SUM(debit) = SUM(credit) for each currency. Otherwise the whole transaction fails (PT14). `SET CONSTRAINTS ... IMMEDIATE` only makes the check fail earlier.
- **Immutable:** entries, lines and accounts cannot be UPDATEd, DELETEd or TRUNCATEd. This is blocked by missing grants and also by triggers, so the owner role is blocked too. Lines can only be added by the transaction that inserted their entry, which means a committed entry can never change.
- **Reversal only:** a `REVERSAL` must mirror its original exactly (same accounts, currencies and amounts, opposite sides). There is at most one reversal per entry, and a reversal cannot itself be reversed.
- **Protected balances:** only the journal-line trigger (`SECURITY DEFINER`, still under FORCE RLS) updates account balances. It does so with an `UPDATE` that takes the row lock and re-reads the latest committed row. Concurrent postings therefore serialize, and `CHECK (balance >= 0)` rejects any overdraw.

## Service behaviour
- **Lock order:** accounts are locked first, `ORDER BY id FOR UPDATE`, so entries touching several accounts cannot deadlock. Each account can appear at most once per entry, so every posting moves an account by exactly one version.
- **Insufficient funds:** a funds shortfall is computed in PostgreSQL on the locked rows. It returns `INSUFFICIENT_FUNDS` with the shortfall, posts nothing, and does not consume the key.
- **Idempotency:** a per-key advisory lock serializes same-key requests. The same key with the same request (actor + body; trace ids excluded) replays the stored entry. A different request raises `LedgerIdempotencyConflict` (409).
- **Errors:** DB constraint failures (`23514`) surface as `LedgerInvariantError` after a full rollback.

## Atomicity
Each change is written in one tenant transaction, and any failure rolls all of it back:
- the journal entry and its lines;
- the account balances;
- chained audit: `LEDGER_ACCOUNT` before/after hashes per account, plus `JOURNAL_ENTRY` `JOURNAL_POSTED`, `JOURNAL_REVERSAL_POSTED` or `JOURNAL_REVERSED`;
- one `ledger.account-changed` outbox event per account version.

The event payload has no amounts or balances; consumers reload the authorized state.

## Reconciliation source
Posted `journal_lines` are the source of truth. `reconcile()` recomputes each account's debits, credits,
balance, version and running `balance_after` chain from the lines. It compares them with the stored projection,
and also checks the per-currency trial balance and that no entry is unbalanced. The baseline
`float_ledger_entries`/`tenants.float_account_balance` from spec 01 is not used. It was only a movement log and
is not double-entry (spec 07).

## Money
NUMERIC(15,2) strings only. TypeScript validates the canonical format, and PostgreSQL NUMERIC does every sum,
comparison and delta. That means no JS float math and no new dependency. Posting copies amounts and never
rounds, so there is no `decimal.js` rounding step here.

## Not in scope
Payment intents and their state machine, bank adapters, callbacks, reconciliation records/HTTP endpoints, and
multi-currency (the service accepts VND only, although the schema checks balance per currency) are follow-up
payment tasks. Postings made with raw SQL as `tpa_app` stay balanced and protected, but they bypass the service's
audit/outbox, so application code must use this service.
