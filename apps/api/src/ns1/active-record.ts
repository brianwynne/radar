// Active steering-record detection. A stable public entry (live.rte.ie) CNAMEs to whichever NS1
// steering record is currently live; RTÉ switches the active config by re-pointing that CNAME.
//
// The entry lives in the rte.ie zone, which the read-only NS1 key does NOT have access to — so we
// discover the current target by resolving the entry over PUBLIC DNS (the authoritative, observed
// truth), then read that target's config from its NS1 zone (nsone.rte.ie), which the key can see.
import { promises as dnsPromises } from 'node:dns';
import type { Ns1ReadClient } from './client.js';
import { normaliseRecord } from './normalise.js';

/** Resolve the CNAME chain of an FQDN (injected for tests; defaults to the system resolver). */
export type CnameResolver = (fqdn: string) => Promise<string[]>;

export interface RecordRef {
  zone: string;
  domain: string;
  type: string;
}

export interface ActiveRecordResult {
  /** The public entry domain that is resolved to discover the active record. */
  entry: string;
  /** The entry's current CNAME target (the active record's FQDN), or null if unresolved. */
  target: string | null;
  /** The active steering record as {zone, domain, type}, or null when the target is outside the
   *  known NS1 zones (or the entry could not be resolved). */
  active: RecordRef | null;
  /** Number of filters on the active record — a steering record has a Filter Chain. */
  filterCount: number | null;
  warnings: string[];
}

/** The stable public entry whose CNAME points at the currently-active steering record. */
export const DEFAULT_ACTIVE_ENTRY = 'live.rte.ie';

const stripDot = (s: string): string => s.replace(/\.$/, '');

/** The longest known NS1 zone that is a suffix of the FQDN (so live.nsone.rte.ie → nsone.rte.ie). */
function zoneFor(fqdn: string, zones: string[]): string | null {
  const host = stripDot(fqdn).toLowerCase();
  let best: string | null = null;
  for (const z of zones) {
    const zn = stripDot(z).toLowerCase();
    if ((host === zn || host.endsWith(`.${zn}`)) && (!best || zn.length > best.length)) best = zn;
  }
  return best;
}

/** Discover the currently-active steering record: DNS-resolve the entry's CNAME target, map it to
 *  its NS1 zone, and read that record to confirm it exists and report its chain length. Read-only. */
export async function resolveActiveRecord(
  client: Ns1ReadClient,
  zones: string[],
  entry: string,
  opts: { resolveCname?: CnameResolver; correlationId?: string } = {},
): Promise<ActiveRecordResult> {
  const resolveCname = opts.resolveCname ?? ((f: string) => dnsPromises.resolveCname(f));
  const warnings: string[] = [];

  let target: string | null;
  try {
    const targets = await resolveCname(entry);
    target = Array.isArray(targets) && targets.length > 0 ? stripDot(targets[0]) : null;
  } catch (err) {
    warnings.push(`Could not resolve ${entry} over DNS (${err instanceof Error ? err.message : 'error'}).`);
    return { entry, target: null, active: null, filterCount: null, warnings };
  }
  if (!target) {
    warnings.push(`${entry} has no CNAME target — cannot determine the active record.`);
    return { entry, target: null, active: null, filterCount: null, warnings };
  }

  const zone = zoneFor(target, zones);
  if (!zone) {
    warnings.push(`Active target ${target} is not within a zone the NS1 key can see; cannot read it.`);
    return { entry, target, active: null, filterCount: null, warnings };
  }

  const active: RecordRef = { zone, domain: target, type: 'CNAME' };
  let filterCount: number | null = null;
  try {
    const arec = normaliseRecord(await client.getRecord(zone, target, 'CNAME', opts.correlationId));
    filterCount = Array.isArray(arec.filters) ? arec.filters.length : 0;
  } catch {
    warnings.push(`Active record ${target} CNAME could not be read from zone ${zone}.`);
  }
  return { entry, target, active, filterCount, warnings };
}
