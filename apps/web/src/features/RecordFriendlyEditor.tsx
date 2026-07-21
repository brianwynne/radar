// Friendly (non-raw) editor for an NS1 record body — the answers, weights, notes, per-answer ASN
// targeting (resolved to network owners) and country targeting, plus TTL. Seeded from a previewed
// record body; on Apply it rebuilds the NS1 record body so the create panel can re-preview/confirm.
// The filter chain and other config are carried through unchanged (shown read-only).
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { colorFor, platformOf } from '../steering/platforms';
import { countryName, isFeedPtr } from '../steering/record-config';

interface RawAnswer { answer?: unknown; meta?: Record<string, unknown>; region?: string }
interface EditAnswer { key: string; value: string; weight: string; note: string; asns: number[]; countries: string[]; feedWeight: boolean }

const asOf = (m: Record<string, unknown> | undefined, k: string): number[] => {
  const v = m?.[k]; return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n)) : [];
};
const strsOf = (m: Record<string, unknown> | undefined, k: string): string[] => {
  const v = m?.[k]; return Array.isArray(v) ? v.map((x) => String(x)) : [];
};
let idc = 0;
const parse = (body: Record<string, unknown>): EditAnswer[] => {
  const answers = Array.isArray(body.answers) ? (body.answers as RawAnswer[]) : [];
  return answers.map((a) => {
    const meta = (a.meta ?? {}) as Record<string, unknown>;
    const rdata = Array.isArray(a.answer) ? a.answer.map((x) => String(x)) : [];
    return {
      key: `a${idc++}`, value: rdata.join(', '),
      weight: isFeedPtr(meta.weight) ? 'feed' : String(typeof meta.weight === 'number' ? meta.weight : ''),
      feedWeight: isFeedPtr(meta.weight),
      note: typeof meta.note === 'string' ? meta.note : '',
      asns: asOf(meta, 'asn'), countries: strsOf(meta, 'country'),
    };
  });
};

