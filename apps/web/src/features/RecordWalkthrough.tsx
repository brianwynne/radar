// "How this record steers" — an interactive, top-down walkthrough of the filter chain for the
// SELECTED config and a chosen requester. It uses the engine's real per-filter trace (via
// /api/v1/dns/explain), so every step, survivor and probability is computed from the live config —
// RADAR reads and interprets, never assumes. Each step states the yes/no question the filter asks,
// the rule for both branches, and what actually happened to EACH answer for this requester; the
// final weighted step shows the probability split. A compare mode lines up several requesters.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import { ISPS, ispToScenario, matchIsp, type Isp } from '../steering/isps';
import { filterMeta, removeFlagFor } from '../steering/record-config';
import { colorFor, orderOf } from '../steering/platforms';
import type { AnswerOutcome, EvaluationResult, ExplainRequest, ExplainResponse, FilterTrace, TracedAnswer } from '../api/types';

interface Form { asn: string; country: string; ecsPrefix: string; resolverIp: string; realtaDown: boolean }
const initialForm = (): Form => ({ ...ispToScenario(ISPS[0]), realtaDown: false });

const pct = (s: number) => `${(s * 100).toFixed(s >= 0.1 ? 0 : 1)}%`;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Render `text` with any whole-token occurrence of the requester's matched values (ASN, country)
 *  wrapped in a green highlight, so the eye finds the match inside a long asn/country list fast. */
