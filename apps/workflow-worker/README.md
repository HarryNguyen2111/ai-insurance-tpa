# WF-01 Temporal foundation

Independent Node 24 processes use official Temporal TypeScript SDK **1.27.0** and
Compose-pinned Temporal server **1.29.7**. CI tests this pair with PostgreSQL 16
and Compose Kafka. No exactly-once guarantee: delivery and Activity execution are
at least once; stable IDs and a tenant transaction ledger prevent repeated effects.

Run migrations first. Start the full-stack dev Compose, then configure:

- `WORKFLOW_DATABASE_URL`: PostgreSQL URL using `tpa_app` only.
- `TEMPORAL_ADDRESS`: trusted `host:port`; `TEMPORAL_NAMESPACE` defaults to `default`.
- Bridge additionally uses `KAFKA_BROKERS` and `KAFKA_TOPIC_PREFIX` (default `tpa.dev`).

Run `pnpm --filter @tpa/workflow-worker start` and independently
`pnpm --filter @tpa/event-worker start:workflow`. SIGTERM/SIGINT drain workers;
bridge disconnects without committing an unfinished effect's Kafka offset.
Temporal persistence uses its own database/role, separate from application data.

The bridge handles claim submitted/state-changed events in aggregate order.
`claim/{tenantId}/{claimId}` and `evt-{eventId}` survive every retry. It awaits
signal-with-start's durable acceptance before committing inbox/offset. A closed
workflow is never restarted by a late event. Invalid events are quarantined,
version gaps parked, and exhausted transport retries alert `workflow-ops` through
the existing owner hook. Recover dependencies before replay; never change IDs.

Use the existing [audited replay runbook](../../docs/runbooks/event-inbox-replay.md)
with `--consumer claim-workflow`. For `replay`, supply `TEMPORAL_ADDRESS` and
`TEMPORAL_NAMESPACE` alongside the documented database/operator configuration.
`list`/`discard` require no Temporal connection. A gap requires restoring/replaying
missing versions in order; this foundation does not invent a domain snapshot.

Workflows contain references/status codes only, with separate orchestration and
I/O queues. Activities own all database operations through tenant transactions.
The synthetic transition is a ledger entry plus immutable audit in one commit;
this is not a real claim endpoint or a claim/payment state machine. Real domain
mutations must join the same transaction with audit/outbox. No PII/documents,
free text, money, OTP, or external provider errors enter workflow inputs/history.

`pnpm --filter @tpa/event-worker test:e2e` exercises PT06 accepted-before-inbox
SIGKILL/redelivery, Activity retry after commit, worker restart, closed-workflow
redelivery, history replay, and PT17 synthetic marker exclusion. It requires
Linux Docker and exclusive Temporal test port 7233; it starts isolated labelled
PG16/Kafka/Temporal containers and removes them in finally. Typecheck and unit
contracts/config/bridge tests run in the ordinary root scripts.

Before upgrading SDK/server or deterministic workflow code, run this real-service
suite and replay representative retained histories with `Worker.runReplayHistory`.
Do not alter deterministic command order on existing executions; use Temporal
patching/worker versioning for incompatible changes. Continue-As-New retains recent
command IDs; the database ledger remains authoritative across continuations.
This foundation does not claim PT07 timer/OTP compatibility or production rollout.
