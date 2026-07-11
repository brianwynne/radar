// Fixture-backed NS1 read client (docs/ns1/developer-guide.md §5, §28). Works with NO
// NS1 credential — this is the default dev/test adapter. Returns deep clones so callers
// cannot mutate the shared fixtures, and raises the same normalised NS1_NOT_FOUND error
// as the live client for unknown resources.
import type { ActivityQuery, Ns1ReadClient } from './client.js';
import { Ns1Error } from './errors.js';
import { ACTIVITY, RECORD_LIVE_RTE_IE_A, ZONE_RTE_IE, ZONES_LIST } from './fixtures.js';

const clone = <T>(value: T): T => structuredClone(value);

export class MockNs1ReadClient implements Ns1ReadClient {
  async listZones(): Promise<unknown> {
    return clone(ZONES_LIST);
  }

  async getZone(zone: string): Promise<unknown> {
    if (zone === 'rte.ie') return clone(ZONE_RTE_IE);
    throw new Ns1Error('NS1_NOT_FOUND');
  }

  async getRecord(zone: string, domain: string, type: string): Promise<unknown> {
    if (zone === 'rte.ie' && domain === 'live.rte.ie' && type.toUpperCase() === 'A') {
      return clone(RECORD_LIVE_RTE_IE_A);
    }
    throw new Ns1Error('NS1_NOT_FOUND');
  }

  async getActivity(_query?: ActivityQuery): Promise<unknown> {
    return clone(ACTIVITY);
  }
}
