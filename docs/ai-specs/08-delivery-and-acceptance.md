# Kế hoạch triển khai và nghiệm thu

Repo hiện là bộ đặc tả, chưa có runtime. Stack Kubernetes/Kafka/Elasticsearch/Temporal triển khai ngay từ nền tảng; mốc dưới đây là thứ tự phụ thuộc, không cam kết hoàn tất trong bốn sprint khi chưa biết nhân lực/tải.

## 1. Thứ tự công việc
1. S0-01: chốt pilot, hợp đồng/chứng từ được phép dùng, vai trò chi trả, threat model và thử nghiệm tích hợp. Chốt version matrix, license, ngân sách, sizing và vị trí dữ liệu cho full stack.
2. S1-01 + P1-01: scaffold monorepo, full-stack Compose, kind/Helm, CI, observability và secret flow. Kiểm tra PostgreSQL, Redis, S3/Imgproxy, Temporal, Kafka/Schema Registry, Elasticsearch cùng hoạt động.
3. S1-02 + P1-02: identity/tenant, migration bổ sung theo 07, RLS/PII/audit, outbox/inbox và workflow skeleton. Lỗi giữa commit/publish/start workflow phải phục hồi được.
4. S1-03 + S2-01 + S2-02: chứng cứ AI, contract/EOB versioning, reservations và golden cases; STP shadow.
5. S3-01 + P2-01: luồng claim, Temporal timers/human commands, search projection, OTP/duyệt kép, payment/ledger/reconciliation; sandbox trước tiền thật.
6. S3-02 + S4-01: giao diện khách hàng/workbench/portal trên API đã được hoàn thiện.
7. Production gate: restore drill, load/security tests, vận hành on-call/runbook và pilot sign-off. Không dùng việc Helm deploy thành công làm bằng chứng nghiệp vụ đã đúng.

## 2. Deliverables nền tảng
- `infra/compose/`, `infra/helm/mps/`, values theo môi trường, GitOps manifests, migrations; không ghi secret thật.
- OpenAPI được lint/validate, generated contracts/runtime validation; event schemas có compatibility policy.
- OTel instrumentation, dashboard/alerts, hướng dẫn khởi chạy và xử lý incident; ownership cho từng dependency.
- Ma trận version đã thử: Node/pnpm/Nest/Temporal SDK-server/PostgreSQL/Kafka client-broker/Elasticsearch client-server/operator/chart. Pin image digest, kiểm tra license và hỗ trợ nâng cấp.
- Tải pilot phải nêu số tenant, concurrency, claims/ngày, trang/claim, file size, retention, AI latency và chi phí/claim; có kịch bản tăng tải và budget alert.

## 3. Kiểm thử bắt buộc
- Typecheck TypeScript, kiểm tra kiểu Python theo cấu hình project; unit và golden TC01–TC06 giữ nguyên kỳ vọng đã chốt.
- Integration trên DB role thực tế: RLS/connection reuse, composite FK, audit first-write race, reservation/coinsurance concurrency và cân journal.
- Temporal replay/version compatibility; crash/resume ở AI, chờ người duyệt, OTP, payment UNKNOWN; không lặp side effect.
- Kafka duplicate/out-of-order/rebalance/poison event; crash trước/sau publish, inbox và offset commit; replay có audit.
- Elasticsearch cross-tenant negative tests trên query/get/export/suggest/count/aggregation; rebuild, lag, deletion và outage.
- E2E: upload/quarantine -> preflight -> submit duplicate -> AI -> review -> versioned EOB -> OTP -> approval/original gates -> payout sandbox -> reconciliation -> search projection.
- Test SSRF/XXE/file bomb, OTP abuse, HMAC replay, PII leak trong log/history/event/index/DLQ; AI eval trên chứng từ được phép dùng.
- Helm lint/render + kubeconform hoặc validator tương đương; smoke trên kind/staging, dependency outage và rolling restart.
- Backup/restore drill đo RPO/RTO thực tế, chứng minh không chi trả trùng sau phục hồi; runbook có người chịu trách nhiệm.

Các scenario nền tảng nằm trong `09-platform-acceptance-cases.json`. Đây là tiêu chí nghiệm thu, chưa phải automated tests đã chạy. Không báo PASS cho business/platform case khi chưa có runner và bằng chứng.

## 4. Điều kiện mở production
Có owner nghiệp vụ, security và vận hành; quyền sử dụng dữ liệu và cấu hình hợp đồng được xác nhận; đo chất lượng AI và sai sót tiền; reconciliation sandbox đạt; không còn lỗi cô lập tenant/chi trả trùng; backup restore được diễn tập. STP ENABLED phải được phê duyệt theo tenant/plan sau shadow evaluation. Phạm vi pháp lý do người phụ trách xác minh, không tự kết luận chỉ từ từ khóa trên hóa đơn.
