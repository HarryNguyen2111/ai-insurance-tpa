# Kiến trúc Backend & Platform — quyết định 2026-11-23

Trạng thái: kiến trúc được người dùng yêu cầu; chưa có backend hoặc cluster được triển khai. Tài liệu này thay thế hướng BullMQ và việc hoãn Kubernetes/Kafka/Elasticsearch/Temporal trong đặc tả cũ. Phạm vi sản phẩm giữ Smart Reimbursement, AI Copilot và cổng DNBH; nền tảng đầy đủ được xây ngay từ đầu.

## 1. Trách nhiệm từng thành phần
| Thành phần | Trách nhiệm | Ranh giới |
| --- | --- | --- |
| NestJS + Drizzle | Modular monolith: identity-tenant, policy-benefit, claim, adjudication, payment, audit, integration | Mọi thay đổi nghiệp vụ được xác nhận tại PostgreSQL |
| PostgreSQL 16 + pgvector/pg_trgm/pgcrypto | Business state, versioned rules/EOB, reservations, ledger, audit, outbox/inbox | Nguồn dữ liệu nghiệp vụ gốc; migration role khác application role |
| Temporal + TypeScript worker | ClaimWorkflow: AI, chờ bác sĩ, bổ sung, bản gốc, OTP, duyệt kép, chi trả, SLA | Không dùng Kafka/Redis làm máy trạng thái thứ hai |
| Kafka | Domain events, search projection, integration và replay | Không chứa PII thô, không thay DB transaction |
| Elasticsearch | Tìm kiếm claim/catalog được phép, projection có thể rebuild | Không dùng để quyết định quyền lợi, kiểm tra hạn mức hoặc chi trả |
| Redis 7 | Cache TTL, rate limit | Mất cache không làm mất hồ sơ, OTP durable state hay tiền |
| Python FastAPI/worker | Ảnh, QR/XML, AI adapter, chứng cứ trích xuất | Không trực tiếp phê duyệt hoặc ghi tiền vào DB |
| S3-compatible + Imgproxy | Chứng từ gốc/versioning, bản xử lý và preview HEIC | Bucket private, signed URL; hạn chế egress |
| Kubernetes + Helm | Deploy, isolation, autoscaling, rollout | Dev có Compose và kind; staging/prod có cấu hình riêng |

Các deployable dự kiến: `apps/core-api`, `apps/workflow-worker`, `apps/event-worker` (relay/indexer có thể tách Deployment), `services/ai-worker`, cùng frontend hiện có. Shared packages: contracts, domain, database, observability. Không tách mỗi module thành microservice.

## 2. Luồng ghi và xử lý
1. API xác thực danh tính, tenant membership, quyền trên đối tượng; kiểm tra input và idempotency request hash.
2. Trong `withTenantTransaction`: khóa aggregate cần thiết, kiểm tra version, ghi business state + audit + outbox. Chỉ trả thành công sau commit.
3. Outbox relay publish Kafka, chỉ đánh dấu sau broker acknowledgement. Crash giữa publish/mark có thể sinh duplicate; consumer dedup bằng `(tenant_id, consumer_name, event_id)` và transaction với thay đổi DB.
4. Consumer khởi động/gửi lệnh Temporal bằng workflow ID ổn định `claim/{tenantId}/{claimId}`. Không đánh dấu hoàn tất trước khi Temporal xác nhận durable acceptance; retry cùng command ID. Workflow/Activity chống duplicate kể cả crash trước khi ghi inbox.
5. Workflow chỉ điều phối deterministic; DB, HTTP, clock ngẫu nhiên và AI nằm trong Activities. Activity gọi domain service qua tenant transaction. Semantic idempotency key giữ ổn định qua retry và workflow continuation.
6. Search consumer upsert projection theo aggregate version. Bỏ event cũ; version gap cần reload snapshot được cấp quyền. Tombstone/xóa dữ liệu cũng có version. Rebuild bằng snapshot + replay, alias swap sau kiểm tra.

## 3. Temporal
- PostgreSQL persistence của Temporal dùng database/role riêng, không truy cập bảng nghiệp vụ; history/visibility có retention và backup riêng. Dùng visibility store được phiên bản Temporal đã chọn hỗ trợ; không buộc dùng chung index tìm kiếm nghiệp vụ.
- Task queues riêng cho orchestration, I/O và AI nặng; timeout, heartbeat, retry/backoff và non-retryable errors được cấu hình theo Activity.
- Timers cho SLA và hạn bổ sung; cập nhật DB mới quyết định trạng thái. Retry hoặc timer chạy lại không được tạo transition/tiền trùng.
- Command chứa commandId, expectedAggregateVersion và tham chiếu dữ liệu; không truyền ảnh, raw XML, tài khoản, OTP hay toàn bộ EOB vào history/search attributes.
- Workflow versioning, replay tests và Continue-As-New có quy trình triển khai; không thay code deterministic làm hỏng workflow đang chạy.
- Nếu giữ webhook AI cho adapter ngoài: mTLS/service identity + HMAC raw body, timestamp, eventId, replay window và dedup; chỉ một đường kết quả có hiệu lực.

