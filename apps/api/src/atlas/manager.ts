// Atlas resolver-reader MANAGER: the baseline read (recurring measurements), an on-demand "check
// now" (fires one-off measurements + aggregates when they land), and a polling on/off switch that
// STOPS the recurring measurements on Atlas to halt credit spend (and re-creates them when turned
// back on). READ-heavy; the only writes are creating/stopping RADAR's own measurements. The API
// key is sent in the Authorization header and never returned. State is in-memory in v1 (re-seeds
// from config on restart) — persistence is a follow-on.
import { buildBurstIsp, buildIdentityView, buildIspView } from './client.js';
import type { AtlasConfig, AtlasIspMeasurement } from './config.js';
import type { ResolverIdentitySnapshot, ResolverSnapshot } from './types.js';

export interface ResolverCheck { isp: string; asn: number; measurementId: number }
export interface ResolverManager {
  snapshot(): Promise<ResolverSnapshot>;
  /** Fire a burst per ISP. `target` overrides the record checked (defaults to the configured one). */
  checkNow(target?: string): Promise<{ checks: ResolverCheck[]; startedAt: string; target: string }>;
  checkResults(checks: ResolverCheck[], target?: string): Promise<{ snapshot: ResolverSnapshot; pending: boolean }>;
  setPolling(enabled: boolean): Promise<{ pollingEnabled: boolean }>;
  pollingEnabled(): boolean;
  /** The ISP's ACTUAL recursive resolvers (behind CPE forwarders) + their ECS behaviour. */
  identity(): Promise<ResolverIdentitySnapshot>;
}

// Accept only a plausible hostname (letters/digits/hyphen labels, dot-separated) so a caller can't
// inject anything odd into the Atlas query. Returns the trimmed, lower-cased name, or null if unusable.
export function normaliseTarget(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase().replace(/\.$/, '');
  if (t.length === 0 || t.length > 253) return null;
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(t) ? t : null;
}

const dnsDefinition = (target: string, description: string, interval?: number) => ({
  type: 'dns', af: 4, query_argument: target, query_class: 'IN', query_type: 'A',
  use_probe_resolver: true, resolve_on_probe: true, include_abuf: true,
  ...(interval ? { interval } : {}), description,
});

export class HttpAtlasManager implements ResolverManager {
  private enabled: boolean;
  private measurements: AtlasIspMeasurement[];
  /** The last on-demand check — used to seed the baseline before the recurring measurements warm
   *  up (a recurring measurement's first result can lag its interval). REAL data, never mock. */
  private lastCheck: ResolverSnapshot | null = null;
  constructor(private readonly cfg: AtlasConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.enabled = true;
    this.measurements = cfg.measurements.map((m) => ({ ...m }));
  }
  pollingEnabled(): boolean { return this.enabled; }

