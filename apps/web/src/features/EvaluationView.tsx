// The graphical, filter-by-filter explanation of an NS1 steering decision. Renders the
// evaluation contract from /api/v1/dns/explain: derived identity, the Filter Chain
// pipeline, eligible answers, and the expected (probabilistic) delivery-platform
// distribution — with the required disclaimers. No evaluation logic lives here.
import type { Confidence, ExplainResponse, FilterTrace, TracedAnswer } from '../api/types';
import { ProvenanceLine } from '../components/Provenance';
import { networkPathForAsn } from '../topology/model';

const confidenceBadge: Record<Confidence, string> = { high: 'ok', medium: 'info', low: 'warn', unknown: 'neutral' };

function labelFor(id: string, answers: TracedAnswer[]): string {
  const a = answers.find((x) => x.id === id);
  return a?.deliveryPlatform ?? a?.label ?? id;
}

function Step({ trace, answers, selected }: { trace: FilterTrace; answers: TracedAnswer[]; selected?: string }) {
  const cls = `step${!trace.supported ? ' unsupported' : ''}${trace.disabled ? ' disabled' : ''}`;
  return (
    <div className={cls}>
      <div className="step-head">
        <span className="step-idx">#{trace.index + 1}</span>
        <span className="step-type mono">{trace.type}</span>
        {trace.supported ? (
          <span className="badge neutral">{trace.behaviour}</span>
        ) : (
          <span className="badge warn">unsupported → partial</span>
        )}
        {trace.disabled && <span className="badge neutral">disabled</span>}
        {trace.reorder && <span className="badge info">reordered</span>}
        <span className={`badge ${confidenceBadge[trace.confidence]}`}>confidence: {trace.confidence}</span>
      </div>
      <div className="step-reason">{trace.reason}</div>
      {trace.warning && <div className="notice warn" style={{ marginTop: '0.4rem' }}>{trace.warning}</div>}
      <div className="flow">
        {trace.output.map((id) => (
          <span key={id} className={`chip${id === selected ? ' selected' : ''}`}>
            {labelFor(id, answers)}
          </span>
        ))}
        {trace.removedAnswerIds.map((id) => (
          <span key={id} className="chip removed" title="Eliminated by this filter">
            {labelFor(id, answers)}
          </span>
        ))}
        {trace.output.length === 0 && trace.removedAnswerIds.length === 0 && <span className="muted">no change</span>}
      </div>
    </div>
  );
}

export function EvaluationView({ data }: { data: ExplainResponse }) {
  const { evaluation: ev, provenance, request } = data;

  return (
    <div>
      <div className="card">
        <div className="step-head">
          <h3 style={{ margin: 0 }}>
            {request.domain} <span className="mono muted">{request.type}</span>
          </h3>
          {ev.complete ? (
            <span className="badge ok">complete evaluation</span>
          ) : (
            <span className="badge warn">partial evaluation</span>
          )}
        </div>
        <p style={{ marginTop: '0.5rem' }}>{ev.explanation}</p>
        <ProvenanceLine p={provenance} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Evaluated identity</h3>
          <div className="kv">
            <span>Address source</span>
            <span>
              <span className="badge info">{ev.identity.source}</span> {ev.identity.evaluatedAddress}
            </span>
          </div>
          <div className="kv">
            <span>Country / ASN</span>
            <span>
              {ev.identity.country ?? '—'} {ev.identity.asn ? `/ AS${ev.identity.asn}` : ''}
            </span>
          </div>
          <div className="kv">
            <span>Confidence</span>
            <span className={`badge ${confidenceBadge[ev.identity.confidence]}`}>{ev.identity.confidence}</span>
          </div>
          <div className="kv">
            <span>Network path</span>
            <span>
              {networkPathForAsn(request.scenario.asn).label} <span className="badge neutral">CONFIGURED</span>
            </span>
          </div>
          {ev.identity.notes.length > 0 && (
            <ul className="notes">
              {ev.identity.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h3>Answers</h3>
          {ev.answers.map((a) => (
            <div key={a.id} className="kv">
              <span>
                {a.deliveryPlatform ?? a.label}
                {ev.eligibleAnswerIds.includes(a.id) ? (
                  <span className="badge ok" style={{ marginLeft: '0.4rem' }}>eligible</span>
                ) : (
                  <span className="badge danger" style={{ marginLeft: '0.4rem' }}>removed</span>
                )}
                {a.id === ev.selected && <span className="badge info" style={{ marginLeft: '0.3rem' }}>selected</span>}
              </span>
              <span className="mono muted">
                {a.rdata.join(', ')}
                {a.weight !== undefined ? ` · w${a.weight}` : ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Filter Chain</h3>
        <div className="pipeline">
          {ev.traces.map((t) => (
            <Step key={t.index} trace={t} answers={ev.answers} selected={ev.selected} />
          ))}
        </div>
      </div>

      {ev.expectedDistribution && (
        <div className="card">
          <h3>Expected delivery-platform distribution</h3>
          {ev.expectedDistribution.shares.map((s) => (
            <div key={s.answerId} className="dist-row">
              <span>{s.deliveryPlatform ?? s.label}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${Math.round(s.share * 100)}%` }} />
              </span>
              <span className="dist-pct">{(s.share * 100).toFixed(0)}%</span>
            </div>
          ))}
          {ev.expectedDistribution.disclaimers.map((d, i) => (
            <div key={i} className="notice info" style={{ marginTop: '0.5rem' }}>
              {d}
            </div>
          ))}
        </div>
      )}

      {(ev.unsupportedFilters.length > 0 || ev.warnings.length > 0) && (
        <div className="card">
          <h3>Warnings</h3>
          {ev.unsupportedFilters.length > 0 && (
            <div className="notice warn">
              Unsupported filters (evaluation is partial): <b>{ev.unsupportedFilters.join(', ')}</b>. RADAR shows the
              configuration but does not invent behaviour.
            </div>
          )}
          {ev.warnings.map((w, i) => (
            <div key={i} className="notice warn">
              {w}
            </div>
          ))}
        </div>
      )}

      <div className="notice info">
        RADAR explains how <b>NS1 selects the delivery platform</b> (Réalta / Fastly / Akamai / CloudFront). It does not
        model Cloudflare's later selection of the Réalta origin pool, and distributions are <b>probabilistic</b> — never a
        guaranteed traffic share.
      </div>
    </div>
  );
}
