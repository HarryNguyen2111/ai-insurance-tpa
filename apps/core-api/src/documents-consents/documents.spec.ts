import { createHash } from 'node:crypto';
import { sniffType, typeMatches, S3DocumentStorage } from './storage.ts';
import { HttpDocumentScanner } from './scanner.ts';
import { S3Client } from '@aws-sdk/client-s3';
const bytes = Buffer.from('%PDF-1.7\nsynthetic');
const sha256 = createHash('sha256').update(bytes).digest('hex');
describe('DOC-01 storage and scanner trust boundaries', () => {
  it('sniffs allowed signatures and rejects executable/empty data; XML alias is explicit', () => {
    expect(sniffType(bytes)).toBe('application/pdf');
    expect(sniffType(Buffer.from('MZ executable'))).toBeUndefined();
    expect(sniffType(Buffer.alloc(0))).toBeUndefined();
    expect(sniffType(Buffer.from('<?xml version="1.0"?><invoice>'))).toBe('application/xml');
    expect(typeMatches('text/xml','application/xml')).toBe(true);
    expect(typeMatches('image/png','application/pdf')).toBe(false);
    expect(sniffType(Buffer.from([255,216,255,0]))).toBe('image/jpeg');
    expect(sniffType(Buffer.from([137,80,78,71,13,10,26,10]))).toBe('image/png');
    expect(sniffType(Buffer.from('0000ftypheic'))).toBe('image/heic');
  });
  it('presigns an exact bounded PUT including checksum/type/length, never a public ACL', async () => {
    const client = new S3Client({ endpoint: 'https://s3.synthetic.invalid', region:'us-east-1',forcePathStyle:true,
      credentials: { accessKeyId:'synthetic',secretAccessKey:'synthetic-only' } });
    jest.spyOn(client,'send').mockResolvedValue({ Status:'Enabled' } as never);
    const s = new S3DocumentStorage(client,'private-documents');
    const u = new URL(await s.grant({ key:'quarantine/opaque',contentType:'application/pdf',sizeBytes:bytes.length,sha256,expiresAt:new Date(Date.now()+290000) }));
    expect(u.protocol).toBe('https:'); expect(u.pathname).toBe('/private-documents/quarantine/opaque');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toMatch(/content-length/);
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toMatch(/content-type/);
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toMatch(/x-amz-checksum-sha256/);
    expect(Number(u.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300);
    expect(u.href).not.toMatch(/public-read|fileName/);
    jest.spyOn(client,'send').mockResolvedValue({ Status:'Suspended' } as never);
    await expect(s.grant({ key:'x',contentType:'application/pdf',sizeBytes:1,sha256,expiresAt:new Date(Date.now()+200000) })).rejects.toThrow();
    client.destroy();
  });
  it('requires version and checksum evidence and independently verifies GET bytes', async () => {
    const client = new S3Client({ region:'us-east-1' }), send = jest.spyOn(client,'send');
    const s = new S3DocumentStorage(client,'private'), o = { key:'opaque',contentType:'application/pdf',sizeBytes:bytes.length,sha256,expiresAt:new Date() };
    send.mockResolvedValueOnce({ ContentLength:bytes.length,ContentType:'application/pdf' } as never);
    await expect(s.head(o)).rejects.toThrow();
    send.mockResolvedValueOnce({ VersionId:'v1',ContentLength:bytes.length,ContentType:'application/pdf',Body:(async function*(){ yield bytes; })() } as never);
    expect(await s.read(o,'v1')).toEqual(bytes);
    send.mockResolvedValueOnce({ VersionId:'v1',ContentLength:bytes.length,ContentType:'application/pdf',Body:(async function*(){ yield Buffer.alloc(bytes.length+1); })() } as never);
    await expect(s.read(o,'v1')).rejects.toThrow('Object too large');
    send.mockResolvedValueOnce({ VersionId:'v1',ContentLength:bytes.length,ContentType:'application/pdf',Body:(async function*(){ yield Buffer.alloc(bytes.length); })() } as never);
    await expect(s.read(o,'v1')).rejects.toThrow('Checksum mismatch'); client.destroy();
  });
  it('blocks type mismatch and XML entities before invoking a parser or network', async () => {
    const s = new HttpDocumentScanner(new URL('https://scanner.synthetic.invalid/scan'),'synthetic-token');
    expect((await s.scan(bytes,'image/png')).clean).toBe(false);
    const xml = Buffer.from('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "http://127.0.0.1/private">]><invoice>&x;</invoice>');
    expect((await s.scan(xml,'application/xml')).clean).toBe(false);
    expect(() => new HttpDocumentScanner(new URL('http://scanner.invalid'),'token')).toThrow();
  });
  it('fails closed on scanner outage, malware, unsafe format, digest mismatch and oversized verdicts', async () => {
    const s = new HttpDocumentScanner(new URL('https://scanner.synthetic.invalid/scan'),'synthetic-token');
    const fetcher = jest.spyOn(globalThis,'fetch');
    const good = { sha256,contentType:'application/pdf',malwareFree:true,structurallySafe:true,scannerVersion:'synthetic-v1' };
    try {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify(good)));
      expect((await s.scan(bytes,'application/pdf')).clean).toBe(true);
      expect(fetcher.mock.calls[0][1]?.body).toEqual(bytes);
      for (const bad of [{ malwareFree:false }, { structurallySafe:false }]) {
        fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...good,...bad })));
        expect((await s.scan(bytes,'application/pdf')).clean).toBe(false);
      }
      for (const bad of [{ sha256:'0'.repeat(64) }, { scannerVersion:'PII invalid version' }]) {
        fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...good,...bad })));
        await expect(s.scan(bytes,'application/pdf')).rejects.toThrow();
      }
      fetcher.mockResolvedValueOnce(new Response('x'.repeat(5000))); await expect(s.scan(bytes,'application/pdf')).rejects.toThrow();
      fetcher.mockRejectedValueOnce(new Error('synthetic outage')); await expect(s.scan(bytes,'application/pdf')).rejects.toThrow();
    } finally { fetcher.mockRestore(); }
  });
});
