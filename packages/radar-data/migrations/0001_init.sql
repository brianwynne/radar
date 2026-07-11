-- 0001_init: RADAR persistence foundation.
-- configuration_snapshots: immutable captures of upstream configuration (e.g. NS1 zones
--   and records), raw payload preserved verbatim plus a canonical form and checksums.
-- audit_events: security and operational audit trail.
-- Payloads and details are stored inline as JSONB; nothing is written to the filesystem
-- or blob storage. RADAR v1 is read-only towards NS1 (ADR-0001).

CREATE TABLE IF NOT EXISTS configuration_snapshots (
  id                  uuid PRIMARY KEY,
  source_system       text NOT NULL,
  resource_kind       text NOT NULL,
  resource_key        text NOT NULL,
  source_endpoint     text,
  retrieved_at        timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by_subject  text,
  label               text,
  raw_payload         jsonb NOT NULL,
  canonical_payload   jsonb NOT NULL,
  raw_checksum        text NOT NULL,
  structural_checksum text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_snapshots_resource
  ON configuration_snapshots (resource_kind, resource_key, retrieved_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_source
  ON configuration_snapshots (source_system);
CREATE INDEX IF NOT EXISTS idx_snapshots_checksum
  ON configuration_snapshots (raw_checksum);
CREATE INDEX IF NOT EXISTS idx_snapshots_created
  ON configuration_snapshots (created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id                    uuid PRIMARY KEY,
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  actor_subject         text,
  actor_roles           text[] NOT NULL DEFAULT '{}',
  authentication_method text,
  action                text NOT NULL,
  resource_type         text,
  resource_key          text,
  outcome               text NOT NULL,
  correlation_id        text,
  details               jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_occurred    ON audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor       ON audit_events (actor_subject);
CREATE INDEX IF NOT EXISTS idx_audit_action      ON audit_events (action);
CREATE INDEX IF NOT EXISTS idx_audit_resource    ON audit_events (resource_type, resource_key);
CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_events (correlation_id);
