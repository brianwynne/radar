// Stream Assurance — DASH/HLS/CMAF conformance + cross-CDN consistency. Read-only overview + a
// per-profile CDN comparison and standards findings. A viewing engineer can trigger a diagnostic
// run. Follows the existing RADAR visual language (cards, matrix tables, badges, notices).
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { SaAlert, SaDiscoveredManifest, SaEndpointInput, SaFinding, SaObservation, SaProfileInput, SaProfileSummary, SaRun } from '../api/types';

const PROVIDERS: SaEndpointInput['provider'][] = ['fastly', 'akamai', 'realta', 'origin', 'custom', 'unknown'];
const blankEndpoint = (role: SaEndpointInput['role']): SaEndpointInput => ({ endpointId: '', provider: 'fastly', role, publicUrl: '', connectHost: '', hostHeader: '', originHost: '' });

// RTÉ delivery defaults — the connect-to targets for the three CDNs behind live.rte.ie, from the
// steering record. Réalta (RTÉ's own CDN) is the reference; Fastly/Akamai are candidates. Object URLs
// follow the Unified Streaming pattern (channel4.isml); change the channel/rendition as needed.
const RTE_OBJECT_URL = 'https://live.rte.ie/live/a/channel4/channel4.isml/dash/channel4-video=6000000.dash';
const RTE_DASH_MPD = 'https://live.rte.ie/live/a/channel4/channel4.isml/.mpd';
const rteEndpoint = (endpointId: string, provider: SaEndpointInput['provider'], role: SaEndpointInput['role'], connectHost: string): SaEndpointInput =>
  ({ endpointId, provider, role, publicUrl: RTE_OBJECT_URL, connectHost, hostHeader: 'live.rte.ie', originHost: 'live.rte.ie' });
const RTE_ENDPOINTS: SaEndpointInput[] = [
  rteEndpoint('realta', 'realta', 'reference', 'liveedge.rte.ie'),
  rteEndpoint('fastly', 'fastly', 'candidate', 't.sni.global.fastly.net'),
  rteEndpoint('akamai', 'akamai', 'candidate', 'live.rte.ie.akamaized.net'),
];

