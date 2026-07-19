// Fixture-backed NS1 read client (docs/ns1/developer-guide.md §5, §28). Works with NO
// NS1 credential — this is the default dev/test adapter. Returns deep clones so callers
// cannot mutate the shared fixtures, and raises the same normalised NS1_NOT_FOUND error
// as the live client for unknown resources.
import type { ActivityQuery, Ns1ReadClient } from './client.js';
import { Ns1Error } from './errors.js';
import { ACTIVITY, RECORD_LIVE_RTE_IE_A, RECORD_LIVE_RTE_IE_CNAME, RECORD_VOD_RTE_IE_A, ZONE_RTE_IE, ZONES_LIST } from './fixtures.js';

const clone = <T>(value: T): T => structuredClone(value);

const RECORDS: Record<string, unknown> = {
  // live.rte.ie is really a CNAME (the default watched record); the A record is retained for
  // fixtures/tests that predate the CNAME switch.
  'rte.ie/live.rte.ie/CNAME': RECORD_LIVE_RTE_IE_CNAME,
  'rte.ie/live.rte.ie/A': RECORD_LIVE_RTE_IE_A,
  'rte.ie/vod.rte.ie/A': RECORD_VOD_RTE_IE_A,
};

export class MockNs1ReadClient implements Ns1ReadClient {
  async listZones(): Promise<unknown> {
    return clone(ZONES_LIST);
  }

  async getZone(zone: string): Promise<unknown> {
    if (zone === 'rte.ie') return clone(ZONE_RTE_IE);
    throw new Ns1Error('NS1_NOT_FOUND');
  }

  async getRecord(zone: string, domain: string, type: string): Promise<unknown> {
    const record = RECORDS[`${zone}/${domain}/${type.toUpperCase()}`];
    if (record) return clone(record);
    throw new Ns1Error('NS1_NOT_FOUND');
  }

  async getActivity(_query?: ActivityQuery): Promise<unknown> {
    return clone(ACTIVITY);
  }
}
