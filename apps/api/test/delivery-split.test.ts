// computeDeliverySplit: eyeball PNI out-bps grouped by provider (Réalta) + commercial CDN totals.
import { describe, it, expect } from 'vitest';
import { computeDeliverySplit } from '../src/dashboard/delivery.js';
import type { NetworkStateSnapshot } from '../src/cloudvision/types.js';
import type { FastlySnapshot } from '../src/fastly/types.js';
import type { AkamaiSnapshot } from '../src/akamai/types.js';

const iface = (o: Record<string, unknown>) => ({ memberOf: null, linkType: 'PRIVATE_PEERING', provider: null, name: 'Port-Channel1', deviceHostname: 'edge', outBps: 0, speedBps: 100e9, ...o });
const net = (ifaces: unknown[]) => ({ interfaces: ifaces }) as unknown as NetworkStateSnapshot;
const fastly = (bps: number[]) => ({ services: bps.map((b) => ({ bandwidthBps: b })) }) as unknown as FastlySnapshot;
const akamai = (bps: number[]) => ({ series: bps.map((b) => ({ bandwidthBps: b })) }) as unknown as AkamaiSnapshot;

describe('computeDeliverySplit', () => {
  it('sums eyeball PNI + public IX (INEX) delivery, and adds commercial CDN totals', () => {
    const split = computeDeliverySplit(
      net([
        iface({ provider: 'Eir', outBps: 3e9, deviceHostname: 'edge-citywest-router', speedBps: 100e9 }),
        iface({ provider: 'Eir', outBps: 2e9, deviceHostname: 'edge-parkwest-router', speedBps: 100e9 }), // two Eir PNIs → 5e9
        iface({ provider: 'Sky', outBps: 4e9 }),
        iface({ provider: 'Cogent', linkType: 'TRANSIT', outBps: 9e9 }), // transit — excluded
        iface({ provider: 'INEX', linkType: 'IX_PEERING', outBps: 6e9 }),// public IX peering → included as 'ix'
        iface({ provider: 'Eir', outBps: 1e9, memberOf: 'Port-Channel1' }), // LAG member skipped
      ]),
      fastly([1e9, 5e8]), // 1.5e9
      akamai([1e9]),      // 1e9
    );
    const byLabel = Object.fromEntries(split.slices.map((s) => [s.label, s]));
    expect(byLabel['Eir'].bps).toBe(5e9);
    expect(byLabel['Eir'].links).toBe(2); // two Eir PNIs summed (transparent multi-link)
    // Per-link detail: both links with their delivery utilisation (out-bps ÷ capacity).
    expect(byLabel['Eir'].linkDetails).toHaveLength(2);
    expect(byLabel['Eir'].linkDetails[0]).toMatchObject({ device: 'edge-citywest-router', bps: 3e9, capacityBps: 100e9, utilisationPercent: 3 });
    expect(byLabel['Eir'].linkDetails[1]).toMatchObject({ device: 'edge-parkwest-router', bps: 2e9, utilisationPercent: 2 });
    expect(byLabel['Eir'].kind).toBe('eyeball');
    expect(byLabel['Eir'].platform).toBe('Réalta');
    expect(byLabel['Sky'].bps).toBe(4e9);
    expect(byLabel['Sky'].links).toBe(1);
    expect(byLabel['Fastly'].links).toBe(2); // two Fastly services summed
    expect(byLabel['INEX'].bps).toBe(6e9);
    expect(byLabel['INEX'].kind).toBe('ix');       // public peering, kept distinct from PNI
    expect(byLabel['INEX'].platform).toBe('Réalta');
    expect(byLabel['Fastly'].bps).toBe(1.5e9);
    expect(byLabel['Akamai'].bps).toBe(1e9);
    expect(byLabel['Cogent']).toBeUndefined();
    expect(split.realtaBps).toBe(15e9);            // 9 (PNI) + 6 (IX)
    expect(split.commercialBps).toBe(2.5e9);
    expect(split.totalBps).toBe(17.5e9);
    // Order: private PNI eyeballs (desc), then IX, then commercial.
    expect(split.slices.map((s) => s.kind)).toEqual(['eyeball', 'eyeball', 'ix', 'commercial', 'commercial']);
    expect(split.slices[0].label).toBe('Eir');
  });

  it('handles empty/null inputs', () => {
    const split = computeDeliverySplit(null, null, null);
    expect(split).toEqual({ slices: [], realtaBps: 0, commercialBps: 0, totalBps: 0 });
  });
});
