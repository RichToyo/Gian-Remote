import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveName, checksumText, json, readReceipt, repository, sha256, tooling, validateReleaseReceipt, verifyOfflineBundle } from '../scripts/release-metadata.mjs';
import { deploySsh, deploymentTarget, downloadRelease, parseArgs } from '../scripts/deploy-ssh.mjs';
import { imageArchive } from './image-archive-fixture.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'remote-offline-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const describe = (file, bytes) => ({ file, size: bytes.length, sha256: sha256(bytes) });
  const tools = tooling.map(item => {
    const bytes = readFileSync(new URL('../' + item.source, import.meta.url));
    writeFileSync(join(directory, item.file), bytes);
    return { ...describe(item.file, bytes), source: item.source };
  });
  const images = ['amd64', 'arm64'].map((arch, index) => {
    const bytes = Buffer.from('fake docker-save archive for ' + arch);
    const file = archiveName('v1.2.3', arch);
    if (arch === 'amd64') writeFileSync(join(directory, file), bytes);
    const configDigest = 'sha256:' + String(index + 1).repeat(64);
    return { platform: 'linux/' + arch, buildImageId: configDigest, configDigest,
      manifestDigest: 'sha256:' + String(index + 3).repeat(64), ...describe(file, bytes) };
  });
  const receipt = { schema: 3, repository, tag: 'v1.2.3', version: '1.2.3', sourceCommit: 'a'.repeat(40),
    sourceDevCommit: 'b'.repeat(40), dataSchema: 'c'.repeat(64), images, tooling: tools };
  const write = value => {
    writeFileSync(join(directory, 'remote-release.json'), json(value));
    writeFileSync(join(directory, 'SHA256SUMS'), checksumText(value, sha256(json(value))));
  };
  write(receipt);
  const published = {
    tag_name: receipt.tag, draft: false, prerelease: false, published_at: '2026-10-22T00:00:00Z',
    assets: [...images, ...tools,
      describe('remote-release.json', Buffer.from(json(receipt))),
      describe('SHA256SUMS', readFileSync(join(directory, 'SHA256SUMS'))),
    ].map(asset => ({ name: asset.file, size: asset.size, digest: 'sha256:' + asset.sha256, state: 'uploaded' })),
  };
  const tree = tools.map(item => {
    const bytes = readFileSync(join(directory, item.file));
    return { path: item.source, type: 'blob', mode: '100644',
      sha: createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') };
  });
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'gh') {
      const route = args[1] ?? '';
      if (args[0] === 'release') throw new Error('Unexpected redownload');
      if (route.endsWith('/releases/tags/' + receipt.tag) || route.endsWith('/releases/latest')) return JSON.stringify(published);
      if (route.endsWith('/git/ref/tags/' + receipt.tag)) return JSON.stringify({ object: { type: 'commit', sha: receipt.sourceCommit } });
      if (route.includes('/compare/')) return JSON.stringify({ status: 'ahead' });
      if (route.includes('/git/trees/')) return JSON.stringify({ truncated: false, tree });
      throw new Error('Unexpected gh request');
    }
    if (command === 'ssh' && args.at(-1).includes('mktemp')) return '/srv/gian-remote/incoming.1234abcd\n';
    if (command === 'ssh' || command === 'scp') return '';
    throw new Error('No local Docker/build/test process is permitted in this fixture');
  };
  const options = { directory, arch: 'amd64', host: 'remote-alias', deployDir: '/srv/gian-remote', project: 'current', volume: 'current_remote-data' };
  return { directory, receipt, write, published, tree, calls, run, options };
}

test('schema 3 distinguishes build/config/manifest IDs and rejects unbound or legacy metadata', t => {
  const f = fixture(t);
  assert.equal(validateReleaseReceipt(f.receipt, { repository, tag: 'v1.2.3', revision: 'a'.repeat(40) }), f.receipt);
  for (const change of [{ schema: 1 }, { schema: 2 }, { extra: true }, { tag: 'v1.2.3-beta1' }, { dataSchema: '' },
    { sourceCommit: 'bad' }, { repository: 'RichLogic/Gian-Remote' }, { images: f.receipt.images.slice(0, 1) },
    { images: [{ ...f.receipt.images[0], file: '../image.tar.gz' }, f.receipt.images[1]] },
    { images: [{ ...f.receipt.images[0], buildImageId: 'gian-remote:latest' }, f.receipt.images[1]] },
    { images: [{ ...f.receipt.images[0], buildImageId: 'sha256:' + 'f'.repeat(64) }, f.receipt.images[1]] },
    { images: [{ ...f.receipt.images[0], manifestDigest: f.receipt.images[0].configDigest }, f.receipt.images[1]] },
    { images: [{ ...f.receipt.images[0], platform: 'linux/arm64' }, f.receipt.images[1]] },
    { tooling: [{ ...f.receipt.tooling[0], source: 'other.sh' }, ...f.receipt.tooling.slice(1)] },
  ]) assert.throws(() => validateReleaseReceipt({ ...f.receipt, ...change }));
});

