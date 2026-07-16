// Integrations Token Management — Engineer-only settings for each integration's connection and
// service-account token. Tokens are WRITE-ONLY: they are never fetched or displayed. A token
// field starts blank; leaving it blank keeps the stored token, typing a value replaces it, and
// "Clear token" removes it. All persistence/encryption happens server-side.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type {
  ConnectorSettingsView, ConnectorSettingsUpdateRequest, ConnectorTestResult,
  CloudflareConnectionSettings, CloudflareConnectionUpdateRequest, CloudflareConnectionTestResult,
} from '../api/types';

export function ConnectorSettings() {
  return (
    <section className="page">
      <header className="page-head">
        <h1>Integrations Token Management</h1>
      </header>
      <p className="muted">Service-account tokens are write-only — stored encrypted server-side and never displayed. Leave a token field blank to keep the current token.</p>
      <CloudVisionConnectorForm />
      <CloudflareConnectorForm />
    </section>
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