## 4. Kafka
- KRaft; topic theo domain/environment, partition key `tenantId:aggregateId`, không topic cho từng claim. Events tối thiểu: claim.submitted, claim.state-changed, eob.published, payment.status-changed, catalog.proposal-reviewed.
- Envelope bắt buộc: eventId, eventType, schemaVersion, tenantId, aggregateId, aggregateVersion, occurredAt, correlationId, causationId, payload tối thiểu. Money dạng string; dùng Schema Registry tương thích JSON Schema và CI compatibility check.
- At-least-once end-to-end. Producer idempotence/acks phù hợp chỉ là một lớp; không hứa exactly-once cho DB/Temporal/ngân hàng.
- Consumer commit offset sau durable side effect; partition ordering, retry có giới hạn, parking/DLQ có owner, alert và công cụ replay có audit. Không đưa PII vào DLQ.
- Production baseline: ít nhất 3 broker/controller phù hợp thiết kế quorum, replication factor 3, min ISR 2; dev single-node không được xem là HA. TLS, SASL và topic ACL theo service account.

## 5. Elasticsearch
- Chỉ truy cập qua backend; không endpoint/query DSL tùy ý cho client. Mọi query/get/mget/export/suggest/count/aggregation đều áp tenant và quyền đối tượng. Không tin tenant từ request body.
- Allowlist field projection, loại PII/raw OCR/raw XML; tiền index dạng keyword nếu cần hiển thị, tổng tiền lấy từ PostgreSQL. Không đổi tiền sang float để search aggregation.
- Shared index bắt buộc filter ở repository tập trung và negative tests; dùng index riêng theo tenant khi yêu cầu cô lập. Không mặc định phụ thuộc document-level security nếu chưa kiểm tra license.
- UI hiển thị eventual consistency; chi tiết/quyết định đọc PostgreSQL. Index outage không chặn submit/adjudication/payment; backlog được xử lý sau phục hồi.
- Index template, analyzer tiếng Việt được benchmark, mappings/version, ILM/retention, snapshot, rebuild và alias rollback phải có runbook.

## 6. Kubernetes và delivery
- Local full-stack Compose để dev; kind + Helm để kiểm tra deploy. Không dùng Temporal dev server hay single-node Kafka/Elasticsearch làm cấu hình production.
- `infra/helm/mps` cho app; values dev/staging/prod. Stateful platform dùng chart/operator được đánh giá hoặc dịch vụ managed đáp ứng vị trí dữ liệu; pin version và image digest sau compatibility spike, không dùng `latest`.
- Namespaces theo môi trường/chức năng, RBAC tối thiểu, workload identity, default-deny NetworkPolicy, TLS ingress, giới hạn egress QR/AI/ngân hàng.
- Non-root, read-only root filesystem khi khả thi, seccomp, requests/limits, startup/readiness/liveness, graceful shutdown, HPA cho stateless/worker theo tải hàng đợi, PDB và topology spread. Không autoscale DB/Kafka mù.
- Secret manager/KMS + External Secrets hoặc CSI; Kubernetes Secret đơn thuần không thay thế quản lý khóa. Không commit secret/PII vào Git/Helm values.
- CI: lint/typecheck, golden/integration/replay/security tests, build, image scan/SBOM, Helm lint/render, manifest schema validation, staging smoke. Migration là job riêng, expand/contract; rollback ứng dụng không tự rollback dữ liệu.
- GitOps bằng Argo CD; production release có evidence kiểm thử và runbook. Helm/Argo không tự đồng nghĩa permission truy cập cluster đã được cấp.

## 7. Quan sát, bảo mật và phục hồi
- OpenTelemetry, Prometheus/Grafana, log tập trung được lọc PII (Loki), tracing backend tương thích OTel. Không dùng business Elasticsearch làm nơi chứa mọi log nhạy cảm.
- Theo dõi outbox age, consumer lag, workflow stuck/retry, AI timeout, search freshness, reservation contention, payment UNKNOWN, reconciliation mismatch, backup age.
- OIDC/OAuth2 provider, MFA nhân sự, RBAC + quyền đối tượng/assignment, maker-checker; rate limit/lockout OTP và sensitive actions. Zalo identity phải được kiểm chứng phía server.
- KMS envelope encryption AES-256-GCM, key version/rotation, PII redaction toàn pipeline. Retention/legal hold và trách nhiệm bên xử lý dữ liệu được phê duyệt trước production; không coi AI nội địa là đủ tuân thủ.
- Backup/PITR PostgreSQL, object versioning/retention, snapshot Elasticsearch, backup Temporal và cấu hình Kafka. DB nghiệp vụ và workflow history phải có kế hoạch phục hồi nhất quán; xử lý event/workflow trùng sau restore.
- Mục tiêu kỹ thuật ban đầu để kiểm chứng: API availability 99.9%/tháng; preflight nhanh p95 <=3s ở tải pilot đã đo, tác vụ sâu trả pending; search freshness p95 <=10s khi bình thường; DB RPO <=5 phút, RTO <=60 phút. Đây là mục tiêu thử nghiệm, không phải SLA đã đạt.
- Không chốt capacity/cost khi chưa biết lưu lượng, kích thước chứng từ, retention và môi trường triển khai; benchmark và budget review là deliverable Sprint 0.

## 8. Tài liệu tham chiếu
- [Temporal Activities và idempotency](https://docs.temporal.io/activities)
- [Kafka delivery semantics](https://kafka.apache.org/22/design/design/)
- [Transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
- [Elasticsearch security](https://www.elastic.co/docs/reference/elasticsearch/configuration-reference/security-settings)
- [Kubernetes production environment](https://kubernetes.io/docs/setup/production-environment/)
