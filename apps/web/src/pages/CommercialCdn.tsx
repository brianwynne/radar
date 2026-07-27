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

type PlatformShare = { platform: string; share: number; commercial: boolean };
type Profile = { rows: PlatformShare[]; commercial: number };

// Commercial CDN delivery platforms (everything else — Réalta — is RTÉ's own PNI-based CDN).
const COMMERCIAL = /fastly|akamai|cloudflare|cloudfront|edgio|limelight|amazon|cachefly/i;

export function CommercialCdn() {
  const [ns1, setNs1] = useState<Ns1ActiveRecordResponse | null>(null);
  const [ns1Error, setNs1Error] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);

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
  // and aggregate the CONFIGURED answer-pool weights by platform — NOT expectedDistribution, which
  // is only the answers that survive filtering for one resolver (an IE-geolocated resolver keeps
  // Réalta and drops the commercial CDNs, hiding their ~1/3 share). evaluation.answers is the full,
  // unfiltered pool, so it reflects the real steering profile — Réalta plus the commercial CDNs
  // (Fastly/Akamai) that carry the international traffic. (asnBreakdown is per-ASN — it reported
  // 100% Réalta — so it's wrong here too.)
  const rec = ns1?.active ?? null;
  const recKey = rec ? `${rec.zone}/${rec.domain}/${rec.type}` : null;
  useEffect(() => {
    if (!rec) { setProfile(null); return; }
    let active = true;
    api.explain({ zone: rec.zone, domain: rec.domain, type: rec.type, scenario: { resolverIp: '9.9.9.9', ecsPresent: false } })
      .then((r) => {
        if (!active) return;
        const answers = r.evaluation.answers.filter((a) => a.deliveryPlatform);
        // Weighted by NS1 answer weight; if the record carries no weights, weight all answers equally.
        const weighted = answers.some((a) => typeof a.weight === 'number' && a.weight > 0);
        const by = new Map<string, number>();
        for (const a of answers) {
          const w = weighted ? (a.weight ?? 0) : 1;
          if (w <= 0) continue;
          by.set(a.deliveryPlatform!, (by.get(a.deliveryPlatform!) ?? 0) + w);
        }
        const total = [...by.values()].reduce((s, w) => s + w, 0);
        if (total <= 0) { setProfile(null); return; }
        let commercialW = 0;
        for (const [platform, w] of by) if (COMMERCIAL.test(platform)) commercialW += w;
        setProfile({
          rows: [...by.entries()]
            .filter(([, w]) => w / total >= 0.005) // drop sub-0.5% standbys
            .map(([platform, w]) => ({ platform, share: Math.round((w / total) * 100), commercial: COMMERCIAL.test(platform) }))
            .sort((a, b) => b.share - a.share),
          commercial: Math.round((commercialW / total) * 100),
        });
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
        {profile && profile.rows.length > 0 && (
          <span className="cdn-banner-sub">
            Live profile: {profile.rows.map((p) => `${p.platform} ${p.share}%`).join(' · ')}
            {profile.commercial > 0 && <> — commercial CDNs (Fastly + Akamai) carry <strong>~{profile.commercial}%</strong></>}
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
