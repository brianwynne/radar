// Explain DNS Decision — the core RADAR workflow. A Viewing Engineer enters a DNS-request
// scenario; RADAR calls /api/v1/dns/explain and renders a filter-by-filter explanation.
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { ExplainRequest, ExplainResponse } from '../api/types';
import { EvaluationView } from '../features/EvaluationView';

interface FormState {
  zone: string;
  domain: string;
  type: string;
  resolverIp: string;
  ecsPresent: boolean;
  ecsPrefix: string;
  country: string;
  asn: string;
  realtaDown: boolean;
}

const DEFAULT: FormState = {
  zone: 'rte.ie',
  domain: 'live.rte.ie',
  type: 'A',
  resolverIp: '9.9.9.9',
  ecsPresent: true,
  ecsPrefix: '185.2.100.0/24',
  country: 'IE',
  asn: '5466',
  realtaDown: false,
};

const PRESETS: { name: string; patch: Partial<FormState> }[] = [
  { name: 'Ireland · ECS · AS5466', patch: { resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: '185.2.100.0/24', country: 'IE', asn: '5466', realtaDown: false } },
  { name: 'Ireland · public resolver (no ECS)', patch: { resolverIp: '8.8.8.8', ecsPresent: false, ecsPrefix: '', country: 'IE', asn: '', realtaDown: false } },
  { name: 'Germany · ECS · AS3320', patch: { resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: '91.0.0.0/24', country: 'DE', asn: '3320', realtaDown: false } },
  { name: 'Réalta down', patch: { realtaDown: true } },
];

function toRequest(f: FormState): ExplainRequest {
  const asn = f.asn.trim() ? Number(f.asn.trim()) : undefined;
  return {
    zone: f.zone.trim(),
    domain: f.domain.trim(),
    type: f.type.trim(),
    scenario: {
      resolverIp: f.resolverIp.trim(),
      ecsPresent: f.ecsPresent,
      ...(f.ecsPresent && f.ecsPrefix.trim() ? { ecsPrefix: f.ecsPrefix.trim() } : {}),
      ...(f.country.trim() ? { country: f.country.trim().toUpperCase() } : {}),
      ...(asn !== undefined && !Number.isNaN(asn) ? { asn } : {}),
      ...(f.realtaDown ? { healthOverrides: { 'ans-realta': false } } : {}),
    },
  };
}

export function ExplainDns() {
  const [form, setForm] = useState<FormState>(DEFAULT);
  const [result, setResult] = useState<ExplainResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      setResult(await api.explain(toRequest(form)));
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : 'Evaluation failed.');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>Explain DNS Decision</h1>
        <p>Evaluate how NS1 steers a DNS request to a delivery platform, filter by filter.</p>
      </div>

      <form className="card" onSubmit={submit}>
        <div style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {PRESETS.map((p) => (
            <button type="button" key={p.name} className="ghost" onClick={() => setForm((f) => ({ ...f, ...p.patch }))}>
              {p.name}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <label className="field">Zone<input value={form.zone} onChange={(e) => set('zone', e.target.value)} /></label>
          <label className="field">Domain<input value={form.domain} onChange={(e) => set('domain', e.target.value)} /></label>
          <label className="field">Type<input value={form.type} onChange={(e) => set('type', e.target.value)} /></label>
          <label className="field">Resolver IP<input value={form.resolverIp} onChange={(e) => set('resolverIp', e.target.value)} /></label>
          <label className="field checkbox">
            <input type="checkbox" checked={form.ecsPresent} onChange={(e) => set('ecsPresent', e.target.checked)} /> ECS present
          </label>
          <label className="field">ECS prefix<input value={form.ecsPrefix} disabled={!form.ecsPresent} onChange={(e) => set('ecsPrefix', e.target.value)} /></label>
          <label className="field">Country<input value={form.country} onChange={(e) => set('country', e.target.value)} placeholder="IE" /></label>
          <label className="field">ASN<input value={form.asn} onChange={(e) => set('asn', e.target.value)} placeholder="5466" /></label>
          <label className="field checkbox">
            <input type="checkbox" checked={form.realtaDown} onChange={(e) => set('realtaDown', e.target.checked)} /> Simulate Réalta down
          </label>
        </div>
        <div style={{ marginTop: '0.85rem' }}>
          <button className="primary" type="submit" disabled={loading}>
            {loading ? 'Evaluating…' : 'Explain decision'}
          </button>
        </div>
      </form>

      {error && <div className="notice danger">{error}</div>}
      {result && <EvaluationView data={result} />}
    </div>
  );
}
