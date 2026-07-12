-- 0003_dns_observations: bounded history of Tier-2 active DNS observations — what a
-- configured resolver actually returned for a watched record, compared with RADAR's
-- predicted NS1 evaluation. READ-ONLY-derived (RADAR never writes to NS1 or Cloudflare).
-- No tokens, credentials, NS1 keys, packet captures or raw resolver logs are ever stored.

CREATE TABLE IF NOT EXISTS dns_observations (
  id                 uuid PRIMARY KEY,
  observed_at        timestamptz NOT NULL DEFAULT now(),
  isp_id             text NOT NULL,
  isp_name           text NOT NULL,
  asn                integer,
  resolver_ip        text,
  zone               text NOT NULL,
  domain             text NOT NULL,
  record_type        text NOT NULL,
  ecs_requested      boolean NOT NULL DEFAULT false,
  ecs_prefix         text,
  ecs_honoured       boolean,
  response_code      text,
  observed_answers   jsonb NOT NULL DEFAULT '[]'::jsonb,
  predicted_answers  jsonb NOT NULL DEFAULT '[]'::jsonb,
  comparison_status  text NOT NULL,
  confidence         text NOT NULL,
  ttl                integer,
  latency_ms         integer,
  record_checksum    text,
  explanation        text,
  warnings           jsonb NOT NULL DEFAULT '[]'::jsonb,
  provenance         jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id     text
);

CREATE INDEX IF NOT EXISTS idx_dns_obs_observed   ON dns_observations (observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dns_obs_isp        ON dns_observations (isp_id);
CREATE INDEX IF NOT EXISTS idx_dns_obs_resolver   ON dns_observations (resolver_ip);
CREATE INDEX IF NOT EXISTS idx_dns_obs_record     ON dns_observations (zone, domain, record_type);
CREATE INDEX IF NOT EXISTS idx_dns_obs_comparison ON dns_observations (comparison_status);
CREATE INDEX IF NOT EXISTS idx_dns_obs_checksum   ON dns_observations (record_checksum);
