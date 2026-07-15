// CloudVision interface classification: specificity order, each match kind, unknowns stay
// visible, and regex validation.
import { describe, it, expect } from 'vitest';
import { classifyInterface, validateClassificationRules, type ClassificationRule } from '../src/cloudvision/classification.js';

const rules: ClassificationRule[] = [
  { match: { kind: 'description_regex', pattern: '\\beir\\b', flags: 'i' }, linkType: 'PRIVATE_PEERING', provider: 'Eir' },
  { match: { kind: 'description_exact', description: 'INEX IXP Dublin' }, linkType: 'IX_PEERING', provider: 'INEX' },
  { match: { kind: 'device_interface', deviceId: 'DEV1', interface: 'Ethernet9' }, linkType: 'TRANSIT', provider: 'Cogent' },
];

describe('classifyInterface', () => {
  it('matches an exact device+interface (most specific) even against a description regex', () => {
    // Ethernet9 also has "eir" in its description, but device_interface wins.
    const r = classifyInterface(rules, { deviceId: 'DEV1', name: 'Ethernet9', description: 'eir backup' });
    expect(r).toMatchObject({ linkType: 'TRANSIT', provider: 'Cogent', classificationSource: 'device_interface' });
  });

  it('matches an exact description', () => {
    const r = classifyInterface(rules, { deviceId: 'DEV2', name: 'Ethernet1', description: 'INEX IXP Dublin' });
    expect(r).toMatchObject({ linkType: 'IX_PEERING', provider: 'INEX', classificationSource: 'description_exact' });
  });

  it('matches a description regex', () => {
    const r = classifyInterface(rules, { deviceId: 'DEV2', name: 'Ethernet2', description: 'Eir PNI Dublin' });
    expect(r).toMatchObject({ linkType: 'PRIVATE_PEERING', provider: 'Eir', classificationSource: 'description_regex' });
  });

  it('returns UNKNOWN (visible, not dropped) when nothing matches', () => {
    const r = classifyInterface(rules, { deviceId: 'DEVX', name: 'Ethernet5', description: 'mystery link' });
    expect(r).toEqual({ linkType: 'UNKNOWN', provider: null, location: null, classificationSource: 'unknown' });
  });

  it('a null description never matches description rules', () => {
    const r = classifyInterface(rules, { deviceId: 'DEVX', name: 'Ethernet5', description: null });
    expect(r.linkType).toBe('UNKNOWN');
  });

  it('respects specificity regardless of the order rules are supplied', () => {
    const reordered = [...rules].reverse();
    const r = classifyInterface(reordered, { deviceId: 'DEV1', name: 'Ethernet9', description: 'eir backup' });
    expect(r.classificationSource).toBe('device_interface');
  });
});

describe('validateClassificationRules', () => {
  it('throws on an invalid regex', () => {
    expect(() => validateClassificationRules([{ match: { kind: 'description_regex', pattern: '(' }, linkType: 'TRANSIT' }])).toThrow(/Invalid classification regex/);
  });
  it('accepts valid rules', () => {
    expect(() => validateClassificationRules(rules)).not.toThrow();
  });
});
