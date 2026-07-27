// RisEventRecorder: drains the in-memory RIS buffer into the bounded history store, records
// connection-state transitions (so gaps are visible), and prunes on an interval.
import { describe, expect, it } from 'vitest';
import type { NewRisEvent, RisConnectionChange, RisEventQuery, RisEventRecord, RisEventRepository } from '@radar/data';
import type { RisEvent } from '../src/ripe/ris-live.js';
import { RisEventRecorder } from '../src/ripe/ris-event-recorder.js';

class FakeRepo implements RisEventRepository {
  upserts: NewRisEvent[][] = [];
  conns: RisConnectionChange[] = [];
  pruneCutoffs: Date[] = [];
  async upsertBatch(events: NewRisEvent[]): Promise<number> { this.upserts.push(events); return events.length; }
  async range(_q: RisEventQuery): Promise<RisEventRecord[]> { return []; }
  async recordConnectionState(c: RisConnectionChange): Promise<void> { this.conns.push(c); }
  async connectionChanges(): Promise<RisConnectionChange[]> { return this.conns; }
  async prune(olderThan: Date): Promise<number> { this.pruneCutoffs.push(olderThan); return 0; }
}

const ev = (id: string, over: Partial<RisEvent> = {}): RisEvent => ({
  id, kind: 'announcement', prefix: '89.207.56.0/21', peerAsn: 174, path: [174, 41073], origin: 41073,
  firstAt: '2026-07-27T10:00:00.000Z', lastAt: '2026-07-27T10:01:00.000Z', observationCount: 3, ...over,
});

const flush = () => new Promise((r) => setImmediate(r));

describe('RisEventRecorder', () => {
  it('drains the buffer, maps events, and records connection-state transitions only on change', async () => {
    const repo = new FakeRepo();
    let events: RisEvent[] = [ev('a')];
    let state = 'connected';
    const rec = new RisEventRecorder(repo, { getEvents: () => events, getState: () => state, now: () => 1_000, pruneIntervalMs: 1 });

    rec.drain();
    await flush();
    expect(repo.upserts).toHaveLength(1);
    expect(repo.upserts[0][0]).toMatchObject({ id: 'a', kind: 'announcement', originAsn: 41073, peerAsn: 174, path: [174, 41073], observationCount: 3 });
    expect(repo.upserts[0][0].firstAt).toBeInstanceOf(Date);
    expect(repo.conns).toHaveLength(1); // initial state recorded
    expect(repo.conns[0]).toMatchObject({ state: 'connected', detail: 'initial' });

    // Same state, new event → upsert but no new connection row.
    events = [ev('a'), ev('b')];
    rec.drain();
    await flush();
    expect(repo.upserts).toHaveLength(2);
    expect(repo.conns).toHaveLength(1);

    // State change → a connection transition is recorded (with the previous state in the detail).
    state = 'disconnected';
    rec.drain();
    await flush();
    expect(repo.conns).toHaveLength(2);
    expect(repo.conns[1]).toMatchObject({ state: 'disconnected', detail: 'from connected' });
  });

  it('prunes with the retention cutoff, at most once per prune interval', async () => {
    const repo = new FakeRepo();
    let clock = 10_000_000_000;
    const rec = new RisEventRecorder(repo, {
      getEvents: () => [ev('a')], getState: () => 'connected', retentionDays: 90,
      pruneIntervalMs: 1000, now: () => clock,
    });
    rec.drain(); await flush();
    expect(repo.pruneCutoffs).toHaveLength(1);
    expect(clock - repo.pruneCutoffs[0].getTime()).toBe(90 * 86_400_000); // 90-day retention

    rec.drain(); await flush();
    expect(repo.pruneCutoffs).toHaveLength(1); // within the interval → not pruned again

    clock += 2000;
    rec.drain(); await flush();
    expect(repo.pruneCutoffs).toHaveLength(2);
  });

  it('records connection state even when the buffer is empty (gap visibility)', async () => {
    const repo = new FakeRepo();
    const rec = new RisEventRecorder(repo, { getEvents: () => [], getState: () => 'disconnected', now: () => 1 });
    rec.drain(); await flush();
    expect(repo.upserts).toHaveLength(0);
    expect(repo.conns).toHaveLength(1);
    expect(repo.conns[0].state).toBe('disconnected');
  });
});
