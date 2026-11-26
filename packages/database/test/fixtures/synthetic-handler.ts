// TEST ONLY: synthetic consumer harness for EVT-02 (#24). Requires fixtures/consumer.sql.
import type { EventEnvelope } from '@tpa/event-contracts';
import type { InboxHandler } from '../../src/inbox.ts';
import type { TenantTransaction } from '../../src/tenant.ts';

export interface SyntheticOptions {
  consumerName?: string;
  withReconcile?: boolean;
  /** Return an error to throw for this event (before any write), or undefined to apply. */
  fail?: (envelope: Readonly<EventEnvelope>) => Error | undefined;
  /** Called after the effect rows are written, still inside the transaction. */
  afterApply?: (envelope: Readonly<EventEnvelope>) => Promise<void>;
}

const statusOf = (e: Readonly<EventEnvelope>) => String((e.payload as { toStatus?: string }).toStatus ?? 'SUBMITTED');

async function project(tx: TenantTransaction, aggregateId: string, version: number, status: string): Promise<void> {
  await tx.query(`INSERT INTO tpa.synthetic_projection VALUES (tpa.current_tenant_id(), $1, $2, $3)
    ON CONFLICT (tenant_id, aggregate_id) DO UPDATE SET version = EXCLUDED.version, status = EXCLUDED.status`, [aggregateId, version, status]);
}

export function syntheticHandler(options: SyntheticOptions = {}): InboxHandler {
  const consumerName = options.consumerName ?? 'synthetic-projection';
  const effect = async (tx: TenantTransaction, e: Readonly<EventEnvelope>) => {
    const failure = options.fail?.(e);
    if (failure) throw failure;
    await tx.query('INSERT INTO tpa.synthetic_effects (tenant_id, consumer_name, event_id) VALUES (tpa.current_tenant_id(), $1, $2)',
      [consumerName, e.eventId]);
  };
  return {
    consumerName,
    owner: 'platform-events',
    eventTypes: ['claim.submitted', 'claim.state-changed'],
    ordering: 'aggregate-version',
    async apply(tx, e) {
      await effect(tx, e);
      await project(tx, e.aggregateId, e.aggregateVersion, statusOf(e));
      await options.afterApply?.(e);
    },
    ...(options.withReconcile ? {
      async reconcile(tx: TenantTransaction, e: Readonly<EventEnvelope>) {
        await effect(tx, e);
        const { rows: [source] } = await tx.query<{ version: number; status: string }>(
          'SELECT version, status FROM tpa.synthetic_source WHERE aggregate_id=$1', [e.aggregateId]);
        if (!source) throw new Error('authoritative snapshot missing');
        await project(tx, e.aggregateId, source.version, source.status);
        return source.version;
      },
    } : {}),
  };
}
