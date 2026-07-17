// Explain a DNS decision for a single, already-selected NS1 record. Scoped to a zone/domain/type
// (supplied by the NS1 Explorer, which owns record selection); the operator varies the request
// SCENARIO — resolver, ECS, geo/ASN identity, Réalta health — and RADAR renders the filter-by-filter
// evaluation from /api/v1/dns/explain. This is the Explain workflow embedded in the Explorer.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { ExplainRequest, ExplainResponse } from '../api/types';
import { EvaluationView } from './EvaluationView';

export interface ExplainScenario {
  resolverIp: string;
  ecsPresent: boolean;
  ecsPrefix: string;
  country: string;
  asn: string;
  realtaDown: boolean;
}

export const DEFAULT_SCENARIO: ExplainScenario = {
  resolverIp: '9.9.9.9',
  ecsPresent: true,
  ecsPrefix: '185.2.100.0/24',
  country: 'IE',
  asn: '5466',
  realtaDown: false,
};

// Callers (Steering, Dashboard) may hand us a prefill that also carries zone/domain/type; we take
// only the scenario fields — the record itself is fixed by the Explorer selection.
export function toScenario(prefill?: Partial<ExplainScenario> | null): ExplainScenario {
  return { ...DEFAULT_SCENARIO, ...(prefill ?? {}) };
}

const PRESETS: { name: string; patch: Partial<ExplainScenario> }[] = [
  { name: 'Ireland · ECS · AS5466', patch: { resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: '185.2.100.0/24', country: 'IE', asn: '5466', realtaDown: false } },
  { name: 'Ireland · public resolver (no ECS)', patch: { resolverIp: '8.8.8.8', ecsPresent: false, ecsPrefix: '', country: 'IE', asn: '', realtaDown: false } },
  { name: 'Germany · ECS · AS3320', patch: { resolverIp: '9.9.9.9', ecsPresent: true, ecsPrefix: '91.0.0.0/24', country: 'DE', asn: '3320', realtaDown: false } },
  { name: 'Réalta down', patch: { realtaDown: true } },
];

function toRequest(zone: string, domain: string, type: string, s: ExplainScenario): ExplainRequest {
  const asn = s.asn.trim() ? Number(s.asn.trim()) : undefined;
  return {
    zone,
    domain,
    type,
    scenario: {
      resolverIp: s.resolverIp.trim(),
      ecsPresent: s.ecsPresent,
      ...(s.ecsPresent && s.ecsPrefix.trim() ? { ecsPrefix: s.ecsPrefix.trim() } : {}),
      ...(s.country.trim() ? { country: s.country.trim().toUpperCase() } : {}),
      ...(asn !== undefined && !Number.isNaN(asn) ? { asn } : {}),
      ...(s.realtaDown ? { healthOverrides: { 'ans-realta': false } } : {}),
    },
  };
}

interface Props {
  zone: string;
  domain: string;
  type: string;
  prefill?: Partial<ExplainScenario> | null;
  autoRun?: boolean;
}

export function ExplainPanel({ zone, domain, type, prefill, autoRun }: Props) {
  const [form, setForm] = useState<ExplainScenario>(() => toScenario(prefill));
  const [result, setResult] = useState<ExplainResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const autoRan = useRef(false);

  const set = <K extends keyof ExplainScenario>(k: K, v: ExplainScenario[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function runExplain(s: ExplainScenario): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.explain(toRequest(zone, domain, type, s)));
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : 'Evaluation failed.');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  // Arriving with a prefill (from the Steering Matrix or Dashboard) runs the evaluation immediately.
  useEffect(() => {
    if (autoRun && !autoRan.current) {
      autoRan.current = true;
      void runExplain(form);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void runExplain(form);
  };

  return (
    <div>
      <form onSubmit={submit}>
        <div style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {PRESETS.map((p) => (
            <button type="button" key={p.name} className="ghost" onClick={() => setForm((f) => ({ ...f, ...p.patch }))}>
              {p.name}
            </button>
          ))}
        </div>
        <div className="form-grid">
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
