// Enhanced, human-readable view of an NS1 record's steering config — the same structure NS1
// shows (ordered filter chain + answer cards with asn/country/note/weight meta) but translated:
// each answer's delivery PLATFORM is derived and colour-coded, country codes show their names,
// ASNs resolve to network owners, weights render as share bars, and each filter is explained in
// plain English. RADAR never writes to NS1 — this is a read-only, display-only enhancement.
import { useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import { colorFor, orderOf, platformOf } from '../steering/platforms';
import { asnList, countryList, countryName, filterMeta, summariseCountries, weightShares } from '../steering/record-config';

interface Ns1Answer { id?: string; answer?: unknown; meta?: Record<string, unknown>; region?: string }
interface Ns1Filter { filter?: string; disabled?: boolean; config?: Record<string, unknown> }

interface ParsedAnswer {
  id: string;
  rdata: string[];
  primary: string;
  platform: string | null;
  weight: number;
  note: string | null;
  asns: number[];
  countries: string[];
  weightIsFeed: boolean;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseAnswers(raw: unknown): ParsedAnswer[] {
  const list = Array.isArray(raw) ? (raw as Ns1Answer[]) : [];
  return list.map((a, i) => {
    const rdata = Array.isArray(a.answer) ? a.answer.map((x) => String(x)) : [];
    const meta = (a.meta ?? {}) as Record<string, unknown>;
    const primary = rdata[0] ?? '';
    return {
      id: typeof a.id === 'string' ? a.id : `ans-${i}`,
      rdata,
      primary,
      platform: platformOf(primary),
      weight: num(meta.weight) ? (meta.weight as number) : 0,
      weightIsFeed: typeof meta.weight === 'object' && meta.weight !== null,
      note: typeof meta.note === 'string' ? meta.note : null,
      asns: asnList(meta),
      countries: countryList(meta),
    };
  });
}

const pct = (share: number) => `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`;

export function RecordConfigView({ record, zone, domain, type }: { record: Record<string, unknown> | undefined; zone: string; domain: string; type: string }) {
  const rec = record ?? {};
  const ttl = num(rec.ttl) ? rec.ttl : null;
  const clientSubnet = rec.use_client_subnet === true;
  const filters = (Array.isArray(rec.filters) ? rec.filters : []) as Ns1Filter[];

  const answers = useMemo(() => weightShares(parseAnswers(rec.answers)), [rec.answers]);
  // Group answers by delivery platform, platform order first, "Unclassified" last.
  const groups = useMemo(() => {
    const by = new Map<string, (typeof answers)[number][]>();
    for (const a of answers) {
      const key = a.platform ?? 'Unclassified';
      (by.get(key) ?? by.set(key, []).get(key)!).push(a);
    }
    return [...by.entries()].sort((x, y) => orderOf(x[0]) - orderOf(y[0]));
  }, [answers]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setExpanded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  // ASN → owner, resolved on demand via the ASN-breakdown route (RIPEstat, cached server-side).
  const [owners, setOwners] = useState<Map<number, string> | null>(null);
  const [resolving, setResolving] = useState(false);
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const resolveOwners = async () => {
    setResolving(true);
    setOwnerError(null);
    try {
      const r = await api.asnBreakdown(zone, domain, type);
      const map = new Map<number, string>();
      for (const row of r.rows) if (row.holder) map.set(row.asn, row.holder);
      setOwners(map);
    } catch (e) {
      setOwnerError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Could not resolve ASN owners.');
    } finally {
      setResolving(false);
    }
  };
  const hasAnyAsn = answers.some((a) => a.asns.length > 0);

  return (
    <div className="config-view">
      {/* Record header */}
      <div className="config-head">
        <div className="config-head-facts">
          <span className="badge neutral">{answers.length} answer{answers.length === 1 ? '' : 's'}</span>
          {ttl !== null && <span className="muted">TTL {ttl}s</span>}
          <span className={`badge ${clientSubnet ? 'ok' : 'neutral'} badge-sm`} title="EDNS Client Subnet — steer on the client's network, not the resolver's">
            client subnet {clientSubnet ? 'on' : 'off'}
          </span>
        </div>
        {hasAnyAsn && (
          <div className="config-head-actions">
            {owners === null ? (
              <button className="ghost" onClick={resolveOwners} disabled={resolving}>{resolving ? 'Resolving…' : 'Resolve network owners'}</button>
            ) : (
              <span className="badge ok badge-sm">owners resolved ({owners.size})</span>
            )}
          </div>
        )}
      </div>
      {ownerError && <div className="notice warn">{ownerError}</div>}

      <div className="config-grid">
        {/* Filter chain — ordered, each step explained */}
        <div className="config-filters">
          <h4>Filter chain <span className="muted">(top → bottom)</span></h4>
          {filters.length === 0 && <div className="muted">No filters — every answer is eligible.</div>}
          <ol className="filter-chain">
            {filters.map((f, i) => {
              const m = filterMeta(f.filter ?? '');
              const cfg = f.config ?? {};
              const n = num(cfg.N) ? cfg.N : num((cfg as { n?: unknown }).n) ? (cfg as { n: number }).n : null;
              return (
                <li key={i} className={`filter-step ${f.disabled ? 'disabled' : ''}`}>
                  <div className="filter-step-head">
                    <span className="filter-step-name">{m.label}{n !== null ? ` · N=${n}` : ''}</span>
                    <span className={`badge badge-sm ${m.supported ? 'ok' : 'warn'}`} title={m.supported ? 'RADAR evaluates this filter' : 'Unsupported → partial evaluation'}>{m.supported ? m.behaviour : 'partial'}</span>
                    {f.disabled && <span className="badge neutral badge-sm">disabled</span>}
                  </div>
                  <div className="filter-step-desc muted">{m.description}</div>
                </li>
              );
            })}
          </ol>
        </div>

        {/* Answers, grouped by delivery platform */}
        <div className="config-answers">
          {groups.map(([platform, items]) => (
            <div key={platform} className="platform-group">
              <div className="platform-group-head">
                <span className="platform-dot" style={{ background: colorFor(platform) }} />
                <strong>{platform}</strong>
                <span className="muted">· {items.length} answer{items.length === 1 ? '' : 's'}</span>
              </div>
              {items.map((a) => {
                const cs = summariseCountries(a.countries);
                const ckey = `${a.id}:c`;
                const akey = `${a.id}:a`;
                return (
                  <div key={a.id} className="answer-card" style={{ borderLeftColor: colorFor(platform) }}>
                    <div className="answer-value mono">{a.rdata.join(', ') || '—'}</div>
                    {a.note && <div className="answer-note">{a.note}</div>}
                    <div className="answer-meta">
                      {/* weight + share */}
                      <div className="answer-weight">
                        <span className="muted">weight</span> <strong>{a.weightIsFeed ? 'feed' : a.weight}</strong>
                        {!a.weightIsFeed && a.share > 0 && (
                          <span className="share">
                            <span className="share-bar"><span className="share-fill" style={{ width: pct(a.share), background: colorFor(platform) }} /></span>
                            <span className="muted">{pct(a.share)} of configured weight</span>
                          </span>
                        )}
                      </div>
                      {/* country: code + name, summarised */}
                      {a.countries.length > 0 && (
                        <div className="answer-tagline">
                          <span className="tag-key">country</span>
                          <span>{cs.phrase}</span>
                          <button className="linklike" onClick={() => toggle(ckey)}>{expanded.has(ckey) ? 'hide' : `show ${cs.codes.length}`}</button>
                          {expanded.has(ckey) && (
                            <div className="chip-wrap">
                              {cs.codes.map((c) => <span key={c} className="chip" title={countryName(c)}>{c} · {countryName(c)}</span>)}
                            </div>
                          )}
                        </div>
                      )}
                      {/* asn: number + resolved owner */}
                      {a.asns.length > 0 && (
                        <div className="answer-tagline">
                          <span className="tag-key">asn</span>
                          <span>{a.asns.length} network{a.asns.length === 1 ? '' : 's'}</span>
                          <button className="linklike" onClick={() => toggle(akey)}>{expanded.has(akey) ? 'hide' : 'show'}</button>
                          {expanded.has(akey) && (
                            <div className="chip-wrap">
                              {a.asns.map((n) => {
                                const owner = owners?.get(n);
                                return <span key={n} className="chip" title={owner ?? `AS${n}`}>AS{n}{owner ? ` · ${owner}` : ''}</span>;
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
