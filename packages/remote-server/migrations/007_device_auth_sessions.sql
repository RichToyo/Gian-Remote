-- Password issuance sessions are separate from GitHub account peers and from
-- device pairings. Existing confirmed pairings keep their keys, but explicit
-- account-peer revocation remains authoritative across the admission upgrade.
UPDATE hosts SET revoked_at = (
  SELECT p.revoked_at FROM account_peers p
  WHERE p.role = 'host' AND p.installation_id = hosts.account_peer_id
) WHERE revoked_at IS NULL AND account_peer_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_peers p
  WHERE p.role = 'host' AND p.installation_id = hosts.account_peer_id AND p.revoked_at IS NOT NULL
);

UPDATE device_host_pairings SET revoked_at = (
  SELECT p.revoked_at FROM account_peers p
  WHERE p.role = 'controller' AND p.installation_id = device_host_pairings.account_peer_id
) WHERE revoked_at IS NULL AND account_peer_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_peers p
  WHERE p.role = 'controller' AND p.installation_id = device_host_pairings.account_peer_id
    AND p.revoked_at IS NOT NULL
);

CREATE TABLE enrollment_password_sessions (
  token_hash TEXT PRIMARY KEY,
  password_generation TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
