import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistory, HISTORY_LIMIT, record, redo, reset, undo } from './workflow-history.ts';

test('undo/redo walk snapshots; a new edit clears redo', () => {
  let h = createHistory('a');
  h = record(h, 'b'); h = record(h, 'c');
  h = undo(h); assert.equal(h.present, 'b');
  h = undo(h); assert.equal(h.present, 'a');
  h = undo(h); assert.equal(h.present, 'a');
  h = redo(h); assert.equal(h.present, 'b');
  h = record(h, 'x'); assert.deepEqual([h.past, h.present, h.future], [['a', 'b'], 'x', []]);
  assert.equal(redo(h), h);
});
test('typing in one field coalesces into one undo step; different fields do not', () => {
  let h = createHistory('');
  for (const v of ['T', 'Ti', 'Tie']) h = record(h, v, 'n_a:label');
  h = record(h, 'Tie!', 'n_a:sla');
  assert.deepEqual(h.past, ['', 'Tie']);
  assert.equal(undo(undo(h)).present, '');
});
test('history is bounded and reset drops undo across server reloads', () => {
  let h = createHistory(0);
  for (let i = 1; i <= HISTORY_LIMIT + 20; i++) h = record(h, i);
  assert.equal(h.past.length, HISTORY_LIMIT);
  assert.deepEqual(reset(5), { past: [], present: 5, future: [] });
});
