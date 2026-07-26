// PniBandwidthRecorder: records only real PNI (private-peering) links from each snapshot, and
// throttles pruning. The repository is faked (no DB); persistence is fire-and-forget so tests flush
// the microtask queue before asserting.
import { describe, it, expect } from 'vitest';
import type { NewPniBandwidthSample, PniBandwidthRepository } from '@radar/data';
import { PniBandwidthRecorder } from '../src/cloudvision/pni-recorder.js';
import type { NetworkInterface, NetworkStateSnapshot } from '../src/cloudvision/types.js';

function fakeRepo() {
  const inserts: { at: Date; samples: NewPniBandwidthSample[] }[] = [];
  const prunes: Date[] = [];
  const repo: PniBandwidthRepository = {
    insertBatch: async (at, samples) => { inserts.push({ at, samples }); return samples.length; },
    prune: async (olderThan) => { prunes.push(olderThan); return 0; },
    range: async () => [],
  };
  return { repo, inserts, prunes };
}

const itf = (over: Partial<NetworkInterface>): NetworkInterface =>
  ({ deviceId: 'D1', name: 'Ethernet1', provider: 'Eir', linkType: 'PRIVATE_PEERING', memberOf: null, inBps: 1e6, outBps: 2e6, ...over } as NetworkInterface);

const snap = (interfaces: NetworkInterface[]): NetworkStateSnapshot =>
  ({ capturedAt: '2026-07-15T12:00:00.000Z', interfaces } as unknown as NetworkStateSnapshot);

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PniBandwidthRecorder', () => {
  it('records only PNI links (excludes IX, transit and LAG members)', async () => {
    const { repo, inserts } = fakeRepo();
    const rec = new PniBandwidthRecorder(repo, { now: () => 1_000_000 });
    rec.record(snap([
      itf({ name: 'Ethernet1', linkType: 'PRIVATE_PEERING', memberOf: null }),
      itf({ name: 'Ethernet2', linkType: 'PRIVATE_PEERING', memberOf: 'Port-Channel7' }), // member — excluded
      itf({ name: 'Ethernet3', linkType: 'IX_PEERING', memberOf: null }),                  // IX — excluded
      itf({ name: 'Ethernet4', linkType: 'TRANSIT', memberOf: null }),                     // transit — excluded
    ]));
    await flush();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].samples.map((s) => s.interfaceName)).toEqual(['Ethernet1']);
    expect(inserts[0].at.toISOString()).toBe('2026-07-15T12:00:00.000Z');
  });

  it('writes nothing when a snapshot has no PNIs', async () => {
    const { repo, inserts } = fakeRepo();
    const rec = new PniBandwidthRecorder(repo, { now: () => 1_000_000 });
    rec.record(snap([itf({ linkType: 'TRANSIT' })]));
    await flush();
    expect(inserts).toHaveLength(0);
  });

  it('throttles pruning to the prune interval and prunes past the retention horizon', async () => {
    const { repo, inserts, prunes } = fakeRepo();
    let t = 1_000_000_000;
    const rec = new PniBandwidthRecorder(repo, { now: () => t, pruneIntervalMs: 1000, retentionHours: 24 });

    rec.record(snap([itf({})]));
    await flush();
    expect(inserts).toHaveLength(1);
    expect(prunes).toHaveLength(1); // first prune fires (lastPruneAt was 0)
    expect(prunes[0].getTime()).toBe(t - 24 * 3600_000); // cutoff = now − retention

    rec.record(snap([itf({})]));
    await flush();
    expect(inserts).toHaveLength(2);
    expect(prunes).toHaveLength(1); // throttled — still within the 1s interval

    t += 2000;
    rec.record(snap([itf({})]));
    await flush();
    expect(prunes).toHaveLength(2); // interval elapsed → prunes again
    expect(prunes[1].getTime()).toBe(t - 24 * 3600_000);
  });
});
