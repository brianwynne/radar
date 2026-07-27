-- 0011_stream_assurance: Stream Conformance & CDN Consistency. Two bounded tables — profiles hold
-- the operator-defined channel + endpoint configuration; runs hold a bounded snapshot of each probe
-- run's per-endpoint observations and findings. No media, no keys, no secrets are stored: only
-- parsed metadata (KIDs are identifiers), cache/header evidence and classification results. Endpoint
-- and run detail are kept as jsonb for a first slice; retention pruning removes old runs.

CREATE TABLE IF NOT EXISTS sa_profiles (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  -- { endpoints:[…], referenceEndpointId, originHost, authoritativeKid, tags:[…] } — no secrets.
  config     jsonb NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sa_runs (
  id            text PRIMARY KEY,
  profile_id    text NOT NULL,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz,
  mode          text NOT NULL,          -- 'normal' | 'event' | 'conformance'
  status        text NOT NULL,          -- 'ok' | 'findings' | 'error'
  observations  jsonb NOT NULL,         -- bounded per-endpoint observations
  findings      jsonb NOT NULL,         -- classified findings (rule id, evidence, remediation)
  finding_count integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sa_runs_profile ON sa_runs (profile_id, started_at DESC);
