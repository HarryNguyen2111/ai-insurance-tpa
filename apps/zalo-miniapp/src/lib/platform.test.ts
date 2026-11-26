import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRuntime, openPermissionSettings, requestCamera } from './platform.ts';

test('plain browser (no Zalo bridge) uses the dev fallback', () => {
  assert.equal(detectRuntime({ location: { search: '' } }), 'browser');
  assert.equal(detectRuntime(undefined), 'browser');
});

test('Zalo bridge objects select the zalo runtime; ?runtime=browser forces the fallback', () => {
  assert.equal(detectRuntime({ ZaloJavaScriptInterface: {}, location: { search: '' } }), 'zalo');
  assert.equal(detectRuntime({ ZJSBridge: {}, location: { search: '' } }), 'zalo');
  assert.equal(detectRuntime({ ZJSBridge: {}, location: { search: '?runtime=browser' } }), 'browser');
});

test('browser camera permission is simulated and never touches zmp-sdk', async () => {
  assert.deepEqual(await requestCamera('browser', false), { granted: false, simulated: true });
  assert.deepEqual(await requestCamera('browser', true), { granted: true, simulated: true });
  assert.equal(await openPermissionSettings('browser'), false);
});
