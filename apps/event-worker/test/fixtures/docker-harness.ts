// TEST ONLY: Docker PG16 + the Kafka image pinned by infra/compose/compose.yaml (#3).
// Random names, loopback ephemeral ports, resource limits, session labels; the
// caller must always invoke cleanup() in finally. Never prints credentials.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import type * as KafkaJs from 'kafkajs';
import { migrateDatabase } from '@tpa/database/migrate';

const kafkajs = createRequire(import.meta.url)('kafkajs') as typeof KafkaJs;
export const root = fileURLToPath(new URL('../../../../', import.meta.url));
const pgImage = 'pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';

function docker(...args: string[]): string {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 }).trim(); }
  catch { throw new Error(`Synthetic Docker ${args[0]} failed (arguments/output suppressed)`); }
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (true) {
    try { const value = await probe(); if (value !== undefined) return value; } catch { /* retry */ }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(250);
  }
}

export interface Harness {
  url(user: 'tpa_app' | 'tpa_migrator' | 'postgres'): string;
  pgAdmin: pg.Client;
  owner: pg.Client;
  brokers: string[];
  kafka: KafkaJs.Kafka;
  admin: KafkaJs.Admin;
  versions: string;
  createTopics(topics: string[], numPartitions?: number): Promise<void>;
  cleanup(): Promise<void>;
}

export async function startHarness(fixtures: string[]): Promise<Harness> {
  const name = `tpa-evt02e2e-${randomBytes(6).toString('hex')}`;
  const label = `ao.session=${process.env.AO_SESSION_ID ?? name}`;
  const password = randomBytes(24).toString('hex');
  const started: string[] = [];
  const clients: pg.Client[] = [];
  let admin: KafkaJs.Admin | undefined;
  const cleanup = async () => {
    await admin?.disconnect().catch(() => {});
    await Promise.allSettled(clients.map(c => c.end()));
    let failed = false;
    for (const container of [...started].reverse()) { try { docker('rm', '--force', '--volumes', container); } catch { failed = true; } }
    if (failed) throw new Error(`Owned test resource cleanup failed for ${name}`);
  };
  try {
    docker('run', '--detach', '--name', name, '--label', label, '--memory', '384m', '--cpus', '1',
      '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', '--publish', '127.0.0.1::5432',
      '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=tpa', pgImage);
    started.push(name);
    const pgPort = docker('port', name, '5432/tcp').split(':').at(-1)!;
    const url = (user: string) => `postgresql://${user}:${password}@127.0.0.1:${pgPort}/tpa`;
    const connect = (user: string) => waitFor('PostgreSQL', async () => {
      const client = new pg.Client({ connectionString: url(user), connectionTimeoutMillis: 2000 });
      try { await client.connect(); clients.push(client); return client; } catch (e) { await client.end().catch(() => {}); throw e; }
    });
    const pgAdmin = await connect('postgres');
    await pgAdmin.query(await readFile(`${root}infra/migrations/bootstrap.sql`, 'utf8'));
    for (const role of ['tpa_app', 'tpa_migrator']) {
      const { rows: [command] } = await pgAdmin.query("SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql", [role, password]);
      await pgAdmin.query(command.sql);
    }
    await migrateDatabase(url('tpa_migrator'));
    const owner = await connect('tpa_migrator');
    for (const fixture of fixtures) await owner.query(await readFile(`${root}${fixture}`, 'utf8'));

    const compose = await readFile(`${root}infra/compose/compose.yaml`, 'utf8');
    const kafkaImage = /\n {2}kafka:\n(?: {4}.*\n)*? {4}image: (apache\/kafka:\S+@sha256:[a-f0-9]{64})/.exec(compose)?.[1];
    assert.ok(kafkaImage, 'Compose Kafka image pin found');
    const kafkaPort = await freePort();
    docker('run', '--detach', '--name', `${name}-kafka`, '--label', label, '--memory', '768m', '--cpus', '1',
      '--publish', `127.0.0.1:${kafkaPort}:9092`,
      '--env', 'CLUSTER_ID=MkU3OEVBNTcwNTJENDM2Qk', '--env', 'KAFKA_NODE_ID=1', '--env', 'KAFKA_PROCESS_ROLES=broker,controller',
      '--env', 'KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093',
      '--env', `KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://127.0.0.1:${kafkaPort}`,
      '--env', 'KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER', '--env', 'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
      '--env', 'KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093', '--env', 'KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1',
      '--env', 'KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1', '--env', 'KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1',
      '--env', 'KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0', '--env', 'KAFKA_AUTO_CREATE_TOPICS_ENABLE=false',
      '--env', 'KAFKA_HEAP_OPTS=-Xms256m -Xmx256m', kafkaImage);
    started.push(`${name}-kafka`);
    const brokers = [`127.0.0.1:${kafkaPort}`];
    const kafka = new kafkajs.Kafka({ clientId: 'evt02-observer', brokers, logLevel: kafkajs.logLevel.NOTHING, retry: { retries: 2 } });
    admin = kafka.admin();
    await waitFor('Kafka broker', async () => { await admin!.connect(); await admin!.listTopics(); return true; }, 150_000);
    const versions = `PostgreSQL ${(await pgAdmin.query('SHOW server_version')).rows[0].server_version}; Kafka ${kafkaImage.split('@')[0]}`;
    return {
      url, pgAdmin, owner, brokers, kafka, admin, versions, cleanup,
      async createTopics(topics, numPartitions = 3) {
        await admin!.createTopics({ waitForLeaders: true, topics: topics.map(topic => ({ topic, numPartitions, replicationFactor: 1 })) });
      },
    };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}
