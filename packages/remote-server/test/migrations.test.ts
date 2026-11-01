import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { test } from 'node:test';

import { ENROLLMENT_TTL_MS } from '@gian/remote-protocol';

import { listColumns, listTables, openRemoteDatabase } from '../src/index.js';
import { RemoteRepositories } from '../src/storage/repositories.js';
import { runMigrations } from '../src/storage/db.js';
import { hashSecret } from '../src/crypto-hash.js';

test('upgrade invalidates old unbound unused tokens and preserves used enrollment history', () => {
  const db = new Database(':memory:');
  try {
    const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    db.exec('CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql') && name < '006').sort()) {
      db.exec(readFileSync(join(migrations, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(file, 'fixture');
    }
    const insert = db.prepare('INSERT INTO host_enrollments(id, token_hash, expires_at, created_at, used_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('unused', hashSecret('old-unused-token'), 900_000, 1, null);
    insert.run('used', hashSecret('old-used-token'), 900_000, 1, 2);
    runMigrations(db);
    assert.equal((db.prepare('SELECT expires_at FROM host_enrollments WHERE id = ?').get('unused') as { expires_at: number }).expires_at, 0);
    assert.equal((db.prepare('SELECT used_at FROM host_enrollments WHERE id = ?').get('used') as { used_at: number }).used_at, 2);
    const repos = new RemoteRepositories(db, () => 10);
    assert.equal(repos.claimEnrollment('old-unused-token', { name: 'Mac', public_key_jwk: '{}' }), null);
    runMigrations(db);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM host_enrollments').get() as { n: number }).n, 2);
  } finally { db.close(); }
});

test('migrations create only identity/relay tables and survive reopen', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-remote-db-'));
  const db = openRemoteDatabase(dataDir);
  const tables = listTables(db);
  assert.deepEqual(tables, [
    'account_challenges',
    'account_peers',
    'browser_installations',
    'connector_challenges',
    'controller_challenges',
    'controller_devices',
    'controller_enrollments',
    'controller_migration_challenges',
    'device_challenges',
    'device_host_pairings',
    'device_sessions',
    'enrollment_password_sessions',
    'enrollment_sessions',
    'host_credentials',
    'host_enrollments',
    'hosts',
    'pairing_grants',
    'presence_leases',
    'relay_outbox',
    'revocation_tombstones',
    'revoked_pairing_keys',
    'schema_migrations',
    'ws_tickets',
  ]);
  assert.ok(listColumns(db, 'host_credentials').includes('previous_refresh_secret_hash'));
  assert.equal(listColumns(db, 'host_credentials').includes('issued_refresh_secret'), false);
  assert.ok(listColumns(db, 'revocation_tombstones').includes('public_key_jwk'));
  for (const table of tables) {
    const columns = listColumns(db, table).join(',');
    assert.doesNotMatch(columns, /prompt|transcript|session_title|queue_text|workspace_path/);
  }
  assert.ok(listColumns(db, 'device_host_pairings').includes('crypto_connection_id'));
  assert.ok(listColumns(db, 'host_enrollments').includes('github_account_id'));
  assert.ok(listColumns(db, 'account_peers').includes('delegated_host_id'));
  assert.deepEqual(listColumns(db, 'enrollment_password_sessions').sort(), ['expires_at', 'password_generation', 'token_hash']);
  const migration007 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '007_device_auth_sessions.sql'), 'utf8');
  assert.match(migration007, /p\.revoked_at IS NOT NULL/);
  assert.doesNotMatch(migration007, /confirmed_at\s*=|revoked_at\s*=\s*NULL|account_peers\.expires_at/i);
  db.close();
  const reopened = openRemoteDatabase(dataDir);
  assert.ok(listTables(reopened).includes('schema_migrations'));
  reopened.close();
});

