-- The PNI Graphs 24h view aggregates every sample in a trailing window. Without an index on
-- observed_at the range query full-scans the whole retention (~7 days) and intermittently exceeds the
-- DB statement timeout as the table grows ("could not load PNI bandwidth history"). Index the
-- timestamp so the window scan is bounded — matching the other history tables (delivery, RIS, DNS).
CREATE INDEX IF NOT EXISTS idx_pni_bw_observed ON pni_bandwidth_samples (observed_at);
