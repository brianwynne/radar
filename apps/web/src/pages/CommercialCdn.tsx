// Commercial CDN observability — read-only, informational. Shows the commercial CDN delivery
// platforms NS1 can steer to (Fastly, Akamai) side by side, each with its own service filter and a
// realtime per-service response-code panel. RADAR issues no CDN writes; absent values are shown as
// such, never invented.
//
// This page takes over the top LIVE banner (via usePageBanner) to report, from NS1 data, whether
// live delivery is being served (NS1's public entry resolving to an active steering record) and how
// the live steering profile currently splits across delivery platforms.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { Ns1ActiveRecordResponse } from '../api/types';
import { usePageBanner } from '../components/page-banner';
import { FastlyColumn } from '../components/cdn/FastlyColumn';
import { AkamaiColumn } from '../components/cdn/AkamaiColumn';

type PlatformShare = { platform: string; share: number };

export function CommercialCdn() {
  const [ns1, setNs1] = useState<Ns1ActiveRecordResponse | null>(null);
  const [ns1Error, setNs1Error] = useState(false);
  const [profile, setProfile] = useState<PlatformShare[] | null>(null);

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

  // Once the active steering record is known (the livebase CNAME the entry points to), evaluate it
  // with a neutral resolver to get the real weighted split across delivery platforms — the same
  // expectedDistribution the Live Steering page shows. asnBreakdown is per-ASN and does NOT reflect
  // the base answer-pool weights (it reported 100% Réalta), so we must use /dns/explain here.
  const rec = ns1?.active ?? null;
  const recKey = rec ? `${rec.zone}/${rec.domain}/${rec.type}` : null;
  useEffect(() => {
    if (!rec) { setProfile(null); return; }
    let active = true;
    api.explain({ zone: rec.zone, domain: rec.domain, type: rec.type, scenario: { resolverIp: '9.9.9.9', ecsPresent: false } })
      .then((r) => {
        if (!active) return;
        const ev = r.evaluation;
        const by = new Map<string, number>();
        const shares = ev.expectedDistribution?.shares ?? [];
        if (shares.length) {
          for (const s of shares) by.set(s.deliveryPlatform ?? 'Unclassified', (by.get(s.deliveryPlatform ?? 'Unclassified') ?? 0) + s.share);
        } else if (ev.selected) {
          // Deterministic single answer → 100% to its platform.
          const a = ev.answers.find((x) => x.id === ev.selected);
          if (a) by.set(a.deliveryPlatform ?? 'Unclassified', 1);
        }
        setProfile(
          [...by.entries()]
            .filter(([, s]) => s >= 0.005) // drop sub-0.5% standbys
            .map(([platform, s]) => ({ platform, share: Math.round(s * 100) }))
            .sort((a, b) => b.share - a.share),
        );
      })
      .catch(() => { if (active) setProfile(null); });
    return () => { active = false; };
    // recKey captures the record identity; rec object identity changes every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recKey]);

  const serving = !!ns1?.active && !!ns1?.target;

  const banner = useMemo(() => {
    if (ns1Error) {
      return (
        <span>
          <strong>Commercial CDN delivery data</strong> — NS1 live-serving status is unavailable.
        </span>
      );
    }
    if (!ns1) return <span>Checking NS1 live-serving status…</span>;
    if (!serving) {
      return (
        <span>
          <strong>Commercial CDN delivery data</strong> — NS1 has no active live steering record resolved; live delivery may not be serving.
        </span>
      );
    }
    return (
      <span className="cdn-banner">
        <span className="cdn-banner-line">
          <span className="live-dot" /> <strong>Live · Commercial CDN delivery data</strong> — NS1 is steering{' '}
          <span className="mono">{ns1.entry}</span> → <span className="mono">{ns1.target}</span>.
        </span>
        {profile && profile.length > 0 && (
          <span className="cdn-banner-sub">
            Live profile: {profile.map((p) => `${p.platform} ${p.share}%`).join(' · ')}
          </span>
        )}
      </span>
    );
  }, [ns1, ns1Error, serving, profile]);

  // The banner colour follows the state: green when serving, amber otherwise.
  usePageBanner(<div className={serving || (!ns1Error && !ns1) ? 'mode-banner-inner ok' : 'mode-banner-inner warn'}>{banner}</div>);

  return (
    <section className="page">
      <header className="page-head">
        <h1>Commercial CDN</h1>
        <div className="head-meta">
          <span className="muted">read-only delivery telemetry · platforms NS1 can steer to</span>
        </div>
      </header>

      <div className="cdn-grid">
        <FastlyColumn />
        <AkamaiColumn />
      </div>
    </section>
  );
}
