// Provenance / mock-disclosure UI. Every NS1-derived view must show its source mode and,
// in mock mode, that the data is synthetic and non-production.
import type { Provenance } from '../api/types';

export function SyntheticTag({ synthetic }: { synthetic: boolean }) {
  return synthetic ? (
    <span className="badge warn" title="Synthetic / mock — not production data">
      MOCK · SYNTHETIC
    </span>
  ) : (
    <span className="badge ok">LIVE</span>
  );
}

export function ProvenanceLine({ p }: { p: Provenance }) {
  return (
    <div className="muted" style={{ fontSize: '0.78rem', marginTop: '0.4rem' }}>
      <SyntheticTag synthetic={p.synthetic} /> Source: NS1 ({p.mode}) · read-only · <code>{p.endpoint}</code> · retrieved{' '}
      {new Date(p.retrievedAt).toLocaleString()}
      {p.disclaimer ? (
        <>
          {' '}
          · <strong>{p.disclaimer}</strong>
        </>
      ) : null}
    </div>
  );
}
