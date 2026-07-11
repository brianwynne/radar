-- 0002_live_steering: durable change-detection checkpoint, latest per-ISP steering state,
-- and persistent meaningful steering-change events. Read-only-derived data (RADAR never
-- writes to NS1); these tables back the Live Steering views and multi-replica-safe polling.

CREATE TABLE IF NOT EXISTS change_detection_checkpoints (
  source                 text PRIMARY KEY,
  checkpoint_id          text,
  checkpoint_occurred_at timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_steering_states (
  isp_id                  text NOT NULL,
  resource_key            text NOT NULL,
  isp_name                text NOT NULL,
  asn                     integer,
  fingerprint             text NOT NULL,
  identity_source         text,
  country                 text,
  matched_prefix          text,
  preferred_path          text,
  eligible_answer_ids     jsonb NOT NULL DEFAULT '[]'::jsonb,
  distribution            jsonb NOT NULL DEFAULT '[]'::jsonb,
  filter_chain            jsonb NOT NULL DEFAULT '[]'::jsonb,
  complete                boolean NOT NULL DEFAULT true,
  stopped_at_filter_index integer,
  structural_checksum     text,
  evaluated_at            timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (isp_id, resource_key)
);

CREATE INDEX IF NOT EXISTS idx_steering_states_asn      ON live_steering_states (asn);
CREATE INDEX IF NOT EXISTS idx_steering_states_resource ON live_steering_states (resource_key);

CREATE TABLE IF NOT EXISTS steering_change_events (
  id                    uuid PRIMARY KEY,
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  isp_id                text NOT NULL,
  isp_name              text NOT NULL,
  asn                   integer,
  resource_key          text NOT NULL,
  reason                text NOT NULL,
  previous_fingerprint  text,
  current_fingerprint   text NOT NULL,
  previous_state        jsonb,
  current_state         jsonb NOT NULL,
  previous_checksum     text,
  current_checksum      text,
  activity              jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_steering_events_occurred ON steering_change_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_steering_events_isp      ON steering_change_events (isp_id);
CREATE INDEX IF NOT EXISTS idx_steering_events_asn      ON steering_change_events (asn);
CREATE INDEX IF NOT EXISTS idx_steering_events_resource ON steering_change_events (resource_key);
