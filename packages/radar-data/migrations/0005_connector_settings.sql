-- 0005_connector_settings: Engineer-managed connector connection settings (currently the
-- CloudVision network-telemetry connector). Non-secret fields are stored in the clear; the
-- service-account TOKEN is stored ONLY as authenticated-encryption ciphertext (AES-256-GCM)
-- with a per-write nonce and tag. The encryption master key is supplied at runtime via a
-- mounted secret and is NEVER stored here — a database backup therefore contains ciphertext
-- alone and no key. No plaintext token, authorization header or endpoint credential is ever
-- written to this table.

CREATE TABLE IF NOT EXISTS connector_settings (
  connector         text PRIMARY KEY,
  enabled           boolean NOT NULL DEFAULT false,
  mode              text NOT NULL DEFAULT 'mock',
  endpoint          text,
  verify_tls        boolean NOT NULL DEFAULT true,
  edge_device_ids   text,
  -- Encrypted token material (opaque; decrypted only inside the connector at runtime).
  token_ciphertext  bytea,
  token_nonce       bytea,
  token_tag         bytea,
  token_set_at      timestamptz,
  updated_by        text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE connector_settings IS 'Engineer-managed connector settings; token stored only as AES-256-GCM ciphertext, master key never persisted.';
COMMENT ON COLUMN connector_settings.token_ciphertext IS 'AES-256-GCM ciphertext of the service-account token; never plaintext.';
COMMENT ON COLUMN connector_settings.token_nonce IS 'Unique per-write 96-bit nonce for the token ciphertext.';
COMMENT ON COLUMN connector_settings.token_tag IS 'AES-256-GCM authentication tag for the token ciphertext.';
