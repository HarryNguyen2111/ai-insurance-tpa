# Runbook — parked / quarantined inbox events (EVT-02 #24)

Owner: the team named in the consumer's `owner` field (alert `owner`). Scope: inbox
consumers in `apps/event-worker` (`createInboxConsumer`). Delivery is
at-least-once; **no exactly-once claim**. Replay never repeats an effect that the
inbox already recorded.

## 1. Alerts you will receive
Alerts are JSON lines (`level: "alert"`) with ids and codes only: no payloads, error
messages or raw bytes.

| `kind` / `reasonCode` | Meaning | Partition blocked? |
| --- | --- | --- |
| `EVENT_PARKED` / `RETRY_EXHAUSTED` | The handler failed `maxAttempts` times (bounded retry with backoff) | No. The offset is committed after parking |
| `EVENT_PARKED` / `HANDLER_REJECTED` | The handler threw `NonRetryableEventError` | No |
| `EVENT_PARKED` / `VERSION_GAP` | The aggregate version skipped ahead and the consumer has no `reconcile` | No |
| `EVENT_PARKED` / `BLOCKED_BY_PARKED` | A later version of an aggregate whose earlier version is parked. Parked to preserve order | No |
| `RECORD_QUARANTINED` / `UNPARSEABLE`, `SCHEMA_INVALID`, `ROUTING_MISMATCH` | The record is not a trustworthy registry envelope for that topic | No |

Parked rows live in `tpa.consumer_parked_events` and are tenant-scoped (RLS). Each row stores the
validated, PII-free envelope, the reason, the attempt count and the error class name. Quarantine
(`tpa.consumer_quarantine`) has no tenant: it stores only the Kafka coordinates and a sha256 of the
raw bytes, because the content may contain PII. The app role cannot read it.

## 2. Triage
1. List the open parked events for a tenant and consumer. The output is JSON lines of ids and codes:
   ```
   EVENT_REPLAY_DATABASE_URL=postgresql://tpa_app:...@host/tpa \
   node apps/event-worker/src/consumers/replay-main.ts list --tenant <tenant-uuid> --consumer <consumer-name>
   ```
2. Use `reasonCode` and `errorName` to fix the cause first: deploy the handler fix, restore the
   dependency, or let the missing predecessor arrive. Replaying before the fix just fails again; the
   failure is audited as `EVENT_REPLAY_FAILED` and the event stays parked.
3. `VERSION_GAP`: check whether the predecessor events have since been applied. If they are lost,
   either replay after they are re-emitted from the outbox, or ship a `reconcile` implementation
   (an authorized snapshot reload, spec 06 §2.6).
4. Quarantined records cannot be replayed, because their content is not kept. Find the producer with
   the coordinates and hash, fix it, and re-emit through the transactional outbox. The producer's
   duplicate eventIds are deduplicated by the inbox.

## 3. Replay (authorized and audited)
```
EVENT_REPLAY_DATABASE_URL=... EVENT_REPLAY_OPERATORS=<operator-uuid>[,...] \
node apps/event-worker/src/consumers/replay-main.ts replay --tenant <uuid> --consumer <name> --operator <your-uuid> [--parked <id>,...] [--limit 100]
```
- **Authorization:** fails closed. Until AUTH-01 (#21) provides verified OIDC roles, the operator
  must be in the `EVENT_REPLAY_OPERATORS` allowlist; unset or malformed denies everyone. A denied
  request changes nothing.
- Events are replayed in aggregate-version order through the same dedup and ordering rules as live
  consumption.
  - Each success writes the effect, the inbox row (`replayed_from`), the resolved parked row and an
    `EVENT_REPLAY` audit entry in **one tenant transaction**.
  - A later version still blocked behind an unresolved one stays parked (`stillParked`).
- Re-running replay is safe: resolved rows are skipped and inbox duplicates are never re-applied.
- The output is one JSON summary: `applied`, `reconciled`, `stale`, `stillParked`, `failed`,
  `alreadyResolved`.

## 4. Discard (authorized and audited)
Use this only when the event must never be applied (for example, superseded by a reconcile). It
writes an `EVENT_DISCARD` audit entry. Redelivery of the same eventId stays a no-op.
```
node apps/event-worker/src/consumers/replay-main.ts discard --tenant <uuid> --consumer <name> --operator <your-uuid> --parked <id>
```

## 5. Verify
- `list` shows no open rows for the aggregate.
- `tpa.audit_logs` has `entity_type='PARKED_EVENT'` entries with your actor id.
- The consumer group lag is 0 (`kafka-consumer-groups.sh --describe --group <consumer-name>`).

## 6. Guarantees and limits
- The effect and the inbox row commit together, and the offset is committed only after that commit.
  A crash in between causes redelivery, which becomes a `duplicate` no-op.
- An old or duplicate version is recorded as `STALE` and never rolls a projection back.
- Parked, inbox and position rows cannot be deleted. Positions only advance, and resolved parked
  rows are immutable. These rules hold even for an RLS-bypassing superuser, through triggers.
  Retention and purge need a separately reviewed operator job, which is not provided here.
- A database outage during retries can park healthy events with `RETRY_EXHAUSTED`. Replay restores
  them once the database is back.
- Delivery of alerts to paging and chat channels, and dashboards for parked counts and lag, are
  OBS-01 (#55). Real consumers (SRCH-01 #47, WF-01 #25) register in
  `apps/event-worker/src/consumers/registry.ts`; until then `replay-main` has no consumers to act on.
