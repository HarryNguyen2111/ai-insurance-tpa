/**
 * Stable context ring for the workspace avatar (issue #106 Deliverable B + owner update):
 *
 *   [ PERSONAL ("Loyalty360 cá nhân"), tenant₁, tenant₂, … ]   — double tap moves one step, wrapping.
 *
 * Order is deterministic and independent of visit history (no MRU re-sorting): the personal entry is
 * always first, then server-verified memberships by Vietnamese collation of the display name, ties broken
 * by the immutable membershipId. The same order is shown in the chooser sheet. Only memberships present in
 * the LATEST authoritative list are in the ring; a stale cached entry that the server rejects is removed
 * after the authoritative refresh, never silently skipped to a different tenant (context-switcher.ts).
 */
import type { WorkspaceMembership } from '../adapters/ports.ts';

export const PERSONAL = 'PERSONAL' as const;
export type ContextId = typeof PERSONAL | string;

const collator = new Intl.Collator('vi', { sensitivity: 'base' });

export function stableMemberships(list: readonly WorkspaceMembership[]): WorkspaceMembership[] {
  return [...list].sort(
    (a, b) =>
      collator.compare(a.workspace.displayName, b.workspace.displayName) ||
      (a.membershipId < b.membershipId ? -1 : a.membershipId > b.membershipId ? 1 : 0),
  );
}

export function contextRing(list: readonly WorkspaceMembership[]): ContextId[] {
  return [PERSONAL, ...stableMemberships(list).map((m) => m.membershipId)];
}

/** Next entry after `current`, wrapping. If `current` is no longer in the ring, restart at PERSONAL. */
export function nextInRing(ring: readonly ContextId[], current: ContextId | null): ContextId {
  const i = current === null ? -1 : ring.indexOf(current);
  if (i < 0) return ring[0] ?? PERSONAL;
  return ring[(i + 1) % ring.length]!;
}

/**
 * 0 memberships → the ring is only PERSONAL: no gesture, the sheet explains how to get workspace access.
 * ≥ 1 membership → PERSONAL ⇄ tenant(s): the gesture toggles/cycles, single tap still opens the sheet.
 */
export function quickSwitchEnabled(ring: readonly ContextId[]): boolean {
  return ring.length >= 2;
}
