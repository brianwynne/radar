// Network breakdown for a record: every ASN referenced by the record's answers, resolved to its
// owner (RIPEstat, via the API) and shown with the delivery answers/platforms it is tagged in.
// Loads on demand — resolving a config's ~100 ASNs is an external lookup, so it's behind a button.
import { useState } from 'react';
import { api, ApiError } from '../api/client';
import type { AsnBreakdownResponse, AsnTag } from '../api/types';

const PLATFORM_COLORS: Record<string, string> = { Réalta: '#2f855a', Fastly: '#dd4b39', Akamai: '#2b6cb0', CloudFront: '#805ad5' };
const colorFor = (p: string | null) => (p ? PLATFORM_COLORS[p] ?? '#718096' : '#718096');

// Collapse an ASN's per-answer tags to one chip per platform, summing weights, so "Réalta 200"
// shows once rather than several near-zero standby rows.
function platformChips(tags: AsnTag[]): { platform: string; weight: number }[] {
  const byPlatform = new Map<string, number>();
  for (const t of tags) byPlatform.set(t.platform ?? 'unknown', (byPlatform.get(t.platform ?? 'unknown') ?? 0) + (t.weight ?? 0));
  return [...byPlatform.entries()].map(([platform, weight]) => ({ platform, weight })).sort((a, b) => b.weight - a.weight);
}

export function AsnBreakdown({ zone, domain, type }: { zone: string; domain: string; type: string }) {
  const [data, setData] = useState<AsnBreakdownResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

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
  const rows = (data?.rows ?? []).filter(
    (r) => !q || String(r.asn).includes(q) || (r.holder ?? '').toLowerCase().includes(q) || r.tags.some((t) => (t.platform ?? '').toLowerCase().includes(q)),
  );

  return (
    <div>
      <div className="step-head" style={{ marginBottom: '0.5rem' }}>
        <h3 style={{ margin: 0 }}>Network breakdown (ASNs)</h3>
        {data && (
          <span className="muted" style={{ fontSize: '0.82rem' }}>
            {data.asnCount} networks · {data.resolvedCount} resolved
            {data.unresolvedCount > 0 ? ` · ${data.unresolvedCount} unresolved` : ''} · source {data.source}
          </span>
        )}
        {data && <input placeholder="Filter ASN / network / platform" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginLeft: 'auto', maxWidth: 260 }} />}
      </div>

      {!data && (
        <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
          Resolve every ASN this record steers on to its network owner (external lookup via RIPEstat), grouped by network with
          the delivery answers each is tagged in.
        </p>
      )}

      {error && <div className="notice danger">{error}</div>}

      {!data ? (
        <button className="primary" onClick={load} disabled={loading}>
          {loading ? 'Resolving ASNs…' : 'Resolve networks'}
        </button>
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
              {rows.map((r) => (
                <tr key={r.asn}>
                  <td className="mono">AS{r.asn}</td>
                  <td>{r.holder ?? <span className="muted">unresolved</span>}</td>
                  <td>
                    {platformChips(r.tags).map((c) => (
                      <span
                        key={c.platform}
                        className="badge"
                        style={{ marginRight: '0.3rem', background: colorFor(c.platform === 'unknown' ? null : c.platform), color: '#fff' }}
                        title={`${c.platform} · relative weight ${c.weight}`}
                      >
                        {c.platform} {c.weight >= 0.01 ? c.weight : '≈0'}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="center-note">
                    No networks match “{filter}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
