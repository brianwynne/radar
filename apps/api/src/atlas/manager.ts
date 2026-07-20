// Atlas resolver-reader MANAGER: the baseline read (recurring measurements), an on-demand "check
// now" (fires one-off measurements + aggregates when they land), and a polling on/off switch that
// STOPS the recurring measurements on Atlas to halt credit spend (and re-creates them when turned
// back on). READ-heavy; the only writes are creating/stopping RADAR's own measurements. The API
// key is sent in the Authorization header and never returned. State is in-memory in v1 (re-seeds
// from config on restart) — persistence is a follow-on.
import { buildIspView } from './client.js';
import type { AtlasConfig, AtlasIspMeasurement } from './config.js';
import type { ResolverSnapshot } from './types.js';

export interface ResolverCheck { isp: string; asn: number; measurementId: number }
export interface ResolverManager {
  snapshot(): Promise<ResolverSnapshot>;
  checkNow(): Promise<{ checks: ResolverCheck[]; startedAt: string }>;
  checkResults(checks: ResolverCheck[]): Promise<{ snapshot: ResolverSnapshot; pending: boolean }>;
  setPolling(enabled: boolean): Promise<{ pollingEnabled: boolean }>;
  pollingEnabled(): boolean;
}

const dnsDefinition = (target: string, description: string, interval?: number) => ({
  type: 'dns', af: 4, query_argument: target, query_class: 'IN', query_type: 'A',
  use_probe_resolver: true, resolve_on_probe: true, include_abuf: true,
  ...(interval ? { interval } : {}), description,
});

export class HttpAtlasManager implements ResolverManager {
  private enabled: boolean;
  private measurements: AtlasIspMeasurement[];
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
  private async createOneOff(m: AtlasIspMeasurement): Promise<number | null> {
    const body = { definitions: [dnsDefinition(this.cfg.target, `RADAR resolver check (on-demand) — ${this.cfg.target} via ${m.isp} (AS${m.asn})`)], probes: [{ type: 'asn', value: m.asn, requested: 10 }], is_oneoff: true };
    const r = await this.fetchImpl(`${this.cfg.endpoint}/measurements/`, { method: 'POST', headers: this.auth(), body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { measurements?: number[] };
    return j.measurements?.[0] ?? null;
  }
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
    return { provenance: { source: 'ripe-atlas', synthetic: false, readOnly: true, informationalOnly: true, retrievedAt: new Date().toISOString() }, isps, observedAt, target: this.cfg.target, warnings, pollingEnabled: this.enabled };
  }

  async checkNow(): Promise<{ checks: ResolverCheck[]; startedAt: string }> {
    const covered = this.measurements.filter((m) => m.asn && this.hasCoverage(m));
    const checks: ResolverCheck[] = [];
    for (const m of covered) {
      const id = await this.createOneOff(m);
      if (id !== null) checks.push({ isp: m.isp, asn: m.asn, measurementId: id });
    }
    return { checks, startedAt: new Date().toISOString() };
  }
  // Covered = the ISP had a recurring measurement (i.e. Atlas has probes there). Three → null → skip.
  private hasCoverage(m: AtlasIspMeasurement): boolean {
    return this.cfg.measurements.find((x) => x.isp === m.isp)?.measurementId !== null;
  }

  async checkResults(checks: ResolverCheck[]): Promise<{ snapshot: ResolverSnapshot; pending: boolean }> {
    const warnings: string[] = [];
    const measurements: AtlasIspMeasurement[] = checks.map((c) => ({ isp: c.isp, asn: c.asn, measurementId: c.measurementId }));
    // Include the no-coverage ISPs (e.g. Three) so the on-demand view is complete.
    for (const m of this.cfg.measurements) if (m.measurementId === null && !measurements.some((x) => x.isp === m.isp)) measurements.push({ ...m });
    const { isps, observedAt } = await this.build(measurements, warnings);
    const pending = isps.some((i) => i.covered && i.samples.length === 0);
    return { snapshot: { provenance: { source: 'ripe-atlas', synthetic: false, readOnly: true, informationalOnly: true, notice: 'On-demand check', retrievedAt: new Date().toISOString() }, isps, observedAt, target: this.cfg.target, warnings, pollingEnabled: this.enabled }, pending };
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
