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
future tables or grant TRUNCATE/ownership to app. No tenant queries are provided
by this package yet. Domain tables and their grants must land with FORCE RLS,
USING/WITH CHECK, composite constraints and `withTenantTransaction` using
transaction-local tenant context in #16. #17 implements crypto; #18 implements
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

This is **PT01 role subset only**. Tenant isolation, PgBouncer connection reuse
and composite FK tests remain pending #16; PT01 as a whole is not passed.
Golden TC01–TC06 and all other PT cases remain pending their domain runners.
No production acceptance, crypto/audit/payment correctness, staging/deployment,
backup/restore or security compliance claim is made by these checks.
