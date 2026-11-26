# Bản xem trước cục bộ Web + Core API (issue #68)

Trạng thái: **bản xem trước đầu tiên, chỉ chạy cục bộ**. Không triển khai công khai hay
production. Đây không phải luồng bồi thường hoàn chỉnh và không chứng minh nền tảng
phụ thuộc đã sẵn sàng.

## Chạy

Yêu cầu Node 24.22.3 và pnpm 10.34.9 (xem README). Không cần Docker.

```sh
pnpm install --frozen-lockfile
pnpm preview:local      # build core-api + workbench, chạy bản build, chờ sẵn sàng
```

Launcher (`apps/workbench/scripts/local-preview.mjs`, chỉ dùng Node built-in) sẽ:

- chạy `apps/core-api/dist/main.js` trên `127.0.0.1:3000` và `next start` (production) trên
  `127.0.0.1:3100`. Host luôn là `127.0.0.1`; cổng đổi bằng `TPA_PREVIEW_API_PORT` /
  `TPA_PREVIEW_WEB_PORT`. Cổng bị chiếm thì dừng với lỗi rõ ràng, không đụng tiến trình khác;
- ghi PID vào `.preview/preview.json`, log có tiền tố `[core-api]` / `[workbench]` ra terminal
  và vào `.preview/logs/*.log` (thư mục bị gitignore);
- chỉ in `READY http://127.0.0.1:3100` sau khi `GET /health` trả 200 `{"status":"ok"}`, trang
  web trả 200 và `/api/backend-health` báo `ONLINE`;
- khi Ctrl+C / SIGTERM / `pnpm preview:stop`: SIGTERM nhóm tiến trình mà nó đã tạo, SIGKILL
  sau 5 giây nếu cần, xóa tệp trạng thái. `preview:stop` kiểm tra cmdline trước khi gửi
  tín hiệu để tránh PID bị tái sử dụng.

Nếu core-api dừng sau khi đã READY, web vẫn chạy để hiển thị trạng thái
"Không kết nối được Core API"; nếu web dừng, launcher dừng toàn bộ.

## Có gì trong giao diện (`apps/workbench`)

Next.js 16 App Router + TypeScript + Tailwind CSS 4 + **shadcn/ui** (component Radix, style
`radix-nova`, thêm qua CLI chính thức `shadcn@4.23.1`; mã component nằm trong
`src/components/ui`). Giao diện tiếng Việt, font Be Vietnam Pro tự host qua Fontsource
(không gọi Google Fonts). Thanh bên thu gọn được, có bộ chuyển tổ chức; trên điện thoại
thanh bên mở dạng sheet.

