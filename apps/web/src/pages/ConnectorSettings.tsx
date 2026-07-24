// Integrations Token Management — Engineer-only settings for each integration's connection and
// service-account token. Tokens are WRITE-ONLY: they are never fetched or displayed. A token
// field starts blank; leaving it blank keeps the stored token, typing a value replaces it, and
// "Clear token" removes it. All persistence/encryption happens server-side.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type {
  ConnectorSettingsView, ConnectorSettingsUpdateRequest, ConnectorTestResult,
  CloudflareConnectionSettings, CloudflareConnectionUpdateRequest, CloudflareConnectionTestResult,
  FastlyConnection, FastlyConnectionUpdate, FastlyConnectionTestResult,
  AkamaiConnectionSettings, AkamaiConnectionUpdate, AkamaiConnectionTestResult,
  Ns1ConnectionSettings, Ns1ConnectionUpdate, Ns1ConnectionTestResult,
  BgpToolsConnection, BgpToolsConnectionUpdate, BgpToolsConnectionTest, MonitoredPrefixItem,
} from '../api/types';

export function ConnectorSettings() {
  return (
    <section className="page">
      <header className="page-head">
        <h1>Integrations Token Management</h1>
      </header>
      <p className="muted">Service-account tokens are write-only — stored encrypted server-side and never displayed. Leave a token field blank to keep the current token.</p>
      <Ns1ConnectorForm />
      <CloudVisionConnectorForm />
      <CloudflareConnectorForm />
      <FastlyConnectorForm />
      <AkamaiConnectorForm />
      <BgpToolsConnectorForm />
    </section>
  );
}

// ---- bgp.tools (external routing intelligence) ----------------------------------------------

