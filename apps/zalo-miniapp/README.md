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
| `/home` | Trang chủ (banner, lời chào, hợp đồng, dịch vụ, hồ sơ gần đây) + thanh điều hướng dưới; nút gửi hồ sơ khóa khi chưa đồng ý phiên bản hiện hành |
| `/ecard` | Thẻ điện tử với hình **MẪU (không phải mã QR)**, token placeholder đổi mỗi 60 giây |
| `/claims/new` | FNOL mô phỏng: giả lập quyền camera; bị từ chối → 3 bước dự phòng (bật lại quyền · chọn ảnh có sẵn · lưu nháp); HEIC/HEIF nhận theo **kiểu tệp** (MIME, hoặc đuôi tệp khi MIME rỗng); không đọc nội dung, không tải lên |
| `/claims`, `/claims/:id` | Danh sách + tiến trình hồ sơ (ẩn làn thẩm định nội bộ như FRAUD_HOLD với khách) |
| `/claims/:id/eob` | Bảng giải trình (EOB) từ fixture: tiền là chuỗi `Money`, mỗi dòng có điều khoản trích dẫn + `explanationVi`; nút OTP bị khóa |

Fixture (`src/fixtures/synthetic.ts`) theo hình dạng `ClaimSummary`, `ClaimDetail`, `ExplainableEOBResponse`, `EobLine`,
`ContractClause`, `ECard` trong `docs/ai-specs/02-openapi-contracts.yaml`. Tiền luôn là chuỗi `"720000.00"`; hiển thị/cộng
bằng `decimal.js` (`ROUND_HALF_UP`), không bao giờ dùng `number`.

## Đối chiếu mẫu giao diện (issue #104)

Owner chọn `/home/tnv/data/vimid-loyalty` (commit `79327a0`, dẫn xuất từ template công khai *ZaUI Coffee* của Zalo, không có
tệp LICENSE, `package.json` ghi `UNLICENSED`) làm **mẫu cấu trúc thị giác**. Chỉ tái hiện cấu trúc bằng mã mới; **không** sao chép
mã, ảnh, logo, AppID, URL API, đăng nhập mật khẩu, dữ liệu hay lockfile. Giữ zmp-ui/React 18/Vite 5 hiện tại (không chuyển
sang Vite 2/Recoil/Swiper/Tailwind).

| Mẫu (vimid-loyalty) | Thành phần TPA | Điều chỉnh |
| --- | --- | --- |
| `components/layout.tsx` (Routes + `<Navigation/>` ngoài routes) | `src/app.tsx` | `BottomNav` đặt **một lần** ngoài `AnimationRoutes`, không bị nhân đôi khi chuyển cảnh |
| `components/navigation.tsx` (ZaUI `BottomNavigation`, nút "Liên hệ" nổi màu `#183346`, ẩn khi bàn phím mở / trang chi tiết) | `src/components/bottom-nav.tsx`, `src/lib/navigation.ts` | Tab chỉ trỏ tới route đã có: Trang chủ `/home`, Hồ sơ `/claims`, Thẻ BH `/ecard`; nút nổi → **Gửi hồ sơ** `/claims/new`, bị khóa khi chưa đồng ý phiên bản điều khoản hiện hành; "Cá nhân" hiển thị **Sắp có**, bấm chỉ báo chưa khả dụng (không có màn giả). Bỏ badge số đếm giả. Ẩn thanh ở onboarding/consent/FNOL/chi tiết hồ sơ/EOB nên không che nút gửi hay EOB; ẩn khi bàn phím mở (ngưỡng 160 px như mẫu) |
| `pages/index/index.tsx` (`bg-[#FFF8E6]`: Banner → Welcome → nội dung cuộn) | `src/pages/home.tsx` (`.page.warm`) | Cùng thứ tự |
| `pages/index/banner.tsx` (Swiper 2:1, chấm phân trang dạng viên thuốc) | `Banner` trong `home.tsx` | CSS scroll-snap, 3 slide chữ + biểu tượng, không ảnh, không tự chạy |
| `components/welcome_vimid.tsx` (tiêu đề app + "Chào mừng, {tên}!") | `Welcome` trong `home.tsx` | Tiêu đề trung tính "Bồi thường Sức khỏe", tên đã che từ fixture; không logo DNBH/tenant |
| `components/section.tsx` + `divider.tsx` | `src/components/section.tsx` | Khối trắng có tiêu đề → thẻ bo góc 16 px trên nền ấm |
| `recommend.tsx`, `product-list.tsx` (xe/sản phẩm) | "Hợp đồng của bạn", "Dịch vụ" (lưới biểu tượng), "Hồ sơ gần đây" | Nội dung xe/loyalty thay bằng hợp đồng, chức năng và hồ sơ **giả lập** |
| `css/app.scss`, `tailwind.config.js`, `app-config.json` `primaryColor` | `src/styles.css` | Màu lấy từ mẫu: nền `#FFF8E6`/`#f4f5f6`, vàng `#ecbf3b`, navy `#183346`, viền `#E9EBED`. Vàng chỉ dùng làm nền/chỉ báo (chữ vàng trên trắng chỉ ~1.9:1); nút chính dùng navy. Chữ phụ giữ `#4a5468` vì xám mẫu `#767A7F` không đạt 4.5:1 trên nền ấm |
| Font biểu tượng zmp-ui (`<Icon>`, tải từ CDN `h5.zadn.vn`) | `src/components/icons.tsx` | SVG nội tuyến tự vẽ: bản giả lập không được gọi ra ngoài 127.0.0.1 |

