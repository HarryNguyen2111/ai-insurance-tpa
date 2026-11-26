# Database foundation (#15)

This is an incremental, synthetic/dev foundation, not a production schema. It
creates an empty `tpa` schema and private Drizzle migration history, not the
baseline business tables. No API/database runtime client is wired into core-api.

## Verified tooling

Use the repository Node **24.22.3** and pnpm **10.34.9** pins. Package versions are
locked: Drizzle ORM **0.45.4**, Drizzle Kit **0.31.11**, pg **8.23.1**, TypeScript
**6.0.3**. ORM's published peer range accepts pg >=8. The stable 0.x Kit/ORM pair
was exercised here; current upstream docs also discuss the newer prerelease
layout, which is not this repository's migration format.

Official references:

- [Drizzle PostgreSQL driver](https://orm.drizzle.team/docs/get-started-postgresql)
- [Drizzle migrations](https://orm.drizzle.team/docs/drizzle-kit-migrate)
- [Drizzle custom migrations](https://orm.drizzle.team/docs/drizzle-kit-generate#custom-migrations)
- [pg type handling](https://node-postgres.com/features/types)
- [PostgreSQL 16 privileges](https://www.postgresql.org/docs/16/ddl-priv.html)
- [Default privileges](https://www.postgresql.org/docs/16/sql-alterdefaultprivileges.html)

Integration uses the existing #3 image pin:
`pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8`.
The test verifies actual PG16, extensions, roles and SQL operations; it does not
substitute a mock, SQLite or the host's unrelated databases.

## Bootstrap and migrate a dedicated dev database

Use a database owned by a separate administrator. Do not use a shared application
or Temporal database. The fixed cluster role names `tpa_migrator` and `tpa_app`
are intended for a dedicated dev cluster; bootstrap rejects elevated roles,
role memberships and ownership of the current database. It revokes PUBLIC
CONNECT/CREATE/TEMP on that database and restores only explicit role grants.
Coordinate administrator access before running it on any existing database.

1. Connect as administrator using `PGSERVICE`/a local pg service file, or another
   external secret source. Do not put credentials in tracked files or command
   arguments. Run from the repository root:

   ```sh
   psql -X --set ON_ERROR_STOP=1 --file infra/migrations/bootstrap.sql
   ```

   Bootstrap installs `vector`, `pg_trgm`, `pgcrypto` as administrator and creates
   login roles without passwords. It is transactional and safe to repeat on the
   dedicated dev database; it never resets passwords. Existing #3 extensions are
   compatible and left installed. This is separate from tracked Drizzle SQL
   because extension installation must not require a superuser migrator.

2. In the administrator's interactive psql session, provision distinct local
   passwords with `\password tpa_migrator` and `\password tpa_app`, or use your
   secret manager. The example in `packages/database/.env.example` contains only
   placeholders and is not loaded automatically.

3. Supply `MIGRATION_DATABASE_URL` for **tpa_migrator** through the environment and
   run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm db:migrate
   pnpm db:migrate
   ```

   Supply `DATABASE_URL` for **tpa_app** only to a future application integration.
   There is no fallback from migration credentials to application/admin URLs.
   The migration runner also checks the authenticated database role and PG16.
   CLI failure output deliberately excludes driver errors/URLs/SQL values.

`0000_application_schema.sql` creates the empty schema. `0001` removes automatic
future table/sequence grants and PUBLIC function EXECUTE defaults; the app can
use the schema but cannot access future objects without an explicit grant.
Drizzle owns `drizzle.__drizzle_migrations`; the app cannot read/write it. The
migrator owns application/migration objects but neither role owns the database
or has SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION. App cannot CREATE
in public/tpa, CREATE TEMP, ALTER/DROP/TRUNCATE objects or SET ROLE to the owner.

The runner uses the official Drizzle node-postgres migrator with a dedicated
connection and advisory lock. It validates the applied history is an exact
hash/timestamp prefix of committed files; changed, removed or reordered applied
SQL is rejected. Pending migrations run in Drizzle's transaction. Failure rolls
back DDL/history and closing the connection releases the lock. Bootstrap and
migration connections are direct administrative paths, not PgBouncer app paths.

## Add the next migration

Update `packages/database/src/schema.ts`, then `pnpm db:generate`. For reviewed
SQL such as policies/default grants use `pnpm db:generate --custom --name NAME`.
Commit SQL, journal and snapshots together. Custom schema changes must be
represented in snapshots; the initial custom migrations record the empty `tpa`
schema. `pnpm db:generate` on this checkout produces no further migration.
Never edit applied SQL: append an expand/contract migration and keep application
rollback separate from data recovery. Do not use `drizzle-kit push` on a deployed
database or bypass this runner with `drizzle-kit migrate` (which lacks its
history validation/serialization).

Future grants must name specific tables/operations. Do not default-grant all
future tables or grant TRUNCATE/ownership to app. The tenant helper added in #16 is described below. Future domain tables and
their grants must land with FORCE RLS, USING/WITH CHECK, composite constraints
and queries through `withTenantTransaction` using transaction-local context. #17 implements crypto; #18 implements
immutable audit. Per spec 07, later domain migrations cover identity/membership,
versioned contracts/EOB, reservations, OTP/approvals, payment/journal,
outbox/inbox/idempotency, evidence/documents and governance. Each needs its own
constraints and integration evidence; this issue does not pre-create them.

## Verification and limits

```sh
pnpm typecheck
pnpm test
pnpm db:test:integration
pnpm test:e2e
pnpm build
pnpm test:smoke
```

`db:test:integration` requires local Docker. It starts one unique container with a
random loopback port, synthetic random password, tmpfs data, 384 MiB/one CPU
limit and `ao.session` label. It removes its container and temp files in finally;
it never starts Compose, changes unrelated containers or leaves a volume.
If interrupted externally, remove only its named `tpa-db15-*` container.

Executed DB assertions: fresh/repeat/concurrent migration history, incremental
upgrade equivalence, missing bootstrap rejection, altered-file detection,
failed-DDL rollback and lock recovery, role attributes/ownership/membership,
real app connection privilege negatives, no default table/function access, and
pg + Drizzle `NUMERIC(15,2)` roundtrip/JSON strings including bounds/overflow.
The numeric fixture is synthetic test-only; no money arithmetic is introduced.
Future calculations must use Decimal ROUND_HALF_UP and JSON strings.

The #15 suite covers the **PT01 role subset only**. The #16 suite below adds
representative tenant isolation, PgBouncer reuse and composite FK checks; actual
domain/API PT01 coverage remains pending.
Golden TC01–TC06 and all other PT cases remain pending their domain runners.
No production acceptance, crypto/audit/payment correctness, staging/deployment,
backup/restore or security compliance claim is made by these checks.

## Tenant transaction foundation (#16)

`@tpa/database/tenant` exports `createTenantDatabase(config)`. Keep its pool
configuration at the trusted server composition root; it exposes only
`withTenantTransaction(tenantId, async tx => ...)` and `close()`, never a raw pool
or client. The callback receives a query-only `TenantTransaction`; it rejects use
after callback completion or rollback. All callback queries must be awaited;
the implementation also drains pending operations and rolls back if a query
failure was swallowed. Query text is trusted repository code, values are bound
parameters. This capability is not a SQL sandbox: do not pass request SQL, issue
transaction-control/session-setting statements, or expose it to callers.

The tenant UUID argument is a server-side interface **before identity
integration**. UUID format validation is not membership verification. A future
adapter must verify issuer/audience/expiry and active principal membership,
then pass that granted tenant; never copy a body/header/query tenant ID. No
identity endpoints or claim repositories are wired by this change.

The helper checks the actual role is unprivileged `tpa_app`, acquires one client,
starts `BEGIN`, executes parameterized
`SELECT pg_catalog.set_config('app.current_tenant_id', $1, true)`, then commits or
rolls back on that same client. `true` is PostgreSQL's transaction-local setting,
equivalent to SET LOCAL; it is not a session SET. Failed rollback destroys the
client. Application code must not use migration credentials. The role/bootstrap
invariants from #15 remain required; runtime role validation supplements them.

Migration `0002` adds only `tpa.current_tenant_id()`, a STABLE SECURITY INVOKER
policy expression with a fixed `pg_catalog` search path. Missing/empty context
raises 42501; malformed UUID raises 22P02. Only `tpa_app` is explicitly granted
EXECUTE; PUBLIC is revoked. It changes no global table permissions and introduces
no runtime tenant-owned/business tables. PostgreSQL may avoid evaluating a policy
for an empty relation or an impossible predicate; the invariant is no rows read
or changed without valid context, not that every possible SQL query must throw.

### Pattern for future domain migrations

Every future domain migration must introduce its real schema, grants, constraints
and isolation tests together. Use `(tenant_id, id)` as a primary/unique key and
reference parents via `FOREIGN KEY (tenant_id, parent_id) REFERENCES
parent(tenant_id, id)`. Single-column UUID foreign keys are insufficient. Set
ENABLE **and FORCE** ROW LEVEL SECURITY on every tenant-owned table, with both
`USING (tenant_id = tpa.current_tenant_id())` and the same `WITH CHECK` expression.
Grant only the specific required SELECT/INSERT/UPDATE/DELETE operations; never
TRUNCATE, DDL, ownership or BYPASSRLS. Business state, audit and outbox must share
the same callback/transaction when those domains land.

Global tables require an explicit per-table boundary: a public reference catalog
may get SELECT only; private cross-tenant registries remain inaccessible to the
app. Any future invoice/allocation privileged operation requires a separately
reviewed narrow interface and concurrency/authorization evidence. There is no
global bypass grant, SECURITY DEFINER helper or generic elevated access here.

### Real PgBouncer integration and provenance

`pnpm db:test:integration` serially runs #15's PG suite and #16's real PgBouncer
suite. No existing Compose runtime is changed. The latter builds the unmodified
upstream **PgBouncer 1.26.1** release, dated 2026-10-14, from the official tarball:

- [Upstream release and checksum](https://www.pgbouncer.org/downloads/)
- [1.26.1 SHA-256](https://www.pgbouncer.org/downloads/files/1.26.1/pgbouncer-1.26.1.tar.gz.sha256):
  `00886a2994b4844cd37110970df777772cfc42a74c400522c82fba509a3f42d9`
- [Upstream ISC license](https://github.com/pgbouncer/pgbouncer/blob/pgbouncer_1_26_1/COPYRIGHT)
  is retained inside the test image. No custom pooler implementation.
- Official Alpine **3.23.2** base, manifest digest
  `sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62`.
  The source and base are pinned; Alpine build dependencies use that release's
  maintained package repositories, so this is not a bit-reproducible image claim.
- [PgBouncer feature compatibility](https://www.pgbouncer.org/features.html),
  [configuration](https://www.pgbouncer.org/config.html), and
  [PG16 transaction-local settings](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADMIN-SET)
  inform the test. It verifies the binary version and PG16 at runtime.

The committed test config uses `pool_mode=transaction`, one backend connection,
zero reserve pool and no forced reset after transactions (no DISCARD ALL masking
context leaks). Multiple frontend connections reuse the same measured backend
PID. SCRAM authenticates only the real `tpa_app` role. Admin/migrator connections
are direct, for bootstrap/fixtures only, not for the isolation assertions.

All `isolation_*` tables are **test-only representative synthetic relations** in
`packages/database/test/fixtures/tenant.sql`; they are not migrations or fake
business tables. Parent/child fixtures have FORCE RLS and composite tenant keys.
Global fixtures demonstrate explicit read-only versus no-access boundaries.
The runner creates a uniquely named network, two labeled containers, random
loopback ports, ephemeral PostgreSQL tmpfs data and synthetic random passwords.
PostgreSQL is limited to 384 MiB/1 CPU and PgBouncer to 128 MiB/0.5 CPU. Cleanup
removes only its owned containers/network/image tag/temp configuration; no
persistent volume, host configuration, unrelated container or production data
is used. If externally interrupted, identify only this run's `tpa-db16-*`
resources and their `ao.session` label before removing them.

Automated assertions cover the PT01 **representative database foundation**:
actual app role and ownership; FORCE RLS/USING/WITH CHECK; tenant A/B cross reads,
inserts, updates, deletes and composite parent references; missing/malformed
contexts; rollback and swallowed-query failure; expired callback capabilities;
concurrent tenant requests; a single reused backend after commit/rollback; and
DDL/TRUNCATE/elevation/global access negatives. The #15 NUMERIC string roundtrip
suite remains unchanged in behavior. No money arithmetic is introduced.

Actual claim/member/plan/document/EOB/payment migrations and API authorization
boundaries do not exist here and remain pending their own child issues. PT01
is not an all-domain or production tenant-isolation certification. Golden
TC01–TC06 have no relevant business runner in this foundation change; their
original expectations remain unchanged and pending domain implementation.
Other platform cases, crypto/audit/idempotency/contract enforcement and production
security/restore/load acceptance remain outside this verification.
