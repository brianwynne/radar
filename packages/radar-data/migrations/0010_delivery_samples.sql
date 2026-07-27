-- 0010_delivery_samples: bounded history of total live delivery throughput, split into RTÉ's own
-- Réalta CDN (eyeball PNI delivery) and the commercial CDNs (Fastly + Akamai), sampled periodically
-- so the Dashboard delivery pie can show a 1-hour average alongside the live total. READ-ONLY-derived
-- from CloudVision + commercial-CDN telemetry — no credentials, tokens or raw data are stored, only
-- aggregate bit-rates. Old rows are pruned past the retention horizon (~25h so any 1h window is covered).

CREATE TABLE IF NOT EXISTS delivery_samples (
  observed_at    timestamptz PRIMARY KEY,
  realta_bps     double precision,   -- Réalta eyeball delivery (sum of eyeball PNI out-bps)
  commercial_bps double precision,   -- Fastly + Akamai
  total_bps      double precision
);

CREATE INDEX IF NOT EXISTS idx_delivery_at ON delivery_samples (observed_at DESC);
