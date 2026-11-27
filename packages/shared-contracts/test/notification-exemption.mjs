// NOTIF-01 (#107), controller decision D3: the ONLY operations exempt from the generic "required
// MembershipContext on every new bearer operation" and "Idempotency-Key on every POST" invariants.
// PERSONAL scope must work with zero memberships, and mark-read is naturally idempotent (monotonic readAt,
// no money/OTP/claim/payout effect; AGENTS rule 6 covers claim creation, OTP and payout).
// notification-contracts.test.mjs fails if this list grows or a listed operation gains such an effect.
export const NOTIFICATION_EXEMPT_OPERATIONS = Object.freeze([
  'listMyNotifications',
  'getMyNotificationUnreadCount',
  'markMyNotificationRead',
  'markMyNotificationsRead',
]);
export const isNotificationExempt = operation => NOTIFICATION_EXEMPT_OPERATIONS.includes(operation?.operationId);
