// "How this record steers" — an interactive, top-down walkthrough of the filter chain for the
// SELECTED config and a chosen requester. It uses the engine's real per-filter trace (via
// /api/v1/dns/explain), so every step, survivor and probability is computed from the live config —
// RADAR reads and interprets, never assumes. Each step states the yes/no question the filter asks,
// the rule for both branches, and what actually happened to the answer pool for this requester;
// the final weighted step shows the probability split.
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import { ISPS, ispToScenario, matchIsp } from '../steering/isps';
import { filterMeta, removeFlagFor } from '../steering/record-config';
import { colorFor, orderOf } from '../steering/platforms';
import type { EvaluationResult, ExplainResponse, FilterTrace, TracedAnswer } from '../api/types';

interface Form { asn: string; country: string; ecsPrefix: string; resolverIp: string; realtaDown: boolean }
const initialForm = (): Form => ({ ...ispToScenario(ISPS[0]), realtaDown: false });

const pct = (s: number) => `${(s * 100).toFixed(s >= 0.1 ? 0 : 1)}%`;

// The yes/no question each filter asks of the requester (references the resolved identity).
export function question(t: FilterTrace, id: EvaluationResult['identity']): string {
  const asn = id.asn !== undefined ? `AS${id.asn}` : 'unknown AS';
  const country = id.country ?? 'unknown country';
  switch (t.type) {
    case 'netfence_asn': return `Is the requester's network (${asn}) listed in an answer's asn metadata?`;
    case 'netfence_prefix': return "Is the requester's IP inside an answer's ip_prefixes?";
    case 'geofence_country': return `Is the requester's country (${country}) listed in an answer's country metadata?`;
    case 'geofence_regional': return "Is the requester's region listed in an answer's georegion metadata?";
    case 'up': return 'Which answers are currently up (healthy)?';
    case 'weighted_shuffle': return 'Reorder the surviving answers randomly, biased by each answer\'s weight.';
    case 'shuffle': return 'Reorder the surviving answers randomly (equal chance each).';
    case 'select_first_n': return 'Keep only the first N answers after the reorder.';
    default: return filterMeta(t.type).summary;
  }
}

// The if-yes / if-no rule for the fence filters, or null for non-fences.
export function branches(t: FilterTrace): { ifYes: string; ifNo: string } | null {
  const rf = removeFlagFor(t.type, t.config);
  if (t.type === 'netfence_asn') return {
    ifYes: `Keep the matching answer(s). Untagged answers (no asn) are ${rf?.enabled ? 'dropped' : 'kept as fallbacks'}.`,
    ifNo: 'Drop the tagged answers; keep only untagged answers (fallbacks).',
  };
  if (t.type === 'netfence_prefix') return {
    ifYes: `Keep the matching answer(s). Answers with no ip_prefixes are ${rf?.enabled ? 'dropped' : 'kept as fallbacks'}.`,
    ifNo: 'Drop the tagged answers; keep only answers with no ip_prefixes (fallbacks).',
  };
  if (t.type === 'geofence_country') return {
    ifYes: `Keep the matching answer(s). Answers with no country are ${rf?.enabled ? 'dropped' : 'kept as fallbacks'}.`,
    ifNo: 'Drop the tagged answers; keep only answers with no country (fallbacks).',
  };
  return null;
}

