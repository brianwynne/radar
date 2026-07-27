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
import { FastlyColumn } from '../components/cdn/FastlyColumn';
import { AkamaiColumn } from '../components/cdn/AkamaiColumn';

// The delivery platforms in the live steering config, split into RTÉ's own PNI-based CDN (Réalta,
// which serves Irish eyeball networks) and the commercial CDNs (which serve international traffic).
type Profile = { domestic: string[]; commercial: string[]; commercialShare: number };

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
  // and read the FULL configured answer pool (evaluation.answers, not the filtered distribution).
  // The record steers by geography: Réalta answers serve Irish eyeball networks, and the commercial
  // CDNs (Fastly/Akamai) are gated for international requesters — so their answer weight is ~0 and a
  // weight-based split hides them. We instead detect which commercial-CDN platforms are present in
  // the config (i.e. are configured to serve international traffic) and report that.
  const rec = ns1?.active ?? null;
  const recKey = rec ? `${rec.zone}/${rec.domain}/${rec.type}` : null;
  useEffect(() => {
    if (!rec) { setProfile(null); return; }
    let active = true;
    api.explain({ zone: rec.zone, domain: rec.domain, type: rec.type, scenario: { resolverIp: '9.9.9.9', ecsPresent: false } })
      .then((r) => {
        if (!active) return;
        const answers = r.evaluation.answers.filter((a) => a.deliveryPlatform);
        const platforms = [...new Set(answers.map((a) => a.deliveryPlatform!))];
        const commercial = platforms.filter((p) => COMMERCIAL.test(p));
        if (commercial.length === 0) { setProfile(null); return; } // config doesn't route to any commercial CDN
        const domestic = platforms.filter((p) => !COMMERCIAL.test(p));
        // Commercial share of the configured weight, when the record carries weights (a hint, not the
        // international traffic volume — which NS1 config alone can't tell us).
        const weighted = answers.some((a) => typeof a.weight === 'number' && a.weight > 0);
        let commercialW = 0, totalW = 0;
        for (const a of answers) {
          const w = weighted ? (a.weight ?? 0) : 0;
          if (w <= 0) continue;
          totalW += w;
          if (COMMERCIAL.test(a.deliveryPlatform!)) commercialW += w;
        }
        setProfile({ domestic, commercial, commercialShare: totalW > 0 ? Math.round((commercialW / totalW) * 100) : 0 });
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
        {profile && (
          <span className="cdn-banner-sub">
            In this config,{' '}
            {profile.domestic.length > 0 && <><strong>{profile.domestic.join(' + ')}</strong> serves Irish eyeball networks and{' '}</>}
            commercial CDNs (<strong>{profile.commercial.join(' + ')}</strong>) serve international traffic
            {profile.commercialShare > 0 && <> (~{profile.commercialShare}% of the live profile)</>}.
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
