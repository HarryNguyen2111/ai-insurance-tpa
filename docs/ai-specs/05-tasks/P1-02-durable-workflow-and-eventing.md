# P1-02 — Temporal, outbox/inbox và Kafka
- Tạo workflow worker và event worker, event envelope/schema compatibility, DB outbox/inbox/idempotency migrations.
- ClaimWorkflow deterministic; Activity retry/heartbeat/idempotency, stable workflow/command IDs, human commands/SLA timers, worker versioning/replay tests.
- DB business state + audit + outbox atomic; consumer retry/DLQ/replay và chống sự kiện trùng/đảo thứ tự. Kafka không ghi claim state song song với Temporal.
- DoD: crash sau DB commit/trước publish, sau publish/trước mark, sau workflow accept/trước inbox commit đều phục hồi; không lặp transition/payment; payload history/event không lộ PII.
