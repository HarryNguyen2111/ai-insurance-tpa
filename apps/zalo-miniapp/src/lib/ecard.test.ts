import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROTATION_SECONDS, placeholderCard, placeholderPattern, secondsRemaining } from './ecard.ts';

const T0 = Date.UTC(2026, 10, 26, 3, 0, 0); // aligned to a minute boundary

test('placeholder rotates exactly every 60 seconds', () => {
  const a = placeholderCard(T0);
  assert.equal(placeholderCard(T0 + 59_999).qrToken, a.qrToken);
  const b = placeholderCard(T0 + 60_000);
  assert.notEqual(b.qrToken, a.qrToken);
  assert.equal(b.windowIndex, a.windowIndex + 1);
  assert.equal(Date.parse(a.expiresAt) - Date.parse(a.issuedAt), ROTATION_SECONDS * 1000);
  assert.equal(a.expiresAt, b.issuedAt);
});

test('token is an explicit placeholder, never a real payload', () => {
  const { qrToken } = placeholderCard(T0);
  assert.match(qrToken, /^PLACEHOLDER-KHONG-PHAI-MA-QR-/);
  assert.ok(qrToken.length <= 2048);
});

test('secondsRemaining counts down 60..1', () => {
  assert.equal(secondsRemaining(T0), 60);
  assert.equal(secondsRemaining(T0 + 1), 60);
  assert.equal(secondsRemaining(T0 + 59_000), 1);
  assert.equal(secondsRemaining(T0 + 59_999), 1);
  assert.equal(secondsRemaining(T0 + 60_000), 60);
});

test('pattern is deterministic per window and differs across windows', () => {
  const w = placeholderCard(T0).windowIndex;
  assert.deepEqual(placeholderPattern(w), placeholderPattern(w));
  assert.notDeepEqual(placeholderPattern(w), placeholderPattern(w + 1));
  const p = placeholderPattern(w);
  assert.equal(p.length, 21);
  assert.ok(p.every((row) => row.length === 21));
});