test('receipt creation checks both saved artifacts and preserves immutable outputs', t => {
  const base = mkdtempSync(join(tmpdir(), 'remote-receipt-create-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const name of ['artifacts', 'scripts', 'packages/remote-server/migrations']) mkdirSync(join(base, name), { recursive: true });
  writeFileSync(join(base, 'release.json'), json({ repository, version: '1.2.3' }));
  writeFileSync(join(base, '.gian-source.json'), json({ workingTree: false, sourceCommit: 'b'.repeat(40) }));
  writeFileSync(join(base, 'packages/remote-server/migrations/001.sql'), 'fixture migration');
  for (const item of tooling) copyFileSync(fileURLToPath(new URL('../' + item.source, import.meta.url)), join(base, item.source));
  for (const arch of ['amd64', 'arm64']) {
    const saved = imageArchive({ arch }); const bytes = saved.bytes; const file = archiveName('v1.2.3', arch);
    writeFileSync(join(base, 'artifacts', file), bytes);
    writeFileSync(join(base, 'artifacts/image-' + arch + '.json'), json({ sourceCommit: 'a'.repeat(40), tag: 'v1.2.3',
      platform: 'linux/' + arch, buildImageId: saved.configDigest, configDigest: saved.configDigest,
      manifestDigest: saved.manifestDigest, file, size: bytes.length, sha256: sha256(bytes) }));
  }
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/release-metadata.mjs', import.meta.url)), 'create', 'remote-release.json'],
    { cwd: base, env: { ...process.env, GITHUB_REPOSITORY: repository, RELEASE_TAG: 'v1.2.3', RELEASE_SHA: 'a'.repeat(40) }, encoding: 'utf8' });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const original = readFileSync(join(base, 'remote-release.json'), 'utf8');
  assert.equal(JSON.parse(original).dataSchema, sha256(Buffer.from('001.sql\0fixture migration\0')));
  assert.notEqual(run().status, 0);
  assert.equal(readFileSync(join(base, 'remote-release.json'), 'utf8'), original);
  rmSync(join(base, 'remote-release.json')); rmSync(join(base, 'SHA256SUMS'));
  writeFileSync(join(base, 'artifacts', archiveName('v1.2.3', 'arm64')), 'corrupted');
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(join(base, 'remote-release.json')), false);
});

test('standard tar parser binds exactly one OCI/Docker image and rejects ambiguous or corrupt shapes', t => {
  const base = mkdtempSync(join(tmpdir(), 'remote-archive-binding-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/offline-release.py', import.meta.url));
  const archive = join(base, 'image.tar.gz');
  const run = () => spawnSync('python3', [script, 'archive', archive, 'amd64', 'a'.repeat(40), 'v1.2.3'], { encoding: 'utf8' });
  const saved = imageArchive();
  writeFileSync(archive, saved.bytes);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(saved.configDigest, saved.manifestDigest);
  assert.deepEqual(JSON.parse(result.stdout), { configDigest: saved.configDigest, manifestDigest: saved.manifestDigest });
  for (const mutation of ['duplicate', 'traversal', 'symlink', 'duplicate-json', 'config-corrupt', 'layer-corrupt',
    'manifest-link', 'docker-mismatch', 'multi-image', 'multi-index', 'extra-manifest', 'missing-index', 'unsupported-layer', 'wrong-platform']) {
    writeFileSync(archive, imageArchive({ mutation }).bytes);
    assert.notEqual(run().status, 0, mutation);
  }
});

