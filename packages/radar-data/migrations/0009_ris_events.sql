-- 0009_ris_events: bounded history of RIS Live BGP events observed for RTÉ's monitored
-- prefixes (announcements / withdrawals), so the BGP Intelligence timeline can look back
-- over a retention window instead of only the in-memory last-N. Read-only external
-- observation via RIPE RIS collectors — RADAR issues no BGP changes and stores no secrets;
-- only prefix/ASN/path metadata. Older rows are pruned past the retention horizon.
--
-- ris_connection_events records RIS Live connection state transitions so a collector gap is
-- visible as a gap in observation (not silently shown as "all quiet").

CREATE TABLE IF NOT EXISTS ris_events (
  id                text PRIMARY KEY,       -- stable RIS cluster id (prefix+kind+path dedup)
  kind              text NOT NULL,          -- 'announcement' | 'withdrawal'
  prefix            text NOT NULL,
  origin_asn        integer,                -- origin ASN (last hop), null for a withdrawal
  peer_asn          integer,                -- a representative RIS peer that reported it
  path              text,                   -- space-joined AS path (empty for a withdrawal)
  observation_count integer NOT NULL DEFAULT 1,
  first_at          timestamptz NOT NULL,
  last_at           timestamptz NOT NULL
);

-- Range scans and retention pruning are both ordered by the cluster's most-recent observation.
CREATE INDEX IF NOT EXISTS idx_ris_events_last_at ON ris_events (last_at DESC);
CREATE INDEX IF NOT EXISTS idx_ris_events_prefix ON ris_events (prefix, last_at DESC);

CREATE TABLE IF NOT EXISTS ris_connection_events (
  at     timestamptz PRIMARY KEY,
  state  text NOT NULL,                     -- 'connected' | 'reconnecting' | 'disconnected' | 'disabled'
  detail text
);

CREATE INDEX IF NOT EXISTS idx_ris_conn_at ON ris_connection_events (at DESC);
