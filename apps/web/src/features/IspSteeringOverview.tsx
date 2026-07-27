// Steering overview — an at-a-glance matrix of how the CURRENT record steers a subscriber on each
// major ISP. For every ISP it evaluates the live config via /api/v1/dns/explain and renders the
// delivery-platform mix as a stacked bar. Nothing is hardcoded: the shares come straight from the
// loaded config, so this stays correct as the config changes. Clicking a row drills into the full
// per-ISP Explain (why), via the parent.
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { ISPS, ispToScenario, type Isp } from '../steering/isps';
import { colorFor, orderOf } from '../steering/platforms';
import { Donut } from '../components/Donut';
import type { ExplainResponse } from '../api/types';

interface Segment {
  platform: string;
  share: number;
}
interface Row {
  isp: Isp;
  segments: Segment[];
  complete: boolean;
  error?: string;
}

function distribution(res: ExplainResponse): Segment[] {
  const map = new Map<string, number>();
  for (const s of res.evaluation.expectedDistribution?.shares ?? []) {
    const p = s.deliveryPlatform ?? s.label ?? 'Unknown';
    map.set(p, (map.get(p) ?? 0) + s.share);
  }
  return [...map.entries()]
    .map(([platform, share]) => ({ platform, share }))
    .filter((x) => x.share > 0.001) // drop negligible standbys (e.g. CloudFront 1e-8)
    .sort((a, b) => orderOf(a.platform) - orderOf(b.platform));
}

interface Props {
  zone: string;
  domain: string;
  type: string;
  onPick?: (isp: Isp) => void;
}

export function IspSteeringOverview({ zone, domain, type, onPick }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let active = true;
    setRows(null);
    Promise.all(
      ISPS.map(async (isp): Promise<Row> => {
        try {
          const res = await api.explain({ zone, domain, type, scenario: { ...ispToScenario(isp), asn: Number(isp.asn) } });
          const segments = distribution(res);
          return { isp, segments, complete: res.evaluation.complete };
        } catch (e) {
          return { isp, segments: [], complete: false, error: e instanceof ApiError ? `${e.code}` : 'failed' };
        }
      }),
    ).then((r) => active && setRows(r));
    return () => {
      active = false;
    };
  }, [zone, domain, type]);

  const platformsSeen = Array.from(new Set((rows ?? []).flatMap((r) => r.segments.map((s) => s.platform)))).sort(
    (a, b) => orderOf(a) - orderOf(b),
  );

  return (
    <div>
      <div className="step-head" style={{ marginBottom: '0.5rem' }}>
        <h3 style={{ margin: 0 }}>Steering overview — every ISP</h3>
        {platformsSeen.length > 0 && (
          <div style={{ display: 'flex', gap: '0.7rem', flexWrap: 'wrap', marginLeft: 'auto' }}>
            {platformsSeen.map((p) => (
              <span key={p} className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem' }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: colorFor(p), display: 'inline-block' }} /> {p}
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: '0.82rem' }}>
        How <span className="mono">{domain}</span> {type} steers a subscriber on each network, from the current NS1 config.
        Shares are probabilistic (weighted shuffle) — the likely mix, not a guaranteed split.
      </p>

      {rows === null ? (
        <span className="muted">Evaluating every ISP…</span>
      ) : (
        <div className="isp-pie-grid">
          {rows.map((r) => (
            <button
              key={r.isp.id}
              className="isp-pie-card"
              onClick={() => onPick?.(r.isp)}
              title={`Explain a ${r.isp.name} subscriber (AS${r.isp.asn})`}
              style={{ cursor: onPick ? 'pointer' : 'default' }}
            >
              {/* Delivery-platform mix as a donut. */}
              <Donut
                data={r.segments.map((s) => ({ label: s.platform, value: s.share, color: colorFor(s.platform) }))}
                size={96}
                thickness={28}
                ariaLabel={`${r.isp.name} delivery mix`}
              />
              <div className="isp-pie-name">
                {r.isp.name} <span className="mono muted">AS{r.isp.asn}</span>
              </div>
              <div className="isp-pie-mix">
                {r.error ? (
                  <span className="muted">unavailable ({r.error})</span>
                ) : r.segments.length === 0 ? (
                  <span className="muted">—</span>
                ) : (
                  // The FULL mix, not just the top platform — off-island shows "Réalta 50% · Fastly 50%".
                  r.segments.map((s, i) => (
                    <span key={s.platform}>
                      {i > 0 && <span className="muted"> · </span>}
                      <b style={{ color: colorFor(s.platform) }}>{s.platform}</b> {(s.share * 100).toFixed(0)}%
                    </span>
                  ))
                )}
                {!r.complete && !r.error && <span className="badge warn" style={{ marginLeft: '0.3rem' }}>partial</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
