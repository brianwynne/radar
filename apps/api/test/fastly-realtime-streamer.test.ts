// Fastly real-time streamer: the rolling per-second ring buffer, monotonic de-dup, window prune,
// cursor advancement, snapshot/status read models and the disabled path. Driven via pollServiceOnce
// with a fake client and a controlled clock — no timers, no network, fully deterministic.
import { describe, it, expect } from 'vitest';
import { FastlyRealtimeStreamer } from '../src/fastly/realtime-streamer.js';
import type { FastlyRealtimeBatch, FastlyRealtimeClient, FastlyRealtimeSample } from '../src/fastly/types.js';

function sample(second: number, requests: number, bandwidthBytes: number): FastlyRealtimeSample {
  return { second, at: new Date(second * 1000).toISOString(), requests, hits: requests, miss: 0, errors: 0, bandwidthBytes, status2xx: requests, status3xx: 0, status4xx: 0, status5xx: 0, statusCodes: { '200': requests } };
}
const batch = (samples: FastlyRealtimeSample[], nextTimestamp: number): FastlyRealtimeBatch => ({ samples, nextTimestamp, aggregateDelaySeconds: 5 });

/** Scripted client: each pollChannel call returns (or throws) the next scripted item. */
class FakeRtClient implements FastlyRealtimeClient {
  private i = 0;
  readonly cursors: number[] = [];
  constructor(private readonly script: Array<FastlyRealtimeBatch | Error>) {}
  async pollChannel(_serviceId: string, sinceTimestamp: number): Promise<FastlyRealtimeBatch> {
    this.cursors.push(sinceTimestamp);
    const item = this.script[Math.min(this.i, this.script.length - 1)];
    this.i += 1;
    if (item instanceof Error) throw item;
    return item;
  }
}

function streamer(client: FastlyRealtimeClient | null, clock: { ms: number }, enabled = true) {
  return new FastlyRealtimeStreamer(
    { client, services: [{ id: 'svc-live', name: 'svc-live' }], enabled, windowSeconds: 5, source: client ? 'fastly' : 'disabled' },
    { now: () => clock.ms },
  );
}

describe('FastlyRealtimeStreamer', () => {
  it('accumulates per-second samples, advances the cursor, and reports the latest second', async () => {
    const clock = { ms: 102_000 };
    const client = new FakeRtClient([batch([sample(100, 10, 1_000), sample(101, 20, 2_000), sample(102, 30, 3_000)], 102)]);
    const s = streamer(client, clock);

    const r = await s.pollServiceOnce('svc-live');
    expect(r).toMatchObject({ ok: true, received: 3 });
    expect(client.cursors[0]).toBe(0); // first poll starts at cursor 0

    const snap = s.snapshot();
    expect(snap.source).toBe('fastly');
    expect(snap.series).toHaveLength(1);
    const series = snap.series[0];
    expect(series.samples.map((x) => x.second)).toEqual([100, 101, 102]);
    expect(series.latestRequestsPerSecond).toBe(30);
    expect(series.latestBandwidthBps).toBe(3_000 * 8);
    expect(series.lastSampleAt).toBe(new Date(102_000).toISOString());
    expect(snap.provenance.informationalOnly).toBe(true);
  });

  it('de-dups non-advancing seconds and prunes samples outside the window on the next poll', async () => {
    const clock = { ms: 102_000 };
    const client = new FakeRtClient([
      batch([sample(100, 10, 1_000), sample(101, 20, 2_000), sample(102, 30, 3_000)], 102),
      batch([sample(108, 40, 4_000), sample(109, 50, 5_000), sample(110, 60, 6_000)], 110),
      batch([sample(109, 99, 9_000), sample(110, 99, 9_000), sample(111, 70, 7_000)], 111), // 109/110 repeat
    ]);
    const s = streamer(client, clock);

    await s.pollServiceOnce('svc-live'); // seconds 100-102
    clock.ms = 110_000;
    await s.pollServiceOnce('svc-live'); // 108-110 arrive; window=5 → cutoff 105 drops 100-102
    expect(client.cursors[1]).toBe(102); // cursor advanced to the previous nextTimestamp
    await s.pollServiceOnce('svc-live'); // 109/110 ignored (not newer), 111 appended

    const series = s.snapshot().series[0];
    expect(series.samples.map((x) => x.second)).toEqual([108, 109, 110, 111]);
    expect(series.samples.find((x) => x.second === 110)!.requests).toBe(60); // original kept, repeat ignored
    expect(series.latestRequestsPerSecond).toBe(70); // second 111
  });

  it('records failures without losing the buffer', async () => {
    const clock = { ms: 102_000 };
    const client = new FakeRtClient([batch([sample(100, 10, 1_000)], 100), new Error('boom')]);
    const s = streamer(client, clock);

    await s.pollServiceOnce('svc-live');
    const r = await s.pollServiceOnce('svc-live');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');

    const st = s.status();
    expect(st.services[0].consecutiveFailures).toBe(1);
    expect(st.services[0].lastError).toBe('boom');
    expect(st.services[0].sampleCount).toBe(1); // buffer retained across the failure
  });

  it('is disabled with no client: empty series, disabled provenance, start() is a no-op', () => {
    const clock = { ms: 102_000 };
    const s = streamer(null, clock, false);
    s.start();
    const snap = s.snapshot();
    expect(snap.source).toBe('disabled');
    expect(snap.series).toEqual([]);
    expect(snap.provenance.notice).toMatch(/disabled/i);
    expect(s.status().running).toBe(false);
  });
});
