// Readiness against a REAL database and a genuinely unreachable one, exercising the
// actual pg pool + databaseHealthCheck (not an injected stub). Authoritative; runs
// against TEST_DATABASE_URL (a disposable database). Fails loudly under REQUIRE_REAL_PG=1
// (CI) if the URL is absent, rather than silently skipping.
import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/database/pool.js';
import { databaseHealthCheck } from '../src/database/health.js';
import type { DatabaseConfig } from '../src/database/config.js';

const URL = process.env.TEST_DATABASE_URL;
if (!URL) {
  if (process.env.REQUIRE_REAL_PG === '1') {
    throw new Error('TEST_DATABASE_URL is required (REQUIRE_REAL_PG=1) but is not set — refusing to silently skip.');
  }
  // eslint-disable-next-line no-console
  console.warn('\n[integration] SKIPPING real-PostgreSQL readiness suite: set TEST_DATABASE_URL to run it.\n');
}

const poolCfg = (url: string, fast = false): DatabaseConfig => ({
  url,
  poolMin: 0,
  poolMax: 4,
  connectionTimeoutMs: fast ? 800 : 5000,
  idleTimeoutMs: 5000,
  statementTimeoutMs: fast ? 800 : 5000,
});

describe.skipIf(!URL)('readiness against a real database', () => {
  it('reports database ok and status 200 when the pool reaches PostgreSQL', async () => {
    const pool = createPool(poolCfg(URL as string));
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: URL }), {
      databaseHealth: databaseHealthCheck(pool),
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.database).toBe('ok');
    await expect(app.close()).resolves.toBeUndefined(); // graceful shutdown completes
    await pool.end();
  });

  it('returns 503 with an unavailable database, exposing no connection or SQL detail; liveness stays up', async () => {
    const bad = 'postgres://radar:radar@127.0.0.1:1/radar';
    const pool = createPool(poolCfg(bad, true));
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: bad }), {
      databaseHealth: databaseHealthCheck(pool),
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', checks: { config: 'ok', auth: 'unconfigured', database: 'unavailable' } });
    // No leakage: the body carries only the coarse status, never a host/port/SQL error.
    expect(res.payload).not.toMatch(/127\.0\.0\.1|radar:radar|ECONNREFUSED|password/i);
    // The process stays operational: liveness is still 200.
    expect((await app.inject({ method: 'GET', url: '/api/v1/health/live' })).statusCode).toBe(200);
    await expect(app.close()).resolves.toBeUndefined();
    await pool.end();
  });
});
