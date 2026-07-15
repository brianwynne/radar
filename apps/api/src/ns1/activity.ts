// Normalisation of the NS1 activity log (GET /v1/account/activity). The exact wire fields
// are FIXTURE-PENDING (docs/ns1/assumptions.md): we map only plausible, confirmed-shaped
// fields and never invent semantics. The original entry is preserved (redacted) under
// `raw` for an engineering detail panel. Anything that looks like a credential is dropped
// so a secret can never leak, even if NS1 ever included one.

export interface ActivityItem {
  id?: string;
  occurredAt?: string;
  actor?: string;
  action?: string;
  resourceType?: string;
  resourceKey?: string;
  outcome?: string;
  detail?: string;
  /** The original NS1 entry with credential-like keys removed. Fixture-derived. */
  raw: Record<string, unknown>;
}

export interface ActivityFilter {
  actor?: string;
  action?: string;
  resource?: string;
}

const SENSITIVE = /(^|_)(key|token|secret|password|passwd|authorization|auth|cookie|credential)s?($|_)/i;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Drop credential-like keys from a shallow entry (defence in depth). */
function redact(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (SENSITIVE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

function first(entry: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const s = asStr(entry[k]);
    if (s !== undefined && s.length > 0) return s;
  }
  return undefined;
}

/** Extract the entry list RADAR operates on. Accepts an array, or an object carrying the
 *  list under `activity`/`items` (envelope is FIXTURE-PENDING). Anything else → no entries,
 *  meaning change detection sees nothing. Exported so validation checks the SAME contract. */
export function entriesOf(raw: unknown): Record<string, unknown>[] {
  const list = Array.isArray(raw)
    ? raw
    : isObject(raw) && Array.isArray(raw.activity)
      ? raw.activity
      : isObject(raw) && Array.isArray(raw.items)
        ? raw.items
        : [];
  return list.filter(isObject);
}

export function normaliseActivity(raw: unknown): ActivityItem[] {
  return entriesOf(raw).map((e) => ({
    id: first(e, ['id', 'activity_id']),
    occurredAt: first(e, ['timestamp', 'occurred_at', 'date', 'time', 'created_at']),
    // Actor is a user or API-key *identity* (name/id) — never the key value; `api_key`
    // is intentionally excluded (and redacted from raw).
    actor: first(e, ['user', 'username', 'user_id', 'actor', 'api_key_name', 'api_key_id']),
    action: first(e, ['action', 'activity_type', 'type', 'method']),
    resourceType: first(e, ['resource_type', 'object_type']),
    resourceKey: first(e, ['resource_id', 'resource', 'object_id', 'object']),
    outcome: first(e, ['status', 'outcome', 'result']),
    detail: first(e, ['note', 'message', 'description']),
    raw: redact(e),
  }));
}

/** RADAR-side filtering by actor/action/resource (case-insensitive contains). NS1's own
 *  filter parameters for this endpoint are FIXTURE-PENDING, so we filter the normalised
 *  list rather than passing unverified query params upstream. */
export function filterActivity(items: ActivityItem[], f: ActivityFilter): ActivityItem[] {
  const has = (hay: string | undefined, needle?: string) => !needle || (hay ?? '').toLowerCase().includes(needle.toLowerCase());
  return items.filter(
    (i) => has(i.actor, f.actor) && has(i.action, f.action) && has(`${i.resourceType ?? ''} ${i.resourceKey ?? ''}`, f.resource),
  );
}
