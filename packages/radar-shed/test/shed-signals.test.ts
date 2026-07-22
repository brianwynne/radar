import { describe, it, expect } from 'vitest';
import { buildShedSignals, shedFraction, shedState, type ShedInterface } from '../src/index.js';

const G = 1_000_000_000; // 1 Gb/s
const CW = 'JPN2508A7QM';
const PW = 'JPA2430A9R2';

function iface(over: Partial<ShedInterface>): ShedInterface {
  return { deviceId: CW, name: 'Ethernet1', provider: null, linkType: 'PRIVATE_PEERING', speedBps: 100 * G, primaryBps: 0, ...over };
}

describe('shedFraction (NS1 shed_load gating)', () => {
  it('is 0 at/below low, ramps linearly, 1 at/above high', () => {
    expect(shedFraction(50, 60, 80)).toBe(0);
    expect(shedFraction(60, 60, 80)).toBe(0);
    expect(shedFraction(70, 60, 80)).toBeCloseTo(0.5, 5); // midpoint
    expect(shedFraction(80, 60, 80)).toBe(1);
    expect(shedFraction(95, 60, 80)).toBe(1);
  });
  it('degenerate band (high<=low) is a hard step; null passes through', () => {
    expect(shedFraction(80, 80, 80)).toBe(1);
    expect(shedFraction(79, 80, 80)).toBe(0);
    expect(shedFraction(null, 60, 80)).toBeNull();
  });
});

describe('shedState', () => {
  it('serve / partial / shed / no-data', () => {
    const wm = { low: 60, high: 80 };
    expect(shedState(50, wm)).toBe('serve');
    expect(shedState(70, wm)).toBe('partial');
    expect(shedState(85, wm)).toBe('shed');
    expect(shedState(null, wm)).toBe('no-data');
  });
});

describe('buildShedSignals', () => {
  const interfaces: ShedInterface[] = [
    // Eir: both DCs, 100G each. CW 50G out (50%), PW 90G out (90%).
    iface({ deviceId: CW, name: 'Port-Channel7', provider: 'Eir', primaryBps: 50 * G }),
    iface({ deviceId: PW, name: 'Port-Channel7', provider: 'Eir', primaryBps: 90 * G }),
    // Three: CW-only PNI (its PW PNI is dead → no interface here).
    iface({ deviceId: CW, name: 'Port-Channel5', provider: 'Three', primaryBps: 82 * G }),
    // INEX: shared IX, both DCs (IX_PEERING). CW 30G/100G.
    iface({ deviceId: CW, name: 'Port-Channel1', provider: 'INEX', linkType: 'IX_PEERING', primaryBps: 30 * G }),
    iface({ deviceId: PW, name: 'Port-Channel2', provider: 'INEX', linkType: 'IX_PEERING', primaryBps: 50 * G }),
    // A transit link that must be ignored (not a PNI/IX delivery link).
    iface({ deviceId: CW, name: 'Ethernet9', provider: 'Blacknight', linkType: 'TRANSIT', primaryBps: 99 * G }),
  ];
  const sig = buildShedSignals(interfaces);
  const byId = (id: string) => sig.isps.find((i) => i.id === id)!;

  it('exposes both datacentres and all policy ISPs', () => {
    expect(sig.datacentres.map((d) => d.id)).toEqual(['citywest', 'parkwest']);
    expect(sig.isps.map((i) => i.id)).toEqual(['eir', 'sky', 'three', 'liberty', 'vodafone', 'inex']);
  });

  it('computes per-DC egress utilisation from capacity, ignoring non-delivery links', () => {
    const eir = byId('eir');
    expect(eir.cells.find((c) => c.dc === 'citywest')!.utilisationPercent).toBe(50);
    expect(eir.cells.find((c) => c.dc === 'parkwest')!.utilisationPercent).toBe(90);
    // combined = 140G / 200G = 70%
    expect(eir.combined.utilisationPercent).toBe(70);
  });

  it('marks a DC with no active PNI as inactive (Three is Citywest-only)', () => {
    const three = byId('three');
    expect(three.cells.find((c) => c.dc === 'citywest')!.active).toBe(true);
    expect(three.cells.find((c) => c.dc === 'parkwest')!.active).toBe(false);
    expect(three.cells.find((c) => c.dc === 'parkwest')!.utilisationPercent).toBeNull();
  });

  it('routes a viaInex ISP (Vodafone) onto the shared INEX combined util', () => {
    const inex = byId('inex');
    const vodafone = byId('vodafone');
    expect(inex.combined.utilisationPercent).toBe(40); // (30+50)/(100+100)
    expect(vodafone.viaInex).toBe(true);
    expect(vodafone.combined.utilisationPercent).toBe(inex.combined.utilisationPercent);
    expect(vodafone.cells.every((c) => !c.active)).toBe(true); // no own PNI cells
  });

  it('an ISP with no interfaces reports null util (Sky/Liberty here)', () => {
    expect(byId('sky').combined.utilisationPercent).toBeNull();
    expect(byId('liberty').combined.utilisationPercent).toBeNull();
  });
});
