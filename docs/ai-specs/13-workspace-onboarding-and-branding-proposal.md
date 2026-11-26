# Tạo tổ chức (workspace), hồ sơ tổ chức, logo và giao diện thương hiệu — đề xuất backend

Trạng thái: **ĐỀ XUẤT, CHƯA DUYỆT, CHƯA TRIỂN KHAI.** Owner yêu cầu ngày 2026-11-26 (phản hồi PR #69, issue #68): có hành trình người dùng "bắt đầu → tạo tổ chức → thông tin tổ chức → logo → chỉnh theme". Owner chọn: làm **prototype giao diện chỉ lưu trên trình duyệt** trước, kèm đề xuất backend này để chốt quyết định mở. Tài liệu bổ sung `10-tenant-workspaces-and-dynamic-intake.md` và `11-dynamic-intake-design.md` (§4 workspace, §11 `tenant_workspace_profiles`, S-W1). Không thay bất biến AGENTS.md hay specs 01–12. `02-openapi-contracts.yaml` và migrations **không** bị sửa ở đây.

Prototype hiện có: `apps/workbench` — `/to-chuc/tao-moi` (wizard 4 bước), `/to-chuc/cai-dat` (tab Thông tin chung / Logo / Giao diện / Thành viên / Nâng cao), bộ chuyển tổ chức ở thanh bên. Luật kiểm tra dùng chung nằm ở `apps/workbench/src/lib/workspace-profile.ts`; backend tương lai phải dùng **cùng giới hạn và thông điệp** (test parity `workspace-spec-parity.test.ts` giữ tài liệu này khớp với code).

## 1. Phạm vi và nguyên tắc

- 1 workspace = 1 tenant (OD-01, mặc định của spec 11). Workspace không phải database/cluster/deployment riêng.
- Tenant và quyền **luôn** lấy từ danh tính + membership phía server (#21). Slug chỉ để định tuyến và lấy branding công khai; không phải bằng chứng truy cập.
- Phase 1 **không có tự đăng ký**. Đề xuất mặc định: nhân sự TPA ops (vai trò mới `TPA_OPS_ADMIN`, MFA) tạo workspace và cấp `WORKSPACE_ADMIN` đầu tiên (OD-05). `WORKSPACE_ADMIN` sửa hồ sơ/logo/giao diện của chính workspace mình.
- Branding chỉ thay **thu thập/hiển thị**; không thay quyền, hợp đồng, tính tiền, audit hay điều kiện chi trả (spec 10 §3).
- Giao diện chỉ chọn trong **tập đóng** (màu `#RRGGBB`, bo góc, chế độ sáng/tối, kiểu thanh bên). Không nhận CSS, font, HTML, script hay URL do tenant nhập.

## 2. Hành trình và màn hình

| ID | Màn hình | Actor (đề xuất) | Prototype | API đề xuất | Trạng thái UI bắt buộc |
| --- | --- | --- | --- | --- | --- |
| S-W0 | Chào mừng / chưa có tổ chức | Mọi principal đã đăng nhập | `/` (welcome) | `GET /v1/me/memberships` (02) | loading, empty, error |
| S-W5 | Wizard tạo tổ chức: thông tin → logo → giao diện → xem lại | TPA_OPS_ADMIN (MFA) | `/to-chuc/tao-moi` | `POST /v1/admin/workspaces`, logo §4.3, `PUT …/theme` | lỗi theo field, slug trùng/dành riêng (409/422), quyền (403), MFA-required, idempotent retry |
| S-W6 | Cài đặt tổ chức (thông tin, logo, giao diện) | WORKSPACE_ADMIN (MFA) | `/to-chuc/cai-dat` | `GET/PUT …/profile`, logo §4.3, `PUT …/theme` | 409 `STALE_VERSION`, 422, forbidden, đã lưu |
| S-W1 | Bộ chuyển workspace + branding | Mọi principal | thanh bên | 02 `POST /v1/me/membership`; `GET /v1/public/workspaces/{slug}/branding` | xóa cache/UI tenant cũ khi đổi (DI03) |
| S-W2 | Thành viên | WORKSPACE_ADMIN | tab "Thành viên" (khóa) | phụ thuộc #21, OD-05 | forbidden, MFA-required |

Prototype mô phỏng S-W5/S-W6 trên localStorage có phiên bản, gồm cả kiểm tra version cũ (mô phỏng 409). Không giả lập đăng nhập, lời mời, email hay tenant.

## 3. Từ điển trường

PII: dữ liệu tổ chức là **P0** (cấu hình/doanh nghiệp). Không thu thông tin cá nhân (tên/SĐT/email người liên hệ) trong phạm vi này. Mọi chuỗi: trim, NFC, gộp khoảng trắng; cấm `< > { } \`` và ký tự điều khiển.

| UI (vi) | API | Lưu trữ đề xuất | Kiểu / giới hạn | Bắt buộc | Lỗi (messageVi) | Hợp lệ / Không hợp lệ |
| --- | --- | --- | --- | --- | --- | --- |
| Tên tổ chức | `displayName` | `tenant_workspace_profiles.display_name TEXT` | 2–120 ký tự | ✓ | "Tên tổ chức cần ít nhất 2 ký tự." / "Tên tổ chức tối đa 120 ký tự." / "Tên tổ chức không được chứa ký tự < > { } \` hoặc ký tự điều khiển." | "Bảo hiểm Mẫu" / "<b>X</b>" |
| Tên viết tắt | `shortName` | `short_name VARCHAR(12)` | 2–12, `^[A-Z0-9][A-Z0-9-]*$` (tự viết hoa) | ✓ | "Tên viết tắt gồm 2–12 chữ in hoa, số hoặc dấu gạch ngang." | "BHMH" / "B H" |
| Định danh URL | `slug` | `slug VARCHAR(32) UNIQUE` (toàn hệ thống) | 3–32, `^[a-z][a-z0-9-]*[a-z0-9]$`, không `--`, không thuộc danh sách dành riêng | ✓ | "Định danh URL gồm 3–32 ký tự a-z, 0-9, dấu gạch ngang; bắt đầu bằng chữ cái." / "Định danh URL này được hệ thống dành riêng." / "Định danh URL đã được dùng cho tổ chức khác." | "bao-hiem-mau" / "admin", "a--b" |
| Loại hình | `orgType` | `org_type` enum | `INSURER`, `TPA_OPERATOR`, `CORPORATE_CLIENT` (OD-WS4) | ✓ | "Vui lòng chọn loại hình tổ chức." | `INSURER` / `HACKER` |
| Mô tả ngắn | `description` | `description TEXT NULL` | ≤ 300; cho phép xuống dòng | – | "Mô tả tối đa 300 ký tự." | "Tổ chức mẫu…" / "{{x}}" |
| Logo | `logoAssetId` | `logo_asset_id UUID NULL` FK tài sản đã xử lý | PNG/JPEG/WebP theo magic bytes; ≤ 256 KB sau xử lý; 64–2048 px; tỷ lệ ≤ 4:1 | – | "Không hỗ trợ SVG vì tệp SVG có thể chứa mã thực thi…" / "Logo tối đa 256 KB…" / "Logo cần tối thiểu 64×64 px." | PNG 512×512 / SVG, ảnh 32×32 |
| Màu thương hiệu | `theme.primaryColor` | `primary_color CHAR(7)` | `^#[0-9a-f]{6}$` (lưu chữ thường) | ✓ (mặc định `#1d4ed8`) | "Màu chính phải có dạng #RRGGBB." | `#0f766e` / `red`, `#0f766e;x` |
| Bo góc | `theme.radius` | `radius` enum | `NONE`, `SM`, `MD`, `LG` | ✓ (MD) | "Độ bo góc không hợp lệ." | `LG` / `XL` |
| Chế độ | `theme.mode` | `color_mode` enum | `LIGHT`, `DARK` | ✓ (LIGHT) | "Chế độ hiển thị không hợp lệ." | |
| Thanh bên | `theme.sidebarStyle` | `sidebar_style` enum | `LIGHT`, `BRAND` | ✓ (LIGHT) | "Kiểu thanh bên không hợp lệ." | |
| Hệ thống | `version`, `createdAt`, `updatedAt` | cột | chỉ đọc | – | ghi vào → 422 `READONLY_FIELD` | |

Slug dành riêng: `admin, api, app, auth, login, logout, public, static, health, internal, www, mail, tpa, mps, support, help, status, docs, v1, next, assets`.

Màu chữ trên màu chính được chọn tự động: trắng `#ffffff` hoặc đen `#000000`, lấy màu có tương phản cao hơn. Lựa chọn này luôn đạt ≥ 4.5:1 (WCAG AA) với mọi màu. Có cảnh báo (không chặn) khi màu chính so với nền trang < 3:1 (viền/biểu tượng khó thấy). Bảng màu gợi ý: Xanh đại dương `#1d4ed8`, Xanh ngọc `#0f766e`, Lục bảo `#047857`, Đỏ son `#b91c1c`, Cam đất `#c2410c`, Tím than `#6d28d9`, Than chì `#334155`. Việc chặn cứng màu có tương phản nền thấp là OD-WS1.

## 4. API đề xuất (bổ sung vào 02 ở task contract sau khi duyệt)

Mọi endpoint quản trị: bearer đã xác minh, kiểm tra membership/role phía server, `Cache-Control: no-store`, lỗi theo `ApiError` (code, messageVi, correlationId, `fieldErrors[]`), không echo giá trị người dùng.

1. `POST /v1/admin/workspaces`: tạo tenant + profile + theme mặc định + membership `WORKSPACE_ADMIN` cho principal được chỉ định.
   - Điều kiện: `TPA_OPS_ADMIN`, MFA, `Idempotency-Key` (cùng key + khác body → 409 `IDEMPOTENCY_CONFLICT`).
   - Body: `{displayName, shortName, slug, orgType, description?, theme?, initialAdminPrincipalId}`.
   - Trả về 201 `{workspaceId, slug, version:1}`. Slug trùng → 409 `SLUG_TAKEN`; slug dành riêng → 422 `SLUG_RESERVED`.
2. `GET /v1/admin/workspaces/{workspaceId}/profile`: `WORKSPACE_ADMIN` của chính tenant; tenant khác → 404.
3. `PUT /v1/admin/workspaces/{workspaceId}/profile` `{expectedVersion, displayName, shortName, description, orgType}`.
   - Sai version → 409 `STALE_VERSION`.
   - Đổi slug là thao tác riêng của TPA ops (OD-02), có lịch sử redirect tạm.
4. Logo theo mẫu presigned của #26:
   - `POST …/logo/upload-url {contentType, contentLength, sha256}` → presigned PUT vào bucket quarantine. Giới hạn 2 MB thô.
   - `POST …/logo/complete {uploadId, expectedVersion}`.
     - Worker kiểm magic bytes và **từ chối SVG**, giới hạn pixel/decompression bomb, quét file.
     - Ảnh được giải mã và mã hóa lại bằng Imgproxy/thư viện ảnh (loại EXIF/GPS), sinh bản 512px và 64px.
     - Ghi `logo_asset_id` mới (bản gốc giữ bất biến). Trả 202 → trạng thái `PROCESSING|READY|REJECTED`.
   - `DELETE …/logo {expectedVersion}`.
5. `PUT /v1/admin/workspaces/{workspaceId}/theme {expectedVersion, primaryColor, radius, mode, sidebarStyle}`: validate tập đóng, trả cảnh báo tương phản.
6. `GET /v1/public/workspaces/{slug}/branding` (spec 11 S-W1/DI19):
   - Chỉ trả `{displayName, shortName, logoUrl (signed/CDN), theme}` và không có ID nội bộ.
   - `Cache-Control: public, max-age=300`. Slug không tồn tại và workspace bị khóa đều trả cùng một 404.

Mỗi mutation ghi business state + `audit_logs` (prev/curr hash) + outbox `workspace.profile-changed` / `workspace.branding-changed` trong cùng `withTenantTransaction`. Event chỉ chứa ID + version, không chứa ảnh.

## 5. Lưu trữ đề xuất (mở rộng spec 11 §11)

`tenant_workspace_profiles(tenant_id PK, slug UNIQUE, display_name, short_name, org_type, description, logo_asset_id NULL, primary_color CHAR(7) CHECK (primary_color ~ '^#[0-9a-f]{6}$'), radius, color_mode, sidebar_style, version INT, updated_by, updated_at)`.

- Bảng có ENABLE + FORCE RLS và chỉ ghi qua `withTenantTransaction`. Đọc branding công khai đi qua view/function hẹp chỉ chứa cột công khai.
- `workspace_assets(tenant_id, id, kind='LOGO', original_object_key, derived_object_keys, mime, width, height, bytes, sha256, scan_state, created_at)`: bản gốc bất biến, bản dẫn xuất có provenance.
- `tenants.branding_config` JSONB tự do được thay dần bằng các cột có kiểu ở trên. Không lưu CSS.
- Tạo workspace là một transaction: `tenants` + profile + membership đầu tiên + audit + outbox.

## 6. Bảo mật và hiệu năng

- Chỉ chấp nhận tập giá trị đóng → không có CSS/HTML injection. Màu được chèn qua CSS variables sinh từ allowlist (như `themeCssVars`).
- Logo: không tin MIME khai báo; cấm SVG; mã hóa lại; giới hạn kích thước/pixel; quét; ảnh phục vụ qua signed URL/CDN không lộ bucket.
- Slug enumeration: rate-limit endpoint branding công khai; phản hồi 404 đồng nhất.
- Đổi workspace phải xóa cache/state tenant cũ (DI03). Cache branding theo `slug + version`; profile quản trị là `no-store`.
- Audit: ai tạo/sửa, giá trị trước/sau (không gồm ảnh). Maker-checker cho đổi slug/đổi tên pháp lý là OD-WS3.

## 7. Acceptance cases đề xuất (SPECIFICATION_ONLY_NOT_EXECUTED cho backend)

| ID | Kịch bản | Prototype đã có test trình duyệt tương đương |
| --- | --- | --- |
| WS01 | Chỉ `TPA_OPS_ADMIN` + MFA tạo được workspace; principal khác → 403 | không (cần #21) |
| WS02 | Retry cùng `Idempotency-Key` không tạo 2 tenant; khác body → 409 | không |
| WS03 | Slug trùng (kể cả đồng thời) → đúng 1 thành công, còn lại 409 `SLUG_TAKEN` | có (trùng cục bộ) |
| WS04 | Slug dành riêng/sai mẫu → 422 với messageVi §3 | có |
| WS05 | Tên/mô tả chứa `< > { } \`` hoặc ký tự điều khiển → 422 | có (unit) |
| WS06 | Logo SVG/đổi đuôi, file hỏng, ảnh quá nhỏ/lớn/dài, decompression bomb → REJECTED | có (SVG giả PNG, ảnh nhỏ) |
| WS07 | Logo được mã hóa lại, EXIF/GPS bị loại, bản gốc bất biến | có (re-encode phía trình duyệt) |
| WS08 | Theme ngoài tập đóng (CSS injection, enum lạ) → 422 | có (unit + dữ liệu bị sửa) |
| WS09 | `expectedVersion` cũ → 409 `STALE_VERSION`, không ghi đè | có (mô phỏng tab khác) |
| WS10 | Tenant A không đọc/sửa profile tenant B (404) | không |
| WS11 | Branding công khai không chứa ID nội bộ; slug không tồn tại và bị khóa cho cùng 404 | không |
| WS12 | Mỗi thay đổi có audit hash-chain + outbox trong cùng transaction | không |

## 8. Quyết định mở

| ID | Câu hỏi | Đề xuất mặc định |
| --- | --- | --- |
| OD-01 | Nhiều workspace trong một tenant? | Không |
| OD-02 | Ai cấp/đổi slug; custom domain? | TPA ops cấp slug; không custom domain Phase 1 |
| OD-05 | Ai tạo workspace và cấp vai trò quản trị đầu tiên? | TPA ops (`TPA_OPS_ADMIN`, MFA) |
| OD-WS1 | Màu có tương phản nền < 3:1: cảnh báo hay chặn? | Cảnh báo, không chặn |
| OD-WS2 | Zalo Mini App có áp dụng chế độ tối/kiểu thanh bên không? | Chỉ áp màu chính + logo; layout theo kênh |
| OD-WS3 | Đổi tên pháp lý/slug có cần maker-checker? | Có, TPA ops duyệt |
| OD-WS4 | Danh sách loại hình tổ chức chính thức | 3 loại ở §3 |
| OD-WS5 | Thông tin pháp lý (MST, địa chỉ, người đại diện) có thuộc hồ sơ tổ chức? | Chưa; cần pháp chế xác nhận phân loại dữ liệu |

## 9. Thứ tự triển khai đề xuất

1. WSC1 — chốt các OD ở §8 và bổ sung contract §4 vào 02 kèm fixtures.
2. WSC2 — migration §5 + RLS/trigger + integration tests WS10/WS12. Phụ thuộc #21 và #18.
3. WSC3 — API admin/public + idempotency/audit/outbox (WS01–WS05, WS08, WS09, WS11).
4. WSC4 — pipeline logo theo #26 + Imgproxy (WS06, WS07).
5. WSC5 — nối prototype `apps/workbench` vào API thật, bỏ localStorage, browser E2E với tenant A/B.
