# Tenant workspaces và cấu hình động tiếp nhận claims

Quyết định phạm vi được owner xác nhận ngày 2026-11-26. Đây là đặc tả và đầu vào thiết kế, chưa phải chức năng đã triển khai hoặc bằng chứng nghiệm thu. Bổ sung specs 01–09; không thay các bất biến bảo mật/nghiệp vụ.

## 1. Stack và kênh truy cập

- Giữ NestJS/TypeScript/Drizzle/PostgreSQL cho core, Python cho AI worker và Temporal/Kafka/Elasticsearch/Kubernetes theo kiến trúc hiện có.
- Zalo Mini App dùng React/Vite/Zalo SDK; nền tảng web dùng Next.js/TypeScript cho tiếp nhận claims, Workbench và cổng DNBH theo vai trò.
- Khách hàng có workspace riêng về quyền truy cập, dữ liệu và cấu hình hiển thị. Mặc định thiết kế một workspace khách hàng tương ứng một tenant; mọi nhu cầu nhiều workspace trong cùng tenant cần quyết định rõ trước khi thêm mô hình con.
- Workspace không mặc định là database, cluster, repository hoặc deployment riêng. Slug/URL chỉ phục vụ định tuyến; không phải bằng chứng quyền truy cập. Custom domain chưa thuộc phạm vi mặc định.

## 2. Cô lập và quyền

- Tenant lấy từ danh tính/membership đã xác minh phía server; chọn hoặc chuyển workspace phải kiểm tra membership. Không tin tenantId/slug từ client.
- API, DB, object storage, search, cache và export đều phải áp tenant/quyền đối tượng. Đổi workspace phải xóa dữ liệu giao diện không còn được phép xem và không dùng lại cache tenant cũ.
- Tenant transaction/RLS, mã hóa PII, immutable audit, idempotency và upload presigned giữ nguyên. Không cho workspace admin sửa trực tiếp dữ liệu chi trả hoặc bypass hợp đồng.

## 3. Form động có giới hạn

- Cấu hình cho phép branding, nhóm/bước, thứ tự, nhãn, trợ giúp, lựa chọn, required và điều kiện hiển thị trong tập component/rule được duyệt.
- Không chạy JavaScript, HTML không tin cậy, biểu thức eval hoặc URL tùy ý do tenant nhập. Giới hạn số trường, độ sâu điều kiện, kích thước schema/payload và độ dài dữ liệu.
- Một schema nghiệp vụ dùng cho web và Zalo; layout có thể thích ứng từng kênh. Trường không hỗ trợ trên một kênh phải có fallback rõ hoặc bị chặn khi publish, không bị bỏ qua âm thầm.
- Cấu hình chỉ điều chỉnh thu thập/hiển thị; không thay quyền, hợp đồng, tính tiền, audit hoặc điều kiện chi trả. Phân biệt required khi lưu nháp và khi submit; quy định riêng hành vi trường bị ẩn, không coi ẩn là bí mật.
- Có draft, validate/preview, publish và rollback bằng phiên bản mới. Chỉ role được cấp quyền được publish; ghi audit. Phiên bản đã publish bất biến.
- Draft/claim gắn form version; cấu hình mới không âm thầm đổi dữ liệu hoặc validation của hồ sơ cũ. Chính sách xử lý version bị thu hồi và chuyển đổi draft phải được đặc tả/test trước implementation.

## 4. Bộ đặc tả bắt buộc trước giao builder

Với mỗi màn hình và mỗi trường: actor/quyền, tên hiển thị/API/DB, kiểu, required/nullable/default, absent/null/empty semantics, precision/length, nguồn danh mục, điều kiện hiển thị/chỉnh sửa, PII classification, lỗi tiếng Việt và ví dụ hợp lệ/không hợp lệ.

Phải có mapping UI → OpenAPI → lưu trữ → validation → test/acceptance; bao gồm loading/empty/error/forbidden, retry/offline/duplicate submit và version conflict. Thông tin chưa rõ là quyết định mở, không giao builder tự suy đoán.

Backend kiểm tra schema/version được tenant phép sử dụng và validate lại toàn bộ payload. Frontend dùng schema/contract có phiên bản cho phản hồi sớm. FE không phải nguồn quyết định; backend từ chối unknown fields, readonly writes và cấu hình không hợp lệ. Cấu hình/schema không chứa PII; errors không echo PII.

Thiết kế persistence phải tách canonical claim fields khỏi custom answers. PostgreSQL giữ dữ liệu gốc; JSONB chỉ là lựa chọn cho metadata/answers thích hợp, không thay constraints/RLS/mã hóa và không đẩy field PII mới thành plaintext. Quy định danh mục field extension được phép, kiểu cố định, version, retention, export/search allowlist; không tự tạo cột SQL hoặc index mọi field theo cấu hình tenant.

## 5. Hiệu năng và nghiệm thu

- Cache config theo tenant + published version + channel; không cache chung tenant. Invalidation sau publish phải nhất quán với version hồ sơ. Tách public branding khỏi config/quyền cần xác thực; không public-cache dữ liệu cá nhân.
- Lazy-load màn hình/components; Zalo bundle <4MB, không đưa OCR/OpenCV WASM xuống client. Upload trực tiếp qua presigned URL; paginate danh sách và tránh N+1.
- Trước nghiệm thu chốt tải đại diện: tenant/concurrency/claims mỗi ngày, số trường/điều kiện và kích thước chứng từ. Đo p95/p99 config fetch/render/submit, throughput, lỗi, CPU/RAM; tách AI/upload khỏi latency API. Không tuyên bố SLA chưa đo.
- Test bắt buộc: tenant A/B có form khác nhau; chuyển workspace/giả slug không lộ dữ liệu; quyền publish; schema/rule injection và payload quá giới hạn; FE/BE parity; draft/submit required; unknown fields; stale/revoked version; cấu hình mới không đổi hồ sơ cũ; PII trong custom answers/cache/log/export; duplicate/concurrent submit; tương thích web/Zalo và cache invalidation.
- Dev tự viết và chạy test: Jest/Node/browser cho TypeScript; pytest cho Python. GitHub required checks là cổng merge theo quyết định owner; không thêm reviewer AI riêng. Golden expectations giữ nguyên. CI xanh không thay thế nghiệm thu UX/nghiệp vụ hoặc performance/security chưa kiểm chứng.

## 6. Triển khai theo backlog

Hoàn thiện spec/API/schema trước task implementation mới; liên kết thay vì tạo lại #21 identity, #26 documents, #37 claims và #49–#52 UI. Bổ sung task nhỏ riêng cho workspace/config/versioning/web intake khi phạm vi/giao diện dữ liệu đã chốt. Không chặn hồi tố các PR nền tảng độc lập đang chạy; không báo yêu cầu mới đã hoàn tất chỉ vì có tài liệu.
