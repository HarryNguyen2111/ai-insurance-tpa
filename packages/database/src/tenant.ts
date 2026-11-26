import pg from 'pg';

/** Trusted repository SQL only; never expose this capability to request callers. */
export interface TenantTransaction {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export interface TenantDatabase {
  /** tenantId MUST come from verified server principal/membership, never body/header. */
  withTenantTransaction<T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Composition-root API: keep connection configuration private to the server. */
export function createTenantDatabase(config: pg.PoolConfig): TenantDatabase {
  const pool = new pg.Pool(config);
  return Object.freeze({
    async withTenantTransaction<T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      // Format validation is not authorization. Identity integration supplies the grant.
      if (typeof tenantId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
        throw new Error('A verified tenant UUID is required');
      }
      const client = await pool.connect();
      let active = false;
      let began = false;
      let destroy = false;
      let queryFailed = false;
      const pending: Promise<unknown>[] = [];
      try {
        const { rows: [role] } = await client.query(`SELECT current_user AS name, rolsuper, rolbypassrls,
          rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname=current_user`);
        if (role.name !== 'tpa_app' || Object.entries(role).some(([key, value]) => key !== 'name' && value !== false)) {
          throw new Error('Tenant access requires the unprivileged tpa_app role');
        }
        await client.query('BEGIN');
        began = true;
        await client.query("SELECT pg_catalog.set_config('app.current_tenant_id', $1, true)", [tenantId]);
        active = true;
        const tx: TenantTransaction = Object.freeze({
          query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
            if (!active) return Promise.reject(new Error('Tenant transaction is no longer active'));
            const operation = client.query<R>(text, values);
            // Drain even unawaited operations before commit/release. A swallowed SQL
            // failure must never turn PostgreSQL's aborted COMMIT into success.
            pending.push(operation.catch(() => { queryFailed = true; }));
            return operation;
          },
        });
        const value = await fn(tx);
        active = false;
        await Promise.all(pending);
        if (queryFailed) throw new Error('Tenant transaction query failed');
        await client.query('COMMIT');
        began = false;
        return value;
      } catch (error) {
        active = false;
        await Promise.all(pending);
        if (began) {
          try { await client.query('ROLLBACK'); } catch { destroy = true; }
        }
        throw error;
      } finally {
        active = false;
        client.release(destroy);
      }
    },
    close: () => pool.end(),
  });
}
