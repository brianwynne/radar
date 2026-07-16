// Akamai routes: RBAC on the read endpoints, shared-secret auth on the DataStream 2 ingest route,
// and the ingest→aggregate→realtime round trip. No credentials appear in responses.
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createAkamaiConnector, loadAkamaiConfig } from '../src/akamai/index.js';

const NOW = Date.parse('2026-07-16T21:00:00Z');
const NOW_SEC = Math.floor(NOW / 1000);
const SECRET = 's3cr3t';

function connector() {
  const cfg = loadAkamaiConfig({ AKAMAI_ENABLED: 'true', AKAMAI_INGEST_SECRET: SECRET, AKAMAI_CP_CODES: '1629049', AKAMAI_CP_NAMES: '1629049=LIVE.RTE.IE', AKAMAI_WINDOW_SECONDS: '300' });
  return createAkamaiConnector(cfg, { now: () => NOW });
}

async function app(role: string, auth = true): Promise<FastifyInstance> {
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), { akamaiConnector: connector() });
  await a.ready();
  return a;
}

const NDJSON = [
  { reqTimeSec: String(NOW_SEC), cp: '1629049', bytes: '1000', cacheStatus: '1', statusCode: '200' },
  { reqTimeSec: String(NOW_SEC), cp: '1629049', bytes: '200', cacheStatus: '0', statusCode: '404' },
  { reqTimeSec: String(NOW_SEC), cp: '9999999', bytes: '5', cacheStatus: '1', statusCode: '200' }, // unobserved CP code
].map((r) => JSON.stringify(r)).join('\n');

describe('Akamai routes', () => {
  it('401 unauthenticated on read routes', async () => {
    const a = await app('NOC_VIEWER', false);
    expect((await a.inject({ url: '/api/v1/cdn/akamai/realtime' })).statusCode).toBe(401);
    await a.close();
  });

  it('a NOC viewer reads status, services and realtime', async () => {
    const a = await app('NOC_VIEWER');
    for (const p of ['status', 'services', 'realtime']) expect((await a.inject({ url: `/api/v1/cdn/akamai/${p}` })).statusCode).toBe(200);
    await a.close();
  });

  it('ingest requires the shared secret', async () => {
    const a = await app('NOC_VIEWER');
    const noKey = await a.inject({ method: 'POST', url: '/api/v1/cdn/akamai/datastream/ingest', headers: { 'content-type': 'application/x-ndjson' }, payload: NDJSON });
    expect(noKey.statusCode).toBe(401);
    await a.close();
  });

  it('ingests a DS2 batch and serves it as per-CP-code realtime telemetry', async () => {
    const a = await app('NOC_VIEWER');
    const ing = await a.inject({ method: 'POST', url: '/api/v1/cdn/akamai/datastream/ingest', headers: { 'content-type': 'application/x-ndjson', 'x-radar-ingest-key': SECRET }, payload: NDJSON });
    expect(ing.statusCode).toBe(200);
    expect(ing.json().accepted).toBe(2); // the unobserved CP code is filtered out

    const rt = (await a.inject({ url: '/api/v1/cdn/akamai/realtime' })).json();
    expect(rt.source).toBe('akamai');
    expect(rt.series).toHaveLength(1);
    const s = rt.series[0];
    expect(s.serviceName).toBe('LIVE.RTE.IE');
    expect(s.samples[0].status2xx).toBe(1);
    expect(s.samples[0].status4xx).toBe(1);
    expect(s.samples[0].statusCodes).toEqual({ '200': 1, '404': 1 });
    expect(s.latestBandwidthBps).toBe(1200 * 8);
    expect(JSON.stringify(rt)).not.toMatch(new RegExp(SECRET));
    await a.close();
  });
});
