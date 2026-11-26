/**
 * FNOL upload MOCKUP helpers. Files are never read, hashed, previewed or sent: only the browser-supplied
 * name/type/size metadata is checked against the OpenAPI `UploadRequest` limits. HEIC/HEIF is accepted
 * purely by its declared type (no decoding/conversion on the client — Imgproxy does that server-side).
 */
export const MAX_UPLOAD_BYTES = 20_971_520; // OpenAPI UploadRequest.sizeBytes maximum (20 MiB)

export const ACCEPTED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const;
export type AcceptedContentType = (typeof ACCEPTED_CONTENT_TYPES)[number];

/** Some desktop browsers report HEIC with an empty MIME type; then the extension is the declared type. */
const EXTENSION_TYPES: Record<string, AcceptedContentType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
};

const FILE_NAME_PATTERN = /^[^/\\\x00-\x1f]+$/;

export type FileMeta = { name: string; type: string; size: number };

export type FileCheck =
  | { ok: true; contentType: AcceptedContentType; isHeic: boolean }
  | { ok: false; reasonVi: string };

export function checkFile(file: FileMeta): FileCheck {
  if (!file.name || file.name.length > 255 || !FILE_NAME_PATTERN.test(file.name)) {
    return { ok: false, reasonVi: 'Tên tệp không hợp lệ.' };
  }
  if (!Number.isInteger(file.size) || file.size < 1) {
    return { ok: false, reasonVi: 'Tệp rỗng, vui lòng chọn lại.' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, reasonVi: 'Tệp vượt quá 20 MB.' };
  }
  const declared = file.type.trim().toLowerCase();
  let contentType: AcceptedContentType | undefined;
  if (declared) {
    contentType = (ACCEPTED_CONTENT_TYPES as readonly string[]).includes(declared)
      ? (declared as AcceptedContentType)
      : undefined;
  } else {
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    contentType = EXTENSION_TYPES[ext];
  }
  if (!contentType) {
    return { ok: false, reasonVi: 'Định dạng chưa hỗ trợ. Chấp nhận JPG, PNG, HEIC/HEIF hoặc PDF.' };
  }
  return { ok: true, contentType, isHeic: contentType === 'image/heic' || contentType === 'image/heif' };
}

/** Value for <input accept>, includes extensions for browsers that don't map HEIC MIME types. */
export const ACCEPT_ATTRIBUTE = [...ACCEPTED_CONTENT_TYPES, '.heic', '.heif'].join(',');

/** Camera-denial fallback, in order. */
export const CAMERA_FALLBACK_STEPS = [
  { id: 'retry', titleVi: 'Bật lại quyền camera', bodyVi: 'Mở cài đặt quyền của Zalo và cho phép Camera, sau đó thử lại.' },
  { id: 'gallery', titleVi: 'Chọn ảnh có sẵn', bodyVi: 'Chọn ảnh hoặc PDF chứng từ đã chụp từ thư viện/tệp trên máy.' },
  { id: 'later', titleVi: 'Lưu nháp, gửi sau', bodyVi: 'Giữ lại thông tin đã nhập trên máy này và hoàn tất khi thuận tiện.' },
] as const;
