# @tpa/event-contracts — versioned domain event registry (EVT-01 #23)

Kafka domain events are internal outbox envelopes (spec 06 §4). This package is
the in-repo JSON Schema registry, its CI compatibility gate and the runtime
builder/validator used by `@tpa/database/outbox`.

## Envelope
`eventId, eventType, schemaVersion, tenantId, aggregateId, aggregateVersion,
occurredAt, correlationId, causationId, payload` — all required, closed object.
`tenantId` comes from the verified tenant transaction, never a request. Record
key = `tenantId:aggregateId` (`partitionKey()`); topic = `<prefix>.<domain>`
where domain is the event type's first segment (`topicName('tpa.dev','claim')`).
Ordering is guaranteed per aggregate key within one topic only.

## Registered events (all `1.0.0`)
| Event | Topic | Source |
| --- | --- | --- |
| claim.submitted | claim | spec 06 minimal set; empty payload (consumers reload) |
| claim.state-changed | claim | spec 06; `fromStatus`/`toStatus` ClaimStatus codes only |
| eob.published | eob | OpenAPI `EobPublishedEvent` (byte-identical) |
| payment.status-changed | payment | OpenAPI `PaymentStatusChangedEvent` |
| catalog.proposal-reviewed | catalog | OpenAPI `CatalogProposalReviewedEvent` |
| workspace.changed | workspace | OpenAPI `WorkspaceChangedEvent` |
| benefit.limit-changed | benefit | BEN-03 internal; aggregate = benefit limit account; changeKind + optional reservationId only |

## Compatibility policy (`pnpm --filter @tpa/event-contracts check:registry`, part of `test`)
- `registry/registry.json` pins every published version by sha256 of its
  canonical JSON. Editing a published schema fails CI: add a new version.
- Within a major version, each new version must be `BACKWARD_TRANSITIVE`
  compatible (new readers accept all older data). Closed objects mean adding an
  optional field is backward- but not forward-compatible. A breaking change needs
  a new major version, which consumers must adopt explicitly.
- `schemaVersion` is excluded from the structural comparison (each version pins
  its own value). Unknown/unsupported keywords that differ fail closed.
- Every envelope is closed; every string must be constrained by enum/format/
  pattern (no free text). OpenAPI-defined events must equal the generated
  `@tpa/shared-contracts` schema, and every OpenAPI `*Event` must be registered.

## PII (PT17)
Closed schemas are the primary control. `assertNoRawPii` additionally rejects
personal-data key names and any string that is not a UUID, sha256, date-time,
semver, Money string, enum code or event type, and non-integer numbers.
Validation errors carry schema paths/keywords only, never values or extra keys.

## Limits
- The dev Compose Apicurio registry is not yet populated from this registry;
  pushing artifacts/rules there (and to production registries) is follow-up.
- The checker supports the draft-04 subset these schemas use; anything else is
  reported as incompatible rather than guessed.
