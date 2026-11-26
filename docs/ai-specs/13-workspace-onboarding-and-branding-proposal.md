# Tạo tổ chức (workspace), hồ sơ tổ chức, logo và giao diện thương hiệu — đề xuất backend

Trạng thái: **ĐỀ XUẤT; OD-02, OD-05, OD-WS1 ĐÃ CHỐT 2026-11-26; CONTRACT WSC1 ĐÃ THÊM VÀO 02; CHƯA TRIỂN KHAI BACKEND.** Owner yêu cầu ngày 2026-11-26 (phản hồi PR #69, issue #68): có hành trình người dùng "bắt đầu → tạo tổ chức → thông tin tổ chức → logo → chỉnh theme". Owner chọn: làm **prototype giao diện chỉ lưu trên trình duyệt** trước, kèm đề xuất backend này để chốt quyết định mở. Tài liệu bổ sung `10-tenant-workspaces-and-dynamic-intake.md` và `11-dynamic-intake-design.md` (§4 workspace, §11 `tenant_workspace_profiles`, S-W1). Không thay bất biến AGENTS.md hay specs 01–12. Contract §4 nằm trong `02-openapi-contracts.yaml` (API 1.3.0, WSC1). Migrations, endpoint, danh tính và phân quyền **chưa** được triển khai.

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
| S-W5 | Wizard tạo tổ chức: thông tin → logo → giao diện → xem lại | TPA_OPS_ADMIN (MFA) | `/to-chuc/tao-moi` | `POST /v1/admin/workspaces`, logo §4.3, `PUT …/theme` | lỗi theo field, slug trùng/dành riêng (422 `DOMAIN_VIOLATION`), quyền (403), MFA-required, idempotent retry |
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

## 4. API (contract WSC1 trong `02-openapi-contracts.yaml`, API 1.3.0)

Mọi endpoint quản trị:
- dùng bearer đã xác minh và header `X-Membership-Context` (server kiểm tra membership/quyền);
- mọi thao tác ghi cần `Idempotency-Key`, MFA và `expectedVersion` (sai → 409 `STALE_VERSION`);
- phản hồi `Cache-Control: no-store`;
- lỗi dùng nguyên `ApiError`/`Error4xx` của C1 (code, messageVi, correlationId) và không echo giá trị người dùng.

Contract **không** thêm mã lỗi hay vai trò mới vào các component C1 đã khóa (snapshot test). Ví dụ: slug trùng hoặc dành riêng trả 422 `DOMAIN_VIOLATION` kèm messageVi ở §3. Lỗi theo từng field (`fieldErrors`) chờ phần mở rộng `ApiError` của F1. `WORKSPACE_ADMIN` và quyền quản trị nền tảng của TPA ops được cấp qua #21; tên vai trò không được thêm vào enum `Membership.roles` của C1 ở bước này.

| operationId | Method + path | Ai | Ghi chú |
| --- | --- | --- | --- |
| `createWorkspace` | `POST /v1/admin/workspaces` | TPA ops + MFA (OD-05) | Body `WorkspaceCreateRequest {displayName, shortName, slug, orgType, description?, theme?, initialAdminPrincipalId}`. 201 `WorkspaceResult`. Slug do TPA cấp tại đây (OD-02). Tạo profile + theme (mặc định nếu thiếu) + `WORKSPACE_ADMIN` đầu tiên trong một transaction. |
| `getWorkspace` | `GET /v1/admin/workspaces/{workspaceId}` | WORKSPACE_ADMIN hoặc TPA ops | 200 `Workspace`. Workspace khác → 404. |
| `updateWorkspaceProfile` | `PUT …/{workspaceId}/profile` | WORKSPACE_ADMIN + MFA | Thay toàn bộ tên/tên viết tắt/loại hình/mô tả; **không có slug** (OD-02). Đổi slug có kiểm soát là thao tác riêng sau OD-WS3. |
| `updateWorkspaceTheme` | `PUT …/{workspaceId}/theme` | WORKSPACE_ADMIN + MFA | Tập đóng `WorkspaceTheme`; tương phản thấp **chỉ** trả `warnings[].code = LOW_SURFACE_CONTRAST` (OD-WS1). |
| `createWorkspaceLogoUpload` | `POST …/{workspaceId}/logo-assets` | WORKSPACE_ADMIN + MFA | `{contentType: png/jpeg/webp, sizeBytes ≤ 2 MiB thô, sha256}` → presigned PUT ≤ 300 giây vào quarantine. core-api không nhận bytes. |
| `completeWorkspaceLogoUpload` | `POST …/logo-assets/{assetId}/complete` | WORKSPACE_ADMIN + MFA | 202 + `Location`. Server kiểm tra lại checksum/kích thước, nhận diện magic bytes (từ chối SVG), giới hạn pixel, quét, mã hóa lại (bỏ EXIF/GPS), tạo bản 512px/64px; bản gốc bất biến. |
| `getWorkspaceLogoAsset` | `GET …/logo-assets/{assetId}` | WORKSPACE_ADMIN | `PENDING_UPLOAD/PROCESSING`, `READY` (có mime/kích thước) hoặc `REJECTED` (mã lỗi cố định, không có văn bản tự do). |
| `setWorkspaceLogo` | `PUT …/{workspaceId}/logo` | WORKSPACE_ADMIN + MFA | `{expectedVersion, logoAssetId}` để kích hoạt asset READY, hoặc `{expectedVersion, clear: true}` để bỏ logo. |

Mỗi mutation ghi business state + `audit_logs` (prev/curr hash) + outbox `workspace.changed` (`WorkspaceChangedEvent`, payload chỉ có `changeKind`) trong cùng `withTenantTransaction`. Event không chứa tên, slug, màu, ảnh hay URL. Không request/response nào nhận hoặc trả `tenantId`; `workspaceId` là định danh riêng, nên OD-01 vẫn mở được.

**Chưa thuộc WSC1:** `GET /v1/public/workspaces/{slug}/branding` (spec 11 S-W1/DI19; công khai, `public, max-age=300`, cần chốt cách phục vụ logo qua CDN/signed URL). Danh sách workspace cho TPA ops và thao tác đổi slug (OD-WS3) cũng chưa có. Ba mục này cần task contract tiếp theo.

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
| WS03 | Slug trùng (kể cả đồng thời) → đúng 1 thành công, còn lại 422 `DOMAIN_VIOLATION` | có (trùng cục bộ) |
| WS04 | Slug dành riêng/sai mẫu → 422 với messageVi §3 | có |
| WS05 | Tên/mô tả chứa `< > { } \`` hoặc ký tự điều khiển → 422 | có (unit) |
| WS06 | Logo SVG/đổi đuôi, file hỏng, ảnh quá nhỏ/lớn/dài, decompression bomb → REJECTED | có (SVG giả PNG, ảnh nhỏ) |
| WS07 | Logo được mã hóa lại, EXIF/GPS bị loại, bản gốc bất biến | có (re-encode phía trình duyệt) |
| WS08 | Theme ngoài tập đóng (CSS injection, enum lạ) → 422 | có (unit + dữ liệu bị sửa) |
| WS09 | `expectedVersion` cũ → 409 `STALE_VERSION`, không ghi đè | có (mô phỏng tab khác) |
| WS10 | Tenant A không đọc/sửa profile tenant B (404) | không |
| WS11 | Branding công khai không chứa ID nội bộ; slug không tồn tại và bị khóa cho cùng 404 | không |
| WS12 | Mỗi thay đổi có audit hash-chain + outbox trong cùng transaction | không |

## 8. Quyết định

| ID | Câu hỏi | Đề xuất mặc định |
| --- | --- | --- |
| OD-01 | Nhiều workspace trong một tenant? | Mặc định Không — **còn mở** |
| OD-02 | Ai cấp/đổi slug; custom domain? | **ĐÃ CHỐT 2026-11-26 (owner):** TPA cấp slug; không custom domain Phase 1 |
| OD-05 | Ai tạo workspace và cấp vai trò quản trị đầu tiên? | **ĐÃ CHỐT 2026-11-26 (owner):** TPA ops tạo tổ chức và cấp admin đầu tiên (MFA) |
| OD-WS1 | Màu có tương phản nền < 3:1: cảnh báo hay chặn? | **ĐÃ CHỐT 2026-11-26 (owner):** chỉ cảnh báo, không chặn |
| OD-WS2 | Zalo Mini App có áp dụng chế độ tối/kiểu thanh bên không? | Chỉ áp màu chính + logo; layout theo kênh |
| OD-WS3 | Đổi tên pháp lý/slug có cần maker-checker? | Có, TPA ops duyệt |
| OD-WS4 | Danh sách loại hình tổ chức chính thức | 3 loại ở §3 |
| OD-WS5 | Thông tin pháp lý (MST, địa chỉ, người đại diện) có thuộc hồ sơ tổ chức? | Chưa; cần pháp chế xác nhận phân loại dữ liệu |

## 9. Thứ tự triển khai đề xuất

1. WSC1 — OD-02/05/WS1 đã chốt; contract §4 đã thêm vào 02 kèm fixtures và test (`packages/shared-contracts/test/workspace-*`). Còn mở: OD-01, OD-WS2–WS5.
2. WSC2 — migration §5 + RLS/trigger + integration tests WS10/WS12. Phụ thuộc #21 và #18.
3. WSC3 — API admin/public + idempotency/audit/outbox (WS01–WS05, WS08, WS09, WS11).
4. WSC4 — pipeline logo theo #26 + Imgproxy (WS06, WS07).
5. WSC5 — nối prototype `apps/workbench` vào API thật, bỏ localStorage, browser E2E với tenant A/B.
