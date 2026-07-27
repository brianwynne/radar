// Commercial CDN observability — read-only, informational. Shows the commercial CDN delivery
// platforms NS1 can steer to (Fastly, Akamai) side by side, each with its own service filter and a
// realtime per-service response-code panel. RADAR issues no CDN writes; absent values are shown as
// such, never invented.
//
// This page takes over the top LIVE banner (via usePageBanner) to report, from NS1 data, whether
// live delivery is being served (NS1's public entry resolving to an active steering record) and,
// from the live steering config, that the commercial CDNs are serving international traffic while
// Réalta serves Irish eyeball networks.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { Ns1ActiveRecordResponse } from '../api/types';
import { usePageBanner } from '../components/page-banner';
import { ISPS, ispToScenario } from '../steering/isps';
import { FastlyColumn } from '../components/cdn/FastlyColumn';
import { AkamaiColumn } from '../components/cdn/AkamaiColumn';

// The off-island steering split for international traffic (the same off-island subscriber the
// Dashboard steering overview evaluates — AS3320 / Germany).
type PlatformShare = { platform: string; share: number; commercial: boolean };
type Profile = { rows: PlatformShare[]; commercialShare: number };

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
  // for an OFF-ISLAND subscriber (AS3320 / Germany — the same preset the Dashboard steering overview
  // uses). The record steers by geography: Irish eyeball networks get Réalta, and only off-island
  // requesters get the commercial CDNs (Fastly/Akamai) in the weighted shuffle. Evaluating an Irish
  // resolver would show Réalta 100% and hide them — so we use the off-island scenario and read its
  // expectedDistribution (exactly the split the Dashboard bar shows).
  const rec = ns1?.active ?? null;
  const recKey = rec ? `${rec.zone}/${rec.domain}/${rec.type}` : null;
  useEffect(() => {
    if (!rec) { setProfile(null); return; }
    let active = true;
    const off = ISPS.find((i) => i.id === 'offisland');
    if (!off) { setProfile(null); return; }
    const scenario = { ...ispToScenario(off), asn: Number(off.asn) };
    api.explain({ zone: rec.zone, domain: rec.domain, type: rec.type, scenario })
      .then((r) => {
        if (!active) return;
        const ev = r.evaluation;
        const by = new Map<string, number>();
        const shares = ev.expectedDistribution?.shares ?? [];
        if (shares.length) {
          for (const s of shares) if (s.deliveryPlatform) by.set(s.deliveryPlatform, (by.get(s.deliveryPlatform) ?? 0) + s.share);
        } else if (ev.selected) {
          const a = ev.answers.find((x) => x.id === ev.selected);
          if (a?.deliveryPlatform) by.set(a.deliveryPlatform, 1);
        }
        const total = [...by.values()].reduce((s, w) => s + w, 0);
        if (total <= 0) { setProfile(null); return; }
        let commercialW = 0;
        for (const [platform, w] of by) if (COMMERCIAL.test(platform)) commercialW += w;
        setProfile({
          rows: [...by.entries()]
            .filter(([, w]) => w / total >= 0.005)
            .map(([platform, w]) => ({ platform, share: Math.round((w / total) * 100), commercial: COMMERCIAL.test(platform) }))
            .sort((a, b) => b.share - a.share),
          commercialShare: Math.round((commercialW / total) * 100),
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
            Irish eyeball networks → <strong>Réalta</strong>; international (off-island) traffic:{' '}
            {profile.rows.map((p) => `${p.platform} ${p.share}%`).join(' · ')}
            {profile.commercialShare > 0 && <> — commercial CDNs serve <strong>~{profile.commercialShare}%</strong> of it</>}.
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
