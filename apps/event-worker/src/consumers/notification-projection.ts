import { NonRetryableEventError, type InboxHandler } from '@tpa/database/inbox';
import type { EventEnvelope } from '@tpa/event-contracts';

/**
 * NOTIF-01 (#107) producer: projects the real, implemented claim events (CLM-02 #37) into the recipient's
 * TENANT inbox. Runs in the event's tenant transaction (SET LOCAL, FORCE RLS) together with the inbox row, so
 * a redelivered event is skipped by the inbox and, if the inbox row was lost, the unique
 * (tenant, recipient, source event, template) key makes the insert a no-op (at-least-once dedup).
 *
 * Only allowlisted templates; text is fixed, minimal and generic: no amounts, diagnosis, identifiers,
 * document URLs, OTP or EOB content. The recipient is derived from PostgreSQL truth (claim submitter), never
 * from the event. Internal review states (AI, STP, doctor review, FRAUD_HOLD, payout processing) and
 * customer-initiated OTP_SIGNED produce nothing. No push/Zalo/provider call here (#41/#13).
 */
export interface NotificationTemplate {
  key: string; version: number; priority: 'INFO' | 'ACTION_REQUIRED'; titleVi: string; bodyVi: string;
}
const t = (key: string, priority: NotificationTemplate['priority'], titleVi: string, bodyVi: string): NotificationTemplate =>
  Object.freeze({ key, version: 1, priority, titleVi, bodyVi });
export const CLAIM_TEMPLATES: Readonly<Record<string, NotificationTemplate>> = Object.freeze({
  SUBMITTED: t('CLAIM_SUBMITTED', 'INFO', 'Đã tiếp nhận hồ sơ bồi thường', 'Hồ sơ của bạn đã được tiếp nhận. Mở hồ sơ để theo dõi tiến trình.'),
  SUPPLEMENT_REQUIRED: t('CLAIM_SUPPLEMENT_REQUIRED', 'ACTION_REQUIRED', 'Hồ sơ cần bổ sung chứng từ', 'Vui lòng mở hồ sơ để xem yêu cầu bổ sung.'),
  WAITING_ORIGINAL_DOCS: t('CLAIM_ORIGINAL_DOCS_REQUIRED', 'ACTION_REQUIRED', 'Hồ sơ cần chứng từ gốc', 'Vui lòng mở hồ sơ để xem hướng dẫn gửi chứng từ gốc.'),
  EOB_READY: t('CLAIM_EOB_READY', 'ACTION_REQUIRED', 'Bảng giải trình đã sẵn sàng',
    'Vui lòng mở hồ sơ để xem và xác nhận. Đọc thông báo này không phải là xác nhận.'),
  PAID: t('CLAIM_PAID', 'INFO', 'Hồ sơ đã được chi trả', 'Mở hồ sơ để xem chi tiết.'),
  REJECTED: t('CLAIM_DECISION_AVAILABLE', 'INFO', 'Hồ sơ đã có kết quả xử lý', 'Mở hồ sơ để xem kết quả và giải thích.'),
  CLOSED_EXPIRED: t('CLAIM_CLOSED', 'INFO', 'Hồ sơ đã đóng', 'Hồ sơ đã đóng do quá hạn bổ sung. Mở hồ sơ để xem chi tiết.'),
});
/** Technical retention proposal (not an approved policy): unread/read rows stop being listed after 90 days. */
export const NOTIFICATION_TTL_DAYS = 90;

/** Pure template selection from the validated envelope; undefined = no notification for this event. */
export function claimTemplate(envelope: Pick<EventEnvelope, 'eventType' | 'payload'>): NotificationTemplate | undefined {
  if (envelope.eventType === 'claim.submitted') return CLAIM_TEMPLATES.SUBMITTED;
  if (envelope.eventType === 'claim.state-changed') {
    const to = (envelope.payload as { toStatus?: unknown }).toStatus;
    // SUBMITTED via supplement re-entry is not re-announced; only customer-relevant targets are allowlisted.
    return typeof to === 'string' && to !== 'SUBMITTED' && Object.hasOwn(CLAIM_TEMPLATES, to) ? CLAIM_TEMPLATES[to] : undefined;
  }
  return undefined;
}

export function createNotificationProjectionHandler(): InboxHandler {
  return {
    consumerName: 'notification-projection', owner: 'notifications',
    eventTypes: ['claim.submitted', 'claim.state-changed'],
    // Each event is an independent notification keyed by its own eventId; out-of-order delivery is harmless.
    ordering: 'none',
    async apply(tx, envelope) {
      const template = claimTemplate(envelope);
      if (!template) return;
      const { rows: [claim] } = await tx.query<{ principal_id: string; membership_id: string; version: number }>(
        'SELECT principal_id::text, membership_id::text, version FROM tpa.claims WHERE id = $1', [envelope.aggregateId]);
      if (!claim || claim.version < envelope.aggregateVersion) {
        throw new NonRetryableEventError('Claim event does not match PostgreSQL truth');
      }
      await tx.query(`INSERT INTO tpa.tenant_notifications(tenant_id,id,recipient_principal_id,recipient_membership_id,service,category,priority,
          template_key,template_version,title_vi,body_vi,target_kind,target_id,source_event_id,source_event_type,source_aggregate_version,occurred_at,expires_at)
        VALUES(tpa.current_tenant_id(),gen_random_uuid(),$1,$2,'TPA_INSURANCE','CLAIM_STATUS',$3,$4,$5,$6,$7,'CLAIM',$8,$9,$10,$11,$12,
          clock_timestamp() + make_interval(days => $13))
        ON CONFLICT DO NOTHING`, // Bare form: an explicit arbiter would apply the recipient SELECT policy to the producer.
      // The id is random, so the only possible conflict is the (tenant, recipient, source event, template) dedup key.
      [claim.principal_id, claim.membership_id, template.priority, template.key, template.version, template.titleVi, template.bodyVi,
        envelope.aggregateId, envelope.eventId, envelope.eventType, envelope.aggregateVersion, envelope.occurredAt, NOTIFICATION_TTL_DAYS]);
    },
  };
}
