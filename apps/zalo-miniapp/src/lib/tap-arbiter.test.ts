import assert from 'node:assert/strict';
import test from 'node:test';
import { DOUBLE_TAP_MS, createTapArbiter } from './tap-arbiter.ts';

/** Manual clock + timer queue so arbitration is deterministic. */
function harness() {
  let now = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  const log: string[] = [];
  const arb = createTapArbiter({
    now: () => now,
    schedule: (fn, ms) => {
      const id = ++seq;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    cancel: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
    onSingle: () => log.push('single'),
    onDouble: () => log.push('double'),
  });
  const advance = (ms: number) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    due.forEach((t) => t.fn());
  };
  const tap = (o: Partial<{ assistive: boolean; quickSwitch: boolean }> = {}) =>
    arb.tap({ assistive: false, quickSwitch: true, ...o });
  return { arb, advance, tap, log, pending: () => timers.length };
}

test('one tap → single (sheet) only after the window; nothing fires early', () => {
  const h = harness();
  assert.equal(h.tap(), 'pending');
  h.advance(DOUBLE_TAP_MS - 1);
  assert.deepEqual(h.log, []);
  h.advance(1);
  assert.deepEqual(h.log, ['single']);
});

test('two taps inside the window → exactly one double, and the single is cancelled (no lingering sheet)', () => {
  const h = harness();
  h.tap();
  h.advance(120);
  assert.equal(h.tap(), 'double');
  h.advance(DOUBLE_TAP_MS * 3);
  assert.deepEqual(h.log, ['double']);
  assert.equal(h.pending(), 0);
});

test('two taps slower than the window → two singles, never a double', () => {
  const h = harness();
  h.tap();
  h.advance(DOUBLE_TAP_MS + 10);
  h.tap();
  h.advance(DOUBLE_TAP_MS + 10);
  assert.deepEqual(h.log, ['single', 'single']);
});

test('triple / rapid taps are bounded: one double, the third tap is ignored during cooldown', () => {
  const h = harness();
  h.tap();
  h.advance(50);
  h.tap();
  h.advance(50);
  assert.equal(h.tap(), 'ignored');
  h.advance(DOUBLE_TAP_MS * 2);
  assert.deepEqual(h.log, ['double']);
});

test('keyboard / screen-reader activation is an immediate single and cancels a pending pointer tap', () => {
  const h = harness();
  h.tap();
  assert.equal(h.tap({ assistive: true }), 'single');
  h.advance(DOUBLE_TAP_MS * 2);
  assert.deepEqual(h.log, ['single']);
});

test('no quick switch available (0 memberships) → pointer tap opens the sheet immediately', () => {
  const h = harness();
  assert.equal(h.tap({ quickSwitch: false }), 'single');
  assert.equal(h.tap({ quickSwitch: false }), 'single');
  assert.deepEqual(h.log, ['single', 'single']);
});

test('reset drops a pending single (e.g. unmount)', () => {
  const h = harness();
  h.tap();
  h.arb.reset();
  h.advance(DOUBLE_TAP_MS * 2);
  assert.deepEqual(h.log, []);
});
