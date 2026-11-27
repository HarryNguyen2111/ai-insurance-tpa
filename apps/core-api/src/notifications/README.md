# NOTIF-01 notification inbox (#107, phase 1: contract + backend runtime)

In-app notification center backend for the Mini App and customer web. **Phase 1 = contract + runtime only.** The UI phase (bell, badge, list, filters, deep-link handling in `apps/zalo-miniapp` and `apps/workbench`) comes after #106 merges, in a separate session.

Contract: `docs/ai-specs/02-openapi-contracts.yaml` API 1.5.0, four additive operations (controller decision D1). Every 1.4.0 path and component is pinned byte-for-byte by `packages/shared-contracts/test/pre-notif1-baseline.json`.

| Operation | Purpose |
| --- | --- |
| `GET /v1/me/notifications` `listMyNotifications` | One explicit scope, newest first, keyset cursor, `status=UNREAD\|ALL`, optional `service`, `limit` 1..50 |
| `GET /v1/me/notifications/unread-count` `getMyNotificationUnreadCount` | Exactly the `UNREAD` list rows, capped at 999 with `capped` |
| `POST /v1/me/notifications/{id}/read` `markMyNotificationRead` | Mark one read; idempotent, monotonic |
| `POST /v1/me/notifications/read-all` `markMyNotificationsRead` | Mark the scope read up to an explicit `cutoff` |

## Scopes and authorization

- **PERSONAL**: the verified principal's own inbox (`tpa.personal_notifications`). It has no tenant column, so there is no `tenant=NULL` bypass. It uses principal-scoped RLS on `tpa.identity_principal_id()` through `IdentityStore.withPrincipal`, with no tenant context: any tenant table access fails closed. It works with zero memberships. `X-Membership-Context` is **rejected (422)**.
- **TENANT**: `tpa.tenant_notifications` under FORCE RLS: same tenant (`SET LOCAL`) AND recipient principal AND recipient membership still **active**. `X-Membership-Context` is **required (422 if absent)**. `IdentityStore.withMembership` re-authorizes it on every call: revoked membership 403, changed grant 409 `STALE_VERSION`, forged or foreign context 403.
- There is no mixed or all-tenant inbox. Personal home never enumerates tenant rows. An all-workspace aggregation would need a separate authorization and privacy decision.
- A notification ID from another user, tenant, membership or scope, an expired notification, or a malformed ID returns 404 and reveals nothing.

**Controller decision D3** exempts exactly these four operations from two generic contract invariants: the required `MembershipContext` header and `Idempotency-Key` on every POST. The exemption is an explicit allowlist in `packages/shared-contracts/test/notification-exemption.mjs`, guarded by `notification-contracts.test.mjs`. That guard fails if the list grows or a listed operation reaches money, claim-state, EOB, OTP, consent or payment schemas.

The rationale has two parts. PERSONAL must work without a membership. Mark-read is naturally idempotent: `read_at` is set once and never reverts, and repeats return identical state. AGENTS rule 6 covers claim creation, OTP confirmation and payout, and reading a notification is none of those.

## Read state

