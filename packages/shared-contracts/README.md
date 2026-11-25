# API-C1 shared contracts (#19)

Contract proposals only; no endpoints, identity server, provider credentials or legal/benefit approvals. Source of truth: `../../docs/ai-specs/02-openapi-contracts.yaml` (OpenAPI 3.0.3, API version 1.2.0). API-C2 EOB and workbench line operations and EOB schema are preserved unchanged. `/health` remains the existing process-only endpoint and is not expanded here.

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
- File limits, idempotency retention and replay windows are explicit technical proposals; pilot sizing and operational configuration still require validation. Benefits/EOB/payment contracts belong to #20.

## Evidence limits and acceptance mapping

Fixtures use synthetic UUIDs, dates and `.invalid` domains. Positive fixtures cover scoped components; negative fixtures cover required fields, unknown/client tenant fields, money, versions, MIME/size/path/checksum and asynchronous states. Status-specific schemas cover 401/403/404/409/422/429/503. Header/key fixtures establish shape only. The runtime callback-header object is generated directly from the OpenAPI operation header parameters.

PT15 maps file constraints/quarantine semantics, PT16 maps required service signature/event/time fields and minimal versioned result, PT22 maps required key/version and 409 error contract. These do **not** execute scanner attacks, signature verification, replay-window/dedup persistence, authorization, concurrency or platform scenarios. TC04's unchanged expected warning is checked for response-schema compatibility only; no preflight business engine is implemented. TC01–03/05–06 require the future benefit engine; no full golden/platform PASS claimed.

Three baseline lint warnings remain: missing `servers` (no provider/server invented), and missing operationId on original EOB GET/workbench PATCH (API-C2). New scoped operations have IDs; schema/reference/security lint errors fail. Unused new components and duplicate YAML aliases were removed.
