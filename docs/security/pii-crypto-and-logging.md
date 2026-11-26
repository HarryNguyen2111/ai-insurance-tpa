# SEC-01: synthetic PII crypto and core API logging

Issue #17 implements local development/test primitives, not production readiness.
No real data, provider credentials, network crypto service, authentication server,
DB migration or backfill job is included. Production KMS, identity, legal retention
and provider choices remain owner gates #11/#12/#14. Do not enable this dev adapter
in staging/production or treat environment keys as a production KMS integration.

## Envelope and caller boundary

`@tpa/security` uses Node 24 `node:crypto`, AES-256-GCM, a random 12-byte nonce
per encryption, a full 16-byte tag and an explicit key version. The JSON text has
exactly `version:1`, `algorithm:"AES-256-GCM"`, `keyVersion`, `nonce`, `ciphertext`,
`tag`; binary fields use canonical padded base64. Unsupported formats, missing
keys, malformed fields and authentication failures return the same `PiiCryptoError`
without inputs or an OpenSSL cause. No unauthenticated plaintext is returned.
Inputs are bounded to 4096 UTF-8 bytes and envelopes to 16384 characters.

AAD is UTF-8 JSON of the tuple
`["tpa.pii",1,"AES-256-GCM",keyVersion,tenantId,recordId,field]`.
Tenant and record identifiers must be stable opaque identifiers (1–128 ASCII
letters, digits, underscore or hyphen), and field is `cccd`, `phone` or
`bank_account`. Context must come from the server's future verified principal,
authorized tenant/object access and actual persisted record identity. Allocate a
stable record ID before encryption. Moving ciphertext to another tenant, record
or field fails authentication; callers must explicitly decrypt/re-encrypt only
after authorization when moving data. This is integrity binding, **not authorization**.
A caller with a key and correct context can decrypt. The module grants no access.

CCCD lookup is lowercase hex SHA-256 of the exact twelve ASCII digits, preserving
leading zeros. Whitespace/non-digit/other lengths are rejected, never silently
normalized. Encryption key rotation leaves this lookup unchanged. The hash is
unsalted by the approved lookup requirement and remains enumerable/sensitive;
never log/export it, and require tenant-scoped authorized lookup plus rate limits.
Phone/bank values are preserved verbatim; domain validation belongs to future APIs.

## Explicit synthetic environment keys

`PiiCryptoService.fromDevelopmentEnv(env)` requires all of:

- `NODE_ENV=development` or `test` (missing, staging and production are rejected).
- `PII_DEV_KEYS_ENABLED=true`.
- `PII_DEV_KEYS_JSON`: JSON object mapping opaque key versions to canonical base64
  of exactly 32 random bytes (maximum 16 versions).
- `PII_DEV_ACTIVE_KEY_VERSION`: an existing version for all new writes.

There is no fallback key or sample secret committed here. Generate synthetic
keys with a cryptographic RNG in a local process and inject them without printing
them or adding them to Git/shell history/logs. Tests generate ephemeral random keys.
Instances snapshot key material as private Node KeyObjects; changing env requires
creating/restarting instances. JavaScript strings and process environment cannot
be guaranteed zeroized; even though temporary decoded key buffers are cleared,
this is unsuitable for production key lifecycle requirements. Never serialize or
inspect crypto objects/environment in telemetry.

## Rotation and future backfill design (not an executed DB migration)

1. Owner approves KMS/provider, identity, decrypt permissions, key scope, nonce
   usage budget, rotation cadence, retention/legal hold, backup recovery and
   break-glass policy. A future production adapter needs authenticated KMS wrapping,
   workload identity, fail-closed access and service tests; this module does not
   pretend to implement those. Enforce conservative per-key write budgets before
   production; random nonces do not eliminate birthday collision risk.
2. Make both old/new versions readable on every writer/reader before switching
   the active write version. Canary on synthetic data and verify unauthorized
   contexts fail. Then switch writes to new; retain old for reads. Never silently
   fall back to another key or version when authentication fails.
3. Future backfill enumerates authorized tenant records in bounded resumable
   batches using `withTenantTransaction(tenantId, ...)` / transaction-local tenant
   context on the eventual real schema. Do not bypass RLS or use an app superuser.
   Inside that transaction, lock/recheck the record (or use an expected envelope
   version compare-and-swap), authenticate old ciphertext and create fresh ciphertext
   with the same tenant/record/field context. `reencrypt()` is only a pure transform;
   it performs no persistence, locking, scheduling or authorization.