export function highlightMatches(text: string, tokens: (string | undefined)[]): ReactNode {
  const toks = tokens.filter((t): t is string => Boolean(t && t.trim()));
  if (toks.length === 0) return text;
  const re = new RegExp(`\\b(${toks.map(escapeRegExp).join('|')})\\b`, 'g');
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<mark key={m.index} className="match-hl">{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function scenarioOf(f: Partial<Form>): ExplainRequest['scenario'] {
  const asn = f.asn && f.asn.trim() ? Number(f.asn.trim()) : undefined;
  return {
    resolverIp: (f.resolverIp ?? '').trim() || '9.9.9.9',
    ecsPresent: Boolean(f.ecsPrefix && f.ecsPrefix.trim()),
    ...(f.ecsPrefix && f.ecsPrefix.trim() ? { ecsPrefix: f.ecsPrefix.trim() } : {}),
    ...(f.country && f.country.trim() ? { country: f.country.trim().toUpperCase() } : {}),
    ...(asn !== undefined && !Number.isNaN(asn) ? { asn } : {}),
    ...(f.realtaDown ? { healthOverrides: { 'ans-realta': false } } : {}),
  };
}

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
    case 'weighted_shuffle': return "Reorder the surviving answers randomly, biased by each answer's weight.";
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

/** Per-answer outcomes for a step. Prefer the engine's own outcomes (with reasons); if absent,
 *  synthesise disposition from input/output so the pool still renders. */
export function outcomesOf(t: FilterTrace): AnswerOutcome[] {
  if (t.outcomes && t.outcomes.length) return t.outcomes;
  const out = new Set(t.output);
  return t.input.map((answerId) => ({ answerId, disposition: out.has(answerId) ? 'retained' : 'removed', reason: '' }));
}

/** Platform-aggregated expected shares (drop <0.5% standbys). */
function platformSharesOf(ev: EvaluationResult): { platform: string; share: number }[] {
  const shares = ev.expectedDistribution?.shares ?? [];
  const by = new Map<string, number>();
  if (shares.length) {
    for (const s of shares) by.set(s.deliveryPlatform ?? 'Unclassified', (by.get(s.deliveryPlatform ?? 'Unclassified') ?? 0) + s.share);
  } else if (ev.selected) {
    // Deterministic single answer → 100% to its platform.
    const a = ev.answers.find((x) => x.id === ev.selected);
    if (a) by.set(a.deliveryPlatform ?? 'Unclassified', 1);
  }
  return [...by.entries()].filter(([, s]) => s >= 0.005).sort((a, b) => orderOf(a[0]) - orderOf(b[0])).map(([platform, share]) => ({ platform, share }));
}

export function RecordWalkthrough({ zone, domain, type }: { zone: string; domain: string; type: string }) {
  const zdt = { zone, domain, type };
  const [mode, setMode] = useState<'single' | 'compare'>('single');

  return (
    <div className="walkthrough">
      <div className="wt-modes">
        <button className={`ghost ${mode === 'single' ? 'active' : ''}`} onClick={() => setMode('single')}>Walk one requester</button>
        <button className={`ghost ${mode === 'compare' ? 'active' : ''}`} onClick={() => setMode('compare')}>Compare requesters</button>
      </div>
      {mode === 'single' ? <SingleWalkthrough {...zdt} /> : <CompareRequesters {...zdt} />}
    </div>
  );
}

function SingleWalkthrough({ zone, domain, type }: { zone: string; domain: string; type: string }) {
  const [form, setForm] = useState<Form>(initialForm);
  const [ev, setEv] = useState<EvaluationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (i: number) => setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });

  const activeIsp = matchIsp({ asn: form.asn, country: form.country });

  // Re-evaluate every 5s so an NS1 edit to the record is reflected near-real-time; only the first
  // run shows the "Evaluating…" state so polls don't flicker.
  useEffect(() => {
    let live = true;
    const run = (initial: boolean) => {
      if (initial) setLoading(true);
      api.explain({ zone, domain, type, scenario: scenarioOf(form) })
        .then((r: ExplainResponse) => { if (live) { setEv(r.evaluation); setError(null); } })
        .catch((e: unknown) => { if (live) setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not evaluate the record.'); })
        .finally(() => { if (live && initial) setLoading(false); });
    };
    run(true);
    const id = setInterval(() => run(false), 5000);
    return () => { live = false; clearInterval(id); };
  }, [zone, domain, type, form]);

  const answerById = useMemo(() => new Map<string, TracedAnswer>((ev?.answers ?? []).map((a) => [a.id, a])), [ev]);
  const platformOfId = (id: string) => answerById.get(id)?.deliveryPlatform ?? 'Unclassified';
  const labelOfId = (id: string) => { const a = answerById.get(id); return a ? (a.rdata[0] ?? a.label) : id; };
  const platformShares = useMemo(() => (ev ? platformSharesOf(ev) : []), [ev]);
  // The requester's matched values (ASN, country) to highlight in fence reasons/lists.
  const idTokens = useMemo(() => (ev ? [ev.identity.asn !== undefined ? String(ev.identity.asn) : undefined, ev.identity.country] : []), [ev]);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <>
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
          {/* Plain-English outcome headline */}
          {platformShares.length > 0 && (
            <div className="wt-headline">
              <span>For <strong>{activeIsp?.name ?? 'this requester'}</strong>{ev.identity.country ? ` (${ev.identity.country}${ev.identity.asn !== undefined ? `, AS${ev.identity.asn}` : ''})` : ''}:</span>
              {platformShares.map((s) => (
                <span key={s.platform} className="wt-headline-share"><span className="platform-dot" style={{ background: colorFor(s.platform) }} />{s.platform} {pct(s.share)}</span>
              ))}
              <span className="muted">· {ev.selectionDeterminism === 'deterministic' ? 'fixed answer' : ev.selectionDeterminism === 'partial' ? 'partial (unsupported filter)' : 'probabilistic'}</span>
            </div>
          )}
          <div className="wt-identity muted">
            Identity from <strong>{ev.identity.source === 'ecs' ? 'client subnet (ECS)' : 'resolver IP'}</strong>. {ev.answers.length} answers enter the chain.
          </div>

          <ol className="wt-steps">
            {ev.traces.map((t) => {
              const m = filterMeta(t.type);
              const br = branches(t);
              const outcomes = outcomesOf(t);
              const kept = outcomes.filter((o) => o.disposition !== 'removed');
              const dropped = outcomes.filter((o) => o.disposition === 'removed');
              const matched = dropped.length > 0;
              return (
                <li key={t.index} className={`wt-step ${t.disabled ? 'disabled' : ''}`}>
                  <div className="wt-step-head">
                    <span className="wt-step-name">{m.label}</span>
                    <span className={`badge badge-sm ${t.supported ? 'ok' : 'warn'}`}>{t.supported ? t.behaviour : 'partial'}</span>
                    <span className="wt-pool">{t.input.length} → {t.output.length}{dropped.length ? ` (−${dropped.length})` : ''}</span>
                  </div>
                  <div className="wt-question">{question(t, ev.identity)}</div>
                  {br && (
                    <div className="wt-branches">
                      <div className={`wt-branch ${matched ? 'taken' : ''}`}><span className="wt-branch-key">If YES</span> {br.ifYes}</div>
                      <div className={`wt-branch ${!matched ? 'taken' : ''}`}><span className="wt-branch-key">If NO</span> {br.ifNo}</div>
                    </div>
                  )}
                  {/* Live answer pool: survivors + dropped, coloured by platform; fallbacks flagged green */}
                  <div className="wt-pool-chips">
                    {kept.map((o) => <span key={o.answerId} className={`chip kept ${o.fallback ? 'fallback' : ''}`} style={o.fallback ? undefined : { borderColor: colorFor(platformOfId(o.answerId)) }} title={o.reason || platformOfId(o.answerId)}>{labelOfId(o.answerId)}{o.fallback && ' · fallback'}</span>)}
                    {dropped.map((o) => <span key={o.answerId} className="chip dropped" title={o.reason || platformOfId(o.answerId)}>{labelOfId(o.answerId)}</span>)}
                  </div>
                  <div className="wt-result muted">→ {highlightMatches(t.reason, idTokens)}</div>
                  {outcomes.some((o) => o.reason) && (
                    <>
                      <button className="linklike" onClick={() => toggle(t.index)}>{open.has(t.index) ? 'hide per-answer detail' : 'per-answer detail'}</button>
                      {open.has(t.index) && (
                        <ul className="wt-outcomes">
                          {outcomes.map((o) => (
                            <li key={o.answerId} className={o.disposition === 'removed' ? 'dropped' : o.fallback ? 'fallback' : 'kept'}>
                              <span className="platform-dot" style={{ background: colorFor(platformOfId(o.answerId)) }} />
                              <span className="mono">{labelOfId(o.answerId)}</span>
                              {o.fallback ? (
                                <span className="badge ok badge-sm" title="Kept as the untagged fallback — nothing matched the requester">fallback</span>
                              ) : (
                                <span className={`badge badge-sm ${o.disposition === 'removed' ? 'danger' : 'ok'}`}>{o.disposition === 'removed' ? 'dropped' : 'kept'}</span>
                              )}
                              <span className="muted">{highlightMatches(o.reason, idTokens)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                  {t.metadataConsumed.length > 0 && <div className="wt-meta muted">reads: {t.metadataConsumed.join(', ')}</div>}
                </li>
              );
            })}
          </ol>

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
    </>
  );
}

// --- Compare requesters: run several ISPs through the same config, line up their platform mix. ---
function CompareRequesters({ zone, domain, type }: { zone: string; domain: string; type: string }) {
  const [selected, setSelected] = useState<string[]>(() => ISPS.slice(0, 3).map((i) => i.id));
  const [evs, setEvs] = useState<Map<string, EvaluationResult>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isps = useMemo(() => selected.map((id) => ISPS.find((i) => i.id === id)).filter((i): i is Isp => Boolean(i)), [selected]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    Promise.all(isps.map((isp) => api.explain({ zone, domain, type, scenario: scenarioOf(ispToScenario(isp)) }).then((r) => [isp.id, r.evaluation] as const)))
      .then((pairs) => { if (live) setEvs(new Map(pairs)); })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not evaluate the record.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [zone, domain, type, isps]);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // Union of platforms across all selected requesters, in canonical order.
  const platforms = useMemo(() => {
    const set = new Set<string>();
    for (const isp of isps) for (const s of platformSharesOf(evs.get(isp.id) ?? ({ answers: [], traces: [] } as unknown as EvaluationResult))) set.add(s.platform);
    return [...set].sort((a, b) => orderOf(a) - orderOf(b));
  }, [isps, evs]);
  const shareFor = (ispId: string, platform: string): number => {
    const ev = evs.get(ispId);
    if (!ev) return 0;
    return platformSharesOf(ev).find((s) => s.platform === platform)?.share ?? 0;
  };

  return (
    <>
      <div className="wt-compare-pick">
        {ISPS.map((i) => (
          <label key={i.id} className="switch"><input type="checkbox" checked={selected.includes(i.id)} onChange={() => toggle(i.id)} /> {i.name}</label>
        ))}
      </div>
      {error && <div className="notice danger">{error}</div>}
      {loading && evs.size === 0 && <span className="muted">Evaluating…</span>}
      {isps.length > 0 && platforms.length > 0 && (
        <div className="matrix-wrap">
          <table className="matrix wt-compare">
            <thead>
              <tr><th>Platform</th>{isps.map((i) => <th key={i.id}>{i.name}<div className="muted">{i.country} · AS{i.asn}</div></th>)}</tr>
            </thead>
            <tbody>
              {platforms.map((p) => (
                <tr key={p}>
                  <td><span className="platform-dot" style={{ background: colorFor(p) }} /> {p}</td>
                  {isps.map((i) => {
                    const share = shareFor(i.id, p);
                    return <td key={i.id} className="wt-compare-cell" style={{ background: share > 0 ? `color-mix(in srgb, ${colorFor(p)} ${Math.round(share * 55)}%, transparent)` : undefined }}>{share > 0 ? pct(share) : '—'}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
