import { S3Client } from '@aws-sdk/client-s3';
import { workflowRuntime } from '../workflow-definition/workflow-runtime.ts';
import { UUID } from '../identity-tenant/identity-context.ts';
import { scanNext } from './documents.store.ts';
import { S3DocumentStorage } from './storage.ts';
import { HttpDocumentScanner } from './scanner.ts';
/** One bounded batch for a provisioned worker/CronJob. Tenant list comes from operator config, never HTTP.
 * Secrets are supplied by secret manager/KMS injection. No payload/errors/URLs are logged.
 */
export async function runScanBatch(config: { databaseUrl: string; tenantId: string; serviceId: string;
  storage: S3DocumentStorage; scanner: HttpDocumentScanner; limit?: number }): Promise<number> {
  if (!UUID.test(config.tenantId) || !UUID.test(config.serviceId)) throw new Error('Invalid worker identity');
  const limit = config.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid batch size');
  const runtime = await workflowRuntime(), db = runtime.createTenantDatabase({ connectionString: config.databaseUrl, max: 1 });
  let count = 0;
  try { while (count < limit && await db.withTenantTransaction(config.tenantId,
    tx => scanNext(tx, runtime, config.storage, config.scanner, config.serviceId))) count++;
    return count;
  } finally { await db.close(); }
}
async function main() {
  const required = (key: string) => { const v = process.env[key]; if (!v) throw new Error('Worker not configured'); return v; };
  const endpoint = new URL(required('DOCUMENT_S3_ENDPOINT'));
  if (endpoint.protocol !== 'https:') throw new Error('TLS storage required');
  const client = new S3Client({ endpoint: endpoint.href, region: required('DOCUMENT_S3_REGION'), forcePathStyle: true, requestHandler: { connectionTimeout: 3000, requestTimeout: 30000 } });
  try { await runScanBatch({ databaseUrl: required('DATABASE_URL'), tenantId: required('DOCUMENT_TENANT_ID'), serviceId: required('DOCUMENT_SCANNER_SERVICE_ID'),
    storage: new S3DocumentStorage(client, required('DOCUMENT_S3_BUCKET')),
    scanner: new HttpDocumentScanner(new URL(required('DOCUMENT_SCANNER_URL')), required('DOCUMENT_SCANNER_TOKEN')) });
  } finally { client.destroy(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('Document scan batch failed; originals remain quarantined.\n'); process.exitCode = 1; });
