import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExitingScreen } from './screen-transition.ts';

test('outgoing route items are detected in every transition mode', () => {
  for (const mode of ['forward', 'backward', 'no-animation']) {
    assert.equal(isExitingScreen(`zaui-routes-item zaui-routes-${mode}-exit`), true, mode);
    assert.equal(isExitingScreen(`zaui-routes-item zaui-routes-${mode}-exit zaui-routes-${mode}-exit-active`), true, mode);
  }
});

test('entering, settled and unrelated elements are not treated as outgoing', () => {
  assert.equal(isExitingScreen('zaui-routes-item'), false);
  assert.equal(isExitingScreen('zaui-routes-item zaui-routes-forward-enter zaui-routes-forward-enter-active'), false);
  assert.equal(isExitingScreen('zaui-routes-item zaui-routes-forward-exit-done'), false);
  assert.equal(isExitingScreen('zaui-routes-forward-exit'), false, 'must be a route item');
  assert.equal(isExitingScreen('card zaui-routes-item-extra zaui-routes-forward-exit'), false);
});
