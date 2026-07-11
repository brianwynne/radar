import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', MAX_BODY_BYTES: '1024' }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('health endpoints', () => {
  it('GET /api/v1/health/live returns live', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'live' });
  });

  it('GET /api/v1/health/ready confirms config loaded (database not wired here)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ready',
      checks: { config: 'ok', auth: 'unconfigured', database: 'not_wired' },
    });
  });
});

describe('correlation id', () => {
  it('preserves a supplied X-Correlation-ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health/live',
      headers: { 'x-correlation-id': 'supplied-corr-123' },
    });
    expect(res.headers['x-correlation-id']).toBe('supplied-corr-123');
  });

  it('generates a correlation id when none is supplied', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    const id = res.headers['x-correlation-id'];
    expect(typeof id).toBe('string');
    expect((id as string).length).toBeGreaterThan(10);
  });
});

describe('security controls', () => {
  it('sets secure headers via helmet', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('rejects an oversized request body with 413', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/health/live',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ big: 'x'.repeat(2048) }), // > 1024-byte limit
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('openapi', () => {
  it('GET /api/v1/openapi.json returns a spec including the health routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(String(doc.openapi)).toMatch(/^3\./);
    expect(doc.paths['/api/v1/health/live']).toBeDefined();
    expect(doc.paths['/api/v1/health/ready']).toBeDefined();
  });
});