| Trang | Nội dung | Thật hay prototype |
| --- | --- | --- |
| `/` Tổng quan | Chưa có tổ chức: màn hình chào mừng, hành trình 6 bước, nút "Tạo tổ chức". Đã có: tên/logo, checklist thiết lập, trạng thái rỗng trung thực (không có số liệu giả), tiến độ | Trạng thái Core API là thật |
| `/to-chuc/tao-moi` | Wizard 4 bước: thông tin tổ chức → logo → giao diện → xem lại, có xem trước trực tiếp | **Prototype — chỉ lưu localStorage** |
| `/to-chuc/cai-dat` | Tab Thông tin chung / Logo / Giao diện (sáng/tối, màu, bo góc, thanh bên) / Thành viên (khóa, #21) / Nâng cao (xóa prototype) | **Prototype** |
| `/tiep-nhan` | Biểu mẫu từ `docs/ai-specs/examples/intake-form-health-outpatient.example.json` (spec 11) | Xem trước; nháp trong bộ nhớ trang |
| `/he-thong` | Chi tiết kết nối Web → Core API | Thật (liveness) |

Prototype tổ chức lưu dưới một khóa `tpa.prototype.workspaces.v1` trong localStorage.
Dữ liệu được kiểm tra lại mỗi lần đọc, và dữ liệu bị sửa/không hợp lệ bị bỏ qua thay vì
hiển thị. Prototype có kiểm tra phiên bản khi lưu (mô phỏng 409 khi tab khác đã sửa) và
giới hạn 5 tổ chức. Logo được nhận diện theo magic bytes (không nhận SVG), vẽ lại bằng
canvas để bỏ metadata và thu nhỏ tối đa 512px, tối đa 256 KB. Giao diện chỉ chọn từ tập
giá trị đóng, chữ trên nút tự chọn trắng/đen để đạt WCAG AA. Prototype **không** có đăng
nhập, tenant, phân quyền, máy chủ hay lời mời thành viên. Thiết kế backend tương ứng
(API, DB, bảo mật, acceptance WS01–WS12, quyết định mở) nằm ở
[docs/ai-specs/13](ai-specs/13-workspace-onboarding-and-branding-proposal.md).

Kết nối backend: trình duyệt chỉ gọi `GET /api/backend-health` cùng origin. Route phía server
gọi `GET {CORE_API_INTERNAL_URL}/health` với địa chỉ cố định lúc khởi động, chỉ chấp nhận
`http://127.0.0.1|localhost|[::1]:<port>` (mặc định `http://127.0.0.1:3000`), timeout 2 giây,
không theo redirect, giới hạn body 1 KiB, `Cache-Control: no-store`, không trả địa chỉ nội bộ
và không chuyển tiếp path/query/header/cookie nào từ trình duyệt. Trạng thái UI:
`ONLINE`, `UNREACHABLE`, `UNEXPECTED_RESPONSE`, `MISCONFIGURED`, `BROWSER_OFFLINE`,
`WEB_UNREACHABLE`. `ONLINE` chỉ là liveness tiến trình.

Không có: đăng nhập/tenant, tạo hoặc nộp hồ sơ, upload, AI, tính quyền lợi/tiền, lưu trữ,
localStorage hay dữ liệu cá nhân. Nút tải chứng từ và nút nộp hồ sơ bị khóa kèm lý do.
`POST /v1/claims` trên core-api vẫn trả 404 như scaffold.

## Kiểm thử

| Lệnh | Nội dung |
| --- | --- |
| `pnpm test` | node:test (33): allowlist địa chỉ; health check với HTTP server thật (200/500/redirect/body sai/quá lớn/timeout/refused); mô hình xem trước dựa trên ví dụ spec; kiểm tra hồ sơ tổ chức, slug, tương phản WCAG (gồm thuộc tính trên 4096 màu), allowlist CSS variables, nhận diện ảnh theo magic bytes; store localStorage bị sửa; parity giữa code và spec 13 |
| `pnpm typecheck` | `next typegen` + `tsc --noEmit` |
| `pnpm build` | `next build` production |
| `pnpm test:smoke` | Playwright Chromium (12) với core-api đã build + `next start`: online, route GET-only/không passthrough, xem trước trung thực, backend dừng → `UNREACHABLE` → khởi động lại → `ONLINE`, trình duyệt offline, web dừng, địa chỉ không phải loopback → `MISCONFIGURED`, điều hướng mobile; hành trình tạo tổ chức (lỗi field, slug dành riêng/trùng, SVG giả PNG, logo nhỏ, logo được tối ưu, theme, tạo, áp màu thương hiệu, tải lại), cài đặt (sửa tên, chế độ tối, phát hiện version cũ), bộ chuyển tổ chức và xóa, dữ liệu localStorage bị sửa; sau đó node:test cho launcher (READY, dọn dẹp, `--stop`, cổng bị chiếm) |

Ảnh chụp nằm ở `apps/workbench/test-results/evidence/`; CI tải lên artifact
`workbench-smoke-evidence`. Playwright cần Chromium: `pnpm --filter @tpa/workbench exec
playwright install chromium` (CI dùng `--with-deps`).

Golden TC01–TC06, PT01–PT24 và DI01–DI28 **không áp dụng / chưa chạy** cho bản xem trước
này; không case nào được báo PASS.

## Điều kiện backend còn thiếu trước luồng bồi thường thật

1. Danh tính OIDC + membership/tenant phía server (#21); MFA cho nhân sự.
2. Lưu tổ chức/logo/giao diện phía máy chủ theo spec 13 sau khi chốt OD-01/02/05 và OD-WS1–WS5.
3. Upload chứng từ qua Pre-signed URL, quarantine/scan (#26).
4. Hợp đồng API intake (F1), `packages/intake-rules` (F2), migrations (F3), API runtime/intake (F5/F6) và claims domain service (#37) với idempotency, audit, outbox.
5. Đề xuất AI có bằng chứng (#30/#31/F7) và candidate quyền lợi theo hợp đồng (#32).
6. Nền tảng phụ thuộc (PostgreSQL, Redis, Kafka, Temporal, Elasticsearch, S3) — kiểm tra riêng
   qua `pnpm infra:up` / workflow `dependency-smoke`; bản xem trước này không thay thế.
