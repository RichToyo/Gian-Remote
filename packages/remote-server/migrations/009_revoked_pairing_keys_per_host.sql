-- A key revocation belongs to the Host it was recorded on: it blocks that
-- Host's pairings of the key created at or before revoked_at, and no other
-- Host's. A row without a Host ('') keeps blocking the key on every Host.
CREATE TABLE revoked_pairing_keys_per_host (
  public_key_hash TEXT NOT NULL,
  host_id TEXT NOT NULL,
  public_key_jwk TEXT NOT NULL,
  device_id TEXT NOT NULL,
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (public_key_hash, host_id)
);

INSERT INTO revoked_pairing_keys_per_host(public_key_hash, host_id, public_key_jwk, device_id, revoked_at)
  SELECT public_key_hash, COALESCE(host_id, ''), public_key_jwk, device_id, revoked_at
    FROM revoked_pairing_keys;

DROP TABLE revoked_pairing_keys;
ALTER TABLE revoked_pairing_keys_per_host RENAME TO revoked_pairing_keys;
