import type { InboxHandler } from '@tpa/database/inbox';

/**
 * Inbox consumers deployed with this worker. Replay can only run for a
 * registered handler (it re-applies the handler's effect). EVT-02 ships the
 * runtime only; real consumers (search projection SRCH-01 #47, Temporal bridge
 * WF-01 #25) register here in their own changes.
 */
export const consumerHandlers: readonly InboxHandler[] = Object.freeze([]);
