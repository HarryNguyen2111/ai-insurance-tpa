import { createHash } from 'node:crypto';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, GetBucketVersioningCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const MAX_BYTES = 20 * 1024 * 1024;
export interface UploadObject { key: string; contentType: string; sizeBytes: number; sha256: string; expiresAt: Date }
export interface ObjectEvidence { version: string; sizeBytes: number; sha256: string; contentType: string }
export interface DocumentStorage {
  grant(object: UploadObject): Promise<string>;
  head(object: UploadObject): Promise<ObjectEvidence>;
  read(object: UploadObject, version: string): Promise<Uint8Array>;
}
/** Operator-provisioned private bucket only. Immutable consumers always use VersionId, never latest. */
export class S3DocumentStorage implements DocumentStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor(client: S3Client, bucket: string) { this.client = client; this.bucket = bucket; }
  async grant(o: UploadObject): Promise<string> {
    const bucket = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.bucket }));
    if (bucket.Status !== 'Enabled') throw new Error('Versioned storage required');
    const seconds = Math.floor((o.expiresAt.getTime() - Date.now()) / 1000);
    if (seconds < 1 || seconds > 300) throw new Error('Invalid expiry');
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: o.key,
      ContentType: o.contentType, ContentLength: o.sizeBytes,
      ChecksumSHA256: Buffer.from(o.sha256, 'hex').toString('base64') }),
    { expiresIn: 295, signingDate: new Date(o.expiresAt.getTime() - 295000), signableHeaders: new Set(['content-type', 'content-length']),
      // The existing UploadHeaders contract requires the checksum header, not a hoisted query value.
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']) });
  }
  async head(o: UploadObject): Promise<ObjectEvidence> {
    const h = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: o.key, ChecksumMode: 'ENABLED' }));
    if (!h.VersionId || h.VersionId === 'null' || !h.ChecksumSHA256 || h.ContentLength === undefined || !h.ContentType) throw new Error('Unverifiable object');
    return { version: h.VersionId, sizeBytes: h.ContentLength, sha256: Buffer.from(h.ChecksumSHA256, 'base64').toString('hex'), contentType: h.ContentType };
  }
  async read(o: UploadObject, version: string): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: o.key, VersionId: version, ChecksumMode: 'ENABLED' }));
    if (!result.Body || result.VersionId !== version || result.ContentLength !== o.sizeBytes || result.ContentType !== o.contentType) throw new Error('Object changed');
    const parts: Buffer[] = []; let size = 0;
    for await (const part of result.Body as AsyncIterable<Uint8Array>) {
      size += part.byteLength;
      if (size > o.sizeBytes || size > MAX_BYTES) { (result.Body as { destroy?: () => void }).destroy?.(); throw new Error('Object too large'); }
      parts.push(Buffer.from(part));
    }
    const bytes = Buffer.concat(parts);
    if (size !== o.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== o.sha256) throw new Error('Checksum mismatch');
    return bytes;
  }
}
/** No parsers, external resolution or decompression run in core-api. Scanner performs full structural inspection. */
export function sniffType(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes), text = b.subarray(0, 1024).toString('utf8');
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (b.length >= 12 && b.subarray(4, 8).toString() === 'ftyp') {
    const brand = b.subarray(8, 12).toString();
    if (['heic','heix','hevc','hevx'].includes(brand)) return 'image/heic';
    if (['mif1','msf1'].includes(brand)) return 'image/heif';
  }
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?<([A-Za-z_][\w.:-]*)(?:\s|>)/.test(text)) return 'application/xml';
  return undefined;
}
export function typeMatches(declared: string, actual: string | undefined): boolean {
  return actual === declared || declared === 'text/xml' && actual === 'application/xml';
}
