// Bounded undo/redo over immutable snapshots. `coalesce` merges consecutive edits of the same field (typing) into one
// step. Pure: the designer keeps the instance in state; nothing here is persisted.
export interface History<T> { past: T[]; present: T; future: T[]; tag?: string }
export const HISTORY_LIMIT = 100;
export const createHistory = <T,>(present: T): History<T> => ({ past: [], present, future: [] });
export function record<T>(h: History<T>, next: T, tag?: string): History<T> {
  if (Object.is(next, h.present)) return h;
  if (tag && h.tag === tag && !h.future.length) return { ...h, present: next };
  const past = [...h.past, h.present].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [], ...(tag ? { tag } : {}) };
}
export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}
export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: h.future[0], future: h.future.slice(1) };
}
/** Replace without an undo step (e.g. server reload or accepted save). */
export const reset = <T,>(present: T): History<T> => createHistory(present);
