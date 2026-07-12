-- 0004_ns1_validations: bounded results of read-only production-readiness validation of live
-- NS1 data against RADAR's runtime schemas/adapters and synthetic fixtures. RADAR NEVER writes
-- to NS1. No API key, bearer token, request headers, cookies or unsanitised secrets are stored;
-- `sanitised_sample` is credential-redacted and structural only.

CREATE TABLE IF NOT EXISTS ns1_validation_results (
  id                      uuid PRIMARY KEY,
  ran_at                  timestamptz NOT NULL DEFAULT now(),
  endpoint                text NOT NULL,
  zone                    text,
  domain                  text,
  record_type             text,
  source_mode             text NOT NULL,
  retrieved_at            timestamptz,
  raw_checksum            text,
  structural_checksum     text,
  overall_status          text NOT NULL,
  schema_compatible       boolean NOT NULL DEFAULT false,
  adapter_compatible      boolean NOT NULL DEFAULT false,
  supported_filters       jsonb NOT NULL DEFAULT '[]'::jsonb,
  unsupported_filters     jsonb NOT NULL DEFAULT '[]'::jsonb,
  unknown_fields          jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_fields          jsonb NOT NULL DEFAULT '[]'::jsonb,
  type_mismatches         jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer_groups_present   boolean NOT NULL DEFAULT false,
  feed_controlled_present boolean NOT NULL DEFAULT false,
  ecs                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  fixture_comparison      jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings                jsonb NOT NULL DEFAULT '[]'::jsonb,
  sanitised_sample        jsonb,
  correlation_id          text
);

CREATE INDEX IF NOT EXISTS idx_ns1_val_ran      ON ns1_validation_results (ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_ns1_val_record   ON ns1_validation_results (zone, domain, record_type);
CREATE INDEX IF NOT EXISTS idx_ns1_val_status   ON ns1_validation_results (overall_status);
CREATE INDEX IF NOT EXISTS idx_ns1_val_checksum ON ns1_validation_results (raw_checksum);
