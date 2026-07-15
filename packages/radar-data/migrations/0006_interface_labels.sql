-- 0006_interface_labels: operator-assigned friendly names for network interfaces, keyed by
-- (device_id, interface_name). Read-only telemetry from CloudVision has no place to store
-- these, so RADAR persists them here. Purely descriptive annotations — no effect on steering.

CREATE TABLE IF NOT EXISTS interface_labels (
  device_id      text NOT NULL,
  interface_name text NOT NULL,
  friendly_name  text NOT NULL,
  updated_by     text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, interface_name)
);

COMMENT ON TABLE interface_labels IS 'Operator-assigned friendly names for interfaces (device_id, interface_name) → friendly_name.';
