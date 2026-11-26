# @tpa/event-worker — transactional outbox relay (EVT-01 #23)

Separate deployable (spec 06 §1) that relays `tpa.outbox_events` to Kafka.

## Write side (`@tpa/database/outbox`)
`commitDomainChange(db, tenantId, mutate)` runs business writes, `appendAudit`
and outbox inserts in ONE `withTenantTransaction` (`SET LOCAL` tenant, FORCE
RLS). All event drafts are validated against the registry before any append;
any failure rolls back business state, audit and outbox together. Success is
returned only after COMMIT. Nothing is published inline.

## Relay
1. An AFTER INSERT trigger registers each emitting tenant in
   `tpa.outbox_relay_tenants` (UUID only; no app grant). The relay pages through
   it with `tpa.outbox_relay_tenant_ids(after, limit)` (SECURITY DEFINER, keyset)
   — its single cross-tenant capability. No non-tenant RLS policy exists on the
   outbox. Each cycle visits every registered tenant (one cheap tenant tx each);
   a pending-tenant hint is a possible optimisation if tenant counts grow large.
2. Per tenant, inside a tenant transaction: `pg_try_advisory_xact_lock` (one
   active relay per tenant, so replicas cannot reorder an aggregate), lock the
   oldest unpublished rows, re-validate each envelope, publish.
3. The Kafka producer is idempotent with `acks=all`; `publish` resolves only after
   broker acknowledgement. Only then is `published_at` stamped (server clock) and
   the transaction committed.

### Delivery semantics — at-least-once, duplicates explicit
| Crash point | Outcome |
| --- | --- |
| before business COMMIT | nothing persisted, nothing published |
| after COMMIT, before relay/publish | row stays pending; next relay publishes it |
| relay holding rows, before publish | PostgreSQL aborts the tx; row stays pending |
| after broker ack, before mark COMMIT | **same eventId published again** on recovery |

Consumers must dedup by `eventId` (header `tpa-event-id`); the inbox consumer
runtime below does this. No exactly-once claim is made.

`published_at` moves only NULL→now(); envelopes are immutable; pending rows
cannot be deleted/truncated (guard trigger applies even to the table owner).
Retention purge of published rows is a separately reviewed operator job (not here).

## Inbox consumers (EVT-02 #24)
`createInboxConsumer` (`src/consumers/consumer.ts`) runs one `InboxHandler` as the Kafka consumer
group `consumerName`, with auto-commit OFF.
- **Dedup and effect:** `processInboxEvent` (`@tpa/database/inbox`) performs the dedup check, the
  aggregate-version ordering, the handler effect and the inbox row in **one**
  `withTenantTransaction`. The offset is committed only after that commits.
- **Ordering:** old versions are `STALE` and never roll the projection back. A gap is reconciled from
  an authorized snapshot (`reconcile`) or parked as `VERSION_GAP`. Later versions park behind a parked
  one (`BLOCKED_BY_PARKED`).
- **Failures:** retries are bounded (`maxAttempts`, exponential backoff, heartbeats), then the event
  is parked as `RETRY_EXHAUSTED`. Poison records are quarantined as hash plus coordinates only.
- **Alerts and replay:** owner alerts go through `AlertSink`. Replay and discard are authorized and
  audited. See `docs/runbooks/event-inbox-replay.md`.
- No exactly-once claim: duplicates are detected and skipped.

## Run
```
EVENT_RELAY_DATABASE_URL=postgresql://tpa_app:...@host/tpa \
KAFKA_BROKERS=kafka:9092 EVENT_TOPIC_PREFIX=tpa.dev pnpm --filter @tpa/event-worker start
```
Optional: `EVENT_RELAY_BATCH_SIZE` (100), `EVENT_RELAY_MAX_TENANTS` (100),
`EVENT_RELAY_POLL_MS` (500), `EVENT_RELAY_MAX_BACKOFF_MS` (30000),
`EVENT_RELAY_SEND_TIMEOUT_MS` (30000), `EVENT_RELAY_CLIENT_ID`. Topics are not
auto-created by the relay (`allowAutoTopicCreation: false`); provision them per
environment. SIGTERM/SIGINT drain the in-flight batch and exit 0. Logs carry
fixed messages and counters only.

## Tests
- `pnpm --filter @tpa/event-worker test` — relay loop, config, record mapping (no Docker).
- `test/inbox-consumer.e2e.test.ts`: the EVT-02 consumer on Docker PG16 plus Kafka. Covers
  duplicates, out-of-order events, gaps, poison, bounded retry and parking, CLI replay, SIGKILL after
  commit and mid-effect, rebalance, and PT17.
- `pnpm --filter @tpa/event-worker test:e2e` (run by CI `pnpm test:e2e`): Docker
  PG16 + the Kafka image pinned in `infra/compose/compose.yaml`: PT05 crash after
  commit / before publish / after ack (SIGKILLed child), ordering per key, real
  `main.ts` process with graceful SIGTERM, and PT17 marker scan over Kafka
  records, outbox envelopes, relay logs and process output.

## Limits
Dev single-node Kafka without TLS/SASL/ACLs is not an HA or production config.
Outbox-age/lag metrics, alerts and Helm deployment are OBS-01/PLAT-01 follow-ups.
KafkaJS 2.2.4 has had no release since 2023; client choice should be revisited
in the version matrix (S0-D #14).