export function RecordFriendlyEditor({ initial, onApply, onCancel }: { initial: Record<string, unknown>; onApply: (body: Record<string, unknown>) => void; onCancel: () => void }) {
  const [ttl, setTtl] = useState<string>(String(typeof initial.ttl === 'number' ? initial.ttl : 30));
  const [answers, setAnswers] = useState<EditAnswer[]>(() => parse(initial));
  const [owners, setOwners] = useState<Map<number, string>>(new Map());
  const [addAsn, setAddAsn] = useState<Record<string, string>>({});
  const [addCty, setAddCty] = useState<Record<string, string>>({});

  const filters = Array.isArray(initial.filters) ? (initial.filters as { filter?: string; disabled?: boolean }[]) : [];
  const allAsns = useMemo(() => [...new Set(answers.flatMap((a) => a.asns))], [answers]);

  // Resolve every ASN in play to its network owner (best-effort; numbers show if unresolved).
  useEffect(() => {
    const need = allAsns.filter((n) => !owners.has(n));
    if (need.length === 0) return;
    let live = true;
    api.asnOwners(need).then((r) => { if (!live) return; setOwners((prev) => { const m = new Map(prev); for (const [k, v] of Object.entries(r.owners)) m.set(Number(k), v); for (const n of need) if (!m.has(n)) m.set(n, ''); return m; }); }).catch(() => {});
    return () => { live = false; };
  }, [allAsns, owners]);

  const upd = (key: string, patch: Partial<EditAnswer>) => setAnswers((prev) => prev.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  const removeAnswer = (key: string) => setAnswers((prev) => prev.filter((a) => a.key !== key));
  const addAnswer = () => setAnswers((prev) => [...prev, { key: `a${idc++}`, value: '', weight: '1', note: '', asns: [], countries: [], feedWeight: false }]);
  const platOf = (v: string) => platformOf(v.split(',')[0]?.trim() ?? '') ?? 'Unclassified';

  function apply() {
    const origAnswers = Array.isArray(initial.answers) ? (initial.answers as RawAnswer[]) : [];
    const rebuilt = answers.map((a, i) => {
      const meta: Record<string, unknown> = {};
      // Weight: preserve a feed pointer as-is; otherwise a number.
      if (a.feedWeight) { const w = (origAnswers[i]?.meta as Record<string, unknown> | undefined)?.weight; if (isFeedPtr(w)) meta.weight = w; }
      else if (a.weight.trim() !== '') meta.weight = Number(a.weight);
      if (a.note.trim()) meta.note = a.note.trim();
      if (a.asns.length) meta.asn = a.asns;
      if (a.countries.length) meta.country = a.countries;
      return { answer: a.value.split(',').map((s) => s.trim()).filter(Boolean), ...(Object.keys(meta).length ? { meta } : {}) };
    });
    onApply({ ...initial, ttl: Number(ttl), answers: rebuilt });
  }

  return (
    <div className="rfe">
      <div className="rfe-head">
        <strong>Edit record</strong>
        <label className="field rfe-ttl"><span className="muted">TTL (s)</span><input type="number" min={1} max={604800} value={ttl} onChange={(e) => setTtl(e.target.value)} className="mono" /></label>
        <span style={{ marginLeft: 'auto' }} />
        <button className="ghost" onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={apply}>Apply edits</button>
      </div>

      {filters.length > 0 && (
        <div className="rfe-filters muted">Filter chain (carried unchanged): {filters.map((f, i) => <span key={i} className="chip mono">{f.filter}{f.disabled ? ' · off' : ''}</span>)}</div>
      )}

      <div className="rfe-answers">
        {answers.map((a) => {
          const plat = platOf(a.value);
          return (
            <div key={a.key} className="rfe-answer" style={{ borderLeftColor: colorFor(plat) }}>
              <div className="rfe-answer-row">
                <label className="field" style={{ flex: '2 1 12rem' }}><span className="muted">Answer (value)</span><input value={a.value} onChange={(e) => upd(a.key, { value: e.target.value })} className="mono" placeholder="liveedge.rte.ie" /></label>
                <label className="field" style={{ flex: '0 0 6rem' }}><span className="muted">Weight</span><input value={a.weight} disabled={a.feedWeight} onChange={(e) => upd(a.key, { weight: e.target.value })} className="mono" placeholder={a.feedWeight ? 'feed' : '1'} /></label>
                <span className="platform-dot" style={{ background: colorFor(plat) }} title={plat} />
                <button className="linklike danger" title="Remove answer" onClick={() => removeAnswer(a.key)}>remove</button>
              </div>
              <label className="field"><span className="muted">Note</span><input value={a.note} onChange={(e) => upd(a.key, { note: e.target.value })} placeholder="(optional)" /></label>

              <div className="rfe-tags">
                <span className="tag-key">ASN targeting</span>
                <div className="chip-wrap">
                  {a.asns.map((n) => (
                    <span key={n} className="chip">AS{n}{owners.get(n) ? ` · ${owners.get(n)}` : ''} <button className="chip-x" title="Remove" onClick={() => upd(a.key, { asns: a.asns.filter((x) => x !== n) })}>×</button></span>
                  ))}
                  <input className="rfe-add mono" placeholder="+ ASN" value={addAsn[a.key] ?? ''} onChange={(e) => setAddAsn((s) => ({ ...s, [a.key]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { const n = Number((addAsn[a.key] ?? '').trim()); if (Number.isInteger(n) && n > 0 && !a.asns.includes(n)) upd(a.key, { asns: [...a.asns, n] }); setAddAsn((s) => ({ ...s, [a.key]: '' })); } }} />
                </div>
              </div>
              <div className="rfe-tags">
                <span className="tag-key">Country targeting</span>
                <div className="chip-wrap">
                  {a.countries.map((c) => (
                    <span key={c} className="chip" title={countryName(c)}>{c} · {countryName(c)} <button className="chip-x" title="Remove" onClick={() => upd(a.key, { countries: a.countries.filter((x) => x !== c) })}>×</button></span>
                  ))}
                  <input className="rfe-add mono" placeholder="+ CC" maxLength={2} value={addCty[a.key] ?? ''} onChange={(e) => setAddCty((s) => ({ ...s, [a.key]: e.target.value.toUpperCase() }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { const c = (addCty[a.key] ?? '').trim().toUpperCase(); if (/^[A-Z]{2}$/.test(c) && !a.countries.includes(c)) upd(a.key, { countries: [...a.countries, c] }); setAddCty((s) => ({ ...s, [a.key]: '' })); } }} />
                </div>
              </div>
            </div>
          );
        })}
        <button className="ghost" onClick={addAnswer}>＋ Add answer</button>
      </div>
    </div>
  );
}
