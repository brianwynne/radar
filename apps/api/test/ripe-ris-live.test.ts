// RIS Live managed connection: subscribe on open, event clustering (dedup many-peer observations),
// withdrawals, monitored-only filtering, and reconnect with exponential backoff. Fake WebSocket +
// injected timers — no real network, no real timers.
import { describe, it, expect } from 'vitest';
import { RisLiveConnection, type WsLike } from '../src/ripe/ris-live.js';

const NOW = Date.parse('2026-07-24T09:00:00Z');
const TS = NOW / 1000; // RIS timestamps are epoch seconds

class FakeWs implements WsLike {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((d: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  send(d: string) { this.sent.push(d); }
  close() { /* noop */ }
}

const risMsg = (data: unknown) => JSON.stringify({ type: 'ris_message', data });

function harness(prefixes = ['89.207.56.0/21']) {
  const ws = new FakeWs();
  const timers: { fn: () => void; ms: number }[] = [];
  const conn = new RisLiveConnection({
    wsFactory: () => ws, prefixes: () => prefixes, now: () => NOW,
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return 0 as unknown as ReturnType<typeof setTimeout>; },
    clearTimeoutImpl: () => undefined,
  });
  return { ws, timers, conn };
}

describe('RisLiveConnection', () => {
  it('subscribes to each monitored prefix on open', () => {
    const { ws, conn } = harness(['89.207.56.0/21', '2a00:1ed8::/29']);
    conn.start();
    ws.onopen!();
    expect(conn.status().state).toBe('connected');
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0]).toContain('"ris_subscribe"');
    expect(ws.sent[0]).toContain('89.207.56.0/21');
  });

  it('records an announcement and clusters duplicate observations', () => {
    const { ws, conn } = harness();
    conn.start(); ws.onopen!();
    const ann = risMsg({ timestamp: TS, peer_asn: '8218', path: [8218, 174, 41073], announcements: [{ prefixes: ['89.207.56.0/21'] }] });
    ws.onmessage!(ann);
    ws.onmessage!(ann); // same prefix+path from another peer → same cluster
    const ev = conn.events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'announcement', prefix: '89.207.56.0/21', origin: 41073, observationCount: 2 });
    // A different AS path is a distinct event.
    ws.onmessage!(risMsg({ timestamp: TS, peer_asn: '3333', path: [3333, 1299, 41073], announcements: [{ prefixes: ['89.207.56.0/21'] }] }));
    expect(conn.events()).toHaveLength(2);
  });

  it('records withdrawals and ignores non-monitored prefixes', () => {
    const { ws, conn } = harness();
    conn.start(); ws.onopen!();
    ws.onmessage!(risMsg({ timestamp: TS, withdrawals: ['89.207.56.0/21'] }));
    ws.onmessage!(risMsg({ timestamp: TS, announcements: [{ prefixes: ['8.8.8.0/24'] }] })); // not monitored
    const ev = conn.events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'withdrawal', prefix: '89.207.56.0/21' });
    expect(conn.status().lastMessageAt).toBe('2026-07-24T09:00:00.000Z');
  });

  it('reconnects with exponential backoff on close', () => {
    const { ws, timers, conn } = harness();
    conn.start(); ws.onopen!();
    ws.onclose!();
    expect(conn.status().state).toBe('reconnecting');
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(1000); // base, attempt 0
    timers[0].fn(); // reconnect fires → new ws; simulate another close
    ws.onclose!();
    expect(timers[1].ms).toBe(2000); // backoff doubles
  });

  it('stop() halts reconnection', () => {
    const { ws, timers, conn } = harness();
    conn.start(); ws.onopen!();
    conn.stop();
    ws.onclose!();
    expect(conn.status().state).toBe('disconnected');
    expect(timers).toHaveLength(0);
  });
});