function BgpToolsConnectorForm() {
  const [view, setView] = useState<BgpToolsConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<BgpToolsConnectionTest | null>(null);

  // Editable form state (the Prometheus URL is write-only — never populated from the server).
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<'mock' | 'live'>('mock');
  const [tableEnabled, setTableEnabled] = useState(false);
  const [userAgent, setUserAgent] = useState('');
  const [prometheusUrl, setPrometheusUrl] = useState('');
  const [clearUrl, setClearUrl] = useState(false);

  // Monitored watch list.
  const [prefixes, setPrefixes] = useState<MonitoredPrefixItem[]>([]);
  const [newPrefix, setNewPrefix] = useState('');
  const [newAsn, setNewAsn] = useState('');
  const [newFamily, setNewFamily] = useState<'ipv4' | 'ipv6'>('ipv4');
  const [newDesc, setNewDesc] = useState('');

  const hydrate = (v: BgpToolsConnection) => {
    setView(v);
    setEnabled(v.enabled);
    setMode(v.mode);
    setTableEnabled(v.tableEnabled);
    setUserAgent(v.userAgent ?? '');
    setPrometheusUrl('');
    setClearUrl(false);
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      hydrate((await api.routingConnection()).settings);
      setPrefixes((await api.routingMonitored()).items);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to load bgp.tools settings.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void loadAll(); }, [loadAll]);

  const save = async () => {
    setError(null);
    setSaved(false);
    const body: BgpToolsConnectionUpdate = { enabled, mode, tableEnabled };
    if (userAgent.trim().length > 0) body.userAgent = userAgent.trim();
    if (clearUrl) body.clearPrometheusUrl = true;
    else if (prometheusUrl.trim().length > 0) body.prometheusUrl = prometheusUrl.trim();
    try {
      hydrate((await api.routingConnectionUpdate(body)).settings);
      setSaved(true);
      setTestResult(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Save failed.');
    }
  };

  const runTest = async () => {
    setTestResult(null);
    setError(null);
    try {
      setTestResult((await api.routingConnectionTest()).result);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Test failed.');
    }
  };

  const addPrefix = async () => {
    setError(null);
    const asn = Number(newAsn);
    if (!newPrefix.trim() || !Number.isInteger(asn) || asn <= 0) { setError('A prefix and a positive expected-origin ASN are required.'); return; }
    try {
      await api.routingMonitoredUpsert({ prefix: newPrefix.trim(), addressFamily: newFamily, expectedOriginAsn: asn, description: newDesc.trim() || undefined });
      setNewPrefix(''); setNewAsn(''); setNewDesc('');
      setPrefixes((await api.routingMonitored()).items);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not add the prefix.');
    }
  };
  const removePrefix = async (prefix: string) => {
    try {
      await api.routingMonitoredDelete(prefix);
      setPrefixes((await api.routingMonitored()).items);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not remove the prefix.');
    }
  };

  return (
    <div className="connector-section">
      <div className="section-head">
        <h2>bgp.tools (routing intelligence)</h2>
        {view && <span className={`badge ${view.source === 'database' ? 'info' : 'neutral'}`}>{view.source === 'database' ? 'managed here' : 'from environment'}</span>}
      </div>
      {loading ? <div className="center-note">Loading…</div> : (
        <>
          {view && !view.masterKeyAvailable && (
            <div className="notice warn">No master key is available (<code>/run/secrets/radar_master_key</code>). You can edit non-secret settings, but the Prometheus URL cannot be stored until the master key is provisioned.</div>
          )}
          {view?.degraded && <div className="notice warn">{view.degraded}</div>}
          {error && <div className="notice danger">{error}</div>}
          {saved && <div className="notice ok">Saved. The connector was reconfigured.</div>}

          <div className="card">
            <div className="field-row"><label className="switch"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label></div>
            <label className="field"><span>Mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'mock' | 'live')}>
                <option value="mock">mock (synthetic, no credentials)</option>
                <option value="live">live (bgp.tools)</option>
              </select>
            </label>
            <label className="field"><span>User-Agent (contact email) {mode === 'live' && view && !view.userAgentValid && <span className="badge warn badge-sm">required for live</span>}</span>
              <input value={userAgent} onChange={(e) => setUserAgent(e.target.value)} placeholder="RADAR bgp.tools - noc@rte.ie" />
            </label>
            <p className="muted field-hint">bgp.tools blocks generic User-Agents — set an app name plus a contact email (required for live mode).</p>
            <label className="field"><span>Prometheus monitoring URL {view?.prometheusUrlConfigured && <span className="badge ok badge-sm">configured</span>}</span>
              <input type="password" autoComplete="off" value={prometheusUrl} disabled={clearUrl} onChange={(e) => setPrometheusUrl(e.target.value)}
                placeholder={view?.prometheusUrlConfigured ? `•••• configured (${view.prometheusHost ?? 'set'}) — leave blank to keep` : 'https://prometheus.bgp.tools/prom/<your-uuid>'} />
            </label>
            <p className="muted field-hint">The whole URL (including the UUID) is your credential — stored encrypted, never displayed. Set an identifying <code>BGPTOOLS_USER_AGENT</code> with a contact email in the environment for live mode.</p>
            {view?.prometheusUrlConfigured && (
              <div className="field-row"><label className="switch"><input type="checkbox" checked={clearUrl} onChange={(e) => setClearUrl(e.target.checked)} /> Clear the stored URL</label></div>
            )}
            <div className="field-row"><label className="switch"><input type="checkbox" checked={tableEnabled} onChange={(e) => setTableEnabled(e.target.checked)} /> Also poll table.jsonl (foreign-origin / hijack detection)</label></div>
            <div className="actions">
              <button className="btn primary" onClick={() => void save()}>Save</button>
              <button className="btn" onClick={() => void runTest()}>Test connection</button>
            </div>
          </div>

          {testResult && (
            <div className={`notice ${testResult.ok ? 'ok' : 'danger'}`}>
              {testResult.ok ? `Connection OK (${testResult.source})${testResult.summary ? ` — ${testResult.summary}` : ''}.` : `Connection failed (${testResult.source})${testResult.error ? `: ${testResult.error}` : ''}.`}
            </div>
          )}

          {view && (
            <div className="card">
              <div className="kv"><span>Prometheus URL configured</span><span>{view.prometheusUrlConfigured ? 'yes' : 'no'}</span></div>
              <div className="kv"><span>Host</span><span>{view.prometheusHost ?? '—'}</span></div>
              <div className="kv"><span>URL set at</span><span>{view.prometheusUrlSetAt ?? '—'}</span></div>
              <div className="kv"><span>Monitored prefixes</span><span>{view.monitoredPrefixCount}</span></div>
              <div className="kv"><span>Master key available</span><span>{view.masterKeyAvailable ? 'yes' : 'no'}</span></div>
            </div>
          )}

          {/* Monitored watch list */}
          <h3>Monitored prefixes</h3>
          <div className="matrix-wrap">
            <table className="matrix">
              <thead><tr><th>Prefix</th><th>AF</th><th>Expected origin</th><th>Description</th><th></th></tr></thead>
              <tbody>
                {prefixes.length === 0 && <tr><td colSpan={5} className="center-note">No prefixes monitored yet.</td></tr>}
                {prefixes.map((p) => (
                  <tr key={p.prefix}>
                    <td>{p.prefix}</td>
                    <td className="muted">{p.addressFamily === 'ipv6' ? 'v6' : 'v4'}</td>
                    <td>AS{p.expectedOriginAsn}</td>
                    <td className="muted">{p.description ?? '—'}</td>
                    <td><button className="btn danger btn-sm" onClick={() => void removePrefix(p.prefix)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <div className="field-inline-row">
              <label className="field"><span>Prefix</span><input value={newPrefix} onChange={(e) => setNewPrefix(e.target.value)} placeholder="89.207.56.0/21" /></label>
              <label className="field"><span>Family</span>
                <select value={newFamily} onChange={(e) => setNewFamily(e.target.value as 'ipv4' | 'ipv6')}><option value="ipv4">IPv4</option><option value="ipv6">IPv6</option></select>
              </label>
              <label className="field"><span>Expected origin ASN</span><input value={newAsn} onChange={(e) => setNewAsn(e.target.value)} placeholder="41073" /></label>
              <label className="field"><span>Description</span><input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="optional" /></label>
              <button className="btn primary" onClick={() => void addPrefix()}>Add</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---- CloudVision (network telemetry) --------------------------------------------------------

function CloudVisionConnectorForm() {
  const [view, setView] = useState<ConnectorSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<ConnectorTestResult | null>(null);

  // Editable form state (token is write-only — never populated from the server).
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<'mock' | 'live'>('mock');
  const [endpoint, setEndpoint] = useState('');
  const [verifyTls, setVerifyTls] = useState(true);
  const [deviceIds, setDeviceIds] = useState('');
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);

  const hydrate = useCallback((s: ConnectorSettingsView) => {
    setView(s);
    setEnabled(s.enabled);
    setMode(s.mode);
    setEndpoint(s.endpoint ?? '');
    setVerifyTls(s.verifyTls);
    setDeviceIds(s.edgeDeviceIds.join(', '));
    setToken('');
    setClearToken(false);
  }, []);

  const load = useCallback(async () => {
    try {
      hydrate((await api.networkConnection()).settings);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to load CloudVision settings.');
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaved(false);
    setError(null);
    const body: ConnectorSettingsUpdateRequest = {
      enabled,
      mode,
      endpoint: endpoint.trim() || null,
      verifyTls,
      edgeDeviceIds: deviceIds.split(',').map((s) => s.trim()).filter(Boolean),
    };
    if (clearToken) body.clearToken = true;
    else if (token.trim().length > 0) body.token = token.trim();
    try {
      hydrate((await api.networkConnectionUpdate(body)).settings);
      setSaved(true);
      setTestResult(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to save.');
    }
  };

  const runTest = async () => {
    setTestResult(null);
    setError(null);
    try {
      setTestResult((await api.networkConnectionTest()).result);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Test failed.');
    }
  };

  return (
    <div className="connector-section">
      <div className="section-head">
        <h2>CloudVision (network telemetry)</h2>
        {view && <span className={`badge ${view.source === 'database' ? 'info' : 'neutral'}`}>{view.source === 'database' ? 'managed here' : 'from environment'}</span>}
      </div>
      {loading ? <div className="center-note">Loading…</div> : (
        <>
          {view && !view.masterKeyAvailable && (
            <div className="notice warn">No master key is available (<code>/run/secrets/radar_master_key</code>). You can edit non-secret settings, but a token cannot be stored until the master key is provisioned.</div>
          )}
          {view?.degraded && <div className="notice warn">{view.degraded}</div>}
          {error && <div className="notice danger">{error}</div>}
          {saved && <div className="notice ok">Saved. The connector was reconfigured.</div>}

          <div className="card">
            <div className="field-row"><label className="switch"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label></div>
            <label className="field"><span>Mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'mock' | 'live')}>
                <option value="mock">mock (synthetic, no credentials)</option>
                <option value="live">live (CloudVision)</option>
              </select>
            </label>
            <label className="field"><span>Endpoint</span><input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://www.arista.io" /></label>
            <div className="field-row"><label className="switch"><input type="checkbox" checked={verifyTls} onChange={(e) => setVerifyTls(e.target.checked)} /> Verify TLS</label></div>
            <label className="field"><span>Edge device IDs</span><input value={deviceIds} onChange={(e) => setDeviceIds(e.target.value)} placeholder="JPExxxxxxx1, JPExxxxxxx2" /></label>
            <label className="field"><span>Service-account token {view?.tokenConfigured && <span className="badge ok badge-sm">configured</span>}</span>
              <input type="password" autoComplete="off" value={token} disabled={clearToken} onChange={(e) => setToken(e.target.value)}
                placeholder={view?.tokenConfigured ? '•••••••• configured — leave blank to keep' : 'not configured'} />
            </label>
            {view?.tokenConfigured && (
              <div className="field-row"><label className="switch"><input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} /> Clear the stored token</label></div>
            )}
            <div className="actions">
              <button className="btn primary" onClick={() => void save()}>Save</button>
              <button className="btn" onClick={() => void runTest()}>Test connection</button>
            </div>
          </div>

          {testResult && (
            <div className={`notice ${testResult.ok ? 'ok' : 'danger'}`}>
              {testResult.ok
                ? `Connection OK (${testResult.source}) — ${testResult.summary?.devices ?? 0} devices, ${testResult.summary?.interfaces ?? 0} interfaces, freshness ${testResult.summary?.freshness}.`
                : `Connection failed (${testResult.source})${testResult.error ? `: ${testResult.error}` : ''}.`}
            </div>
          )}

          {view && (
            <div className="card">
              <div className="kv"><span>Token configured</span><span>{view.tokenConfigured ? 'yes' : 'no'}</span></div>
              <div className="kv"><span>Token set at</span><span>{view.tokenSetAt ?? '—'}</span></div>
              <div className="kv"><span>Last updated by</span><span>{view.updatedBy ?? '—'}</span></div>
              <div className="kv"><span>Master key available</span><span>{view.masterKeyAvailable ? 'yes' : 'no'}</span></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- Cloudflare (Réalta cache load balancing) -----------------------------------------------

function CloudflareConnectorForm() {
  const [view, setView] = useState<CloudflareConnectionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<CloudflareConnectionTestResult | null>(null);

  // Editable form state (token is write-only — never populated from the server).
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<'mock' | 'live'>('mock');
  const [accountId, setAccountId] = useState('');
  const [zones, setZones] = useState('');
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);

  const hydrate = useCallback((s: CloudflareConnectionSettings) => {
    setView(s);
    setEnabled(s.enabled);
    setMode(s.mode);
    setAccountId(s.accountId ?? '');
    setZones(s.zones.join(', '));
    setToken('');
    setClearToken(false);
  }, []);

  const load = useCallback(async () => {
    try {
      hydrate((await api.cloudflareConnection()).settings);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to load Cloudflare settings.');
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaved(false);
    setError(null);
    const body: CloudflareConnectionUpdateRequest = {
      enabled,
      mode,
      accountId: accountId.trim() || null,
      zones: zones.split(',').map((s) => s.trim()).filter(Boolean),
    };
    if (clearToken) body.clearToken = true;
    else if (token.trim().length > 0) body.token = token.trim();
    try {
      hydrate((await api.cloudflareConnectionUpdate(body)).settings);
      setSaved(true);
      setTestResult(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to save.');
    }
  };

  const runTest = async () => {
    setTestResult(null);
    setError(null);
    try {
      setTestResult((await api.cloudflareConnectionTest()).result);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Test failed.');
    }
  };

  return (
    <div className="connector-section">
      <div className="section-head">
        <h2>Cloudflare (Réalta cache load balancing)</h2>
        {view && <span className={`badge ${view.source === 'database' ? 'info' : 'neutral'}`}>{view.source === 'database' ? 'managed here' : 'from environment'}</span>}
      </div>
      {loading ? <div className="center-note">Loading…</div> : (
        <>
          {view && !view.masterKeyAvailable && (
            <div className="notice warn">No master key is available (<code>/run/secrets/radar_master_key</code>). You can edit non-secret settings, but a token cannot be stored until the master key is provisioned.</div>
          )}
          {view?.degraded && <div className="notice warn">{view.degraded}</div>}
          {error && <div className="notice danger">{error}</div>}
          {saved && <div className="notice ok">Saved. The connector was reconfigured.</div>}

          <div className="card">
            <div className="field-row"><label className="switch"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label></div>
            <label className="field"><span>Mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'mock' | 'live')}>
                <option value="mock">mock (synthetic, no credentials)</option>
                <option value="live">live (Cloudflare)</option>
              </select>
            </label>
            <label className="field"><span>Account ID</span><input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="0dae703e9ae3c6b11a561818549a4192" /></label>
            <label className="field"><span>Zones <span className="muted">(comma-separated; blank = all)</span></span><input value={zones} onChange={(e) => setZones(e.target.value)} placeholder="rte.ie, rasset.ie, rte.host" /></label>
            <label className="field"><span>API token {view?.tokenConfigured && <span className="badge ok badge-sm">configured</span>}</span>
              <input type="password" autoComplete="off" value={token} disabled={clearToken} onChange={(e) => setToken(e.target.value)}
                placeholder={view?.tokenConfigured ? '•••••••• configured — leave blank to keep' : 'not configured'} />
            </label>
            {view?.tokenConfigured && (
              <div className="field-row"><label className="switch"><input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} /> Clear the stored token</label></div>
            )}
            <div className="actions">
              <button className="btn primary" onClick={() => void save()}>Save</button>
              <button className="btn" onClick={() => void runTest()}>Test connection</button>
            </div>
          </div>

          {testResult && (
            <div className={`notice ${testResult.ok ? 'ok' : 'danger'}`}>
              {testResult.ok
                ? `Connection OK (${testResult.source}) — ${testResult.summary?.loadBalancers ?? 0} load balancers, ${testResult.summary?.pools ?? 0} pools, ${testResult.summary?.origins ?? 0} origins.`
                : `Connection failed (${testResult.source})${testResult.error ? `: ${testResult.error}` : ''}.`}
            </div>
          )}

          {view && (
            <div className="card">
              <div className="kv"><span>Token configured</span><span>{view.tokenConfigured ? 'yes' : 'no'}</span></div>
              <div className="kv"><span>Token set at</span><span>{view.tokenSetAt ?? '—'}</span></div>
              <div className="kv"><span>Last updated by</span><span>{view.updatedBy ?? '—'}</span></div>
              <div className="kv"><span>Master key available</span><span>{view.masterKeyAvailable ? 'yes' : 'no'}</span></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- Fastly (commercial CDN observability) --------------------------------------------------

function FastlyConnectorForm() {
  const [view, setView] = useState<FastlyConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<FastlyConnectionTestResult | null>(null);

  // Editable form state (token is write-only — never populated from the server).
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<'mock' | 'live'>('mock');
  const [apiBase, setApiBase] = useState('');
  const [serviceIds, setServiceIds] = useState('');
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);

  const hydrate = useCallback((s: FastlyConnection) => {
    setView(s);
    setEnabled(s.enabled);
    setMode(s.mode);
    setApiBase(s.apiBase ?? '');
    setServiceIds(s.serviceIds.join(', '));
    setToken('');
    setClearToken(false);
  }, []);

  const load = useCallback(async () => {
    try {
      hydrate((await api.fastlyConnection()).settings);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to load Fastly settings.');
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaved(false);
    setError(null);
    const body: FastlyConnectionUpdate = {
      enabled,
      mode,
      apiBase: apiBase.trim() || null,
      serviceIds: serviceIds.split(',').map((s) => s.trim()).filter(Boolean),
    };
    if (clearToken) body.clearToken = true;
    else if (token.trim().length > 0) body.token = token.trim();
    try {
      hydrate((await api.fastlyConnectionUpdate(body)).settings);
      setSaved(true);
      setTestResult(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to save.');
    }
  };

  const runTest = async () => {
    setTestResult(null);
    setError(null);
    try {
      setTestResult((await api.fastlyConnectionTest()).result);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Test failed.');
    }
  };

  return (
    <div className="connector-section">
      <div className="section-head">
        <h2>Fastly (commercial CDN)</h2>
        {view && <span className={`badge ${view.source === 'database' ? 'info' : 'neutral'}`}>{view.source === 'database' ? 'managed here' : 'from environment'}</span>}
      </div>
      {loading ? <div className="center-note">Loading…</div> : (
        <>
          {view && !view.masterKeyAvailable && (
            <div className="notice warn">No master key is available (<code>/run/secrets/radar_master_key</code>). You can edit non-secret settings, but a token cannot be stored until the master key is provisioned — an environment token (<code>FASTLY_API_TOKEN</code>) still drives the connector.</div>
          )}
          {view?.degraded && <div className="notice warn">{view.degraded}</div>}
          {error && <div className="notice danger">{error}</div>}
          {saved && <div className="notice ok">Saved. The connector was reconfigured.</div>}

          <div className="card">
            <div className="field-row"><label className="switch"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label></div>
            <label className="field"><span>Mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'mock' | 'live')}>
                <option value="mock">mock (synthetic, no credentials)</option>
                <option value="live">live (Fastly)</option>
              </select>
            </label>
            <label className="field"><span>API base <span className="muted">(optional; blank = https://api.fastly.com)</span></span><input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://api.fastly.com" /></label>
            <label className="field"><span>Service IDs <span className="muted">(comma-separated; blank = all)</span></span><input value={serviceIds} onChange={(e) => setServiceIds(e.target.value)} placeholder="SU1z2x…, SU9a8b…" /></label>
            <label className="field"><span>API token <span className="muted">(read-only, global:read)</span> {view?.tokenConfigured && <span className="badge ok badge-sm">configured</span>}</span>
              <input type="password" autoComplete="off" value={token} disabled={clearToken} onChange={(e) => setToken(e.target.value)}
                placeholder={view?.tokenConfigured ? '•••••••• configured — leave blank to keep' : 'not configured'} />
            </label>
            {view?.tokenConfigured && (
              <div className="field-row"><label className="switch"><input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} /> Clear the stored token</label></div>
            )}
            <div className="actions">
              <button className="btn primary" onClick={() => void save()}>Save</button>
              <button className="btn" onClick={() => void runTest()}>Test connection</button>
            </div>
          </div>

          {testResult && (
            <div className={`notice ${testResult.ok ? 'ok' : 'danger'}`}>
              {testResult.ok
                ? `Connection OK (${testResult.source}) — ${testResult.summary?.services ?? 0} services.`
                : `Connection failed (${testResult.source})${testResult.error ? `: ${testResult.error}` : ''}.`}
            </div>
          )}

          {view && (
            <div className="card">
              <div className="kv"><span>Token configured</span><span>{view.tokenConfigured ? 'yes' : 'no'}</span></div>
              <div className="kv"><span>Token set at</span><span>{view.tokenSetAt ?? '—'}</span></div>
              <div className="kv"><span>Last updated by</span><span>{view.updatedBy ?? '—'}</span></div>
              <div className="kv"><span>Master key available</span><span>{view.masterKeyAvailable ? 'yes' : 'no'}</span></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- Akamai (commercial CDN via DataStream 2 → S3) ------------------------------------------

const namesToText = (r: Record<string, string>): string => Object.entries(r).map(([k, v]) => `${k}=${v}`).join(', ');
function textToNames(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

function AkamaiConnectorForm() {
  const [view, setView] = useState<AkamaiConnectionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<AkamaiConnectionTestResult | null>(null);

  // Editable form state (the S3 secret is write-only — never populated from the server).
  const [enabled, setEnabled] = useState(false);
  const [cpCodes, setCpCodes] = useState('');
  const [cpNames, setCpNames] = useState('');
  const [bucket, setBucket] = useState('');
  const [region, setRegion] = useState('');
  const [prefix, setPrefix] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [pollInterval, setPollInterval] = useState('30');
  const [secretKey, setSecretKey] = useState('');
  const [clearSecret, setClearSecret] = useState(false);

  const hydrate = useCallback((s: AkamaiConnectionSettings) => {
    setView(s);
    setEnabled(s.enabled);
    setCpCodes(s.cpCodes.join(', '));
    setCpNames(namesToText(s.cpNames));
    setBucket(s.s3.bucket);
    setRegion(s.s3.region);
    setPrefix(s.s3.prefix);
    setAccessKeyId(s.s3.accessKeyId);
    setPollInterval(String(s.s3.pollIntervalSeconds));
    setSecretKey('');
    setClearSecret(false);
  }, []);

  const load = useCallback(async () => {
    try {
      hydrate((await api.akamaiConnection()).settings);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to load Akamai settings.');
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaved(false);
    setError(null);
    const body: AkamaiConnectionUpdate = {
      enabled,
      cpCodes: cpCodes.split(',').map((s) => s.trim()).filter(Boolean),
      cpNames: textToNames(cpNames),
      bucket: bucket.trim() || null,
      region: region.trim() || null,
      prefix: prefix.trim() || null,
      accessKeyId: accessKeyId.trim() || null,
      pollIntervalSeconds: Number(pollInterval) || null,
    };
    if (clearSecret) body.clearSecret = true;
    else if (secretKey.trim().length > 0) body.secretKey = secretKey.trim();
    try {
      hydrate((await api.akamaiConnectionUpdate(body)).settings);
      setSaved(true);
      setTestResult(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to save.');
    }
  };

  const runTest = async () => {
    setTestResult(null);
    setError(null);
    try {
      setTestResult((await api.akamaiConnectionTest()).result);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Test failed.');
    }
  };

  return (
    <div className="connector-section">
      <div className="section-head">
        <h2>Akamai (DataStream 2 → S3)</h2>
        {view && <span className={`badge ${view.connected ? 'ok' : 'neutral'}`}>{view.connected ? 'connected' : 'not connected'}</span>}
      </div>
      <p className="muted">RADAR pulls Akamai DataStream 2 edge-log objects from an S3 bucket and aggregates them into per-CP-code telemetry. The stream itself is created in Akamai Control Center (destination = this bucket); RADAR needs read-only S3 credentials.</p>
      {loading ? <div className="center-note">Loading…</div> : (
        <>
          {view && !view.masterKeyAvailable && (
            <div className="notice warn">No master key is available (<code>/run/secrets/radar_master_key</code>). You can edit non-secret settings, but the S3 secret key cannot be stored until the master key is provisioned — an environment secret (<code>AKAMAI_S3_SECRET_KEY</code>) still drives the connector.</div>
          )}
          {view?.degraded && <div className="notice warn">{view.degraded}</div>}
          {error && <div className="notice danger">{error}</div>}
          {saved && <div className="notice ok">Saved. The connector was reconfigured.</div>}

          <div className="card">
            <div className="field-row"><label className="switch"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label></div>
            <label className="field"><span>CP codes <span className="muted">(comma-separated; blank = all seen)</span></span><input value={cpCodes} onChange={(e) => setCpCodes(e.target.value)} placeholder="1629049, 1629053" /></label>
            <label className="field"><span>CP code names <span className="muted">(code=Name, comma-separated)</span></span><input value={cpNames} onChange={(e) => setCpNames(e.target.value)} placeholder="1629049=LIVE.RTE.IE" /></label>
            <label className="field"><span>S3 bucket</span><input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="rte-akamai-ds2" /></label>
            <label className="field"><span>S3 region</span><input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="eu-west-1" /></label>
            <label className="field"><span>S3 prefix <span className="muted">(optional)</span></span><input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="datastream/" /></label>
            <label className="field"><span>S3 access key ID</span><input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} placeholder="AKIA…" /></label>
            <label className="field"><span>S3 secret access key <span className="muted">(write-only)</span> {view?.secretConfigured && <span className="badge ok badge-sm">configured</span>}</span>
              <input type="password" autoComplete="off" value={secretKey} disabled={clearSecret} onChange={(e) => setSecretKey(e.target.value)}
                placeholder={view?.secretConfigured ? '•••••••• configured — leave blank to keep' : 'not configured'} />
            </label>
            <label className="field"><span>Poll interval (seconds)</span><input type="number" min={5} max={3600} value={pollInterval} onChange={(e) => setPollInterval(e.target.value)} /></label>
            {view?.secretConfigured && (
              <div className="field-row"><label className="switch"><input type="checkbox" checked={clearSecret} onChange={(e) => setClearSecret(e.target.checked)} /> Clear the stored secret</label></div>
            )}
            <div className="actions">
              <button className="btn primary" onClick={() => void save()}>Save</button>
              <button className="btn" onClick={() => void runTest()}>Test connection</button>
            </div>
          </div>

          {testResult && (
            <div className={`notice ${testResult.ok ? 'ok' : 'danger'}`}>
              {testResult.ok
                ? `S3 connection OK — listed ${testResult.summary?.objects ?? 0} object(s).`
                : `S3 connection failed${testResult.error ? `: ${testResult.error}` : ''}.`}
            </div>
          )}

          {view && (
            <div className="card">
              <div className="kv"><span>S3 secret configured</span><span>{view.secretConfigured ? 'yes' : 'no'}</span></div>
              <div className="kv"><span>Secret set at</span><span>{view.secretSetAt ?? '—'}</span></div>
              <div className="kv"><span>Last updated by</span><span>{view.updatedBy ?? '—'}</span></div>
              <div className="kv"><span>Connected</span><span>{view.connected ? 'yes' : 'no'}</span></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- NS1 (the core steering source) ---------------------------------------------------------

function Ns1ConnectorForm() {
  const [view, setView] = useState<Ns1ConnectionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<Ns1ConnectionTestResult | null>(null);

  // Editable form state (the key is write-only — never populated from the server).
  const [mode, setMode] = useState<'mock' | 'live'>('mock');
  const [apiBase, setApiBase] = useState('');
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [writeKey, setWriteKey] = useState('');
  const [clearWriteKey, setClearWriteKey] = useState(false);

  const hydrate = useCallback((s: Ns1ConnectionSettings) => {
    setView(s);
    setMode(s.mode);
    setApiBase(s.apiBase);
    setKey('');
    setClearKey(false);
    setWriteKey('');
    setClearWriteKey(false);
  }, []);

  const load = useCallback(async () => {
    try {
      hydrate((await api.ns1Connection()).settings);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to load NS1 settings.');
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaved(false);
    setError(null);
    const body: Ns1ConnectionUpdate = { mode, apiBase: apiBase.trim() || null };
    if (clearKey) body.clearKey = true;
    else if (key.trim().length > 0) body.key = key.trim();
    if (clearWriteKey) body.clearWriteKey = true;
    else if (writeKey.trim().length > 0) body.writeKey = writeKey.trim();
    try {
      hydrate((await api.ns1ConnectionUpdate(body)).settings);
      setSaved(true);
      setTestResult(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to save.');
    }
  };

  const runTest = async () => {
    setTestResult(null);
    setError(null);
    try {
      setTestResult((await api.ns1ConnectionTest()).result);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Test failed.');
    }
  };

  return (
    <div className="connector-section">
      <div className="section-head">
        <h2>NS1 (steering source)</h2>
        {view && <span className={`badge ${view.live ? 'ok' : 'neutral'}`}>{view.live ? 'LIVE' : 'MOCK'}</span>}
      </div>
      <p className="muted">RADAR reads IBM NS1 Connect configuration read-only to explain steering. Live mode needs a <strong>read-only</strong> NS1 API key with view access to the zones you want explained. A separate, optional <strong>write key</strong> powers the guarded create/clone-record path (test zone only).</p>
      {loading ? <div className="center-note">Loading…</div> : (
        <>
          {view && !view.masterKeyAvailable && (
            <div className="notice warn">No master key is available (<code>/run/secrets/radar_master_key</code>). You can edit non-secret settings, but the NS1 key cannot be stored until the master key is provisioned — an environment key (<code>NS1_API_KEY</code> + <code>RADAR_MODE=live</code>) still drives the connector.</div>
          )}
          {view?.degraded && <div className="notice warn">{view.degraded}</div>}
          {error && <div className="notice danger">{error}</div>}
          {saved && <div className="notice ok">Saved. The NS1 client was reconfigured.</div>}

          <div className="card">
            <label className="field"><span>Mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'mock' | 'live')}>
                <option value="mock">mock (fixtures, no credential)</option>
                <option value="live">live (NS1)</option>
              </select>
            </label>
            <label className="field"><span>API base <span className="muted">(blank = https://api.nsone.net/v1)</span></span><input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://api.nsone.net/v1" /></label>
            <label className="field"><span>Read-only API key <span className="muted">(write-only)</span> {view?.keyConfigured && <span className="badge ok badge-sm">configured</span>}</span>
              <input type="password" autoComplete="off" value={key} disabled={clearKey} onChange={(e) => setKey(e.target.value)}
                placeholder={view?.keyConfigured ? '•••••••• configured — leave blank to keep' : 'not configured'} />
            </label>
            {view?.keyConfigured && (
              <div className="field-row"><label className="switch"><input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> Clear the stored key</label></div>
            )}
            <label className="field"><span>Write key <span className="muted">(write-only — create/clone path)</span> {view?.writeKeyConfigured && <span className="badge ok badge-sm">configured</span>}</span>
              <input type="password" autoComplete="off" value={writeKey} disabled={clearWriteKey} onChange={(e) => setWriteKey(e.target.value)}
                placeholder={view?.writeKeyConfigured ? '•••••••• configured — leave blank to keep' : 'not configured (optional)'} />
            </label>
            {view && (
              <div className="muted" style={{ fontSize: '0.78rem', marginTop: '-0.2rem', marginBottom: '0.5rem' }}>
                Write path: <span className={`badge badge-sm ${view.writeEnabled ? (view.writeLive ? 'ok' : 'warn') : 'neutral'}`}>{view.writeEnabled ? (view.writeLive ? 'LIVE' : 'enabled · needs key + live mode') : 'disabled (NS1_WRITE_ENABLED off)'}</span>
                {view.writeAllow.length > 0 && <> · allow-list: {view.writeAllow.map((a) => <span key={a} className="chip mono" style={{ marginRight: '0.25rem' }}>{a}</span>)}</>}
              </div>
            )}
            {view?.writeKeyConfigured && (
              <div className="field-row"><label className="switch"><input type="checkbox" checked={clearWriteKey} onChange={(e) => setClearWriteKey(e.target.checked)} /> Clear the stored write key</label></div>
            )}
            <div className="actions">
              <button className="btn primary" onClick={() => void save()}>Save</button>
              <button className="btn" onClick={() => void runTest()}>Test connection</button>
            </div>
          </div>

          {testResult && (
            <div className={`notice ${testResult.ok ? 'ok' : 'danger'}`}>
              {testResult.ok
                ? `Connection OK (${testResult.source}) — ${testResult.summary?.zones ?? 0} zones visible.`
                : `Connection failed (${testResult.source})${testResult.error ? `: ${testResult.error}` : ''}.`}
            </div>
          )}

          {view && (
            <div className="card">
              <div className="kv"><span>Read key configured</span><span>{view.keyConfigured ? 'yes' : 'no'}</span></div>
              <div className="kv"><span>Read key set at</span><span>{view.keySetAt ?? '—'}</span></div>
              <div className="kv"><span>Write key configured</span><span>{view.writeKeyConfigured ? 'yes' : 'no'}</span></div>
              <div className="kv"><span>Write key set at</span><span>{view.writeKeySetAt ?? '—'}</span></div>
              <div className="kv"><span>Write path</span><span>{view.writeEnabled ? (view.writeLive ? 'live' : 'enabled (needs key + live)') : 'disabled'}</span></div>
              <div className="kv"><span>Last updated by</span><span>{view.updatedBy ?? '—'}</span></div>
              <div className="kv"><span>Effective</span><span>{view.live ? 'live' : 'mock'}</span></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