test('upgrade preserves explicit peer revocations without treating expiry as revocation', () => {
  const db = new Database(':memory:');
  try {
    const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    db.exec('CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql') && name < '007').sort()) {
      db.exec(readFileSync(join(migrations, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(file, 'fixture');
    }
    const peer = db.prepare(`INSERT INTO account_peers(
      role, installation_id, github_account_id, github_login, public_key_fingerprint,
      server_identity_fingerprint, token_hash, verified_at, expires_at, revoked_at
    ) VALUES (?, ?, '42', 'owner', ?, ?, ?, 1, ?, ?)`);
    peer.run('host', 'host-revoked', 'h', 's', 'hr', 100, 20);
    peer.run('host', 'host-expired', 'h', 's', 'he', 100, null);
    peer.run('controller', 'controller-revoked', 'c', 's', 'cr', 100, 30);
    peer.run('controller', 'controller-expired', 'c', 's', 'ce', 100, null);
    const host = db.prepare('INSERT INTO hosts(id, name, public_key_jwk, created_at, account_peer_id) VALUES (?, ?, ?, 1, ?)');
    host.run('revoked-host', 'revoked', '{}', 'host-revoked');
    host.run('live-host', 'live', '{}', 'host-expired');
    const browser = db.prepare('INSERT INTO browser_installations(id, created_at) VALUES (?, 1)');
    for (const id of ['revoked-browser', 'expired-browser', 'new-browser']) browser.run(id);
    const pairing = db.prepare(`INSERT INTO device_host_pairings(
      id, browser_installation_id, host_id, public_key_jwk, platform, user_agent,
      created_at, confirmed_at, account_peer_id
    ) VALUES (?, ?, 'live-host', '{}', 'test', 'test', 1, 1, ?)`);
    pairing.run('revoked-controller', 'revoked-browser', 'controller-revoked');
    pairing.run('expired-controller', 'expired-browser', 'controller-expired');
    pairing.run('new-device', 'new-browser', null);
    runMigrations(db);
    runMigrations(db);
    assert.equal((db.prepare("SELECT revoked_at FROM hosts WHERE id = 'revoked-host'").get() as { revoked_at: number }).revoked_at, 20);
    assert.equal((db.prepare("SELECT revoked_at FROM hosts WHERE id = 'live-host'").get() as { revoked_at: null }).revoked_at, null);
    assert.deepEqual(db.prepare(`SELECT id, revoked_at FROM device_host_pairings ORDER BY id`).all(), [
      { id: 'expired-controller', revoked_at: null },
      { id: 'new-device', revoked_at: null },
      { id: 'revoked-controller', revoked_at: 30 },
    ]);
  } finally { db.close(); }
});

test('cleanup removes expired unused grants and tickets without business tables', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-remote-db-'));
  let now = Date.UTC(2026, 8, 1);
  const db = openRemoteDatabase(dataDir);
  const repos = new RemoteRepositories(db, () => now);
  const tables = listTables(db);
  for (const forbidden of ['sessions', 'tasks', 'queue', 'transcripts', 'messages', 'attachments', 'commands']) {
    assert.equal(tables.includes(forbidden), false);
  }
  assert.throws(() => {
    db.prepare(`
      INSERT INTO device_host_pairings(
        id, browser_installation_id, host_id, public_key_jwk, platform, user_agent, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('id', 'missing-browser', 'missing-host', '{}', 'macOS', 'x', now);
  });
  now += 1;
  repos.cleanupExpired();
  db.close();
});

test('cleanup expires controller records without deleting live rows or referenced identities', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-remote-db-'));
  const now = Date.UTC(2026, 8, 1);
  const db = openRemoteDatabase(dataDir);
  try {
    const repos = new RemoteRepositories(db, () => now);
    db.prepare("INSERT INTO hosts(id, name, public_key_jwk, created_at) VALUES ('host', 'Host', '{}', ?)").run(now);
    repos.ensureBrowser('controller');
    db.prepare(`INSERT INTO controller_devices(browser_installation_id, public_key_jwk, platform, created_at)
      VALUES ('controller', '{}', 'iOS', ?)`).run(now);
    db.prepare(`INSERT INTO device_host_pairings(
      id, browser_installation_id, host_id, public_key_jwk, platform, user_agent, created_at, confirmed_at
    ) VALUES ('pairing', 'controller', 'host', '{}', 'iOS', 'test', ?, ?)`).run(now, now);
    const family = repos.createRefreshFamily('controller', 'refresh-secret');
    const hostEnrollment = repos.createEnrollment('host-enrollment');
    db.prepare(`UPDATE host_enrollments
      SET expires_at = ?, used_at = ?, claimed_host_id = 'host' WHERE id = ?`)
      .run(now - 1, now - 1, hostEnrollment.id);

    const enrollment = db.prepare(`INSERT INTO controller_enrollments(
      id, token_hash, expires_at, used_at, claimed_browser_installation_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`);
    enrollment.run('expired-used', hashSecret('expired-used'), now - ENROLLMENT_TTL_MS,
      now - ENROLLMENT_TTL_MS, 'controller', now - ENROLLMENT_TTL_MS * 2);
    enrollment.run('expired-unused', hashSecret('expired-unused'), now - ENROLLMENT_TTL_MS,
      null, null, now - ENROLLMENT_TTL_MS * 2);
    enrollment.run('recent-used', hashSecret('recent-used'), now - 1, now - 1, 'controller', now - 2);
    enrollment.run('live-unused', hashSecret('live-unused'), now + 1_000, null, null, now);

    const expiredControllerChallenge = repos.createControllerChallenge('controller', 'expired-challenge', -1);
    const liveControllerChallenge = repos.createControllerChallenge('controller', 'live-challenge', 1_000);
    const expiredMigration = repos.createControllerMigrationChallenge({
      browserInstallationId: 'controller', hostId: 'host', publicKeyJwk: '{}', challenge: 'expired-migration', ttlMs: -1,
    });
    const liveMigration = repos.createControllerMigrationChallenge({
      browserInstallationId: 'controller', hostId: 'host', publicKeyJwk: '{}', challenge: 'live-migration', ttlMs: 1_000,
    });

    repos.cleanupExpired();

    assert.deepEqual(db.prepare('SELECT id FROM controller_enrollments ORDER BY id').all(), [
      { id: 'expired-unused' },
      { id: 'live-unused' },
      { id: 'recent-used' },
    ]);
    assert.deepEqual(db.prepare('SELECT id FROM controller_challenges').all(), [{ id: liveControllerChallenge.id }]);
    assert.deepEqual(db.prepare('SELECT id FROM controller_migration_challenges').all(), [{ id: liveMigration.id }]);
    assert.equal(repos.getControllerMigrationChallenge(expiredMigration.id), undefined);
    assert.equal(db.prepare('SELECT id FROM controller_challenges WHERE id = ?').get(expiredControllerChallenge.id), undefined);
    assert.deepEqual(db.prepare('SELECT id FROM host_enrollments').all(), [{ id: hostEnrollment.id }]);
    assert.equal(repos.getHost('host')?.name, 'Host');
    assert.equal(repos.getController('controller')?.platform, 'iOS');
    assert.equal(repos.getPairing('pairing')?.confirmed_at, now);
    assert.equal(repos.getSession(family.id)?.browser_installation_id, 'controller');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
