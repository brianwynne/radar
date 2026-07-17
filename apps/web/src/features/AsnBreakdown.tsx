// Network breakdown for a record: every ASN referenced by the record's answers, resolved to its
// owner (RIPEstat, via the API). Two views over the same data:
//   • By answer (default) — each delivery block of the config (EIR, Vodafone, Three, LG, Main CDN,
//     BSKYB, Emergency Offload…) with the resolved networks it steers. This is the "each part of
//     the chain" view.
//   • By network — one row per ASN with the answers/platforms it is tagged in.
// Loads on demand — resolving a config's ~100 ASNs is an external lookup, so it's behind a button.
import { useState } from 'react';
import { api, ApiError } from '../api/client';
import type { AsnAnswerGroup, AsnBreakdownResponse, AsnTag } from '../api/types';

const PLATFORM_COLORS: Record<string, string> = { Réalta: '#2f855a', Fastly: '#dd4b39', Akamai: '#2b6cb0', CloudFront: '#805ad5' };
const colorFor = (p: string | null) => (p ? PLATFORM_COLORS[p] ?? '#718096' : '#718096');
const fmtWeight = (w: number | null) => (w === null ? '—' : w >= 0.01 ? String(w) : '≈0');

function platformChips(tags: AsnTag[]): { platform: string; weight: number }[] {
  const byPlatform = new Map<string, number>();
  for (const t of tags) byPlatform.set(t.platform ?? 'unknown', (byPlatform.get(t.platform ?? 'unknown') ?? 0) + (t.weight ?? 0));
  return [...byPlatform.entries()].map(([platform, weight]) => ({ platform, weight })).sort((a, b) => b.weight - a.weight);
}

// Filter a group's networks by the query; a header match (note/platform/target) keeps all its
// networks. Returns null when nothing in the group matches.
function matchGroup(g: AsnAnswerGroup, q: string): AsnAnswerGroup | null {
  if (!q) return g;
  const headerMatches = [g.note, g.platform, g.target].some((s) => (s ?? '').toLowerCase().includes(q));
  if (headerMatches) return g;
  const networks = g.networks.filter((n) => String(n.asn).includes(q) || (n.holder ?? '').toLowerCase().includes(q));
  return networks.length ? { ...g, networks } : null;
}

function AnswerCard({ g }: { g: AsnAnswerGroup }) {
  const nets = g.networks;
  return (
    <div style={{ border: '1px solid var(--border, #2d3748)', borderRadius: 8, padding: '0.6rem 0.75rem' }}>
      <div className="step-head" style={{ marginBottom: '0.4rem' }}>
        <span className="badge" style={{ background: colorFor(g.platform), color: '#fff' }}>{g.platform ?? 'unknown'}</span>
        <b>{g.note ?? g.target}</b>
        <span className="mono muted" style={{ fontSize: '0.78rem' }}>{g.target}</span>
        <span className="muted" style={{ fontSize: '0.78rem' }}>weight {fmtWeight(g.weight)}</span>
        <span className="muted" style={{ marginLeft: 'auto', fontSize: '0.78rem' }}>{g.asnCount} networks</span>
      </div>
      <div className="flow">
        {nets.map((n) => (
          <span key={n.asn} className="chip" title={`AS${n.asn}`}>
            <span className="mono muted">AS{n.asn}</span> {n.holder ?? <span className="muted">unresolved</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

export function AsnBreakdown({ zone, domain, type }: { zone: string; domain: string; type: string }) {
  const [data, setData] = useState<AsnBreakdownResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'answer' | 'network'>('answer');

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setData(await api.asnBreakdown(zone, domain, type));
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not resolve ASNs.');
    } finally {
      setLoading(false);
    }
  }

  const q = filter.trim().toLowerCase();
  const netRows = (data?.rows ?? []).filter(
    (r) => !q || String(r.asn).includes(q) || (r.holder ?? '').toLowerCase().includes(q) || r.tags.some((t) => (t.platform ?? '').toLowerCase().includes(q)),
  );

  return (
    <div>
      <div className="step-head" style={{ marginBottom: '0.5rem' }}>
        <h3 style={{ margin: 0 }}>Network breakdown (ASNs)</h3>
        {data && (
          <>
            <button className={`ghost ${view === 'answer' ? 'active' : ''}`} onClick={() => setView('answer')}>By answer</button>
            <button className={`ghost ${view === 'network' ? 'active' : ''}`} onClick={() => setView('network')}>By network</button>
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              {data.asnCount} networks · {data.resolvedCount} resolved{data.unresolvedCount > 0 ? ` · ${data.unresolvedCount} unresolved` : ''} · {data.source}
            </span>
            <input placeholder="Filter ASN / network / platform" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginLeft: 'auto', maxWidth: 240 }} />
          </>
        )}
      </div>

      {!data && (
        <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
          Resolve every ASN this record steers on to its network owner (external lookup via RIPEstat), grouped per answer —
          each part of the chain — so you can see which real networks each delivery block targets.
        </p>
      )}

      {error && <div className="notice danger">{error}</div>}

      {!data ? (
        <button className="primary" onClick={load} disabled={loading}>
          {loading ? 'Resolving ASNs…' : 'Resolve networks'}
        </button>
      ) : view === 'answer' ? (
        (() => {
          const groups = data.answers.map((g) => matchGroup(g, q)).filter((g): g is AsnAnswerGroup => g !== null);
          return (
            <div style={{ display: 'grid', gap: '0.6rem' }}>
              {groups.length ? groups.map((g) => <AnswerCard key={g.answerId} g={g} />) : <div className="center-note">No networks match “{filter}”.</div>}
            </div>
          );
        })()
      ) : (
        <div className="matrix-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th>ASN</th>
                <th>Network owner</th>
                <th>Tagged in (platform · weight)</th>
              </tr>
            </thead>
            <tbody>
              {netRows.map((r) => (
                <tr key={r.asn}>
                  <td className="mono">AS{r.asn}</td>
                  <td>{r.holder ?? <span className="muted">unresolved</span>}</td>
                  <td>
                    {platformChips(r.tags).map((c) => (
                      <span key={c.platform} className="badge" style={{ marginRight: '0.3rem', background: colorFor(c.platform === 'unknown' ? null : c.platform), color: '#fff' }} title={`${c.platform} · relative weight ${c.weight}`}>
                        {c.platform} {c.weight >= 0.01 ? c.weight : '≈0'}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
              {netRows.length === 0 && (
                <tr>
                  <td colSpan={3} className="center-note">No networks match “{filter}”.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
