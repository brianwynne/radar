// Presentational "Observed DNS answer" tier (Tier 2) for a Live Steering ISP card. Shows
// what a resolver actually returned and RADAR's predicted-vs-observed comparison — clearly
// separate from the predicted-steering tier and from actual traffic telemetry. Never claims
// anything about delivered traffic. Highlights (distinct from a steering change) when the
// observation changes.
import type { DnsComparisonStatus, DnsObservationItem } from '../api/types';
import { formatFreshness } from './format';

const STATUS: Record<DnsComparisonStatus, { label: string; badge: string }> = {
  match: { label: 'match', badge: 'ok' },
  partial_match: { label: 'partial match', badge: 'warn' },
  mismatch: { label: 'mismatch', badge: 'danger' },
  observation_unavailable: { label: 'observation unavailable', badge: 'neutral' },
  confidence_low: { label: 'confidence low', badge: 'warn' },
  unknown: { label: 'unknown', badge: 'neutral' },
};

const REASON_LABELS: Record<string, string> = {
  observed_answer_set_changed: 'Observed answer set changed',
  predicted_observed_match_changed: 'Predicted-vs-observed status changed',
  ecs_behaviour_changed: 'ECS behaviour changed',
  resolver_changed: 'Resolver changed',
  ttl_changed: 'TTL changed',
  observation_became_unavailable: 'Observation became unavailable',
  observation_recovered: 'Observation recovered',
  confidence_changed: 'Confidence changed',
  unknown_change: 'Observation changed',
};

export function DnsObservationTier({ observation, highlighted, reason, reduceMotion, detail }: { observation: DnsObservationItem | null; highlighted?: boolean; reason?: string; reduceMotion?: boolean; detail?: boolean }) {
  const cls = `observation-tier${highlighted ? (reduceMotion ? ' changed no-animate' : ' changed') : ''}`;
  if (!observation) {
    return (
      <div className={cls}>
        <div className="tele-row">
          <span className="tier-label">Observed DNS answer</span>
          <span className="muted">No observation yet — run one to verify what resolvers return.</span>
        </div>
      </div>
    );
  }
  const s = STATUS[observation.comparisonStatus];
  const ecs = observation.ecsRequested ? (observation.ecsHonoured ? 'ECS honoured' : 'ECS requested, not honoured') : 'no ECS';
  const answers = observation.observedAnswers.map((a) => a.address).join(', ') || '—';
  return (
    <div className={cls}>
      <div className="tele-row">
        <span className="tier-label">Observed DNS answer</span>
        <span className={`badge ${s.badge}`}>{s.label}</span>
        {highlighted && <span className="badge info">changed</span>}
      </div>
      <div className="tele-row muted" style={{ fontSize: '0.76rem' }}>
        {answers} · resolver {observation.resolverIp ?? '—'} · {ecs} · confidence {observation.confidence}
        {observation.ttl !== undefined && ` · TTL ${observation.ttl}s`}
        {observation.latencyMs !== undefined && ` · ${observation.latencyMs}ms`}
        {' · '}
        {formatFreshness(observation.freshness.ageSeconds)}
      </div>
      {highlighted && reason && <div className="tele-row muted" style={{ fontSize: '0.74rem' }}>{REASON_LABELS[reason] ?? 'Observation changed'} (observed DNS, not traffic).</div>}
      {detail && observation.differences.length > 0 && (
        <ul className="notes" style={{ fontSize: '0.74rem' }}>
          {observation.differences.map((d, i) => (
            <li key={i}><span className="mono">{d.kind}</span> — {d.detail}</li>
          ))}
        </ul>
      )}
      {detail && observation.explanation && <div className="tele-row muted" style={{ fontSize: '0.72rem' }}>{observation.explanation}</div>}
    </div>
  );
}
