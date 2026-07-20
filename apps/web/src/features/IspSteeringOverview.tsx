// Steering overview — an at-a-glance matrix of how the CURRENT record steers a subscriber on each
// major ISP. For every ISP it evaluates the live config via /api/v1/dns/explain and renders the
// delivery-platform mix as a stacked bar. Nothing is hardcoded: the shares come straight from the
// loaded config, so this stays correct as the config changes. Clicking a row drills into the full
// per-ISP Explain (why), via the parent.
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { ISPS, ispToScenario, type Isp } from '../steering/isps';
import { colorFor, orderOf } from '../steering/platforms';
import type { ExplainResponse } from '../api/types';

interface Segment {
  platform: string;
  share: number;
}
interface Row {
  isp: Isp;
  segments: Segment[];
  top?: Segment;
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
          const top = [...segments].sort((a, b) => b.share - a.share)[0];
          return { isp, segments, top, complete: res.evaluation.complete };
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
        <div style={{ display: 'grid', gap: '0.4rem' }}>
          {rows.map((r) => (
            <button
              key={r.isp.id}
              onClick={() => onPick?.(r.isp)}
              title={`Explain a ${r.isp.name} subscriber (AS${r.isp.asn})`}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(130px, 200px) 1fr minmax(96px, auto)',
                gap: '0.7rem',
                alignItems: 'center',
                textAlign: 'left',
                background: 'transparent',
                border: 'none',
                borderBottom: '1px solid var(--border, #2d3748)',
                padding: '0.45rem 0.2rem',
                cursor: onPick ? 'pointer' : 'default',
                font: 'inherit',
                color: 'inherit',
              }}
            >
              <span>
                {r.isp.name} <span className="mono muted" style={{ fontSize: '0.78rem' }}>AS{r.isp.asn}</span>
              </span>
              <span style={{ display: 'flex', height: 16, borderRadius: 4, overflow: 'hidden', background: 'var(--track, #e2e8f0)' }}>
                {r.error ? (
                  <span className="muted" style={{ fontSize: '0.78rem', paddingLeft: 6 }}>unavailable ({r.error})</span>
                ) : (
                  r.segments.map((s) => (
                    <span
                      key={s.platform}
                      title={`${s.platform} ${(s.share * 100).toFixed(0)}%`}
                      style={{ width: `${s.share * 100}%`, background: colorFor(s.platform) }}
                    />
                  ))
                )}
              </span>
              <span style={{ fontSize: '0.85rem' }}>
                {r.top ? (
                  <>
                    <b>{r.top.platform}</b> {(r.top.share * 100).toFixed(0)}%
                  </>
                ) : (
                  <span className="muted">—</span>
                )}
                {!r.complete && !r.error && <span className="badge warn" style={{ marginLeft: '0.3rem' }}>partial</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
