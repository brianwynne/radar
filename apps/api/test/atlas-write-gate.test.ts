import { describe, expect, it, vi } from 'vitest';
import { HttpAtlasManager, AtlasWriteError } from '../src/atlas/manager.js';
import { loadAtlasConfig } from '../src/atlas/config.js';

const liveCfg = (writeEnabled: boolean) =>
  loadAtlasConfig({ ATLAS_ENABLED: 'true', ATLAS_MODE: 'live', ATLAS_API_KEY: 'k-test', ATLAS_WRITE_ENABLED: String(writeEnabled) });

describe('Atlas measurement-management write gate', () => {
  it('refuses check-now and polling when ATLAS_WRITE_ENABLED is off — and makes NO Atlas call', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const m = new HttpAtlasManager(liveCfg(false), fetchImpl as unknown as typeof fetch);
    expect(m.writeEnabled()).toBe(false);
    await expect(m.checkNow()).rejects.toBeInstanceOf(AtlasWriteError);
    await expect(m.setPolling(false)).rejects.toBeInstanceOf(AtlasWriteError);
    expect(fetchImpl).not.toHaveBeenCalled(); // gate fails BEFORE any measurement create/stop
  });

  it('allows check-now when enabled, creates burst measurements, and reports write:true', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ measurements: [987654] }), { status: 201 }));
    const m = new HttpAtlasManager(liveCfg(true), fetchImpl as unknown as typeof fetch);
    expect(m.writeEnabled()).toBe(true);
    const res = await m.checkNow();
    expect(res.write).toBe(true);
    expect(res.checks.length).toBeGreaterThan(0);
    // Every create is a POST to /measurements/.
    expect(fetchImpl).toHaveBeenCalled();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
  });
});