test('explicit target selection rejects shell injection and preserves configured SSH ports when no override is selected', () => {
  const options = { host: 'remote-alias', directory: '/srv/gian-remote', project: 'current', volume: 'current_remote-data' };
  assert.equal(deploymentTarget(options).port, undefined);
  for (const change of [{ host: 'host;id' }, { directory: '/root' }, { directory: '/srv/../etc' },
    { user: '-oProxyCommand=id' }, { port: '65536' }, { project: '' }, { volume: '' }]) assert.throws(() => deploymentTarget({ ...options, ...change }));
  assert.throws(() => parseArgs(['upload', '--directory', 'x', '--arch', 'amd64', '--apply', '--apply']));
  assert.throws(() => parseArgs(['download', '--directory', 'x', '--arch', 'amd64', '--apply']));
});

test('upload verifies published assets and tagged tooling, then bootstraps checksums before executing uploaded code; default is stage only', async t => {
  const f = fixture(t);
  const result = await deploySsh(f.options, f.run);
  assert.equal(result.applied, false);
  const ssh = f.calls.filter(call => call.command === 'ssh');
  assert.equal(ssh.length, 2);
  for (const call of ssh) {
    assert.ok(call.args.includes('StrictHostKeyChecking=yes'));
    assert.ok(call.args.includes('ServerAliveInterval=15'));
    assert.equal(call.args.includes('-p'), false);
    assert.equal(call.args.includes('-F'), false);
  }
  assert.equal(f.calls.find(call => call.command === 'scp').args.includes('-P'), false);
  const command = ssh.at(-1).args.at(-1);
  assert.ok(command.indexOf('sha256sum --check --strict -') < command.indexOf("bash './deploy.sh'"));
  for (const name of ['remote-release.json', 'SHA256SUMS', ...tooling.map(item => item.file), f.receipt.images[0].file]) assert.ok(command.includes('  ' + name + '\n'));
  assert.match(command, /'stage'/);
  assert.doesNotMatch(command, /docker|registry|PRIVATE_KEY/);
});

test('explicit apply and SSH port override are distinct from a no-restart upload', async t => {
  const f = fixture(t);
  assert.equal((await deploySsh({ ...f.options, apply: true, port: '2222' }, f.run)).applied, true);
  assert.match(f.calls.filter(call => call.command === 'ssh').at(-1).args.at(-1), /'apply'/);
  for (const call of f.calls.filter(call => ['ssh', 'scp'].includes(call.command))) {
    assert.equal(call.args[call.args.indexOf(call.command === 'ssh' ? '-p' : '-P') + 1], '2222');
  }
});

test('forged equal-size local cache with self-consistent receipt/checksums cannot replace published assets', async t => {
  const f = fixture(t);
  const image = f.receipt.images[0];
  const bytes = readFileSync(join(f.directory, image.file));
  bytes[0] ^= 1;
  writeFileSync(join(f.directory, image.file), bytes);
  f.write({ ...f.receipt, images: [{ ...image, sha256: sha256(bytes) }, f.receipt.images[1]] });
  await assert.rejects(deploySsh(f.options, f.run), /published asset digest/);
  assert.equal(f.calls.some(call => ['ssh', 'scp'].includes(call.command)), false);
});

test('missing/unsupported GitHub digests and modified tagged tooling fail before any remote mutation', async t => {
  for (const change of ['missing', 'unsupported', 'source']) {
    const f = fixture(t);
    if (change === 'missing') delete f.published.assets[0].digest;
    if (change === 'unsupported') f.published.assets[0].digest = 'md5:' + 'a'.repeat(32);
    if (change === 'source') f.tree[0].sha = 'd'.repeat(40);
    await assert.rejects(deploySsh(f.options, f.run));
    assert.equal(f.calls.some(call => ['ssh', 'scp'].includes(call.command)), false);
  }
});

test('partial/dirty/symlinked bundles and checksum edits fail closed; incomplete uploads never execute a script', async t => {
  for (const change of ['missing', 'dirty', 'symlink', 'checksum']) {
    const f = fixture(t); const image = join(f.directory, f.receipt.images[0].file);
    if (change === 'missing') rmSync(image);
    if (change === 'dirty') writeFileSync(join(f.directory, 'unexpected'), 'dirty');
    if (change === 'symlink') { rmSync(image); symlinkSync('compose.yaml', image); }
    if (change === 'checksum') writeFileSync(join(f.directory, 'SHA256SUMS'), 'untrusted  ../../runtime.env\n');
    await assert.rejects(deploySsh(f.options, f.run));
    assert.equal(f.calls.some(call => ['ssh', 'scp'].includes(call.command)), false);
  }
  const f = fixture(t);
  await assert.rejects(deploySsh(f.options, (command, args, options) => {
    if (command === 'scp') throw new Error('Partial transfer');
    return f.run(command, args, options);
  }), /Partial transfer/);
  assert.equal(f.calls.filter(call => call.command === 'ssh').length, 1);
});

