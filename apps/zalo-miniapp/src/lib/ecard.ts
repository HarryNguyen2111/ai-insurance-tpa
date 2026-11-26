/**
 * E-card PLACEHOLDER rotation. Real `ECard.qrToken` is an opaque server token (<= 60 s) that needs
 * backend authorisation (#36-#41). Here the token is a visibly fake label and the pattern is
 * NOT a QR code — nothing scannable, no member data encoded.
 */
export const ROTATION_SECONDS = 60;
const ROTATION_MS = ROTATION_SECONDS * 1000;

export type PlaceholderCard = {
  windowIndex: number;
  qrToken: string;
  issuedAt: string;
  expiresAt: string;
};

export function placeholderCard(nowMs: number): PlaceholderCard {
  const windowIndex = Math.floor(nowMs / ROTATION_MS);
  const issued = windowIndex * ROTATION_MS;
  return {
    windowIndex,
    qrToken: `PLACEHOLDER-KHONG-PHAI-MA-QR-${windowIndex.toString(36).toUpperCase()}`,
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + ROTATION_MS).toISOString(),
  };
}

/** Whole seconds until the placeholder rotates, in [1, 60]. */
export function secondsRemaining(nowMs: number): number {
  const elapsed = nowMs - Math.floor(nowMs / ROTATION_MS) * ROTATION_MS;
  return Math.ceil((ROTATION_MS - elapsed) / 1000) || ROTATION_SECONDS;
}

/**
 * Deterministic decorative N×N pattern derived only from the rotation window (xorshift PRNG).
 * Deliberately lacks QR finder patterns/format info so no reader can decode it.
 */
export function placeholderPattern(windowIndex: number, size = 21): boolean[][] {
  let s = (windowIndex ^ 0x9e3779b9) >>> 0 || 1;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
  return Array.from({ length: size }, () => Array.from({ length: size }, () => (next() & 1) === 1));
}
