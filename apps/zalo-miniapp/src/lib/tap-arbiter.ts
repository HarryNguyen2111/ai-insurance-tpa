/**
 * Single- vs double-tap arbitration for the workspace avatar (issue #106 Deliverable B).
 *
 *  - Pointer tap #1 starts a window; nothing happens yet (so a double tap never flashes the sheet open).
 *  - Pointer tap #2 inside the window → DOUBLE (quick switch); the pending SINGLE is cancelled.
 *  - Window expires with one tap → SINGLE (open the chooser sheet).
 *  - Taps during a short cooldown after a DOUBLE are dropped, so a triple tap does not also open the sheet
 *    or start a second network switch.
 *  - Keyboard / screen-reader activation (`click` with `detail === 0`) is ALWAYS an immediate SINGLE: those
 *    users get the explicit labelled chooser, never a timing gesture.
 *  - When quick switch is not available (only the personal entry exists) a pointer tap is an immediate
 *    SINGLE — no artificial delay.
 *
 * Pure and clock-injected so it is unit-tested without a DOM; the component supplies setTimeout/Date.now.
 * Touch zoom on double tap is avoided with `touch-action: manipulation` on the button only (no global
 * preventDefault / viewport hacks).
 */
export const DOUBLE_TAP_MS = 300;

export type TapOutcome = 'single' | 'double' | 'pending' | 'ignored';

export type ArbiterDeps = {
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  onSingle: () => void;
  onDouble: () => void;
  windowMs?: number;
};

export type TapArbiter = {
  /** `assistive` = keyboard/AT activation; `quickSwitch` = whether the ring has ≥ 2 entries right now. */
  tap: (input: { assistive: boolean; quickSwitch: boolean }) => TapOutcome;
  /** Drop any pending single tap (unmount, navigation, sheet opened by other means). */
  reset: () => void;
};

export function createTapArbiter(deps: ArbiterDeps): TapArbiter {
  const windowMs = deps.windowMs ?? DOUBLE_TAP_MS;
  let pending: unknown = null;
  let cooldownUntil = -Infinity;

  const clearPending = () => {
    if (pending !== null) deps.cancel(pending);
    pending = null;
  };

  return {
    tap({ assistive, quickSwitch }) {
      if (assistive || !quickSwitch) {
        clearPending();
        deps.onSingle();
        return 'single';
      }
      if (deps.now() < cooldownUntil) return 'ignored';
      if (pending !== null) {
        clearPending();
        cooldownUntil = deps.now() + windowMs;
        deps.onDouble();
        return 'double';
      }
      pending = deps.schedule(() => {
        pending = null;
        deps.onSingle();
      }, windowMs);
      return 'pending';
    },
    reset: clearPending,
  };
}
