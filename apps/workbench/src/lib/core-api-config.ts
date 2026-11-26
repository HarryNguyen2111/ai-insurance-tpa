// Server-only configuration of the single backend the web preview may contact.
// The origin is fixed at process start from CORE_API_INTERNAL_URL and must be a
// plain-HTTP loopback origin (this is a LOCAL preview). Nothing from the browser
// request ever influences the target: no path, query, header or host passthrough.

export const DEFAULT_CORE_API_ORIGIN = 'http://127.0.0.1:3000';
export const CORE_API_HEALTH_PATH = '/health';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type CoreApiConfig =
  | { ok: true; origin: string }
  | { ok: false; reason: 'INVALID_URL' | 'NOT_LOOPBACK' | 'UNSUPPORTED_FORM' };

export function parseCoreApiOrigin(raw: string | undefined): CoreApiConfig {
  const value = raw === undefined || raw.trim() === '' ? DEFAULT_CORE_API_ORIGIN : raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'INVALID_URL' };
  }
  if (url.protocol !== 'http:') return { ok: false, reason: 'UNSUPPORTED_FORM' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'UNSUPPORTED_FORM' };
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'UNSUPPORTED_FORM' };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return { ok: false, reason: 'NOT_LOOPBACK' };
  return { ok: true, origin: url.origin };
}
