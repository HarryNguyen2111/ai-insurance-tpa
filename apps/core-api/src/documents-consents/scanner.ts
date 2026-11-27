import { createHash } from 'node:crypto';
import { MAX_BYTES, typeMatches, sniffType } from './storage.ts';
export interface ScanVerdict { clean: boolean; scannerVersion: string }
export interface DocumentScanner { scan(bytes: Uint8Array, contentType: string): Promise<ScanVerdict> }
/** Trusted sandbox adapter; no caller URL. Requires malware AND structural safety from the same byte digest.
 * Scanner must isolate parsers, deny network/XXE, enforce page/pixel/expansion limits and reject polyglots.
 * Missing, mismatched, oversized or failed scanner responses throw: original remains quarantined.
 */
export class HttpDocumentScanner implements DocumentScanner {
  private readonly endpoint: URL;
  private readonly token: string;
  constructor(endpoint: URL, token: string) {
    this.endpoint = endpoint; this.token = token;
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || !token) throw new Error('Trusted TLS scanner required');
  }
  async scan(bytes: Uint8Array, contentType: string): Promise<ScanVerdict> {
    if (!bytes.length || bytes.length > MAX_BYTES || !typeMatches(contentType, sniffType(bytes))) return { clean: false, scannerVersion: 'local-format-gate-v1' };
    // Defense in depth before any XML parser. No external entity/network access is permitted.
    if (contentType.endsWith('xml') && /<!DOCTYPE|<!ENTITY/i.test(Buffer.from(bytes).toString('utf8'))) return { clean: false, scannerVersion: 'local-xml-gate-v1' };
    const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/octet-stream', 'x-document-content-type': contentType },
      body: Buffer.from(bytes) });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 4096) throw new Error('Scanner unavailable');
    // Bound response even if Content-Length is absent or lies.
    const reader = response.body?.getReader(); if (!reader) throw new Error('Scanner unavailable');
    const parts: Uint8Array[] = []; let length = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length;
      if (length > 4096) throw new Error('Invalid scanner evidence'); parts.push(value); } }
    finally { await reader.cancel(); }
    const v = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>;
    if (v.sha256 !== createHash('sha256').update(bytes).digest('hex') || v.contentType !== contentType ||
      typeof v.malwareFree !== 'boolean' || typeof v.structurallySafe !== 'boolean' ||
      typeof v.scannerVersion !== 'string' || !/^[A-Za-z0-9_.:+-]{1,200}$/.test(v.scannerVersion)) throw new Error('Invalid scanner evidence');
    return { clean: v.malwareFree && v.structurallySafe, scannerVersion: v.scannerVersion };
  }
}
