import type { InboxHandler } from '@tpa/database/inbox';
import { createNotificationProjectionHandler } from './notification-projection.ts';

/**
 * Inbox consumers deployed with this worker. Replay can only run for a
 * registered handler (it re-applies the handler's effect). EVT-02 ships the
 * runtime only; real consumers (search projection SRCH-01 #47, Temporal bridge
 * WF-01 #25) register here in their own changes. NOTIF-01 (#107) registers the
 * dependency-free notification projection so parked claim events can be replayed.
 */
export const consumerHandlers: readonly InboxHandler[] = Object.freeze([createNotificationProjectionHandler()]);
