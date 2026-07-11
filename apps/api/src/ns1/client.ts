// The read-only NS1 client contract (docs/ns1/developer-guide.md §5, §23). GET-only:
// there is deliberately NO create/update/delete method and NO method that accepts an
// arbitrary NS1 path or URL. Optional capabilities (monitors, data sources, feeds) are
// FIXTURE-PENDING (guide §5) and intentionally omitted until their contract is verified.
//
// Every method returns the raw NS1 JSON as `unknown` — raw preservation is a core rule
// (guide §2.5/§6); typed interpretation happens later in @radar/engine, not here.

/** Optional, allow-listed activity-log query parameters (guide §4.4). */
export interface ActivityQuery {
  limit?: number;
}

export interface Ns1ReadClient {
  /** GET /v1/zones — zones visible to the API key. */
  listZones(correlationId?: string): Promise<unknown>;
  /** GET /v1/zones/{zone} — complete zone JSON (includes the Filter Chain). */
  getZone(zone: string, correlationId?: string): Promise<unknown>;
  /** GET /v1/zones/{zone}/{domain}/{type} — a single record. */
  getRecord(zone: string, domain: string, type: string, correlationId?: string): Promise<unknown>;
  /** GET /v1/account/activity — audit/activity log (needs the view-activity permission). */
  getActivity(query?: ActivityQuery, correlationId?: string): Promise<unknown>;
}
