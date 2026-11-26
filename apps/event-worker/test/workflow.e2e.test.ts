import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client, Connection } from '@temporalio/client';
import { DefaultLogger, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { buildEventEnvelope, domainTopic } from '@tpa/event-contracts';
import { createTenantDatabase } from '@tpa/database/tenant';
import { createQuarantineSink } from '@tpa/database/inbox';
import { connectTemporalEngine } from '@tpa/workflow/engine';
import { claimWorkflowId, commandIdForEvent } from '@tpa/workflow/contracts';
import { createClaimWorkers, WORKFLOWS_PATH } from '../../workflow-worker/src/worker.ts';
import { createTransitionActivities } from '../../workflow-worker/src/activities/transitions.ts';
import { createWorkflowHandler } from '../src/consumers/workflow.ts';
import { createInboxConsumer, type InboxConsumer } from '../src/consumers/consumer.ts';
import { createKafkaPublisher } from '../src/kafka-publisher.ts';
import { startHarness, waitFor } from './fixtures/docker-harness.ts';
import { startTemporal } from './fixtures/temporal-harness.ts';

test('PT06/PT17: accepted-before-inbox SIGKILL, redelivery, Activity retry, worker restart and replay', async t => {
  const h = await startHarness([]);
  let server: Awaited<ReturnType<typeof startTemporal>> | undefined;
  let child: ChildProcess | undefined;
  let consumer: InboxConsumer | undefined;
  let connection: NativeConnection | undefined;
  let clientConnection: Connection | undefined;
  let engine: Awaited<ReturnType<typeof connectTemporalEngine>> | undefined;
  let workers: Awaited<ReturnType<typeof createClaimWorkers>> | undefined;
  let running: Promise<void> | undefined;
  const db = createTenantDatabase({ connectionString: h.url('tpa_app'), max: 8 });
  const quarantine = createQuarantineSink({ connectionString: h.url('tpa_app') });
  const publisher = createKafkaPublisher({ brokers: h.brokers, clientId: 'wf01-test', topicPrefix: 'tpa.wf01', sendTimeoutMs: 30000 });
  const logs: string[] = [];
  const MARKER = 'PT17-PII-SYNTHETIC-079123456789';
  try {
    server = await startTemporal(h);
    t.diagnostic(`${h.versions}; ${server.version}; TS SDK 1.27.0`);
    Runtime.install({ logger: new DefaultLogger('WARN', entry => logs.push(JSON.stringify(entry, (_key, value) => typeof value === 'bigint' ? value.toString() : value))) });
    connection = await NativeConnection.connect({ address: server.address });
    clientConnection = await Connection.connect({ address: server.address });
    const client = new Client({ connection: clientConnection });
    engine = await connectTemporalEngine({ address: server.address });
    const ref = { tenantId: randomUUID(), claimId: randomUUID() };
    const event = buildEventEnvelope(ref.tenantId, { eventType: 'claim.submitted', aggregateId: ref.claimId, aggregateVersion: 1,
      correlationId: randomUUID(), causationId: randomUUID(), payload: {} }).envelope;
    // PII remains solely in source truth; it must never enter history or logs.
    await h.pgAdmin.query('CREATE TABLE private_source (marker text)');
    await h.pgAdmin.query('INSERT INTO private_source VALUES ($1)', [MARKER]);
    await h.createTopics(['tpa.wf01.claim']);
    await publisher.connect();
    await publisher.publish([{ seq: '0', eventId: event.eventId, eventType: event.eventType, schemaVersion: event.schemaVersion,
      topic: domainTopic(event.eventType), partitionKey: `${ref.tenantId}:${ref.claimId}`, value: JSON.stringify(event) }]);
    child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/workflow-crash-child.ts', import.meta.url))], {
      env: { ...process.env, CRASH_DATABASE_URL: h.url('tpa_app'), CRASH_BROKERS: h.brokers.join(','), CRASH_PREFIX: 'tpa.wf01', TEMPORAL_ADDRESS: server.address },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout!.on('data', b => { output += b.toString(); });
    child.stderr!.on('data', b => logs.push(b.toString()));
    const exited = once(child, 'exit');
    const [code, signal] = await Promise.race([exited, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Crash child timed out')), 60000); timer.unref(); })]);
    assert.equal(code, null); assert.equal(signal, 'SIGKILL'); assert.match(output, /ACCEPTED/);
    const count = (table: string) => db.withTenantTransaction(ref.tenantId, async tx => Number((await tx.query(`SELECT count(*)::int AS n FROM tpa.${table}`)).rows[0].n));
    assert.equal(await count('consumer_inbox'), 0, 'crash rolled back inbox');
    const [offsets] = await h.admin.fetchOffsets({ groupId: 'claim-workflow', topics: ['tpa.wf01.claim'] });
    assert.ok(offsets.partitions.every(p => p.offset === '-1' || p.offset === '0'), 'offset not completed');
    const activities = createTransitionActivities(db);
    // Inject audit failure after ledger insert: both writes must roll back.
    const failedId = randomUUID();
    const failing = createTransitionActivities({
      close: async () => {},
      withTenantTransaction: (tenant, fn) => db.withTenantTransaction(tenant, tx => fn({
        query: (sql, values) => sql.includes('append_audit')
          ? Promise.reject(new Error('Synthetic audit failure')) : tx.query(sql, values),
      })),
    });
    await assert.rejects(failing.applyClaimTransition({ ...ref, workflowId: claimWorkflowId(ref),
      commandId: commandIdForEvent(failedId), transition: 'SUBMITTED' }), /Synthetic audit failure/);
    assert.equal(await count('workflow_command_ledger'), 0, 'audit failure rolled back ledger');
    let injected = false;
    workers = await createClaimWorkers({ connection, activities: { async applyClaimTransition(request) {
      const result = await activities.applyClaimTransition(request);
      if (!injected) { injected = true; throw new Error('Synthetic crash after effect commit'); }
      return result;
    } } }); // omitted identity regression: actual SDK startup must succeed
    running = workers.run();
    consumer = createInboxConsumer({ db, quarantine, handler: createWorkflowHandler(engine.engine), brokers: h.brokers,
      clientId: 'wf01-recovery', domains: ['claim'], topicPrefix: 'tpa.wf01', maxAttempts: 3, retryBackoffMs: 50, sessionTimeoutMs: 8000 });
    await consumer.start();
    await waitFor('redelivered inbox', async () => (await count('consumer_inbox')) === 1 ? true : undefined);
    await waitFor('one audited effect', async () => (await count('audit_logs')) === 1 ? true : undefined);
    assert.equal(await count('workflow_command_ledger'), 1);
    // Restart while workflow waits for a human command. New worker replays history.
    workers.shutdown(); await running; workers = undefined; running = undefined;
    workers = await createClaimWorkers({ connection, activities }); running = workers.run();
    const eventId = randomUUID();
    await engine.engine.submitClaimCommand(ref, { commandId: commandIdForEvent(eventId), causationEventId: eventId, aggregateVersion: 2, transition: 'PAID' });
    const handle = client.workflow.getHandle(claimWorkflowId(ref));
    assert.deepEqual(await handle.result(), { status: 'PAID' });
    assert.equal(await count('workflow_command_ledger'), 2);
    assert.equal(await count('audit_logs'), 2);
    assert.equal((await engine.engine.submitClaimCommand(ref, { commandId: commandIdForEvent(eventId), causationEventId: eventId, aggregateVersion: 2, transition: 'PAID' })).status, 'closed');
    const history = await handle.fetchHistory();
    assert.ok(!JSON.stringify(history).includes(MARKER));
    for (const e of history.events ?? []) {
      const payloads = [e.workflowExecutionStartedEventAttributes?.input, e.workflowExecutionSignaledEventAttributes?.input,
        e.activityTaskScheduledEventAttributes?.input, e.activityTaskCompletedEventAttributes?.result];
      for (const payload of payloads) for (const p of payload?.payloads ?? []) {
        assert.ok(!Buffer.from(p.data ?? []).toString().includes(MARKER));
      }
    }
    assert.ok(!logs.join('\n').includes(MARKER));
    await Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history);
    assert.equal(await count('workflow_command_ledger'), 2, 'replay has no effects');
    await db.withTenantTransaction(randomUUID(), async tx => {
      assert.equal((await tx.query('SELECT * FROM tpa.workflow_command_ledger')).rowCount, 0, 'other tenant cannot read ledger');
    });
    for (const sql of ['UPDATE tpa.workflow_command_ledger SET transition=\'PAID\'',
      'DELETE FROM tpa.workflow_command_ledger', 'TRUNCATE tpa.workflow_command_ledger']) {
      await assert.rejects(db.withTenantTransaction(ref.tenantId, tx => tx.query(sql)),
        error => error instanceof Error && 'code' in error && error.code === '42501');
    }

  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await consumer?.stop();
    if (workers) { workers.shutdown(); await running; }
    await Promise.allSettled([publisher.disconnect(), quarantine.close(), db.close(), engine?.close(), clientConnection?.close()]);
    await connection?.close();
    server?.cleanup();
    await h.cleanup();
  }
});