| Concern | Behaviour |
| --- | --- |
| Mark one | `UPDATE … WHERE read_at IS NULL`. Concurrent or cross-device repeats block on the row lock, re-check, and change nothing. Every caller gets the same server `readAt`. |
| Mark all | Only `created_at <= cutoff` in the same scope, membership and service. A future cutoff is 422. Notifications created after the cutoff stay unread. A repeat returns `markedCount: 0`. |
| Monotonic | DB trigger: only `read_at`/`version` change, once (1→2). Content is immutable and there is no DELETE. `tpa_app` has column-level UPDATE on `(read_at, version)` only. |
| Audit | TENANT first transitions are audited: `NOTIFICATION_READ` per notification, and `NOTIFICATION_READ_ALL` per effective read-all on the membership. The payload is a hash only. No-ops are not audited. PERSONAL read state is recipient UI state, not a tenant audit event (controller D2). |
| Meaning | Read/unread is in-app state only. It is not provider sent/delivered (#41/#13), and it never signs OTP, approves an EOB, accepts consent or advances a claim. |

`asOf` in list and count responses is the server statement time at microsecond precision; clients pass it back as `cutoff`. Residual limit: a producer transaction that stamped `created_at` before the cutoff but committed after the user's read can be included in a read-all covering that cutoff. The window is the producer's commit latency (one short insert + inbox transaction).

## Producer (event-worker `notification-projection`)

The consumer reads only the real implemented `claim.submitted` and `claim.state-changed` 1.0.0 events (#37/#24). It runs through the existing inbox in the event's tenant transaction. The recipient is the claim's submitting principal and membership from PostgreSQL, never from the event.

Only these allowlisted templates are produced (v1, fixed generic Vietnamese text):

- `CLAIM_SUBMITTED`
- `CLAIM_SUPPLEMENT_REQUIRED`
- `CLAIM_ORIGINAL_DOCS_REQUIRED`
- `CLAIM_EOB_READY`
- `CLAIM_PAID`
- `CLAIM_DECISION_AVAILABLE` (REJECTED)
- `CLAIM_CLOSED`

`AI_PROCESSING`, `GREEN_STP`, `DOCTOR_REVIEW`, `FRAUD_HOLD`, `OTP_SIGNED`, `PAYOUT_PROCESSING` and supplement re-entry produce nothing.

Dedup has two layers: the inbox `(tenant, consumer, eventId)`, plus the unique key `(tenant, recipient, source event, template)` used with a bare `ON CONFLICT DO NOTHING`. An explicit arbiter would apply the recipient SELECT policy to the producer. Events that don't match PostgreSQL truth are parked as non-retryable. Out-of-order delivery is harmless because each event is its own notification.

The producer makes no push, Zalo or provider calls (#41/#13). Expiry is 90 days; this is a technical proposal, not an approved retention policy.

## Field specification (`Notification`)

| Field | Type | Req | Null/default | Storage | PII | Validation / error | Example |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `notificationId` | uuid | yes | server `gen_random_uuid()` | `id` | no | malformed in path → 404 | `5358…7d76` |
| recipient principal / membership | uuid | server only | never in API | `recipient_principal_id`, `recipient_membership_id` (tenant) | internal refs | server-stamped from claim truth; client cannot assign | — |
| `scope` | `PERSONAL\|TENANT` | yes | — | table choice | no | other value → 422 | `TENANT` |
| tenant | uuid | server only | never in API | `tenant_id` (tenant table only) | no | from `SET LOCAL` context only | — |
| `service` | `TPA_INSURANCE\|LOYALTY360` | yes | — | `service` (CHECK per table) | no | enum | `TPA_INSURANCE` |
| `category` | `CLAIM_STATUS\|SERVICE_NOTICE` | yes | — | `category` | no | enum | `CLAIM_STATUS` |
| `priority` | `INFO\|ACTION_REQUIRED` | yes | — | `priority` | no | enum; presentation only | `ACTION_REQUIRED` |
| `templateKey` / `templateVersion` | string / int ≥1 | yes | — | `template_key`, `template_version` | no | `^[A-Z][A-Z0-9_]{2,63}$`; allowlist in producer | `CLAIM_EOB_READY` / `1` |
| `titleVi` / `bodyVi` | string ≤120 / ≤280 | yes | — | `title_vi`, `body_vi` | **none by construction** | DB CHECK `notification_text_safe`: no `<>`, URLs, control chars, ≥6-digit runs → 23514 | `Hồ sơ cần bổ sung chứng từ` |
| `target` | `{kind: CLAIM, id}` | no | absent for personal | `target_kind`, `target_id` | no | descriptor, never URL; target API re-authorizes (404) | `{kind:"CLAIM",id:"…"}` |
| source event | uuid / type / version | server only | never in API | `source_event_*` | no | registry event types | — |
| `occurredAt` | date-time | yes | — | `occurred_at` | no | from envelope | `2026-11-27T10:00:07.609837Z` |
| `createdAt` | date-time | yes | `clock_timestamp()` | `created_at` | no | order and cutoff key | same |
| `expiresAt` | date-time | yes | created+90d | `expires_at` | no | CHECK `> created_at`, ≤366d; expired hidden/404 | — |
| `readAt` | date-time | no | absent = unread | `read_at` | no | monotonic (trigger 42501) | — |
| `version` | 1\|2 | yes | 1 | `version` | no | CHECK `(read_at IS NULL) = (version = 1)` | `2` |
| `nextCursor` | string ≤2048 | no | absent on last page | — | no | bound to principal/scope/membership/filters → 422 | opaque |

## Gaps and follow-ups (not built here)

- Loyalty360 personal producer and consent (#110 G4/G9): no producer exists, and `tpa_app` has no INSERT grant on `personal_notifications`.
- Per-purpose preferences and mandatory-service-notice policy need explicit design and approval. Retention/cleanup is a proposal.
- Provider push, Zalo OA and ZNS delivery are #41/#13.
- UI phase after #106: bell, accessible badge, filters, offline/expired/revoked states, avatar-switch stale-response guard, browser tests, bundle/latency measurement.
