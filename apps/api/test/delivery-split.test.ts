// computeDeliverySplit: eyeball PNI out-bps grouped by provider (Réalta) + commercial CDN totals.
import { describe, it, expect } from 'vitest';
import { computeDeliverySplit } from '../src/dashboard/delivery.js';
import type { NetworkStateSnapshot } from '../src/cloudvision/types.js';
import type { FastlySnapshot } from '../src/fastly/types.js';
import type { AkamaiSnapshot } from '../src/akamai/types.js';

const iface = (o: Record<string, unknown>) => ({ memberOf: null, linkType: 'PRIVATE_PEERING', provider: null, name: '', outBps: 0, ...o });
const net = (ifaces: unknown[]) => ({ interfaces: ifaces }) as unknown as NetworkStateSnapshot;
const fastly = (bps: number[]) => ({ services: bps.map((b) => ({ bandwidthBps: b })) }) as unknown as FastlySnapshot;
const akamai = (bps: number[]) => ({ series: bps.map((b) => ({ bandwidthBps: b })) }) as unknown as AkamaiSnapshot;

describe('computeDeliverySplit', () => {
  it('sums eyeball PNI out-bps per provider and adds commercial CDN totals', () => {
    const split = computeDeliverySplit(
      net([
        iface({ provider: 'Eir', outBps: 3e9 }),
        iface({ provider: 'Eir', outBps: 2e9 }),                         // two Eir PNIs → 5e9
        iface({ provider: 'Sky', outBps: 4e9 }),
        iface({ provider: 'Cogent', linkType: 'TRANSIT', outBps: 9e9 }), // transit — not eyeball
        iface({ provider: 'INEX', linkType: 'IX_PEERING', outBps: 9e9 }),// IX — not eyeball PNI
        iface({ provider: 'Eir', outBps: 1e9, memberOf: 'Port-Channel1' }), // LAG member skipped
      ]),
      fastly([1e9, 5e8]), // 1.5e9
      akamai([1e9]),      // 1e9
    );
    const byLabel = Object.fromEntries(split.slices.map((s) => [s.label, s]));
    expect(byLabel['Eir'].bps).toBe(5e9);
    expect(byLabel['Eir'].kind).toBe('eyeball');
    expect(byLabel['Eir'].platform).toBe('Réalta');
    expect(byLabel['Sky'].bps).toBe(4e9);
    expect(byLabel['Fastly'].bps).toBe(1.5e9);
    expect(byLabel['Akamai'].bps).toBe(1e9);
    expect(byLabel['Cogent']).toBeUndefined();
    expect(split.realtaBps).toBe(9e9);
    expect(split.commercialBps).toBe(2.5e9);
    expect(split.totalBps).toBe(11.5e9);
    expect(split.slices[0].label).toBe('Eir'); // eyeball slices sorted desc, commercial appended
  });

  it('handles empty/null inputs', () => {
    const split = computeDeliverySplit(null, null, null);
    expect(split).toEqual({ slices: [], realtaBps: 0, commercialBps: 0, totalBps: 0 });
  });
});
