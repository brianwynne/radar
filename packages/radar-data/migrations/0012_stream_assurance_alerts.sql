-- 0012_stream_assurance_alerts: durable alert lifecycle for Stream Assurance findings. A finding
-- identity (profile + endpoint + rule + classification) persists across runs so it can be promoted
-- observed → pending → active, acknowledged by an operator, and auto-resolved — rather than being a
-- fresh one-shot each run. No media/keys/secrets; only classification, evidence and lifecycle state.

CREATE TABLE IF NOT EXISTS sa_alerts (
  id                  text PRIMARY KEY,       -- stable: profileId:endpointId:ruleId:classification
  profile_id          text NOT NULL,
  endpoint_id         text NOT NULL,
  rule_id             text NOT NULL,
  classification      text NOT NULL,
  severity            text NOT NULL,
  state               text NOT NULL,          -- observed | pending | active | acknowledged | resolved
  consecutive_present integer NOT NULL DEFAULT 0,
  consecutive_absent  integer NOT NULL DEFAULT 0,
  occurrences         integer NOT NULL DEFAULT 0,
  first_observed      timestamptz NOT NULL,
  last_observed       timestamptz NOT NULL,
  explanation         text,
  remediation         text,
  evidence            jsonb,
  acknowledged_by     text,
  acknowledged_at     timestamptz,
  updated_at          timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sa_alerts_profile ON sa_alerts (profile_id, state);