Banner thử nghiệm giờ là một dải gọn (≤ 2 dòng) nhưng vẫn luôn hiển thị. Ảnh so sánh 390×844 và 360×640: `pnpm test:smoke`
sinh `test-results/104-*.png`. Kiểm thử hồi quy: `e2e/navigation.spec.ts` (tab/`aria-current`, tab chưa khả dụng, khóa theo
đồng ý, một thanh duy nhất khi chuyển cảnh, nội dung không bị che ở 2 khung nhìn, safe-area 34 px). Chạy khi cổng 3201 đang
bận: `SMOKE_PORT=3317 pnpm test:smoke`.

## Trang tiện ích, đổi không gian và Loyalty360 (issue #106)

Thiết kế đầy đủ (bản đồ màn hình, ma trận trường → nguồn → quyền → test, máy trạng thái, ranh giới dữ liệu, token
giao diện, khoảng trống hợp đồng G1–G9): [`docs/106-user-hub-design.md`](docs/106-user-hub-design.md).

- Vào từ màn đầu tiên: **Mở trang tiện ích cá nhân** → `/hub`. Không chọn đơn vị ⇒ Loyalty360 cá nhân (giả lập).
- Biểu tượng đơn vị: chạm 1 lần mở danh sách chọn; chạm đúp chuyển lần lượt Cá nhân → An Bình → Bình Minh →
  Cát Tường → Cá nhân. Bàn phím/trình đọc màn hình: Enter mở danh sách.
- Giao diện theo màu thương hiệu của đơn vị đang dùng (hợp đồng #72); Bình Minh cố ý có màu tương phản thấp để thể
  hiện cảnh báo OD-WS1 và màu chữ/viền dẫn xuất.
- Mọi dữ liệu đơn vị/Loyalty360 là giả lập trong `src/fixtures/workspaces.ts`, qua cổng `src/adapters/ports.ts`.
  Không có API thật, không lưu gì vào bộ nhớ trình duyệt.
- Kịch bản qua URL: `?members=0|1|2|3`, `?start=PERSONAL|AB|BM|CT`, `?slow=BM` (phản hồi trễ 1,5 s),
  `?badtheme=CT` (màu không hợp lệ). Các tình huống mất mạng/lỗi/thu hồi quyền/đổi màu ở màn **Cá nhân → Bảng
  điều khiển mô phỏng**.
- Chuông thông báo chỉ là chỗ giữ chỗ cho #107: không có số đếm, không có thông báo.

## Dev fallback (không có Zalo runtime)

`src/lib/platform.ts` nhận diện Zalo qua cầu nối native (`ZaloJavaScriptInterface` / `ZJSBridge`). Ngoài Zalo:

- banner hiển thị “Đang chạy ngoài Zalo (chế độ giả lập trình duyệt)”;
- quyền camera là lựa chọn giả lập trên màn hình (để kiểm thử nhánh từ chối một cách xác định);
- “Mở cài đặt quyền” chỉ hiển thị hướng dẫn;
- `zmp-sdk` **không** được tải (chỉ `import()` động khi ở trong Zalo, nằm ở chunk riêng);
- `?runtime=browser` ép dùng fallback kể cả khi có cầu nối.

Router dùng `ZMPRouter memoryRouter` vì ở bản build production `ZMPRouter` mặc định đặt basename `/zapps/<APP_ID>`,
không chạy được trên trình duyệt thường.

`AnimationRoutes` của zmp-ui giữ màn hình cũ trong 400 ms chuyển cảnh; `src/components/screen-transition.ts` đặt màn hình đang
thoát thành `inert` + `aria-hidden` để chỉ một màn hình được thao tác/đọc bởi trình đọc màn hình (và smoke test không bị lẫn).

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
