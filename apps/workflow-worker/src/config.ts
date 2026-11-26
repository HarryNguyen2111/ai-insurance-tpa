export interface WorkflowWorkerConfig { databaseUrl: string; temporalAddress: string; namespace: string }

/** Errors name the variable only; credentials and addresses are never echoed. */
export function readWorkflowWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkflowWorkerConfig {
  const databaseUrl = env.WORKFLOW_DATABASE_URL;
  if (!databaseUrl) throw new Error('WORKFLOW_DATABASE_URL is required');
  let url: URL;
  try { url = new URL(databaseUrl); } catch { throw new Error('WORKFLOW_DATABASE_URL is invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'tpa_app') {
    throw new Error('WORKFLOW_DATABASE_URL must use PostgreSQL and the tpa_app role');
  }
  const temporalAddress = env.TEMPORAL_ADDRESS ?? '';
  if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(temporalAddress)) throw new Error('TEMPORAL_ADDRESS must be host:port');
  const namespace = env.TEMPORAL_NAMESPACE ?? 'default';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(namespace)) throw new Error('TEMPORAL_NAMESPACE is invalid');
  return { databaseUrl, temporalAddress, namespace };
}
