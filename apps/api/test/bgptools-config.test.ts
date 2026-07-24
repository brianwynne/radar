// bgp.tools config: env parsing, threshold coherence, and the live-mode identifying-User-Agent
// requirement. Mock mode needs no credentials; live mode fails fast without a proper UA.
import { describe, it, expect } from 'vitest';
import { loadBgpToolsConfig } from '../src/bgptools/config.js';

describe('loadBgpToolsConfig', () => {
  it('defaults to disabled mock mode with an EMPTY watch list and no credentials', () => {
    const c = loadBgpToolsConfig({});
    expect(c.enabled).toBe(false);
    expect(c.mode).toBe('mock');
    expect(c.token).toBeUndefined();
    expect(c.monitoredPrefixes).toEqual([]); // synthetic fixtures are NOT injected here
    expect(c.pollIntervalSeconds).toBeGreaterThanOrEqual(1800); // honours the table cache guidance
  });

  it('rejects a warn ratio below the critical ratio', () => {
    expect(() => loadBgpToolsConfig({ BGPTOOLS_VISIBILITY_WARN_RATIO: '0.4', BGPTOOLS_VISIBILITY_CRITICAL_RATIO: '0.6' })).toThrow(/WARN_RATIO/);
  });

  it('live mode requires an identifying User-Agent with a contact email', () => {
    expect(() => loadBgpToolsConfig({ BGPTOOLS_ENABLED: 'true', BGPTOOLS_MODE: 'live' })).toThrow(/USER_AGENT/);
    expect(() => loadBgpToolsConfig({ BGPTOOLS_ENABLED: 'true', BGPTOOLS_MODE: 'live', BGPTOOLS_USER_AGENT: 'radar' })).toThrow(/USER_AGENT/);
    const ok = loadBgpToolsConfig({ BGPTOOLS_ENABLED: 'true', BGPTOOLS_MODE: 'live', BGPTOOLS_USER_AGENT: 'RADAR bgp.tools - noc@rte.ie' });
    expect(ok.mode).toBe('live');
    expect(ok.userAgent).toContain('@');
  });

  it('reads the token from BGPTOOLS_TOKEN in memory (never required in mock)', () => {
    const c = loadBgpToolsConfig({ BGPTOOLS_TOKEN: 'secret-abc' });
    expect(c.token).toBe('secret-abc');
  });

  it('live mode with no monitored file starts with an empty watch list (nothing fabricated)', () => {
    const c = loadBgpToolsConfig({ BGPTOOLS_ENABLED: 'true', BGPTOOLS_MODE: 'live', BGPTOOLS_USER_AGENT: 'RADAR bgp.tools - noc@rte.ie' });
    expect(c.monitoredPrefixes).toEqual([]);
  });
});
