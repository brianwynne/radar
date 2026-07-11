// Readiness against a REAL database and against a genuinely unreachable one, exercising
// the actual pg pool + databaseHealthCheck (not an injected stub). Skipped unless
// PG_INTEGRATION_URL is set; CI provides a PostgreSQL service container.
import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/database/pool.js';
import { databaseHealthCheck } from '../src/database/health.js';
import type { DatabaseConfig } from '../src/database/config.js';

const PG_URL = process.env.PG_INTEGRATION_URL;

const poolCfg = (url: string, fast = false): DatabaseConfig => ({
  url,
  poolMin: 0,
  poolMax: 4,
  connectionTimeoutMs: fast ? 800 : 5000,
  idleTimeoutMs: 5000,
  statementTimeoutMs: fast ? 800 : 5000,
});

describe.skipIf(!PG_URL)('readiness against a real database', () => {
  it('reports database ok and status 200 when the pool reaches PostgreSQL', async () => {
    const pool = createPool(poolCfg(PG_URL as string));
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: PG_URL }), {
      databaseHealth: databaseHealthCheck(pool),
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.database).toBe('ok');
    await app.close();
    await pool.end();
  });

  it('reports 503 not_ready when the database is genuinely unreachable', async () => {
    const bad = 'postgres://radar:radar@127.0.0.1:1/radar';
    const pool = createPool(poolCfg(bad, true));
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: bad }), {
      databaseHealth: databaseHealthCheck(pool),
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.database).toBe('unavailable');
    // Liveness is unaffected by the database being down.
    expect((await app.inject({ method: 'GET', url: '/api/v1/health/live' })).statusCode).toBe(200);
    await app.close();
    await pool.end();
  });
});
