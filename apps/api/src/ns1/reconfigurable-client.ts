// A stable Ns1ReadClient that forwards to a swappable inner client. The whole engine (explain,
// steering, change-detection, validation, snapshot capture, routes) holds THIS object, so the NS1
// connector manager can switch the underlying mock/live client at runtime — when an Engineer sets or
// changes the read-only NS1 key on the Integrations page — without re-wiring everything. Read-only.
import type { ActivityQuery, Ns1ReadClient } from './client.js';

export class ReconfigurableNs1ReadClient implements Ns1ReadClient {
  constructor(private inner: Ns1ReadClient) {}

  /** Swap the underlying client (mock ⇄ live, or a new key). */
  setInner(inner: Ns1ReadClient): void {
    this.inner = inner;
  }

  listZones(correlationId?: string): Promise<unknown> {
    return this.inner.listZones(correlationId);
  }
  getZone(zone: string, correlationId?: string): Promise<unknown> {
    return this.inner.getZone(zone, correlationId);
  }
  getRecord(zone: string, domain: string, type: string, correlationId?: string): Promise<unknown> {
    return this.inner.getRecord(zone, domain, type, correlationId);
  }
  getActivity(query?: ActivityQuery, correlationId?: string): Promise<unknown> {
    return this.inner.getActivity(query, correlationId);
  }
}
