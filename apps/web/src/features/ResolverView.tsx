// Resolver reader — what each ISP's own recursive resolvers return for the steering record, from
// RIPE Atlas probes inside each ISP. Shows platform, the Cloudflare pool (CW/PW) split, and the
// TTLs the resolvers actually serve (does the low liveedge TTL get honoured?). A 6-hourly recurring
// baseline (instant), a "Check now" button for on-demand freshness, and a polling on/off switch to
// halt the recurring credits when not needed. Engineer-gated controls; read-only for everyone.
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { colorFor } from '../steering/platforms';
import type { ResolverCheck, ResolverIspView, ResolverSnapshot } from '../api/types';

const ago = (iso: string | null): string => {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

function IspCard({ v }: { v: ResolverIspView }) {
  const [open, setOpen] = useState(false);
  if (!v.covered) {
    return (
      <div className="rv-card uncovered">
        <div className="rv-head"><span className="rv-isp">{v.isp}</span><span className="rv-asn">AS{v.asn}</span></div>
        <div className="rv-nocov">{v.note ?? 'No RIPE Atlas probe coverage.'}</div>
      </div>
    );
  }
  const platforms = Object.entries(v.platforms).sort((a, b) => b[1] - a[1]);
  const pools = Object.entries(v.pools).sort((a, b) => b[1] - a[1]);
  const total = platforms.reduce((s, [, n]) => s + n, 0) || 1;
  return (
    <div className="rv-card">
      <div className="rv-head">
        <span className="rv-isp">{v.isp}</span><span className="rv-asn">AS{v.asn}</span>
        <span className="rv-count muted">{v.resolverCount} resolvers · {v.probeCount} probes</span>
      </div>
      <div className="rv-platforms">
        {platforms.map(([p, n]) => (
          <span key={p} className="rv-plat" style={{ borderColor: colorFor(p) }}>
            <span className="platform-dot" style={{ background: colorFor(p) }} />{p} {Math.round((n / total) * 100)}%
          </span>
        ))}
      </div>
      <div className="rv-meta">
        <div className="rv-metric">
          <span className="rv-metric-k">edge TTL</span>
          <span className="rv-metric-v mono">{v.edgeTtl ? (v.edgeTtl.min === v.edgeTtl.max ? `${v.edgeTtl.max}s` : `${v.edgeTtl.min}–${v.edgeTtl.max}s`) : '—'}</span>
          {v.honoursLowTtl !== null && <span className={`badge badge-sm ${v.honoursLowTtl ? 'ok' : 'warn'}`}>{v.honoursLowTtl ? 'honoured' : 'floored'}</span>}
        </div>
        <div className="rv-metric">
          <span className="rv-metric-k">pools</span>
          {pools.length ? pools.map(([pool, n]) => <span key={pool} className="rv-pool mono">{pool}.x · {n}</span>) : <span className="muted">—</span>}
        </div>
      </div>
      {v.samples.length > 0 && (
        <>
          <button className="linklike" onClick={() => setOpen((o) => !o)}>{open ? 'hide resolvers' : `${v.samples.length} resolver answers`}</button>
          {open && (
            <ul className="rv-samples">
              {v.samples.map((s, i) => (
                <li key={`${s.probeId}-${i}`}>
                  <span className="mono rv-resolver">{s.resolver}</span>
                  <span className="platform-dot" style={{ background: colorFor(s.platform ?? 'Unclassified') }} />{s.platform ?? '?'}
                  <span className="muted mono">{s.target}</span>
                  <span className="muted mono">apex {s.apexTtl ?? '?'}s · edge {s.edgeTtl ?? '?'}s</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function ResolverView() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('connector.manage');
  const [snap, setSnap] = useState<ResolverSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.resolvers()
      .then((s) => { if (live) { setSnap(s); setError(null); } })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not load resolver data.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const covered = useMemo(() => (snap?.isps ?? []).filter((i) => i.covered).length, [snap]);

  async function checkNow() {
    setChecking(true); setCheckNote('Firing measurements from each ISP…'); setError(null);
    try {
      const { checks } = await api.resolverCheck();
      const start = Date.now();
      // Poll until every covered ISP has reported, or ~3 min.
      for (;;) {
        await new Promise((r) => setTimeout(r, 12000));
        const { snapshot, pending } = await api.resolverCheckResults(checks as ResolverCheck[]);
        setSnap(snapshot);
        if (!pending) { setCheckNote(`Fresh check complete — ${covered} ISPs.`); break; }
        if (Date.now() - start > 180000) { setCheckNote('Still measuring — showing what has reported so far.'); break; }
        setCheckNote('Waiting for probes to report…');
      }
    } catch (e: unknown) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Check failed.');
    } finally {
      setChecking(false);
    }
  }

  async function togglePolling() {
    if (!snap) return;
    setBusy(true);
    try {
      const { pollingEnabled } = await api.resolverPolling(!snap.pollingEnabled);
      setSnap({ ...snap, pollingEnabled });
    } catch (e: unknown) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not change polling.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <span className="muted">Loading resolver data…</span>;
  if (error && !snap) return <div className="notice danger">{error}</div>;
  if (!snap) return <div className="notice info">No resolver data.</div>;

  const mode = snap.provenance.source;
  return (
    <div className="rv">
      <div className="rv-bar">
        <div className="rv-bar-l">
          <span className={`badge ${mode === 'ripe-atlas' ? 'ok' : mode === 'mock' ? 'warn' : 'neutral'}`}>
            {mode === 'ripe-atlas' ? 'LIVE · RIPE Atlas' : mode === 'mock' ? 'MOCK · SYNTHETIC' : 'DISABLED'}
          </span>
          <span className="muted">What each ISP’s own resolvers return for <b className="mono">{snap.target}</b> · baseline {ago(snap.observedAt)}</span>
        </div>
        <div className="rv-bar-r">
          {canManage && (
            <label className="switch" title="Turn the 6-hourly recurring measurements on/off to control RIPE Atlas credit spend">
              <input type="checkbox" checked={snap.pollingEnabled ?? true} disabled={busy} onChange={togglePolling} /> 6h polling
            </label>
          )}
          {canManage && <button className="primary" onClick={checkNow} disabled={checking}>{checking ? 'Checking…' : 'Check resolvers now'}</button>}
        </div>
      </div>
      {checkNote && <div className="notice info rv-note">{checking && <span className="rv-spin" />}{checkNote}</div>}
      {error && <div className="notice danger">{error}</div>}
      {snap.warnings.map((w, i) => <div key={i} className="notice warn">{w}</div>)}

      <div className="rv-grid">
        {snap.isps.map((v) => <IspCard key={v.isp} v={v} />)}
      </div>
    </div>
  );
}
