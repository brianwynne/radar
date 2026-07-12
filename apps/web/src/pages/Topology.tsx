// Delivery Topology — a role-aware, RADAR-CONFIGURED view of the delivery architecture.
// It makes the responsibility boundary explicit: NS1 selects the delivery PLATFORM;
// Cloudflare then selects the Réalta ORIGIN POOL. NS1 never selects a cache/pool. All
// capacity/target values are configured/manually-maintained, never live telemetry.
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { CAPACITY, NETWORK_PATHS, PLATFORMS, REALTA_CHAIN } from '../topology/model';
import { useNetworkPaths } from '../telemetry/use-network-paths';
import { useCacheTelemetry } from '../telemetry/use-cache-telemetry';
import { NetworkPathTelemetryTable } from '../telemetry/NetworkPathTelemetry';
import { CacheNodeTable, CachePoolTable, OriginPanel } from '../telemetry/CacheTelemetry';

function Node({ label, cat, className }: { label: string; cat: string; className: string }) {
  return (
    <div className={`node ${className}`}>
      <span className="cat">{cat}</span>
      {label}
    </div>
  );
}

function Diagram({ zoom }: { zoom: number }) {
  const pools = REALTA_CHAIN.slice(2, 6); // Donnybrook 1/2, External 1/2
  return (
    <div className="topo-canvas">
      <div className="topo-scale" style={{ transform: `scale(${zoom})` }}>
        <div className="topo-section" data-testid="topology-steering">
          <h4>Platform steering (NS1)</h4>
          <div className="flow-row">
            <Node label="DNS Request" cat="request" className="plain" />
            <span className="arrow">→</span>
            <Node label="Resolver" cat="recursive" className="plain" />
            <span className="arrow">→</span>
            <Node label="NS1" cat="authoritative DNS" className="ns1" />
            <span className="edge-label">selects platform →</span>
            <div className="stack">
              {PLATFORMS.map((p) => (
                <Node key={p} label={p} cat="delivery platform" className="platform" />
              ))}
            </div>
          </div>
        </div>

        <div className="boundary" role="note">
          <strong>NS1 selects the delivery platform.</strong> Cloudflare subsequently selects the Réalta origin pool. NS1
          does <strong>not</strong> select a cache or pool.
        </div>

        <div className="topo-section" data-testid="topology-realta">
          <h4>Réalta origin selection (Cloudflare)</h4>
          <div className="flow-row">
            <Node label="Réalta" cat="platform" className="realta" />
            <span className="edge-label">→ Cloudflare selects pool →</span>
            <Node label="Cloudflare Load Balancer" cat="load balancer" className="cloudflare" />
            <span className="arrow">→</span>
            <div className="stack">
              {pools.map((p) => (
                <Node key={p} label={p} cat="origin pool" className="pool" />
              ))}
            </div>
            <span className="arrow">→</span>
            <Node label="Origin" cat="origin" className="origin" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ListView() {
  const pools = REALTA_CHAIN.slice(2, 6);
  return (
    <div>
      <h4>Platform steering (NS1)</h4>
      <ol>
        <li>DNS Request</li>
        <li>Resolver</li>
        <li>
          NS1 — selects one delivery platform: {PLATFORMS.join(', ')}
        </li>
      </ol>
      <p className="muted">NS1 selects the delivery platform; Cloudflare then selects the Réalta pool. NS1 does not select a cache/pool.</p>
      <h4>Réalta origin selection (Cloudflare)</h4>
      <ol>
        <li>Réalta</li>
        <li>Cloudflare Load Balancer — selects a pool</li>
        <li>Pools: {pools.join(', ')}</li>
        <li>Origin</li>
      </ol>
    </div>
  );
}

export function Topology() {
  const { hasPermission } = useAuth();
  const detailed = hasPermission('ns1.detail.read'); // Viewing Engineer and above
  const canManage = hasPermission('topology.manage'); // Engineer
  const telemetry = useNetworkPaths(60_000); // read-only, informational
  const cache = useCacheTelemetry({ includeNodes: true, refreshMs: 60_000 });
  const [view, setView] = useState<'diagram' | 'list'>('diagram');
  const [zoom, setZoom] = useState(1);

  return (
    <div>
      <div className="page-head">
        <h1>Delivery Topology</h1>
        <p>Configured delivery architecture. RADAR-maintained values — not live telemetry.</p>
      </div>

      <div className="card">
        <div className="topo-toolbar">
          <button className={`ghost ${view === 'diagram' ? 'active' : ''}`} onClick={() => setView('diagram')}>
            Diagram
          </button>
          <button className={`ghost ${view === 'list' ? 'active' : ''}`} onClick={() => setView('list')}>
            List (accessible)
          </button>
          {view === 'diagram' && (
            <>
              <span style={{ marginLeft: '0.5rem' }} className="muted">
                Zoom
              </span>
              <button className="ghost" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(2)))}>
                −
              </button>
              <button className="ghost" aria-label="Fit to view" onClick={() => setZoom(1)}>
                Fit
              </button>
              <button className="ghost" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))}>
                +
              </button>
            </>
          )}
        </div>
        {view === 'diagram' ? <Diagram zoom={zoom} /> : <ListView />}
      </div>

      <div className="card">
        <h3>Network paths</h3>
        {telemetry.notice && telemetry.mode !== 'disabled' && <div className="notice info">{telemetry.notice}</div>}
        {telemetry.error ? (
          <div className="notice danger">{telemetry.error}</div>
        ) : telemetry.loading ? (
          <span className="muted">Loading telemetry…</span>
        ) : (
          <NetworkPathTelemetryTable paths={telemetry.paths} detail={detailed} />
        )}
        <div className="notice info" style={{ marginTop: '0.5rem' }}>
          Capacity and target are CONFIGURED (manually maintained); utilisation is observed and read-only. Future source per
          path: {NETWORK_PATHS.map((p) => `${p.label} — ${p.telemetryFutureSource}`).join('; ')}.
        </div>
        {detailed && (
          <div className="notice info" style={{ marginTop: '0.5rem' }}>
            ASN → path mapping is CONFIGURED (manually maintained): Eir AS5466/15502/25441 → Eir PNI; AS6830 → Virgin /
            Liberty PNI; INEX members → INEX; others → Transit.
          </div>
        )}
      </div>

      <div className="card">
        <h3>Configured capacity {detailed ? '' : '(summary)'}</h3>
        {(detailed ? CAPACITY : CAPACITY.filter((c) => c.label.includes('aggregate') || c.label.includes('target'))).map((c) => (
          <div className="kv" key={c.label}>
            <span>
              {c.label} <span className="badge neutral">{c.provenance}</span>
            </span>
            <span className="muted">
              {c.configuredCapacity ?? c.configuredTarget} · Utilisation: <b>Telemetry not connected</b> · future:{' '}
              {c.telemetryFutureSource}
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Réalta cache pools, nodes &amp; origin</h3>
        {cache.notice && cache.mode !== 'disabled' && <div className="notice info">{cache.notice}</div>}
        <div className="notice info" style={{ marginBottom: '0.5rem' }}>
          NS1 selects Réalta; Cloudflare selects the pool; RADAR observes pool and origin telemetry and does not yet control
          Cloudflare or NS1. Capacity and node counts are CONFIGURED (manually maintained); throughput/CPU/hit-ratio are observed.
        </div>
        {cache.error ? (
          <div className="notice danger">{cache.error}</div>
        ) : cache.loading ? (
          <span className="muted">Loading cache telemetry…</span>
        ) : (
          <>
            <CachePoolTable pools={cache.pools} detail={detailed} />
            {detailed && (
              <div style={{ marginTop: '0.75rem' }}>
                <h4 style={{ margin: '0 0 0.3rem' }}>Cache nodes</h4>
                <CacheNodeTable nodes={cache.nodes} detail={detailed} />
              </div>
            )}
            <div style={{ marginTop: '0.75rem' }}>
              <h4 style={{ margin: '0 0 0.3rem' }}>Origin</h4>
              <OriginPanel origin={cache.origin} />
            </div>
          </>
        )}
      </div>

      {canManage && (
        <div className="card">
          <h3>Topology management (Engineer)</h3>
          <div className="muted" style={{ marginBottom: '0.5rem' }}>
            Editing is not enabled in v1. Future controls appear here as disabled.
          </div>
          <button className="ghost" disabled>
            Edit capacity targets
          </button>{' '}
          <button className="ghost" disabled>
            Edit ASN → path mappings
          </button>
        </div>
      )}
    </div>
  );
}