// Engineer-only form to create a Stream Test profile (channel + CDN endpoints). Mirrors the API zod
// schema; empty optional fields are dropped before submit. No secrets or keys are ever entered here.
function NewProfileForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [id, setId] = useState('channel4');
  const [name, setName] = useState('Channel 4 (live.rte.ie)');
  const [endpoints, setEndpoints] = useState<SaEndpointInput[]>(RTE_ENDPOINTS.map((e) => ({ ...e })));
  const [dashMpdUrl, setDash] = useState(RTE_DASH_MPD);
  // Left blank: the object URL above is an init segment (no moof), not a time-addressed media
  // fragment, so prefilling it here would mis-report. Paste a real fragment URL to enable the check.
  const [mediaFragmentUrl, setFrag] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mpdUrl, setMpdUrl] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<SaDiscoveredManifest | null>(null);

  // Discover: fetch the manifest, derive the object URLs, and auto-fill the form. Picks the top video
  // rendition's init as the object to compare across CDNs, and its current fragment for the timeline.
  const discover = async () => {
    if (!mpdUrl.trim()) return;
    setDiscovering(true); setErr(null);
    try {
      const { manifest } = await api.saDiscover(mpdUrl.trim());
      setDiscovered(manifest);
      const videos = manifest.representations.filter((r) => r.contentType === 'video' && !r.trickPlay && r.initUrl);
      const top = videos.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
      if (top) {
        setEndpoints((es) => es.map((e) => ({ ...e, publicUrl: top.initUrl })));
        setFrag(top.latestMediaUrl ?? '');
      }
      setDash(mpdUrl.trim());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Discovery failed — check the manifest URL is reachable.');
    } finally {
      setDiscovering(false);
    }
  };

  const setEp = (i: number, patch: Partial<SaEndpointInput>) => setEndpoints((es) => es.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const addEp = () => setEndpoints((es) => [...es, blankEndpoint('candidate')]);
  const removeEp = (i: number) => setEndpoints((es) => es.filter((_, j) => j !== i));

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setErr(null);
    // Build a clean payload — drop empty optional strings so the API's URL/host validators don't reject blanks.
    const eps: SaEndpointInput[] = endpoints.map((e) => {
      const out: SaEndpointInput = { endpointId: e.endpointId.trim(), provider: e.provider, role: e.role, publicUrl: e.publicUrl.trim(), connectHost: e.connectHost.trim() };
      if (e.connectPort) out.connectPort = e.connectPort;
      if (e.hostHeader?.trim()) out.hostHeader = e.hostHeader.trim();
      if (e.sni?.trim()) out.sni = e.sni.trim();
      if (e.managedInternal) out.managedInternal = true;
      if (e.originHost?.trim()) out.originHost = e.originHost.trim();
      return out;
    });
    const manifests: SaProfileInput['config']['manifests'] = {};
    if (dashMpdUrl.trim()) manifests.dashMpdUrl = dashMpdUrl.trim();
    if (mediaFragmentUrl.trim()) manifests.mediaFragmentUrl = mediaFragmentUrl.trim();
    const payload: SaProfileInput = { id: id.trim(), name: name.trim(), config: { endpoints: eps, ...(Object.keys(manifests).length ? { manifests } : {}) } };

    setBusy(true);
    try {
      const res = await api.saCreateProfile(payload);
      onCreated(res.id);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Create failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="sa-form" onSubmit={submit}>
      <div className="sa-discover">
        <h4 className="sa-form-h">Discover from a DASH manifest <span className="muted">· optional — auto-fills the objects to test</span></h4>
        <div className="sa-form-row">
          <input value={mpdUrl} onChange={(e) => setMpdUrl(e.target.value)} placeholder="DASH .mpd URL (e.g. the player's manifest — even an ad-stitched one)" />
          <button type="button" className="btn" onClick={discover} disabled={discovering || !mpdUrl.trim()}>{discovering ? 'Discovering…' : 'Discover'}</button>
        </div>
        {discovered && (() => {
          const vids = discovered.representations.filter((r) => r.contentType === 'video' && !r.trickPlay);
          const auds = discovered.representations.filter((r) => r.contentType === 'audio');
          return (
            <div className="notice ok" style={{ fontSize: '0.78rem' }}>
              Found <b>{vids.length}</b> video rendition{vids.length === 1 ? '' : 's'} ({vids.map((v) => v.height ? `${v.height}p` : v.id).join(', ')}), <b>{auds.length}</b> audio.
              Media served from <span className="mono">{(() => { try { return new URL(discovered.baseUrl).host; } catch { return discovered.baseUrl; } })()}</span>.
              {discovered.drm.defaultKid && <> KID <span className="mono">{discovered.drm.defaultKid}</span>.</>} Filled the top video rendition below — adjust and create.
            </div>
          );
        })()}
      </div>

      <div className="sa-form-row">
        <label>ID<input value={id} onChange={(e) => setId(e.target.value)} placeholder="rte-test" pattern="[a-z0-9][a-z0-9-]*" required /></label>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="RTÉ delivery (test)" required /></label>
      </div>

      <h4 className="sa-form-h">CDN endpoints <span className="muted">· same object, different CDN</span></h4>
      <p className="muted" style={{ fontSize: '0.76rem', margin: '-0.2rem 0 0.2rem' }}>Prefilled with the three RTÉ CDNs behind <code>live.rte.ie</code>. Each dials its own <em>connect host</em> for the same object URL; edit the channel/rendition as needed.</p>
      {endpoints.map((e, i) => (
        <div className="sa-ep" key={i}>
          <div className="sa-ep-head">
            <select value={e.role} onChange={(ev) => setEp(i, { role: ev.target.value as SaEndpointInput['role'] })} aria-label="Role">
              <option value="reference">reference</option>
              <option value="candidate">candidate</option>
            </select>
            <input className="sa-ep-id" value={e.endpointId} onChange={(ev) => setEp(i, { endpointId: ev.target.value })} placeholder="endpoint id (e.g. fastly)" required />
            <select value={e.provider} onChange={(ev) => setEp(i, { provider: ev.target.value as SaEndpointInput['provider'] })} aria-label="Provider">
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            {endpoints.length > 1 && <button type="button" className="linklike" onClick={() => removeEp(i)}>remove</button>}
          </div>
          <input value={e.publicUrl} onChange={(ev) => setEp(i, { publicUrl: ev.target.value })} placeholder="public object URL — https://host/path/init.mp4" required />
          <div className="sa-form-row">
            <input value={e.connectHost} onChange={(ev) => setEp(i, { connectHost: ev.target.value })} placeholder="connect host/IP (the CDN edge to dial)" required />
            <input value={e.hostHeader ?? ''} onChange={(ev) => setEp(i, { hostHeader: ev.target.value })} placeholder="Host header to forward (optional)" />
          </div>
          <div className="sa-form-row">
            <input value={e.originHost ?? ''} onChange={(ev) => setEp(i, { originHost: ev.target.value })} placeholder="expected origin host (optional)" />
            <label className="sa-ep-mi"><input type="checkbox" checked={!!e.managedInternal} onChange={(ev) => setEp(i, { managedInternal: ev.target.checked })} /> managed-internal target</label>
          </div>
        </div>
      ))}
      <button type="button" className="btn" onClick={addEp}>+ endpoint</button>

      <h4 className="sa-form-h">Manifests <span className="muted">· optional</span></h4>
      <input value={dashMpdUrl} onChange={(e) => setDash(e.target.value)} placeholder="DASH MPD URL (optional)" />
      <input value={mediaFragmentUrl} onChange={(e) => setFrag(e.target.value)} placeholder="sample media-fragment URL (optional)" />

      {err && <div className="notice danger">{err}</div>}
      <div className="sa-form-actions">
        <button type="submit" className="btn active" disabled={busy}>{busy ? 'Creating…' : 'Create profile'}</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

// Redacted response headers per endpoint — the ground truth for diagnosing cache/origin display
// (e.g. which cache header a CDN actually emits). Credentials are already redacted server-side.
function HeaderInspector({ observations }: { observations: SaObservation[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const withHeaders = observations.filter((o) => o.headers && Object.keys(o.headers).length > 0);
  if (withHeaders.length === 0) return null;
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="sa-headers">
      <h3 style={{ margin: '0 0 0.25rem' }}>Response headers <span className="muted">· redacted · what each CDN actually returned</span></h3>
      {withHeaders.map((o) => {
        const isOpen = open.has(o.endpointId);
        const headers = o.headers!;
        return (
          <div key={o.endpointId} className={`pni-card${isOpen ? ' open' : ''}`}>
            <button type="button" className="pni-card-head" onClick={() => toggle(o.endpointId)} aria-expanded={isOpen} style={{ cursor: 'pointer', background: 'transparent', border: 'none', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', padding: 0 }}>
              <span className="pni-card-name">{o.endpointId} <span className="muted">{o.provider}</span></span>
              <span className="muted">{Object.keys(headers).length} headers</span>
              <span className="pni-chip">{isOpen ? '▾' : '▸'}</span>
            </button>
            {isOpen && (
              <dl className="sa-headers-detail">
                {Object.entries(headers).map(([k, v]) => (<Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>))}
              </dl>
            )}
          </div>
        );
      })}
    </div>
  );
}

const HANDLER_LABELS: Record<string, string> = { vide: 'video', soun: 'audio', subt: 'text', sbtl: 'text', text: 'text', clcp: 'captions', meta: 'metadata', hint: 'hint' };
const handlerLabel = (h: string | null): string => (h ? HANDLER_LABELS[h] ?? h : '?');

function InitInspector({ observations }: { observations: SaObservation[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const withInit = observations.filter((o) => o.init);
  if (withInit.length === 0) return null;
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="sa-inspector">
      <h3 style={{ margin: '1.25rem 0 0.5rem' }}>Init segment / CMAF inspector <span className="muted">· parsed metadata (no keys)</span></h3>
      {withInit.map((o) => {
        const init = o.init!;
        const isOpen = open.has(o.endpointId);
        return (
          <div key={o.endpointId} className={`pni-card${isOpen ? ' open' : ''}`}>
            <button type="button" className="pni-card-head" onClick={() => toggle(o.endpointId)} aria-expanded={isOpen} style={{ cursor: 'pointer' }}>
              <span className="pni-card-name">{o.endpointId} <span className="muted">{o.provider}</span></span>
              <span className="mono" title={init.cenc.defaultKid ?? ''}>{init.cenc.isProtected ? `${init.cenc.scheme ?? 'enc'} · ${init.cenc.defaultKid?.slice(0, 8) ?? '?'}…` : 'clear'}</span>
              <span className="pni-chip">{isOpen ? '▾' : '▸'}</span>
            </button>
            {isOpen && (
              <div className="sa-inspector-detail">
                <div><span className="muted">Brands</span> <span className="mono">{init.majorBrand ?? '—'}{init.compatibleBrands.length ? ` (${init.compatibleBrands.join(', ')})` : ''}</span></div>
                {init.tracks.map((t, i) => (
                  <div key={i}><span className="muted">Track {t.trackId ?? i}</span> <span className="mono">{handlerLabel(t.handler)} · {t.codec ?? '?'}{t.timescale ? ` · timescale ${t.timescale}` : ''}{t.width ? ` · ${t.width}×${t.height}` : ''}</span></div>
                ))}
                <div className="muted" style={{ fontSize: '0.72rem' }}>CMAF init segments carry one track — this is the probed rendition. Audio and other bitrates are separate objects; the full ladder is under Media checks.</div>
                <div><span className="muted">Protection</span> {init.cenc.isProtected
                  ? <span className="mono"><b>tenc</b> {init.cenc.scheme} · KID {init.cenc.defaultKid} · IV {init.cenc.perSampleIvSize}{init.cenc.hasConstantIv ? ' (constant)' : ''}</span>
                  : <span>clear (unencrypted)</span>}</div>
                {init.pssh.length > 0 && (
                  <div><span className="muted">PSSH</span> {init.pssh.map((p, i) => <span key={i} className="mono">{p.systemName ?? p.systemId}{p.kids.length ? ` [${p.kids.length} KID]` : ''}{i < init.pssh.length - 1 ? ' · ' : ''}</span>)}</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const ok = <span className="badge ok badge-sm">✓</span>;
const dash = <span className="muted">—</span>;
const unreachable = (status: number | null) => <span><span className="badge danger badge-sm">unreachable</span>{status != null && <span className="muted"> · HTTP {status}</span>}</span>;

function fmtAge(publishTime: string | null): string {
  if (!publishTime) return '';
  const t = Date.parse(publishTime);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

// Positive display of the manifest/fragment checks — so they read as "ran + green", not just an
// absence of findings. Shown per endpoint (manifests are fetched via every CDN).
function MediaChecks({ observations }: { observations: SaObservation[] }) {
  const withMedia = observations.filter((o) => o.media);
  if (withMedia.length === 0) {
    return <div className="notice info" style={{ marginTop: '1rem' }}>No manifest or media-fragment URLs configured for this profile, so only the init-segment / cross-CDN object checks ran. Add a DASH MPD and/or a sample fragment URL to the profile to enable manifest freshness, ladder and fragment-timeline checks.</div>;
  }
  return (
    <div className="matrix-wrap" style={{ marginTop: '1rem' }}>
      <h3 style={{ margin: '0 0 0.5rem' }}>Media checks <span className="muted">· DASH / HLS / fragment, per CDN</span></h3>
      <table className="matrix">
        <thead><tr><th>Endpoint</th><th>DASH manifest</th><th>Media fragment</th><th>HLS</th></tr></thead>
        <tbody>
          {withMedia.map((o) => {
            const m = o.media!;
            return (
              <tr key={o.endpointId}>
                <td>{o.endpointId}{o.role === 'reference' && <span className="badge neutral badge-sm" style={{ marginLeft: '0.3rem' }}>reference</span>}</td>
                <td>{!m.requested.dash ? dash : m.dash
                  ? <span>{ok} <span className="muted">{m.dash.presentation ?? 'static'}{m.dash.presentation === 'dynamic' && m.dash.publishTime ? ` · ${fmtAge(m.dash.publishTime)}` : ''} · {m.dash.bandwidths.length} rendition{m.dash.bandwidths.length === 1 ? '' : 's'}</span></span>
                  : unreachable(m.status.dash)}</td>
                <td>{!m.requested.fragment ? dash : m.fragment
                  ? (m.fragment.hasTimeline
                    ? <span>{ok} <span className="muted mono">seq {m.fragment.sequenceNumber ?? '?'} · dts {m.fragment.baseMediaDecodeTime ?? '?'}</span></span>
                    : <span className="muted">fetched · no <code>moof</code> (not a media fragment)</span>)
                  : unreachable(m.status.fragment)}</td>
                <td>{!m.requested.hls ? dash : m.hls ? ok : unreachable(m.status.hls)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const sevBadge = (s: string): string => (s === 'critical' || s === 'error' ? 'danger' : s === 'warning' ? 'warn' : 'neutral');
const stateBadge = (s: string): string => (s === 'active' ? 'danger' : s === 'acknowledged' ? 'neutral' : s === 'resolved' ? 'ok' : 'warn');
const cacheLabel = (t: string): string => (t === 'hit' ? 'HIT' : t === 'miss' ? 'MISS' : '—');

function ComparisonTable({ run }: { run: SaRun }) {
  const ref = run.observations.find((o) => o.role === 'reference');
  const refKid = ref?.kid ?? null;
  const kidDiffers = (o: SaObservation) => o.role !== 'reference' && o.kid != null && refKid != null && o.kid !== refKid;
  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead><tr><th>Endpoint</th><th>Provider</th><th>KID</th><th>Cache (edge / parent)</th><th>Origin</th><th>Last-Modified</th><th>Status</th></tr></thead>
        <tbody>
          {run.observations.map((o) => (
            <tr key={o.endpointId}>
              <td>{o.endpointId}{o.role === 'reference' && <span className="badge neutral badge-sm" style={{ marginLeft: '0.3rem' }}>reference</span>}</td>
              <td className="muted">{o.provider}</td>
              <td className={kidDiffers(o) ? 'danger mono sa-kid' : 'mono sa-kid'} title={o.kid ?? ''}>{o.kid ?? '—'}</td>
              <td className="mono">{cacheLabel(o.cdn.edge)} / {cacheLabel(o.cdn.parent)}{o.cdn.fetchedFromOrigin && <span className="muted"> · from origin</span>}</td>
              <td className="muted">{o.cdn.originIdentity ?? '—'}</td>
              <td className="muted">{o.lastModified ?? '—'}</td>
              <td>{o.error ? <span className="badge danger badge-sm">error</span> : o.reachable ? <span className="badge ok badge-sm">{o.httpStatus}</span> : <span className="badge danger badge-sm">unreachable</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Findings({ findings }: { findings: SaFinding[] }) {
  if (findings.length === 0) return <div className="notice ok"><span className="live-dot" /> No findings — endpoints are consistent.</div>;
  return (
    <div className="sa-findings">
      {findings.map((f, i) => (
        <div key={i} className={`sa-finding sa-sev-${f.severity}`}>
          <div className="sa-finding-head">
            <span className={`badge ${sevBadge(f.severity)}`}>{f.severity}</span>
            <strong>{f.classification}</strong>
            <span className="muted mono">{f.ruleId}</span>
            <span className="muted">· {f.provider} · likely {f.likelyLayer}</span>
          </div>
          <p className="sa-finding-explain">{f.explanation}</p>
          <p className="muted sa-finding-fix"><strong>Fix:</strong> {f.remediation}</p>
        </div>
      ))}
    </div>
  );
}

export function StreamAssurance() {
  const { hasPermission } = useAuth();
  const canRun = hasPermission('dns.explain.read');
  const canManage = hasPermission('connector.manage');
  const [profiles, setProfiles] = useState<SaProfileSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [run, setRun] = useState<SaRun | null>(null);
  const [alerts, setAlerts] = useState<SaAlert[]>([]);
  const [eventOn, setEventOn] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onCreated = (id: string) => {
    setCreating(false); setError(null);
    api.saProfiles().then((r) => { setProfiles(r.profiles); setSelected(id); }).catch(() => {});
  };

  const loadAlerts = (id: string) => api.saAlerts(id)
    .then((r) => { setAlerts(r.alerts); setEventOn(r.eventModeProfiles.includes(id)); })
    .catch(() => { setAlerts([]); setEventOn(false); });

  useEffect(() => {
    api.saProfiles()
      .then((r) => { setProfiles(r.profiles); if (r.profiles[0] && !selected) setSelected(r.profiles[0].id); })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load stream profiles.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) { setRun(null); setAlerts([]); return; }
    let active = true;
    api.saLatest(selected).then((r) => { if (active) setRun(r.run); }).catch(() => { if (active) setRun(null); });
    void loadAlerts(selected);
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const runNow = async () => {
    if (!selected) return;
    setRunning(true); setError(null);
    try { const r = await api.saRun(selected); setRun(r.run); await loadAlerts(selected); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Run failed.'); }
    finally { setRunning(false); }
  };

  const act = async (fn: () => Promise<unknown>, key: string) => {
    if (!selected) return;
    setBusy(key); setError(null);
    try { await fn(); await loadAlerts(selected); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Action failed.'); }
    finally { setBusy(null); }
  };
  const toggleEventMode = () => act(() => api.saEventMode(selected!, !eventOn, 30), 'event');

  const current = profiles?.find((p) => p.id === selected) ?? null;

  return (
    <section className="page">
      <header className="page-head">
        <h1>Stream Tests</h1>
        <div className="head-meta">
          <span className="muted">DASH / HLS / CMAF conformance · cross-CDN consistency</span>
          {canManage && !creating && <button className="btn" onClick={() => setCreating(true)}>New profile</button>}
        </div>
      </header>

      {error && <div className="notice danger">{error}</div>}

      {creating && (
        <div className="sa-detail" style={{ marginBottom: '1rem' }}>
          <div className="sa-detail-head"><h2 style={{ margin: 0 }}>New Stream Test profile</h2></div>
          <NewProfileForm onCreated={onCreated} onCancel={() => setCreating(false)} />
        </div>
      )}

      {!creating && profiles && profiles.length === 0 && (
        <div className="notice info">
          No Stream Test profiles configured yet.{' '}
          {canManage ? <button className="linklike" onClick={() => setCreating(true)}>Add one</button> : 'An Engineer can add one (channel + CDN endpoints).'}
        </div>
      )}

      {!creating && profiles && profiles.length > 0 && (
        <div className="sa-layout">
          <nav className="sa-profiles">
            {profiles.map((p) => (
              <button key={p.id} className={`sa-profile${selected === p.id ? ' active' : ''}`} onClick={() => setSelected(p.id)}>
                <span className="sa-profile-name">{p.name}</span>
                <span className="muted">{p.endpointCount} endpoints{p.tags.length ? ` · ${p.tags.join(', ')}` : ''}</span>
              </button>
            ))}
          </nav>

          <div className="sa-detail">
            {current && (
              <div className="sa-detail-head">
                <h2 style={{ margin: 0 }}>{current.name}</h2>
                <div className="sa-detail-actions">
                  {run && <span className="muted">last run {new Date(run.startedAt).toLocaleTimeString()} · {run.findingCount} finding{run.findingCount === 1 ? '' : 's'}</span>}
                  {eventOn && <span className="badge warn badge-sm">event mode</span>}
                  {canRun && <button className={`btn${eventOn ? ' active' : ''}`} onClick={toggleEventMode} disabled={busy === 'event'}>{eventOn ? 'Stop event mode' : 'Event mode'}</button>}
                  {canRun && <button className="btn" onClick={runNow} disabled={running}>{running ? 'Running…' : 'Run now'}</button>}
                </div>
              </div>
            )}

            {alerts.length > 0 && (
              <div className="sa-alerts">
                <h3 style={{ margin: '0 0 0.5rem' }}>Active alerts <span className="muted">· {alerts.length}</span></h3>
                {alerts.map((al) => (
                  <div key={al.id} className={`sa-finding sa-sev-${al.severity}`}>
                    <div className="sa-finding-head">
                      <span className={`badge ${stateBadge(al.state)}`}>{al.state}</span>
                      <strong>{al.classification}</strong>
                      <span className="muted mono">{al.ruleId} · {al.endpointId}</span>
                      <span className="muted">· seen ×{al.occurrences}</span>
                      {canRun && al.state !== 'acknowledged' && <button className="linklike" onClick={() => act(() => api.saAckAlert(al.id), al.id)} disabled={busy === al.id}>acknowledge</button>}
                      {canRun && <button className="linklike" onClick={() => act(() => api.saResolveAlert(al.id), al.id)} disabled={busy === al.id}>resolve</button>}
                    </div>
                    {al.explanation && <p className="sa-finding-explain">{al.explanation}</p>}
                  </div>
                ))}
              </div>
            )}

            {run ? (
              <>
                <ComparisonTable run={run} />
                <MediaChecks observations={run.observations} />
                <InitInspector observations={run.observations} />
                <HeaderInspector observations={run.observations} />
                <h3 style={{ marginTop: '1.25rem' }}>Findings</h3>
                <Findings findings={run.findings} />
              </>
            ) : (
              <div className="notice info">No run yet for this profile.{canRun ? ' Use “Run now” to check the endpoints.' : ''}</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
