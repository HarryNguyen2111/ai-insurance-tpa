# `@tpa/zalo-miniapp` — Bản thử nghiệm giả lập (UI-Z0, issue #74)

> **BẢN THỬ NGHIỆM · DỮ LIỆU GIẢ LẬP.** Chỉ chạy trên trình duyệt: không backend, không đăng nhập, không lưu trữ,
> không danh tính Zalo thật, không tải tệp lên. Mọi số liệu, điều khoản và mã băm hiển thị là **MẪU**.
> Ứng dụng này **không** đáp ứng UI-Z1 #49 hay UI-Z2 #50 (vẫn bị chặn bởi #21, #26, #27, #36–#41).

## Chạy nhanh

```bash
pnpm install                                   # từ thư mục gốc monorepo (Node 24.22.3, pnpm 10.34.9)
pnpm --filter @tpa/zalo-miniapp dev            # http://127.0.0.1:3200 (dev fallback, không cần Zalo)
pnpm --filter @tpa/zalo-miniapp typecheck
pnpm --filter @tpa/zalo-miniapp test           # unit tests (node --test, TS gốc)
pnpm --filter @tpa/zalo-miniapp build          # vite build + kiểm tra bundle < 4 MB, không WASM/OpenCV
pnpm --filter @tpa/zalo-miniapp test:smoke     # Playwright (Pixel 7 Chromium) trên bản build production
```

Báo cáo kích thước bundle: `test-results/bundle-size.json`; ảnh chụp smoke: `test-results/*.png`.

## Màn hình

| Đường dẫn | Nội dung |
| --- | --- |
| `/` | Giới thiệu (onboarding) |
| `/consent`, `/consent/denied` | Điều khoản đồng ý có phiên bản + mã băm SHA-256; nhánh **không đồng ý** → chế độ giới hạn (chỉ xem thẻ) |
| `/home` | Trang chủ; nút gửi hồ sơ khóa khi chưa đồng ý phiên bản hiện hành |
| `/ecard` | Thẻ điện tử với hình **MẪU (không phải mã QR)**, token placeholder đổi mỗi 60 giây |
| `/claims/new` | FNOL mô phỏng: giả lập quyền camera; bị từ chối → 3 bước dự phòng (bật lại quyền · chọn ảnh có sẵn · lưu nháp); HEIC/HEIF nhận theo **kiểu tệp** (MIME, hoặc đuôi tệp khi MIME rỗng); không đọc nội dung, không tải lên |
| `/claims`, `/claims/:id` | Danh sách + tiến trình hồ sơ (ẩn làn thẩm định nội bộ như FRAUD_HOLD với khách) |
| `/claims/:id/eob` | Bảng giải trình (EOB) từ fixture: tiền là chuỗi `Money`, mỗi dòng có điều khoản trích dẫn + `explanationVi`; nút OTP bị khóa |

Fixture (`src/fixtures/synthetic.ts`) theo hình dạng `ClaimSummary`, `ClaimDetail`, `ExplainableEOBResponse`, `EobLine`,
`ContractClause`, `ECard` trong `docs/ai-specs/02-openapi-contracts.yaml`. Tiền luôn là chuỗi `"720000.00"`; hiển thị/cộng
bằng `decimal.js` (`ROUND_HALF_UP`), không bao giờ dùng `number`.

## Dev fallback (không có Zalo runtime)

`src/lib/platform.ts` nhận diện Zalo qua cầu nối native (`ZaloJavaScriptInterface` / `ZJSBridge`). Ngoài Zalo:

- banner hiển thị “Đang chạy ngoài Zalo (chế độ giả lập trình duyệt)”;
- quyền camera là lựa chọn giả lập trên màn hình (để kiểm thử nhánh từ chối một cách xác định);
- “Mở cài đặt quyền” chỉ hiển thị hướng dẫn;
- `zmp-sdk` **không** được tải (chỉ `import()` động khi ở trong Zalo, nằm ở chunk riêng);
- `?runtime=browser` ép dùng fallback kể cả khi có cầu nối.

Router dùng `ZMPRouter memoryRouter` vì ở bản build production `ZMPRouter` mặc định đặt basename `/zapps/<APP_ID>`,
không chạy được trên trình duyệt thường.

## Cần ứng dụng Zalo thật (provider blocker — không khẳng định ở đây)

- Zalo Mini App ID, tài khoản Zalo OA/nhà phát triển, quyền mini-app (camera, thông tin người dùng, số điện thoại).
- `zmp-cli` (`zmp login`/`zmp start`/`zmp deploy`) và `zmp-vite-plugin` để đóng gói/deploy; `app-config.json` ở đây chỉ là stub.
- Kiểm thử trên thiết bị thật iOS/Android: `requestCameraPermission`, `openPermissionSetting`, `chooseImage`, `openDocument` (PDF),
  ảnh HEIC từ iPhone, safe-area, `compressLevel`.
- Đăng nhập thật: `POST /v1/auth/zalo/exchange` (xác minh phía server), `GET /v1/me`; consent thật qua `POST /v1/consents`;
  e-card thật qua `GET /v1/members/{memberId}/e-card` (token ≤ 60 s, xác thực khi dùng); upload qua pre-signed URL +
  `Idempotency-Key`; OTP gắn phiên bản/mã băm EOB. Tất cả thuộc #49/#50 và các issue backend liên quan.
- Văn bản đồng ý chính thức, mục đích xử lý và phiên bản do pháp chế phê duyệt.

## Phiên bản (đã kiểm tra 2026-11-26)

Cặp phiên bản theo template chính thức `Zalo-MiniApp/zmp-blank-templates` (cập nhật 2026-10-29: `zmp-sdk ^2.53.3`,
`zmp-ui ^1.11.15-2`, React 18.3, Vite 5, `@vitejs/plugin-react` 4) và npm registry:

| Gói | Ghim | Ghi chú |
| --- | --- | --- |
| `zmp-sdk` | 2.54.0 | `latest` trên npm (2026-11-17) |
| `zmp-ui` | 1.11.15-2 | `latest` trên npm và template chính thức (hậu tố `-2` là bản phát hành của Zalo) |
| `react` / `react-dom` | 18.3.1 | `zmp-ui` phụ thuộc `react-is ^18`; template chính thức dùng React 18 |
| `vite` | 5.4.21 | `zmp-vite-plugin` 1.1.6 chỉ hỗ trợ Vite 4–5 |
| `@vitejs/plugin-react` | 4.7.0 | dòng 4.x tương thích Vite 5 |

Cài thật bằng Node 24.22.3 + pnpm 10.34.9 (`engine-strict`) không có cảnh báo peer dependency. `tsconfig.json` ánh xạ
`react` về `@types/react` 18 của gói này vì `.d.ts` của `zmp-ui` sẽ lấy nhầm `@types/react` 19 được hoist từ workbench.
