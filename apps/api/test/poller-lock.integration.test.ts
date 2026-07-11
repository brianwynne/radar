// Multi-replica poller lock against a REAL PostgreSQL server (session-scoped advisory lock).
// Skipped unless TEST_DATABASE_URL is set; fails loudly under REQUIRE_REAL_PG=1 (CI).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresPollerLock } from '../src/database/poller-lock.js';

const URL = process.env.TEST_DATABASE_URL;
if (!URL && process.env.REQUIRE_REAL_PG === '1') {
  throw new Error('TEST_DATABASE_URL is required (REQUIRE_REAL_PG=1) but is not set — refusing to skip.');
}

const KEY = 918273; // dedicated test key, distinct from the app default

describe.skipIf(!URL)('PostgresPollerLock against real PostgreSQL', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL, max: 6 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('grants the lock to exactly one holder; a second replica cannot acquire until release', async () => {
    const a = new PostgresPollerLock(pool, KEY);
    const b = new PostgresPollerLock(pool, KEY);

    expect(await a.acquire()).toBe(true);
    expect(a.held).toBe(true);
    // A distinct session cannot take the same advisory lock.
    expect(await b.acquire()).toBe(false);
    expect(b.held).toBe(false);

    // acquire() is idempotent for the current holder.
    expect(await a.acquire()).toBe(true);

    // After A releases, B (or a fresh replica) can take over.
    await a.release();
    expect(a.held).toBe(false);
    expect(await b.acquire()).toBe(true);
    expect(b.held).toBe(true);
    await b.release();

    // Lock is fully free again.
    const c = new PostgresPollerLock(pool, KEY);
    expect(await c.acquire()).toBe(true);
    await c.release();
  });

  it('releasing without holding is a safe no-op', async () => {
    const lock = new PostgresPollerLock(pool, KEY);
    await expect(lock.release()).resolves.toBeUndefined();
    expect(lock.held).toBe(false);
  });
});
