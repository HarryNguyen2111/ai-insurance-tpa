# API-C1/C2 shared contracts (#19, #20)

Contract proposals only; no endpoints, identity server, provider credentials or legal/benefit approvals. Source of truth: `../../docs/ai-specs/02-openapi-contracts.yaml` (OpenAPI 3.0.3, API version 1.2.0). API-C2 completes the EOB and workbench line contracts and adds the versioned benefits/payment/search/export/catalog contracts. API-C1 operations, headers, security, errors and schemas are preserved semantically and compared to the prerequisite snapshot in tests. `/health` remains the existing process-only endpoint and is not expanded here.

## Commands and compatibility

Use repository Node 24.22.3 and pnpm 10.34.9:

```
pnpm install --frozen-lockfile
pnpm --filter @tpa/shared-contracts generate
pnpm --filter @tpa/shared-contracts typecheck
pnpm --filter @tpa/shared-contracts test
```

`test` runs Redocly lint, Swagger Parser structural/reference validation, deterministic generated-artifact drift checks and Node schema fixtures. Root Turbo typecheck/test/build discovers this package. `generate` uses upstream openapi-typescript for types and openapi-schema-to-json-schema for dereferenced draft-04 schemas. Runtime Ajv + ajv-draft-04 + ajv-formats validates without defaults/coercion/removal, returns a boolean and never logs/echoes input. Call `validate('ClaimSubmit', unknownInput)`; use generated `paths`, `operations`, `components` types separately. A successful boolean does not establish authorization or legal validity. Adapters must normalize/select HTTP headers and reject unknown query keys before validating their values.

Pinned and actually exercised: openapi-typescript 7.13.0, Redocly CLI 2.83.0, converter 5.1.1, Swagger Parser 13.1.0, Ajv 8.20.0, ajv-draft-04 1.0.0, ajv-formats 3.0.1, YAML 2.9.1, TypeScript 5.9.3. openapi-typescript requires TS `^5.x`; using core's TS 6.0.3 produces an npm peer conflict, so this package pins TS5 without changing core. Converter emits draft-04; Ajv's default draft-07 cannot consume it, hence upstream draft-04 support. The runtime is CommonJS for compatible upstream import typing; generated/client types remain ESM-compatible.

