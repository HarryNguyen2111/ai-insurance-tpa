# DB-03 immutable audit (synthetic technical foundation)

Use `appendAudit(tx, input)` from `@tpa/database/audit` inside the same
`withTenantTransaction` callback as the mutation. It does not start or commit a
transaction. Domain services must require the append; this foundation does not
implement claim/payment transitions or outbox writes. Tenant comes exclusively
from the existing transaction context, never an append argument. Identity and
object authorization remain the caller's responsibility.

## Canonical format v1

Hash SHA256 over UTF-8 canonical JSON containing exactly `tenant_id`,
`entity_type`, `entity_id`, `actor_type`, `actor_id`, `action`, `payload_diff`,
`sequence`, `version`, `occurred_at`, and `prev_hash`. Sort ASCII object keys,
recursively, with no insignificant whitespace; standard JSON string escaping.
Only objects and string leaves are supported. Version is `"1"`; sequence is a
base-10 bigint string starting at `"1"`. Genesis predecessor is 64 zeroes.
Database timestamp is UTC `YYYY-MM-DDTHH:mm:ss.SSSZ`, generated once per append;
`created_at` represents that same instant. Identity bigint `id` is not a chain
sequence and may have rollback gaps. It is deliberately excluded from the hash.

Metadata uses internal UUIDs and trusted uppercase code identifiers (letters and
underscores, up to 50 characters), never user text. Actor type is SYSTEM, USER or
SERVICE. Payload v1 is an object containing only optional `before_hash` and
`after_hash`, each a lowercase 64-hex commitment to an approved redacted state.
Unknown keys, nested content, numbers, raw identifiers, documents, names, OTPs,
phone/bank/CCCD values and free text are rejected. Do not hash low-entropy PII as
a substitute for encryption/redaction. This is a deliberately minimal payload
contract; a future extension requires a version and explicit review. This module
has no logging. It cannot certify redaction in other systems or PT17 as a whole.

SQL and TypeScript independently implement canonicalization and hashing; real
integration compares every stored row with the TypeScript verifier. Verify the
complete ordered chain against an independently retained expected head to detect
truncation, missing rows, forks and altered metadata. Checking hashes without a
trusted expected head cannot detect full-history replacement or tail truncation.

## Locking and access

The append function first inserts the composite `(tenant_id, entity_type,
entity_id)` head with ON CONFLICT DO NOTHING, then SELECT FOR UPDATE. Competing
first appends wait for the uncommitted unique key; subsequent appenders lock the
same head until commit/rollback. Sequence increment, log insert and head update
are transactional, with a unique chain sequence. Use READ COMMITTED (the existing
helper default); stronger isolation may raise serialization failures which callers
must handle by retrying the entire authorized mutation, never just the audit.
Lock multiple entities in a stable order if a future mutation touches several.

The function is SECURITY DEFINER owned by unprivileged `tpa_migrator`, has fixed
`pg_catalog` search_path and fully qualified relations, and derives the tenant
from `tpa.current_tenant_id()`. FORCE RLS applies to that owner too. App role has
only tenant-scoped SELECT and append EXECUTE; no direct INSERT/UPDATE/DELETE,
sequence access, head writes, anchor writes, TRUNCATE, DDL or role escalation.
UPDATE/DELETE triggers also reject modifications by the ordinary table owner.
This narrow function grants no tenant bypass or caller-controlled SQL capability.
Trusted server SQL still controls tenant context; the helper is not an SQL sandbox.

`audit_anchors` is an immutable, tenant-scoped local inventory reserved for a
separately authorized operator. No app write grant or automated anchor publisher
is added. Operators must compare the referenced log hash and retain signed head
commitments outside the writable database under independent custody. External
store, signer, schedule, retention and operator permissions need owner decisions;
none are claimed implemented. A DBA/superuser or migration credential can disable
triggers/rewrite history. Local chains/anchors alone do not protect against that.

PostgreSQL 16 behavior references:
- https://www.postgresql.org/docs/16/sql-insert.html
- https://www.postgresql.org/docs/16/explicit-locking.html
- https://www.postgresql.org/docs/16/ddl-rowsecurity.html
- https://www.postgresql.org/docs/16/sql-createfunction.html

## Verification scope

`pnpm --filter @tpa/database test` includes canonical vectors, payload rejection,
and verifier negatives. `pnpm db:test:integration` runs the real Docker PG16
PT02 suite via the existing glob, plus migration and tenant suites. It never skips
when Docker is unavailable. Containers use random names, loopback ephemeral ports,
CPU/memory/tmpfs limits and session labels; cleanup runs in finally.

PT02 mapping: blocked concurrent first append, 14 chained commits, transactional
mutation rollback for new/existing heads, no chain sequence gaps, payload rejection
rollback, privileges/RLS and immutable trigger negatives. PT17 mapping is only the
minimal audit payload boundary; Kafka/Temporal/search/DLQ are not implemented here.
Golden TC01–TC06 concern adjudication/preflight; DB-03 changes none of that behavior
and makes no claim those cases have executed. CI must run the combined checks and
real PG integration on the exact PR head; local Docker absence is not PASS.
