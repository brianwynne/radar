// RIPE service: a poll cycle fetches every monitored prefix, builds the snapshot and reports
// combined source health. Uses the mock RIPEstat client; RIS Live disabled (no WebSocket).
import { describe, it, expect } from 'vitest';
import { RipeService } from '../src/ripe/service.js';
import { loadRipeConfig } from '../src/ripe/config.js';
import { MockRipestatClient, type RipeScenario } from '../src/ripe/fixtures.js';

const NOW = Date.parse('2026-07-24T09:00:00Z');
const scenarioFor = (prefix: string): RipeScenario => (/\/24$/.test(prefix) ? 'withdrawn_with_cover' : 'healthy');

function service() {
  const config = loadRipeConfig({ RIPE_ENABLED: 'true', RIPE_RIS_LIVE_ENABLED: 'false' });
  return new RipeService({ config, client: new MockRipestatClient({ scenarioFor, now: () => NOW }), now: () => NOW });
}

describe('RipeService', () => {
  it('polls all monitored prefixes and rolls up the snapshot', async () => {
    const snap = await service().poll();
    expect(snap.counts.total).toBe(5); // the 5 default AS41073 prefixes
    // The two /24s are traffic-engineering degradations (unseen but covered), the rest healthy.
    expect(snap.counts).toMatchObject({ healthy: 3, degraded: 2, withdrawn: 0, critical: 0 });
    expect(snap.overall).toBe('degraded');
  });

  it('reports source health: RIPEstat reachable, RIS Live disabled, status live', async () => {
    const svc = service();
    await svc.poll();
    const h = svc.sourceHealth();
    expect(h.ripestatReachable).toBe(true);
    expect(h.ripestatLastSuccessAt).toBe('2026-07-24T09:00:00.000Z');
    expect(h.risLiveState).toBe('disabled');
    expect(h.status).toBe('live');
  });

  it('marks source unavailable when RIPEstat fails entirely', async () => {
    const config = loadRipeConfig({ RIPE_ENABLED: 'true', RIPE_RIS_LIVE_ENABLED: 'false' });
    const svc = new RipeService({ config, client: new MockRipestatClient({ scenarioFor: () => 'unavailable', now: () => NOW }), now: () => NOW });
    const snap = await svc.poll();
    expect(snap.overall).toBe('unknown'); // every prefix unknown — NOT withdrawn
    expect(snap.prefixes.every((p) => p.health === 'unknown')).toBe(true);
    expect(svc.sourceHealth().status).toBe('unavailable');
  });
});