  private auth() { return { Authorization: `Key ${this.cfg.apiKey}`, 'Content-Type': 'application/json' }; }
  private async latest(id: number): Promise<unknown[]> {
    const r = await this.fetchImpl(`${this.cfg.endpoint}/measurements/${id}/latest/`, { headers: { Authorization: `Key ${this.cfg.apiKey}` } });
    if (!r.ok) throw new Error(`RIPE Atlas ${r.status} for measurement ${id}`);
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  }
  // ALL results so far (not just the latest run) — burst aggregation needs every sample per resolver.
  private async allResults(id: number): Promise<unknown[]> {
    const r = await this.fetchImpl(`${this.cfg.endpoint}/measurements/${id}/results/?format=json`, { headers: { Authorization: `Key ${this.cfg.apiKey}` } });
    if (!r.ok) throw new Error(`RIPE Atlas ${r.status} for measurement ${id}`);
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  }
  // A short high-cadence BURST: a recurring measurement (60s interval) that auto-stops after ~11 min,
  // oversampling the 300s cache cycle so each resolver's MAX served TTL = its true set-TTL.
  private async createBurst(m: AtlasIspMeasurement, target: string): Promise<number | null> {
    const stopTime = Math.floor(Date.now() / 1000) + this.burstWindowSecs;
    const body = { definitions: [dnsDefinition(target, `RADAR TTL burst — ${target} via ${m.isp} (AS${m.asn})`, 60)], probes: [{ type: 'asn', value: m.asn, requested: 20 }], is_oneoff: false, stop_time: stopTime };
    const r = await this.fetchImpl(`${this.cfg.endpoint}/measurements/`, { method: 'POST', headers: this.auth(), body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { measurements?: number[] };
    return j.measurements?.[0] ?? null;
  }
  private readonly burstWindowSecs = 660; // ~11 min → ~11 samples per resolver
  private readonly burstTargetRuns = 8;    // consider a burst "done" once this many runs have landed
  private async createRecurring(m: AtlasIspMeasurement): Promise<number | null> {
    const body = { definitions: [dnsDefinition(this.cfg.target, `RADAR resolver reader — ${this.cfg.target} via ${m.isp} (AS${m.asn})`, 21600)], probes: [{ type: 'asn', value: m.asn, requested: 20 }], is_oneoff: false };
    const r = await this.fetchImpl(`${this.cfg.endpoint}/measurements/`, { method: 'POST', headers: this.auth(), body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { measurements?: number[] };
    return j.measurements?.[0] ?? null;
  }
  private async stop(id: number): Promise<void> {
    await this.fetchImpl(`${this.cfg.endpoint}/measurements/${id}/`, { method: 'DELETE', headers: { Authorization: `Key ${this.cfg.apiKey}` } });
  }

  private async build(measurements: AtlasIspMeasurement[], warnings: string[]) {
    const isps = await Promise.all(measurements.map(async (m) => {
      if (m.measurementId === null) return buildIspView(m, [], this.cfg.honourTtlThreshold);
      try {
        return buildIspView(m, (await this.latest(m.measurementId)) as never, this.cfg.honourTtlThreshold);
      } catch (err) {
        warnings.push(`${m.isp}: ${err instanceof Error ? err.message : 'fetch failed'}`);
        return buildIspView(m, [], this.cfg.honourTtlThreshold);
      }
    }));
    const observedAt = isps.map((i) => i.observedAt).filter((x): x is string => !!x).sort().at(-1) ?? null;
    return { isps, observedAt };
  }

  async snapshot(): Promise<ResolverSnapshot> {
    const warnings: string[] = [];
    const { isps, observedAt } = await this.build(this.measurements, warnings);
    const hasData = isps.some((i) => i.covered && i.samples.length > 0);
    // Recurring baseline not warmed yet → fall back to the last real on-demand check (never mock).
    if (!hasData && this.lastCheck) {
      return { ...this.lastCheck, warnings: [...this.lastCheck.warnings, 'Recurring baseline not warmed yet — showing the last on-demand check.'], pollingEnabled: this.enabled };
    }
    if (!hasData) warnings.push('Recurring measurements are scheduled but have not reported yet — use “Check resolvers now” for immediate data.');
    return { provenance: { source: 'ripe-atlas', synthetic: false, readOnly: true, informationalOnly: true, retrievedAt: new Date().toISOString() }, isps, observedAt, target: this.cfg.target, warnings, pollingEnabled: this.enabled };
  }

  async checkNow(target?: string): Promise<{ checks: ResolverCheck[]; startedAt: string; target: string }> {
    const t = normaliseTarget(target) ?? this.cfg.target;
    const covered = this.measurements.filter((m) => m.asn && this.hasCoverage(m));
    const checks: ResolverCheck[] = [];
    for (const m of covered) {
      const id = await this.createBurst(m, t);
      if (id !== null) checks.push({ isp: m.isp, asn: m.asn, measurementId: id });
    }
    return { checks, startedAt: new Date().toISOString(), target: t };
  }
  // Covered = the ISP had a recurring measurement (i.e. Atlas has probes there). Three → null → skip.
  private hasCoverage(m: AtlasIspMeasurement): boolean {
    return this.cfg.measurements.find((x) => x.isp === m.isp)?.measurementId !== null;
  }

  // Aggregate a BURST: fetch ALL runs per ISP, collapse to per-resolver MAX (set-TTL) + verdicts.
  // Pending until every covered ISP has ≥ burstTargetRuns distinct runs (or the frontend times out).
  async checkResults(checks: ResolverCheck[], target?: string): Promise<{ snapshot: ResolverSnapshot; pending: boolean }> {
    const t = normaliseTarget(target) ?? this.cfg.target;
    const warnings: string[] = [];
    const covered = checks.map((c) => ({ m: { isp: c.isp, asn: c.asn, measurementId: c.measurementId } as AtlasIspMeasurement }));
    let pending = false;
    const isps = await Promise.all(covered.map(async ({ m }) => {
      try {
        const results = (await this.allResults(m.measurementId as number)) as never[];
        const runs = new Set((results as { timestamp?: number }[]).map((r) => r.timestamp ?? 0)).size;
        if (runs < this.burstTargetRuns) pending = true;
        return buildBurstIsp(m, results);
      } catch (err) {
        warnings.push(`${m.isp}: ${err instanceof Error ? err.message : 'fetch failed'}`);
        pending = true;
        return buildBurstIsp(m, []);
      }
    }));
    // Include the no-coverage ISPs (e.g. Three) so the view is complete.
    for (const m of this.cfg.measurements) if (m.measurementId === null && !isps.some((i) => i.isp === m.isp)) isps.push(buildBurstIsp({ ...m }, []));
    const observedAt = isps.map((i) => i.observedAt).filter((x): x is string => !!x).sort().at(-1) ?? null;
    const snapshot: ResolverSnapshot = { provenance: { source: 'ripe-atlas', synthetic: false, readOnly: true, informationalOnly: true, notice: `TTL burst check — per-resolver set-TTL for ${t} (max over ~11 min)`, retrievedAt: new Date().toISOString() }, isps, observedAt, target: t, warnings, pollingEnabled: this.enabled };
    if (isps.some((i) => i.covered && i.samples.length > 0)) this.lastCheck = snapshot; // seed the baseline with real data
    return { snapshot, pending };
  }

  async identity(): Promise<ResolverIdentitySnapshot> {
    const warnings: string[] = [];
    const isps = await Promise.all(this.cfg.whoamiMeasurements.map(async (m) => {
      if (m.measurementId === null) return buildIdentityView(m, []);
      try {
        return buildIdentityView(m, (await this.latest(m.measurementId)) as never);
      } catch (err) {
        warnings.push(`${m.isp}: ${err instanceof Error ? err.message : 'fetch failed'}`);
        return buildIdentityView(m, []);
      }
    }));
    const observedAt = isps.map((i) => i.observedAt).filter((x): x is string => !!x).sort().at(-1) ?? null;
    return { provenance: { source: 'ripe-atlas', synthetic: false, readOnly: true, informationalOnly: true, retrievedAt: new Date().toISOString() }, isps, observedAt, warnings };
  }

  async setPolling(enabled: boolean): Promise<{ pollingEnabled: boolean }> {
    if (enabled === this.enabled) return { pollingEnabled: this.enabled };
    if (!enabled) {
      // Stop the recurring measurements → no more credit spend. Keep ids for last-known baseline.
      for (const m of this.measurements) if (m.measurementId !== null) await this.stop(m.measurementId).catch(() => {});
    } else {
      // Re-create the recurring measurements for ISPs that have coverage.
      this.measurements = await Promise.all(this.measurements.map(async (m) => (this.hasCoverage(m) ? { ...m, measurementId: (await this.createRecurring(m)) ?? m.measurementId } : { ...m })));
    }
    this.enabled = enabled;
    return { pollingEnabled: this.enabled };
  }
}

/** Not-connected manager — the resolver reader shows an honest empty state, NEVER synthetic data.
 *  Used whenever the RIPE Atlas connector is not live (disabled / no key). */
export class DisabledResolverManager implements ResolverManager {
  constructor(private readonly target: string) {}
  pollingEnabled() { return false; }
  private empty(): ResolverSnapshot {
    return { provenance: { source: 'disabled', synthetic: false, readOnly: true, informationalOnly: true, notice: 'RIPE Atlas resolver reader is not connected — enable it (ATLAS_ENABLED + live mode + key) to read live measurements.', retrievedAt: new Date().toISOString() }, isps: [], observedAt: null, target: this.target, warnings: [], pollingEnabled: false };
  }
  async snapshot() { return this.empty(); }
  async checkNow(target?: string) { return { checks: [], startedAt: new Date().toISOString(), target: normaliseTarget(target) ?? this.target }; }
  async checkResults() { return { snapshot: this.empty(), pending: false }; }
  async setPolling() { return { pollingEnabled: false }; }
  async identity(): Promise<ResolverIdentitySnapshot> {
    return { provenance: { source: 'disabled', synthetic: false, readOnly: true, informationalOnly: true, notice: 'RIPE Atlas resolver reader is not connected.', retrievedAt: new Date().toISOString() }, isps: [], observedAt: null, warnings: [] };
  }
}