test('server bootstrap rejects a corrupted uploaded deployment script before executing any uploaded shell or Python', async t => {
  const f = fixture(t);
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'remote-bootstrap-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const incoming = join(base, 'incoming.1234abcd'); const bin = join(base, 'bin');
  mkdirSync(incoming); mkdirSync(bin);
  const marker = join(base, 'should-not-exist');
  // Portable fake coreutils checks the same stdin hash list without Docker/SSH.
  writeFileSync(join(bin, 'sha256sum'), '#!' + process.execPath + '\n'
    + "const fs=require('fs'),c=require('crypto');for(const line of fs.readFileSync(0,'utf8').trim().split('\\n')){const [hash,name]=line.split('  ');if(c.createHash('sha256').update(fs.readFileSync(name)).digest('hex')!==hash)process.exit(1);}", { mode: 0o755 });
  const run = (command, args, options) => {
    if (command === 'ssh' && args.at(-1).includes('mktemp')) return incoming + '\n';
    if (command === 'scp') {
      for (const name of ['remote-release.json', 'SHA256SUMS', ...tooling.map(item => item.file), f.receipt.images[0].file]) copyFileSync(join(f.directory, name), join(incoming, name));
      writeFileSync(join(incoming, 'deploy.sh'), "printf corrupted > '" + marker + "'\n");
      return '';
    }
    if (command === 'ssh') {
      const result = spawnSync('bash', ['-c', args.at(-1)], { env: { ...process.env, PATH: bin + ':' + process.env.PATH }, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      throw new Error('Server checksum mismatch');
    }
    return f.run(command, args, options);
  };
  await assert.rejects(deploySsh({ ...f.options, deployDir: base, apply: true }, run), /Server checksum mismatch/);
  assert.equal(existsSync(marker), false);
});

test('download publishes a verified local directory atomically; retry uses existing files without Docker or redownload', async t => {
  const f = fixture(t); const destination = f.directory + '-download';
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  const run = (command, args, options) => {
    if (command === 'gh' && args[0] === 'release') {
      const directory = args[args.indexOf('--dir') + 1];
      for (let index = 0; index < args.length; index++) {
        if (args[index] === '--pattern') copyFileSync(join(f.directory, args[index + 1]), join(directory, args[index + 1]));
      }
      return '';
    }
    return f.run(command, args, options);
  };
  await downloadRelease({ tag: 'v1.2.3', arch: 'amd64', directory: destination }, run);
  assert.equal((await verifyOfflineBundle(destination, { arch: 'amd64' })).receipt.sourceCommit, f.receipt.sourceCommit);
  await downloadRelease({ tag: 'v1.2.3', arch: 'amd64', directory: destination }, f.run);
  assert.equal(readReceipt(destination).receiptHash, sha256(json(f.receipt)));
});

test('release saves the exact smoke-tested daemon ID and binds its archive; hosted deployment stays retired', () => {
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.ok(release.indexOf('bash scripts/smoke-image.sh "$IMAGE_ID"') < release.indexOf('docker save "$IMAGE_ID"'));
  assert.match(release, /gzip -n/);
  assert.match(release, /offline-image-/);
  assert.match(release, /scripts\/offline-release.py/);
  assert.doesNotMatch(release, /docker push|docker\/login|secrets: inherit|uses: .*deploy.yml|  deploy:/);
  const retired = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(retired, /workflow_call:|  release:|secrets\.|node scripts\/deploy-ssh/);
  assert.match(retired, /exit 1/);
  const restricted = readFileSync(new URL('../scripts/ssh-entrypoint.sh', import.meta.url), 'utf8');
  assert.match(restricted, /exit 64/);
  assert.doesNotMatch(restricted, /docker login|docker pull|bash .*deploy.sh/);
});