4. Write the new ciphertext and safe rotation metadata, append an immutable audit
   entry through the future chain-head locking service, and write any minimal outbox
   event **in the same tenant transaction**. Do not put plaintext, key material,
   hashes, envelopes, raw docs or before/after PII in audit payloads/events. Use
   approved opaque references/version counters. Consumers use inbox/dedup; retry
   after interruption must recheck current version and skip already-migrated rows.
   A failed decrypt or audit/outbox write rolls back the batch mutation; report a
   fixed failure category without the input. Avoid overwriting concurrent PII edits.
5. Verify decrypted CCCD hashes against stored lookup values inside authorized
   processing, retaining existing lookup values only when equal. Quarantine/review
   inconsistencies rather than silently changing lookup semantics. Verify old/new
   readability and coverage with safe aggregate metrics; never export decrypted
   values to prove success. Progress checkpoint must commit consistently with work.
6. Retire old reads only after all live versions/replicas/queues and approved backups
   are accounted for and a recovery drill passes. Old backups need approved old-key
   availability or an approved replacement strategy through retention expiry/legal
   hold. Keep rollback possible during migration; new ciphertext cannot be read by
   old-only instances. Do not delete keys merely because live-row migration finished.

No nonexistent business tables are mutated here; this design does not depend on
unmerged RLS work. DB transaction/audit/outbox/backfill concurrency and KMS recovery
are future integration acceptance, not proven by pure transformation tests.

## Logging boundary and tradeoff

Core bootstrap installs `SafeLogger` before Nest initialization. It implements
Nest's upstream `LoggerService` and delegates output formatting, JSON records and
levels to the pinned Nest `ConsoleLogger` 12.6.0. Every arbitrary message, nested
field, metadata, stack, cause, context and extra parameter is suppressed as
`REDACTED_LOG` without traversing objects or invoking serialization hooks. This
intentionally sacrifices free-text diagnostics: field-name blacklists cannot stop
PII embedded in errors or unknown fields. Future useful events must be separately
reviewed fixed-schema events, not arbitrary strings. The one explicit lifecycle
method accepts a loopback listener URL and emits only its validated host/port;
other addresses yield `SERVICE_LISTENING`. Bootstrap rejection is caught and logs
through the same boundary with a failing process exit code.

This covers Nest system/application logs routed through the installed logger.
Direct `console.*`, raw stdout/stderr, Node runtime warnings, third-party logging,
proxy/access logs, crash dumps and other services are separate boundaries; callers
must not send sensitive values there. This is not a whole-process interception or
an authorization filter. No request body/header logging is added.

Compatibility verified using registry metadata for `@nestjs/common@12.6.0` and
`@nestjs/core@12.6.0`, installed interface declarations, and actual Node24/Nest
unit/HTTP/compiled tests. Core's common/platform peers require Nest12, RxJS ^7.1
and reflect-metadata ^0.1.12 or ^0.2.0; pinned RxJS7.8.2/reflect-metadata0.2.2 fit.
No new logging library or runtime dependency is needed.

Upstream references: [Nest custom logger](https://docs.nestjs.com/techniques/logger),
[Node24 authenticated crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html).

## Acceptance coverage

`packages/security/test/crypto.test.ts` executes all three field round trips,
independent Node GCM interop, nonce variation, metadata/ciphertext/tag/nonce tamper,
wrong/unknown keys, aliased key-version tamper, tenant/record/field swaps, malformed
inputs, explicit dev config rejection, dual reads/new writes, re-encryption,
old-key retirement and lookup preservation. These are synthetic crypto integration
and unit tests, not actual database rotation/backfill or KMS tests.

`apps/core-api/src/logging/safe-logger.spec.ts` captures actual stdout/stderr and
scans for a synthetic marker across all levels, nested/unknown sensitive values,
Error/cause/stack/context, buffers, cycles, serialization hooks, contextual/static
Nest loggers and an HTTP500 failure through Nest's exception handler. It also
checks safe listener output. Core e2e/build/compiled smoke preserve bootstrap,
health and shutdown behavior. Exact execution results belong to the PR evidence.

This is only the crypto/core-logger subset of PT17. Kafka, Temporal history,
Elasticsearch, DLQ, document authorization, foreign-AI egress and production
telemetry/retention have no applicable end-to-end runner here and are **unexecuted**.
Golden TC01–TC06 business money/routing behavior is not changed or claimed by these
security tests; root contract tests validate contracts, not future business engines.
