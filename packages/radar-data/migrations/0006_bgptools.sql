-- 0006_bgptools: read-only bgp.tools routing-intelligence persistence. Three tables:
--   * bgptools_monitored_prefixes — the Engineer-managed watch list (prefix → expected origin ASN)
--   * bgptools_observations       — raw table observations, recorded only when content CHANGES
--                                    (a change-log timeline, not every identical poll), retained
--   * bgptools_incidents          — grouped routing incidents with a lifecycle
-- The connector's connection settings + encrypted API token reuse the shared connector_settings
-- table (connector = 'bgptools'), so no secret material is stored here. All timestamps are UTC.

CREATE TABLE IF NOT EXISTS bgptools_monitored_prefixes (
  prefix              text PRIMARY KEY,
  address_family      text NOT NULL CHECK (address_family IN ('ipv4', 'ipv6')),
  expected_origin_asn bigint NOT NULL CHECK (expected_origin_asn > 0),
  description         text,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE bgptools_monitored_prefixes IS 'Engineer-managed bgp.tools watch list: prefix and the origin ASN it is expected to be announced from.';

CREATE TABLE IF NOT EXISTS bgptools_observations (
  id               uuid PRIMARY KEY,
  prefix           text NOT NULL,
  address_family   text NOT NULL CHECK (address_family IN ('ipv4', 'ipv6')),
  -- Observed origins for the prefix: [{ "asn": <int>, "hits": <int> }]. Empty array = withdrawn.
  origins          jsonb NOT NULL,
  -- SHA-256 over the normalised origins, so an unchanged poll is skipped (change-log, not a firehose).
  content_checksum text NOT NULL,
  observed_at      timestamptz NOT NULL,
  source           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bgptools_observations_prefix_time ON bgptools_observations (prefix, observed_at DESC);

COMMENT ON TABLE bgptools_observations IS 'Raw bgp.tools table observations per prefix, stored only when the origin set changes; retained for the visibility timeline.';

CREATE TABLE IF NOT EXISTS bgptools_incidents (
  id                uuid PRIMARY KEY,
  prefix            text NOT NULL,
  -- 'withdrawn' | 'hijack' | 'moas' | 'visibility_loss'
  kind              text NOT NULL,
  -- 'degraded' | 'critical'
  severity          text NOT NULL,
  -- 'detected' | 'active' | 'acknowledged' | 'resolved' | 'suppressed'
  state             text NOT NULL,
  first_detected_at timestamptz NOT NULL,
  last_observed_at  timestamptz NOT NULL,
  resolved_at       timestamptz,
  observation_count integer NOT NULL DEFAULT 1,
  -- Latest evidence (normalised signal + reasons) so the operator sees why it fired.
  evidence          jsonb NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bgptools_incidents_state ON bgptools_incidents (state);
CREATE INDEX IF NOT EXISTS bgptools_incidents_prefix_time ON bgptools_incidents (prefix, first_detected_at DESC);

-- At most one OPEN incident per (prefix, kind): the poller updates it instead of flooding new rows.
CREATE UNIQUE INDEX IF NOT EXISTS bgptools_incidents_open_one
  ON bgptools_incidents (prefix, kind)
  WHERE state IN ('detected', 'active', 'acknowledged');

COMMENT ON TABLE bgptools_incidents IS 'Grouped bgp.tools routing incidents with a lifecycle; one open incident per prefix+kind (partial unique index).';
