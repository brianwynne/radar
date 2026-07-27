// DeliveryRecorder: samples total delivery into the bounded store, skips zero-total cold starts,
// and prunes on an interval.
import { describe, it, expect } from 'vitest';
import type { DeliveryAverages, DeliverySampleRepository, NewDeliverySample } from '@radar/data';
import { DeliveryRecorder } from '../src/dashboard/delivery-recorder.js';
import type { NetworkStateSnapshot } from '../src/cloudvision/types.js';
import type { FastlySnapshot } from '../src/fastly/types.js';
import type { AkamaiSnapshot } from '../src/akamai/types.js';

class FakeRepo implements DeliverySampleRepository {
  inserts: NewDeliverySample[] = [];
  pruneCutoffs: Date[] = [];
  async insert(s: NewDeliverySample): Promise<void> { this.inserts.push(s); }
  async averageSince(): Promise<DeliveryAverages> { return { avgRealtaBps: null, avgCommercialBps: null, avgTotalBps: null, sampleCount: 0 }; }
  async prune(olderThan: Date): Promise<number> { this.pruneCutoffs.push(olderThan); return 0; }
}

const net = (bps: number) => ({ interfaces: bps > 0 ? [{ memberOf: null, linkType: 'PRIVATE_PEERING', provider: 'Eir', name: '', outBps: bps }] : [] }) as unknown as NetworkStateSnapshot;
const fastly = (bps: number) => ({ services: [{ bandwidthBps: bps }] }) as unknown as FastlySnapshot;
const akamai = () => ({ series: [] }) as unknown as AkamaiSnapshot;
const flush = () => new Promise((r) => setImmediate(r));

describe('DeliveryRecorder', () => {
  it('samples the current split and persists the totals', async () => {
    const repo = new FakeRepo();
    const rec = new DeliveryRecorder(repo, {
      getNetwork: () => net(5e9), getFastly: () => fastly(1e9), getAkamai: akamai,
      now: () => 1_000, pruneIntervalMs: 999_999,
    });
    rec.sample();
    await flush();
    expect(repo.inserts).toHaveLength(1);
    expect(repo.inserts[0]).toMatchObject({ realtaBps: 5e9, commercialBps: 1e9, totalBps: 6e9 });
    expect(repo.inserts[0].at).toBeInstanceOf(Date);
  });

  it('skips writing when there is no delivery (cold start)', async () => {
    const repo = new FakeRepo();
    const rec = new DeliveryRecorder(repo, { getNetwork: () => net(0), getFastly: () => fastly(0), getAkamai: akamai, now: () => 1 });
    rec.sample();
    await flush();
    expect(repo.inserts).toHaveLength(0);
  });

  it('prunes with the retention cutoff, at most once per prune interval', async () => {
    const repo = new FakeRepo();
    let clock = 10_000_000_000;
    const rec = new DeliveryRecorder(repo, {
      getNetwork: () => net(5e9), getFastly: () => fastly(0), getAkamai: akamai,
      retentionHours: 25, pruneIntervalMs: 1000, now: () => clock,
    });
    rec.sample(); await flush();
    expect(repo.pruneCutoffs).toHaveLength(1);
    expect(clock - repo.pruneCutoffs[0].getTime()).toBe(25 * 3_600_000);
    rec.sample(); await flush();
    expect(repo.pruneCutoffs).toHaveLength(1); // within interval
    clock += 2000;
    rec.sample(); await flush();
    expect(repo.pruneCutoffs).toHaveLength(2);
  });
});