export function RecordWalkthrough({ zone, domain, type }: { zone: string; domain: string; type: string }) {
  const [form, setForm] = useState<Form>(initialForm);
  const [ev, setEv] = useState<EvaluationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const activeIsp = matchIsp({ asn: form.asn, country: form.country });

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const asn = form.asn.trim() ? Number(form.asn.trim()) : undefined;
    api
      .explain({
        zone, domain, type,
        scenario: {
          resolverIp: form.resolverIp.trim() || '9.9.9.9',
          ecsPresent: Boolean(form.ecsPrefix.trim()),
          ...(form.ecsPrefix.trim() ? { ecsPrefix: form.ecsPrefix.trim() } : {}),
          ...(form.country.trim() ? { country: form.country.trim().toUpperCase() } : {}),
          ...(asn !== undefined && !Number.isNaN(asn) ? { asn } : {}),
          ...(form.realtaDown ? { healthOverrides: { 'ans-realta': false } } : {}),
        },
      })
      .then((r: ExplainResponse) => { if (live) setEv(r.evaluation); })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not evaluate the record.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [zone, domain, type, form]);

  const answerById = useMemo(() => new Map<string, TracedAnswer>((ev?.answers ?? []).map((a) => [a.id, a])), [ev]);
  const platformOfId = (id: string) => answerById.get(id)?.deliveryPlatform ?? 'Unclassified';
  const labelOfId = (id: string) => { const a = answerById.get(id); return a ? (a.rdata[0] ?? a.label) : id; };

  // Expected distribution aggregated per platform (drop <0.5% standbys) for the weighting bars.
  const platformShares = useMemo(() => {
    const shares = ev?.expectedDistribution?.shares ?? [];
    const by = new Map<string, number>();
    for (const s of shares) by.set(s.deliveryPlatform ?? 'Unclassified', (by.get(s.deliveryPlatform ?? 'Unclassified') ?? 0) + s.share);
    return [...by.entries()].filter(([, s]) => s >= 0.005).sort((a, b) => orderOf(a[0]) - orderOf(b[0])).map(([platform, share]) => ({ platform, share }));
  }, [ev]);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="walkthrough">
      {/* Requester selector */}
      <div className="wt-requester">
        <label className="field"><span>Requester (ISP)</span>
          <select value={activeIsp?.id ?? ''} onChange={(e) => { const i = ISPS.find((x) => x.id === e.target.value); if (i) set({ ...ispToScenario(i) }); }}>
            <option value="">Custom</option>
            {ISPS.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </label>
        <label className="field"><span>ASN</span><input value={form.asn} onChange={(e) => set({ asn: e.target.value })} inputMode="numeric" placeholder="e.g. 5466" /></label>
        <label className="field"><span>Country</span><input value={form.country} onChange={(e) => set({ country: e.target.value })} placeholder="e.g. IE" maxLength={2} /></label>
        <label className="switch" title="Evaluate as if the Réalta answer's health check is failing">
          <input type="checkbox" checked={form.realtaDown} onChange={(e) => set({ realtaDown: e.target.checked })} /> Réalta down
        </label>
      </div>

      {error && <div className="notice danger">{error}</div>}
      {!ev && loading && <span className="muted">Evaluating…</span>}

      {ev && (
        <>
          <div className="wt-identity muted">
            Evaluating for <strong>{activeIsp?.name ?? 'a custom requester'}</strong> —{' '}
            identity from <strong>{ev.identity.source === 'ecs' ? 'client subnet (ECS)' : 'resolver IP'}</strong>
            {ev.identity.asn !== undefined && <> · AS{ev.identity.asn}</>}
            {ev.identity.country && <> · {ev.identity.country}</>}. {ev.answers.length} answers enter the chain.
          </div>

          <ol className="wt-steps">
            {ev.traces.map((t) => {
              const m = filterMeta(t.type);
              const br = branches(t);
              const removed = t.removedAnswerIds;
              const matched = removed.length > 0; // a fence that removed answers found a match
              return (
                <li key={t.index} className={`wt-step ${t.disabled ? 'disabled' : ''}`}>
                  <div className="wt-step-head">
                    <span className="wt-step-name">{m.label}</span>
                    <span className={`badge badge-sm ${t.supported ? 'ok' : 'warn'}`}>{t.supported ? t.behaviour : 'partial'}</span>
                    <span className="wt-pool">{t.input.length} → {t.output.length}{removed.length ? ` (−${removed.length})` : ''}</span>
                  </div>
                  <div className="wt-question">{question(t, ev.identity)}</div>
                  {br && (
                    <div className="wt-branches">
                      <div className={`wt-branch ${matched ? 'taken' : ''}`}><span className="wt-branch-key">If YES</span> {br.ifYes}</div>
                      <div className={`wt-branch ${!matched ? 'taken' : ''}`}><span className="wt-branch-key">If NO</span> {br.ifNo}</div>
                    </div>
                  )}
                  <div className="wt-result muted">→ {t.reason}</div>
                  {removed.length > 0 && (
                    <div className="wt-removed">
                      <span className="tag-key">dropped</span>
                      {removed.map((id) => (
                        <span key={id} className="chip" style={{ borderColor: colorFor(platformOfId(id)) }} title={platformOfId(id)}>{labelOfId(id)}</span>
                      ))}
                    </div>
                  )}
                  {t.metadataConsumed.length > 0 && <div className="wt-meta muted">reads: {t.metadataConsumed.join(', ')}</div>}
                </li>
              );
            })}
          </ol>

          {/* Weighting resolution */}
          {ev.expectedDistribution ? (
            <div className="wt-weighting card">
              <h4>How the weighting resolves <span className="muted">({ev.expectedDistribution.method.replace(/_/g, ' ')})</span></h4>
              <div className="wt-bars">
                {platformShares.map((s) => (
                  <div key={s.platform} className="wt-bar-row">
                    <span className="wt-bar-label"><span className="platform-dot" style={{ background: colorFor(s.platform) }} /> {s.platform}</span>
                    <span className="share-bar"><span className="share-fill" style={{ width: pct(s.share), background: colorFor(s.platform) }} /></span>
                    <span className="wt-bar-pct">{pct(s.share)}</span>
                  </div>
                ))}
              </div>
              <div className="matrix-wrap">
                <table className="matrix">
                  <thead><tr><th>Surviving answer</th><th>Platform</th><th>Weight</th><th>Probability</th></tr></thead>
                  <tbody>
                    {ev.expectedDistribution.shares.filter((s) => s.share > 0).map((s) => (
                      <tr key={s.answerId}>
                        <td className="mono">{labelOfId(s.answerId)}</td>
                        <td><span className="platform-dot" style={{ background: colorFor(s.deliveryPlatform ?? 'Unclassified') }} /> {s.deliveryPlatform ?? 'Unclassified'}</td>
                        <td>{answerById.get(s.answerId)?.weight ?? '—'}</td>
                        <td>{pct(s.share)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {ev.expectedDistribution.disclaimers.map((d, i) => <div key={i} className="muted wt-disclaimer">{d}</div>)}
            </div>
          ) : (
            <div className="notice info">The chain resolves to a fixed answer for this requester (no probabilistic step) — see the last step above.</div>
          )}

          <div className="wt-explanation">{ev.explanation}</div>
        </>
      )}
    </div>
  );
}
