// NS1 connector manager — the WRITE key: stored in its own settings row, decrypted only here,
// never returned, and it drives the guarded record writer (which the create/clone routes use).
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Ns1ConnectorManager } from '../src/ns1/manager.js';
import { loadNs1Config } from '../src/ns1/index.js';
import { SecretBox } from '../src/security/secret-box.js';
import type { ConnectorSettingsRecord, ConnectorSettingsRepository, ConnectorSettingsUpdate } from '@radar/data';

// A repo that keys rows by connector name (so 'ns1' and 'ns1-write' are independent).
class MultiRepo implements ConnectorSettingsRepository {
  rows = new Map<string, ConnectorSettingsRecord>();
  async get(connector: string) { return this.rows.get(connector) ?? null; }
  async upsert(u: ConnectorSettingsUpdate) {
    const p = this.rows.get(u.connector);
    let ct = p?.tokenCiphertext ?? null, nn = p?.tokenNonce ?? null, tg = p?.tokenTag ?? null, at = p?.tokenSetAt ?? null;
    if (u.tokenAction === 'replace') { ct = u.tokenCiphertext ?? null; nn = u.tokenNonce ?? null; tg = u.tokenTag ?? null; at = new Date(0); }
    else if (u.tokenAction === 'clear') { ct = null; nn = null; tg = null; at = null; }
    const row: ConnectorSettingsRecord = { connector: u.connector, enabled: u.enabled, mode: u.mode, endpoint: u.endpoint, verifyTls: u.verifyTls, edgeDeviceIds: u.edgeDeviceIds, tokenCiphertext: ct, tokenNonce: nn, tokenTag: tg, tokenSetAt: at, updatedBy: u.updatedBy, updatedAt: new Date(0) };
    this.rows.set(u.connector, row);
    return row;
  }
}

const make = () => new Ns1ConnectorManager({
  baseConfig: loadNs1Config({ NS1_WRITE_ENABLED: 'true' }), // write gate on; allow-list = livetest defaults
  repository: new MultiRepo(),
  secretBox: new SecretBox(randomBytes(32)),
  fetchImpl: (async () => new Response('[]', { status: 200 })) as typeof fetch,
});
const actor = { subject: 'eng', roles: ['ENGINEER'] };

describe('NS1 manager — write key', () => {
  it('stores the write key + goes live only after the gate is turned ON (defaults OFF)', async () => {
    const m = make();
    await m.init();
    expect(m.getRecordWriter().writeEnabled()).toBe(false); // gate defaults OFF (not env-driven)

    const view = await m.updateSettings({ mode: 'live', apiBase: 'https://api.nsone.net/v1', key: 'read-key', writeKey: 'write-key' }, actor);
    expect(view.writeKeyConfigured).toBe(true);
    expect(view.writeKeySetAt).not.toBeNull();
    expect(view.writeEnabled).toBe(false); // storing a key does NOT enable the gate
    expect(view.writeLive).toBe(false);
    expect(view.writeAllow).toEqual(['livetest.rte.ie', '*.livetest.rte.ie']);
    expect(m.getRecordWriter().writeReady()).toBe(false); // gate off → not ready even with live + key

    // Explicitly turn the gate on → now live + ready.
    const on = await m.setWriteEnabled(true, actor);
    expect(on.writeEnabled).toBe(true);
    expect(on.writeLive).toBe(true);
    const w = m.getRecordWriter();
    expect(w.writeReady()).toBe(true);
    expect(w.plan({ zone: 'livetest.rte.ie', domain: 'x.livetest.rte.ie', type: 'A', answers: ['203.0.113.1'], ttl: 30 }).allowed).toBe(true);
    // Guards still apply through the writer — a prod target is blocked.
    expect(w.plan({ zone: 'nsone.rte.ie', domain: 'livebase.nsone.rte.ie', type: 'CNAME', answers: ['liveedge.rte.ie'], ttl: 30 }).allowed).toBe(false);
  });

  it('clearing the write key disables the writer again', async () => {
    const m = make();
    await m.init();
    await m.updateSettings({ mode: 'live', apiBase: 'https://api.nsone.net/v1', key: 'read-key', writeKey: 'write-key' }, actor);
    await m.setWriteEnabled(true, actor);
    expect(m.getRecordWriter().writeReady()).toBe(true);

    const view = await m.updateSettings({ clearWriteKey: true }, actor);
    expect(view.writeKeyConfigured).toBe(false);
    expect(view.writeLive).toBe(false);
    expect(view.writeEnabled).toBe(true); // the gate stays as it was (clearing the key doesn't flip it)
    expect(m.getRecordWriter().writeReady()).toBe(false); // no key → not ready
  });

  it('toggles the write gate at runtime (persisted); defaults OFF', async () => {
    const m = make();
    await m.init();
    expect(m.getRecordWriter().writeEnabled()).toBe(false); // default OFF
    const on = await m.setWriteEnabled(true, actor);
    expect(on.writeEnabled).toBe(true);
    expect(m.getRecordWriter().writeEnabled()).toBe(true);
    const off = await m.setWriteEnabled(false, actor);
    expect(off.writeEnabled).toBe(false);
    expect(m.getRecordWriter().writeEnabled()).toBe(false);
  });

  it('never returns either key in the settings view', async () => {
    const m = make();
    await m.init();
    const view = await m.updateSettings({ mode: 'live', apiBase: 'https://api.nsone.net/v1', key: 'read-key', writeKey: 'write-key' }, actor);
    expect(JSON.stringify(view)).not.toContain('write-key');
    expect(JSON.stringify(view)).not.toContain('read-key');
  });
});
