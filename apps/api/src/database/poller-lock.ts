// Multi-replica poller lock via a PostgreSQL session-scoped advisory lock. Only the
// replica holding the lock polls; on shutdown the lock is released and another replica can
// take over. The lock is held by a dedicated retained client for its whole lifetime
// (advisory locks are session-scoped).
import type { Pool, PoolClient } from 'pg';

export interface PollerLock {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
  readonly held: boolean;
}

export class PostgresPollerLock implements PollerLock {
  private client: PoolClient | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly key = 5203072,
  ) {}

  get held(): boolean {
    return this.client !== null;
  }

  async acquire(): Promise<boolean> {
    if (this.client) return true;
    const client = await this.pool.connect();
    try {
      const r = await client.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1) AS got', [this.key]);
      if (r.rows[0].got) {
        this.client = client;
        return true;
      }
      client.release();
      return false;
    } catch (err) {
      client.release();
      throw err;
    }
  }

  async release(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [this.key]);
    } finally {
      client.release();
    }
  }
}
