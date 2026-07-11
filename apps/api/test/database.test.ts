import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { loadDatabaseConfig, redactDatabaseUrl } from '../src/database/config.js';
import type { DatabaseHealth } from '../src/database/health.js';

const URL = 'postgres://radar:secret@db:5432/radar';

describe('database configuration', () => {
  it('parses defaults and is surfaced on the app config', () => {
    const cfg = loadDatabaseConfig({ DATABASE_URL: URL });
    expect(cfg).toMatchObject({ url: URL, poolMin: 0, poolMax: 10, statementTimeoutMs: 15000 });
    expect(loadConfig({ NODE_ENV: 'test', DATABASE_URL: URL }).database?.url).toBe(URL);
  });

  it('leaves database undefined when DATABASE_URL is absent', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).database).toBeUndefined();
  });

  it('fails when DATABASE_URL is missing', () => {
    expect(() => loadDatabaseConfig({})).toThrow(/DATABASE_URL is required/);
  });

  it('fails when the pool minimum exceeds the maximum', () => {
    expect(() => loadDatabaseConfig({ DATABASE_URL: URL, DATABASE_POOL_MIN: '20', DATABASE_POOL_MAX: '5' })).toThrow(
      /cannot exceed/,
    );
  });

  it('fails on a non-positive pool maximum', () => {
    expect(() => loadDatabaseConfig({ DATABASE_URL: URL, DATABASE_POOL_MAX: '0' })).toThrow(/Invalid database/);
  });

  it('redacts credentials from a connection string for logging', () => {
    expect(redactDatabaseUrl(URL)).toBe('postgres://db:5432/radar');
    expect(redactDatabaseUrl(URL)).not.toContain('secret');
    expect(redactDatabaseUrl('not a url')).toBe('(unparseable database url)');
  });
});

describe('readiness reflects database health', () => {
  const baseEnv = { NODE_ENV: 'test', LOG_LEVEL: 'silent' } as const;
  const health = (h: DatabaseHealth) => async (): Promise<DatabaseHealth> => h;

  it('reports database ok and status ready (200) when the probe succeeds', async () => {
    const app = await buildApp(loadConfig(baseEnv), { databaseHealth: health({ status: 'ok' }) });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.database).toBe('ok');
    await app.close();
  });

  it('returns 503 not_ready when the database probe fails, but liveness stays 200', async () => {
    const app = await buildApp(loadConfig(baseEnv), {
      databaseHealth: health({ status: 'unavailable', error: 'connection refused' }),
    });
    const ready = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'not_ready', checks: { config: 'ok', auth: 'unconfigured', database: 'unavailable' } });

    const live = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'live' });
    await app.close();
  });

  it('reports database not_wired and is NOT ready (503) when no probe is injected', async () => {
    const app = await buildApp(loadConfig(baseEnv));
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', checks: { config: 'ok', auth: 'unconfigured', database: 'not_wired' } });
    // Liveness remains healthy regardless.
    expect((await app.inject({ method: 'GET', url: '/api/v1/health/live' })).statusCode).toBe(200);
    await app.close();
  });
});