Upstream references: [openapi-typescript](https://openapi-ts.dev/introduction), [Redocly lint](https://redocly.com/docs/cli/commands/lint), [converter](https://github.com/openapi-contrib/openapi-schema-to-json-schema), [Ajv draft-04 support](https://ajv.js.org/json-schema.html#draft-04), [Ajv formats](https://ajv.js.org/guide/formats.html). No custom generator platform or schema dialect translator.

## Server obligations

Tenant comes from a verified principal and active server-issued membership context, never request tenant IDs. Object references must be checked for owner/guardian/assignment, membership, member and version. Inaccessible objects return 404; authenticated action denial 403. Staff MFA comes from verified provider claims. Token and membership revocation must be checked on retries as well.

Mutation keys are tenant/actor/operation scoped with durable canonical request hashes and at least 24h retention. Identical retry returns original status/body; mismatched body 409 IDEMPOTENCY_CONFLICT; concurrent in-progress 409 OPERATION_IN_PROGRESS with Retry-After. Expiration is not permission to repeat a semantic side effect. Expected versions prevent stale preflight/claim attachment. Record business mutation, immutable audit hash chain and outbox in the same tenant transaction using SET LOCAL and FORCE RLS. No money computation here: all money is decimal string bounded to NUMERIC(15,2); computations use Decimal ROUND_HALF_UP downstream.

Upload sessions bind verified owner/member, unique immutable object key, type, checksum and size. Maximum proposed technical input is 20 MiB (not a pilot capacity commitment); server may impose stricter limits. Completion independently checks object metadata and quarantines; only CLEAN documents can enter preflight/claims/AI. No caller storage keys or fetch URLs. Scanner must enforce page/decompression limits, sniff types, block malware/SSRF/XXE and preserve original versions. Quarantined status is polled via document resource. Sensitive responses and signed URLs use no-store, are never logged, and cannot enter events/history/search. No raw PII, XML or OCR in service payloads; text fields still require upstream redaction and authorized access.

AI result is a proposal, never a monetary approval/rejection. Core verifies authenticated extraction run, claim version, document versions, evidence references and source-verification provenance. Parsing is distinct from tax verification. Confidence/similarity are signals only. Callback requires ingress service identity/mTLS AND HMAC over timestamp + newline + event ID + newline + exact body, ±300s replay window, constant-time digest check, header/body event ID equality and durable dedup/body hash. Reused ID with different body is 409; identical valid replay is acknowledged without repeated side effects. Neither schema nor signature establishes truth of evidence. No provider or contract exclusions inferred from warning names.

## Explicit unresolved blockers

- #12 / #21: OIDC issuer/audience/allowed algorithms/JWKS/key rotation, role and MFA claim mapping, token lifecycle, membership-context signing/revocation and principal linking require provider decisions. Generic bearer/verified-membership semantics do not approve a provider.
- #13 / #21: Zalo exchange's code/PKCE/state/redirect fields are a technical adapter proposal, **not verified Zalo support**. Actual flow, one-time proof verification, client binding and OIDC federation require official provider/sandbox evidence. Fail closed 503 PROVIDER_NOT_CONFIGURED until resolved; never mint identity from client user IDs.
- #11 / #26: approved consent purposes, policy text/version, guardian authority, evidence/retention and lawful processing dataset need accountable owner approval. Schema does not supply legal terms. E-card redemption protocol and provider integration need approval; opaque QR TTL <=60s is a technical requirement only.
- #13 / #28–31 / #39: tax-source verification semantics, Viettel response mapping/model/prompt versions, redaction evaluation, mTLS trust and HMAC secret rotation need provider/security evidence. No production credentials or foreign AI endpoints supplied.
- File limits, idempotency retention and replay windows are explicit technical proposals; pilot sizing and operational configuration still require validation. Benefits/EOB/payment shapes are specified by #20; provider configuration remains blocked.

## Evidence limits and acceptance mapping

Fixtures use synthetic UUIDs, dates and `.invalid` domains. Positive fixtures cover scoped components; negative fixtures cover required fields, unknown/client tenant fields, money, versions, MIME/size/path/checksum and asynchronous states. Status-specific schemas cover 401/403/404/409/422/429/503. Header/key fixtures establish shape only. The runtime callback-header object is generated directly from the OpenAPI operation header parameters.

PT15 maps file constraints/quarantine semantics, PT16 maps required service signature/event/time fields and minimal versioned result, PT22 maps required key/version and 409 error contract. These do **not** execute scanner attacks, signature verification, replay-window/dedup persistence, authorization, concurrency or platform scenarios. TC04's unchanged expected warning is checked for response-schema compatibility only; no preflight business engine is implemented. TC01–03/05–06 require the future benefit engine; no full golden/platform PASS claimed.

The remaining baseline lint warning is missing `servers` (no provider/server invented). Three additional `no-unused-components` warnings are intentional for the C2 event-only roots declared under `x-domain-events`; they have generated types/runtime schemas and positive/negative fixtures, but no invented HTTP event endpoint. C2 completes the two legacy operation IDs; strict schema/reference/security lint errors still fail.

## API-C2 scope and server obligations

This is a contract-only proposal before endpoint implementation. It creates no endpoint, DB migration, workflow, money engine, provider adapter, issuer, identity server or UI. Versioned policy/rule creation and reads expose approved immutable source/config references, not invented policy values. Calculation snapshots include stable line order, input/output hash and rule/config/catalog/model/prompt/engine versions. Policy-specific extra rules resolve through the immutable configuration reference; missing terms require review. Money maps to Decimal ROUND_HALF_UP and PostgreSQL NUMERIC(15,2), never JSON floats or Elasticsearch arithmetic. Runtime schemas enforce shape/bounds only, not sums, rounding or conservation.

EOB publication creates an immutable version and atomically adjusts reservations; first publication requires version 0 without a prior hash, replacement requires both current version and hash. A new version invalidates old OTP challenges, signatures and insurer approvals. Line decisions require immutable cited clause provenance and explanationVi; published snapshots cannot be overwritten. Once payment is submitted, EOB/payee/amount edits are blocked pending a controlled adjustment. OTP is bound to member/claim/EOB version/hash with durable expiry, resend/attempt caps and one-time use; exact delivery/code semantics remain pending. Plaintext codes must not enter logs, telemetry, events or workflow history. Schema validation cannot enforce expiry, identity, challenge consumption or hash verification.

Insurer decisions derive maker/checker stage and actors server-side; checker must differ from maker and reference a current maker decision. Thresholds and required approvals resolve from approved configuration, never example amounts. Original receipt requires actual staff verification, immutable receipt evidence and received document IDs; a tracking code alone is insufficient. Finance verifies current signature/approval/original/reservation/funds gates under lock before payment intent creation. Amount/currency/payee derive from approved snapshots. Semantic payout keys remain unique beyond transport idempotency retention. UNKNOWN never permits blind retry: only independently verified callback/query/reconciliation evidence may resolve it. A new attempt after FAILED requires definitive non-success evidence. PAID requires confirmed success plus atomic reservation consumption, balanced journal, audit and outbox. POSTED journals are immutable; corrections require a new balanced reversal referencing the original. No journal mutation API is added.

The payment callback is a generic **internal** adapter contract, not a bank wire protocol or confirmation that any bank supports these fields. It requires service identity/mTLS AND HMAC raw-body verification, the same explicit timestamp/event header boundary as C1, replay-window checks and durable service/payment/attempt/event plus body-hash deduplication. Header/body IDs must agree. Stale/reordered/conflicting status cannot downgrade success. Core independently verifies provider evidence, payment/attempt binding and immutable payout snapshot. These checks, service trust/key rotation and bank idempotency are not implemented by the schema. Internal bodies contain opaque references, not raw bank payloads, account numbers, document text or caller tenant IDs.

Search accepts only exploded `status`, `benefitType`, `cursor`, `limit` query fields (`style: form`, `explode: true`); adapters reject unknown keys before runtime validation. Server injects verified tenant and object permissions for query/get/mget/count/suggest/aggregation/export. Projection returns only IDs, status, benefit type, version and timestamp, with explicit eventual consistency. No free-text PII or DSL, arbitrary fields or money aggregation. PostgreSQL detail remains authoritative; search outages must not block submit/payment. Export checks every payment at create/execute/download, uses an asynchronous status resource and private signed URL TTL <=300s. Revocation requires an authorized gateway when object storage cannot revoke a granted URL. Fixed columns exclude PII. CSV writers must neutralize formula prefixes `=`, `+`, `-`, `@` after whitespace/control, then quote/escape cells; XLSX writers use text cells. These are writer obligations, not executed CSV attack tests.

Catalog proposals are tenant-scoped, have immutable line/evidence/clause provenance and do not modify a global catalog. A separate authorized reviewer (different from proposer) reviews the current proposal/catalog version. Global curator authority is provisioned separately, never inferred from tenant membership. Approval creates a new scoped version; previously cited versions remain immutable.

## Pending owner/provider decisions (not approvals)

- #11: actual approved policy text/clauses, benefit values, thresholds, guardian/consent/signature legal effect, dataset and retention remain pending.
- #12: issuer, audience, algorithms/JWKS, membership/permission/MFA mapping, service trust, key lifecycle and identity evidence remain pending. Described roles are permissions, not a new identity server or assumed provider claims.
- #13: actual bank status/idempotency/callback/reconciliation semantics, Zalo exchange/message/OTP capabilities, approved adapters and sandbox evidence remain pending. Technical internal HMAC and opaque OTP shapes do not assert provider support.
- #14: independent security/readiness decisions and provider sign-off remain pending; this PR neither edits nor substitutes for its decisions/security documentation.

Until these are resolved, provider-dependent behavior must fail closed with 503 PROVIDER_NOT_CONFIGURED. Synthetic fixtures are shape evidence only, not approved policy terms, actual bank behavior or usable signature proof. Technical replay windows, retention/input bounds and signed URL TTL are proposals needing operational validation.

## C2 evidence mapping (schema-only)

| Original scenario | Executed contract coverage | Still required at runtime |
| --- | --- | --- |
| TC01/02/03/05 | Unchanged golden expected money/routing fits Money/calculation schemas | Decimal engine, conservation, caps, routing and clauses |
| TC06 | Unchanged expected routing fits calculation schema; no amount inferred | Waiting-period engine, evidence and routing |
| PT09 | Query/projection/export allowlists reject tenant/DSL/PII field shapes | Real cross-tenant query/get/count/suggest/aggregation/export authorization |
| PT11 | Exact EOB version/hash required; first/replacement publish pairing | Durable invalidation of old OTP/approval/reservations |
| PT12 | UNKNOWN shape, minimal authenticated callback headers/payload | Bank timeout, evidence validation, concurrency, dedup and no second payout |
| PT13 | Receipt evidence/documents and payment gate references required | Actual receipt, maker-checker, signature expiry, locks/funds |
| PT18 | Provenance and expected catalog/proposal versions required | Separate reviewer authority and immutable catalog publication |
| PT22 | Mutation key/version/hash and shared 409 shapes, C1 preservation | Durable canonical hash/replay/semantic uniqueness |
| PT24 | Challenge/verification fields and no code leakage in outputs | Rate limits, durable attempt caps, expiry and one-time use across restarts |

`c1-baseline.json` is a semantic snapshot of C1 from origin/main `4a35e84fb488672609975a9ef724d0a1c53b5600`; tests compare every preserved operation and component. It is not a replacement for original golden expectations. C2 fixtures use synthetic data, with positive/negative boundaries and required-field checks. No PT or business golden PASS is claimed; only schema compatibility and existing scaffold checks are executed.

C2 event schemas are explicit `x-domain-events` roots in OpenAPI and use the same upstream generation/runtime validation. `eob.published`, `payment.status-changed`, `catalog.proposal-reviewed` contain only immutable IDs/version/hash/status references in a versioned outbox envelope, never PII, raw evidence, OTP, URLs or money totals. Tenant is assigned by trusted core. Consumers require durable inbox dedup and aggregate version/order/gap handling. Compatibility policy: keep emitted `schemaVersion=1.0.0` shape immutable; breaking required-field/type/enum changes require a new schema version and dual-version consumer migration before publication. These fixtures validate the current shape, not Schema Registry compatibility, Kafka delivery or actual emitters.


Payment-attempt continuity: authorized `GET /v1/payments/{paymentId}` and intent creation share `PaymentIntent`. `attemptId` is a stable server-created non-PII UUID, optional only while CREATED and required in SUBMITTED/UNKNOWN/SUCCEEDED/FAILED responses. Finance copies the applicable attempt, payment ID, aggregate version and EOB binding from this authorized read into reconciliation, even if no callback arrives. Transport retries/timeout do not regenerate the attempt or submit again. Core must verify the attempt belongs to the payment and current obligation, reject stale/mismatched references with 409 STALE_VERSION, and independently verify evidence. Shape tests prove the read-to-reconciliation contract can be constructed and reject missing/malformed attempt references; they do not execute provider reconciliation or authorization.

## WSC1 workspace administration contract (API 1.3.0)

Contract only. Source of the design: `docs/ai-specs/13-workspace-onboarding-and-branding-proposal.md`. Owner decisions recorded 2026-11-26:

- **OD-05:** TPA operations create workspaces and name the first `WORKSPACE_ADMIN`.
- **OD-02:** TPA assigns the slug at creation; it cannot be edited via profile updates.
- **OD-WS1:** low colour contrast is a `LOW_SURFACE_CONTRAST` warning, never a rejection.
- **Still open:** OD-01 and OD-WS2–WS5.

Eight bearer + `X-Membership-Context` operations under `/v1/admin/workspaces`:

- **Create and read:** create, get.
- **Updates:** profile, theme, logo selection.
- **Logo assets:** presigned upload, complete (202), status.

Every mutation requires `Idempotency-Key` and MFA; updates also require `expectedVersion`. All responses are no-store.

The C1 error and role components are untouched (snapshot test): slug conflicts map to 422 `DOMAIN_VIOLATION`, and workspace roles are provisioned through #21. No schema accepts or returns `tenantId`. Only the internal `workspace.changed` outbox envelope carries the trusted tenant, and its payload is just `changeKind`.

Logo handling:

- Only PNG, JPEG or WebP, at most 2 MiB raw; SVG is never accepted.
- Bytes go only through a presigned URL.
- Processing re-encodes the image and returns fixed rejection codes.
- A logo becomes active only after explicit activation of a READY asset.

The public branding endpoint, the TPA ops workspace list and slug changes are not part of WSC1.

`test/workspace-contracts.test.mjs` and 98 fixtures in `test/workspace-fixtures.json` cover:

- the operation inventory;
- how the decisions are encoded;
- the absence of tenant selectors;
- the logo flow;
- parity with spec 13;
- FE/BE parity: the same normalized inputs are accepted or rejected by the contract and by the workbench prototype validators.

`types.ts` adds compile-time checks. The new event-only root adds one intentional `no-unused-components` lint warning (5 total). WS01–WS12 runtime cases (authorization, idempotency persistence, concurrency, logo pipeline, audit/outbox) are **not executed**: there is no endpoint, migration or identity yet.
