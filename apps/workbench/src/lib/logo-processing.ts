// Browser-only logo intake for the prototype. The declared MIME type is ignored in
// favour of magic bytes; the decoded image is re-drawn on a canvas so EXIF/GPS and
// any other embedded metadata are dropped before anything is stored.
import { LIMITS, sniffImageMime, validateLogoDimensions, validateLogoFile, type LogoMime, type WorkspaceLogo } from './workspace-profile';

const OUTPUT_MAX_PX = 512;

export type LogoResult = { ok: true; logo: WorkspaceLogo } | { ok: false; message: string };

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function processLogoFile(file: File): Promise<LogoResult> {
  if (file.size > 4 * 1024 * 1024) return { ok: false, message: 'Tệp quá lớn (tối đa 4 MB trước khi tối ưu).' };
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const sniffed = sniffImageMime(head);
  const fileError = validateLogoFile({ declaredMime: file.type, sniffedMime: sniffed, bytes: Math.min(file.size, 1) });
  if (fileError) return { ok: false, message: fileError };

  const sourceUrl = URL.createObjectURL(new Blob([await file.arrayBuffer()], { type: sniffed as LogoMime }));
  let img: HTMLImageElement;
  try {
    img = await loadImage(sourceUrl);
  } catch {
    return { ok: false, message: 'Không đọc được ảnh. Tệp có thể bị hỏng.' };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
  const dimError = validateLogoDimensions(img.naturalWidth, img.naturalHeight);
  if (dimError) return { ok: false, message: dimError };

  const scale = Math.min(1, OUTPUT_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(LIMITS.logoMinPx, Math.round(img.naturalWidth * scale));
  const height = Math.max(LIMITS.logoMinPx, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, message: 'Trình duyệt không hỗ trợ xử lý ảnh.' };
  ctx.drawImage(img, 0, 0, width, height);

  for (const [type, quality] of [['image/png', undefined], ['image/webp', 0.92], ['image/webp', 0.8]] as const) {
    const blob = await canvasToBlob(canvas, type, quality);
    if (blob && blob.type === type && blob.size <= LIMITS.logoBytes) {
      return { ok: true, logo: { mime: type, dataUrl: await blobToDataUrl(blob), width, height, bytes: blob.size } };
    }
  }
  return { ok: false, message: `Không thể tối ưu logo xuống dưới ${LIMITS.logoBytes / 1024} KB.` };
}
