# P2-01 — Quyền lợi có phiên bản, search và chi trả
- Hoàn thiện migrations/API theo 07 trước implementation: contract/EOB versions, reservation account, OTP, maker-checker, original receipt, payment intents/journals/reconciliation.
- Elasticsearch projection/index templates/tenant repository/versioned updates/tombstones/rebuild; search outage không chặn nghiệp vụ.
- Payment sandbox trước tiền thật; UNKNOWN reconciliation; EOB sửa làm mất hiệu lực chữ ký/phê duyệt cũ; posted journals cân bằng và chỉ reversal.
- DoD: concurrent limit/coinsurance tests, cross-tenant search negatives, stale EOB OTP rejection, bank timeout/no double payout, DR/reconciliation evidence. Chạy golden và platform scenarios liên quan.
