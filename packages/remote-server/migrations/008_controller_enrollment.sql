CREATE TABLE controller_enrollments (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  claimed_browser_installation_id TEXT REFERENCES browser_installations(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE controller_devices (
  browser_installation_id TEXT PRIMARY KEY REFERENCES browser_installations(id) ON DELETE CASCADE,
  public_key_jwk TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE controller_challenges (
  id TEXT PRIMARY KEY,
  browser_installation_id TEXT NOT NULL REFERENCES controller_devices(browser_installation_id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE controller_migration_challenges (
  id TEXT PRIMARY KEY,
  browser_installation_id TEXT NOT NULL REFERENCES browser_installations(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  public_key_jwk TEXT NOT NULL,
  challenge_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
