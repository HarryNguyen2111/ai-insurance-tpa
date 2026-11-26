import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCEPT_ATTRIBUTE, CAMERA_FALLBACK_STEPS, MAX_UPLOAD_BYTES, checkFile } from './upload.ts';

test('HEIC/HEIF accepted by declared MIME type alone', () => {
  assert.deepEqual(checkFile({ name: 'hoa-don.heic', type: 'image/heic', size: 1000 }), {
    ok: true, contentType: 'image/heic', isHeic: true,
  });
  assert.deepEqual(checkFile({ name: 'x', type: 'image/heif', size: 1 }), { ok: true, contentType: 'image/heif', isHeic: true });
});

test('empty MIME falls back to the extension; a conflicting MIME is NOT overridden by extension', () => {
  assert.deepEqual(checkFile({ name: 'IMG_0001.HEIC', type: '', size: 10 }), { ok: true, contentType: 'image/heic', isHeic: true });
  assert.equal(checkFile({ name: 'IMG_0001.heic', type: 'application/octet-stream', size: 10 }).ok, false);
});

test('common document types are accepted, others rejected with a Vietnamese reason', () => {
  for (const type of ['image/jpeg', 'image/png', 'application/pdf']) {
    assert.equal(checkFile({ name: 'a', type, size: 5 }).ok, true, type);
  }
  const gif = checkFile({ name: 'a.gif', type: 'image/gif', size: 5 });
  assert.equal(gif.ok, false);
  assert.match(gif.ok ? '' : gif.reasonVi, /Định dạng chưa hỗ trợ/);
});

test('size and filename limits mirror OpenAPI UploadRequest', () => {
  assert.equal(checkFile({ name: 'a.jpg', type: 'image/jpeg', size: MAX_UPLOAD_BYTES }).ok, true);
  assert.equal(checkFile({ name: 'a.jpg', type: 'image/jpeg', size: MAX_UPLOAD_BYTES + 1 }).ok, false);
  assert.equal(checkFile({ name: 'a.jpg', type: 'image/jpeg', size: 0 }).ok, false);
  assert.equal(checkFile({ name: '../a.jpg', type: 'image/jpeg', size: 1 }).ok, false);
  assert.equal(checkFile({ name: 'a\u0001.jpg', type: 'image/jpeg', size: 1 }).ok, false);
  assert.equal(checkFile({ name: 'a'.repeat(256), type: 'image/jpeg', size: 1 }).ok, false);
});

test('accept attribute advertises HEIC; camera-denial fallback has exactly 3 ordered steps', () => {
  assert.match(ACCEPT_ATTRIBUTE, /image\/heic/);
  assert.match(ACCEPT_ATTRIBUTE, /\.heic/);
  assert.deepEqual(CAMERA_FALLBACK_STEPS.map((s) => s.id), ['retry', 'gallery', 'later']);
});
