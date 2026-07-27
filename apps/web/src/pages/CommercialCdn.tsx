// Commercial CDN observability — read-only, informational. Shows the commercial CDN delivery
// platforms NS1 can steer to (Fastly, Akamai) side by side, each with its own service filter and a
// realtime per-service response-code panel. RADAR issues no CDN writes; absent values are shown as
// such, never invented. The header banner reflects, from NS1 data, whether live delivery is being
// served (NS1's public entry resolving to an active steering record).
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Ns1ActiveRecordResponse } from '../api/types';
import { FastlyColumn } from '../components/cdn/FastlyColumn';
import { AkamaiColumn } from '../components/cdn/AkamaiColumn';

export function CommercialCdn() {
  const [ns1, setNs1] = useState<Ns1ActiveRecordResponse | null>(null);
  const [ns1Error, setNs1Error] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () =>
      api.activeRecord()
        .then((r) => { if (active) { setNs1(r); setNs1Error(false); } })
        .catch(() => { if (active) setNs1Error(true); });
    load();
    const id = setInterval(load, 30_000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const serving = !!ns1?.active && !!ns1?.target;

  return (
    <section className="page">
      <header className="page-head">
        <h1>Commercial CDN</h1>
        <div className="head-meta">
          <span className="muted">read-only delivery telemetry · platforms NS1 can steer to</span>
        </div>
      </header>

      {/* Live-serving status from NS1 (green when NS1 is steering live delivery to an active record). */}
      {ns1Error ? (
        <div className="notice warn">Commercial CDN delivery data — NS1 live-serving status is unavailable.</div>
      ) : serving ? (
        <div className="notice ok">
          <span className="live-dot" /> <strong>Live · Commercial CDN delivery data</strong> — NS1 is steering{' '}
          <span className="mono">{ns1!.entry}</span> → <span className="mono">{ns1!.target}</span>.
        </div>
      ) : ns1 ? (
        <div className="notice warn">
          <strong>Commercial CDN delivery data</strong> — NS1 has no active live steering record resolved; live delivery may not be serving.
        </div>
      ) : (
        <div className="notice info">Checking NS1 live-serving status…</div>
      )}

      <div className="cdn-grid">
        <FastlyColumn />
        <AkamaiColumn />
      </div>
    </section>
  );
}
