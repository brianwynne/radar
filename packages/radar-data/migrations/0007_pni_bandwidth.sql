-- 0007_pni_bandwidth: append-only, bounded history of each PNI (private-peering)
-- interface's in/out bandwidth, captured from CloudVision on every poll, so the PNI
-- Graphs page can render a real time-series over the last 24 hours (older rows are
-- pruned). READ-ONLY-derived from CloudVision telemetry — RADAR issues no writes to any
-- device. No credentials, tokens or raw device data are stored; only numeric rates.

CREATE TABLE IF NOT EXISTS pni_bandwidth_samples (
  observed_at    timestamptz NOT NULL,
  device_id      text NOT NULL,
  interface_name text NOT NULL,
  provider       text,
  in_bps         double precision,
  out_bps        double precision,
  PRIMARY KEY (device_id, interface_name, observed_at)
);

-- Range scans and retention pruning are both time-ordered.
CREATE INDEX IF NOT EXISTS idx_pni_bw_at ON pni_bandwidth_samples (observed_at DESC);
