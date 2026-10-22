import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readlinkSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(existsSync('delivery/remote/scripts/deploy.sh') ? 'delivery/remote' : '.');
const { archiveName, checksumText, json, sha256, tooling } = await import(pathToFileURL(join(root, 'scripts/release-metadata.mjs')));
const { imageArchive } = await import(pathToFileURL(join(root, 'test/image-archive-fixture.mjs')));
const oldRevision = 'a'.repeat(40); const newRevision = 'b'.repeat(40); const schema = 'c'.repeat(64);
const oldImage = 'sha256:' + 'd'.repeat(64);
function fixture(t, changedSchema = false, mutation = '') {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'gian-remote-deploy-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, 'bin'); mkdirSync(bin);
  writeFileSync(join(base, 'runtime.env'), 'GIAN_REMOTE_ADMIN_TOKEN=fake-only\n');
  const old = join(base, 'releases', oldRevision); mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'compose.yaml'), 'services: {}\n');
  writeFileSync(join(old, 'deploy.env'), 'REMOTE_IMAGE=' + oldImage + '\n');
  writeFileSync(join(old, 'data-schema'), (changedSchema ? 'f'.repeat(64) : schema) + '\n');
  symlinkSync('releases/' + oldRevision, join(base, 'current'));
  const incoming = join(base, 'incoming.1234abcd'); mkdirSync(incoming);
  const tools = tooling.map(item => {
    const bytes = readFileSync(join(root, item.source));
    writeFileSync(join(incoming, item.file), bytes);
    return { file: item.file, source: item.source, size: bytes.length, sha256: sha256(bytes) };
  });
  const binding = imageArchive({ revision: newRevision, mutation });
  const images = ['amd64', 'arm64'].map(arch => {
    const saved = arch === 'amd64' ? binding : imageArchive({ arch, revision: newRevision });
    const bytes = saved.bytes;
    const file = archiveName('v1.2.3', arch);
    if (arch === 'amd64') writeFileSync(join(incoming, file), bytes);
    return { platform: 'linux/' + arch, buildImageId: saved.configDigest, configDigest: saved.configDigest,
      manifestDigest: saved.manifestDigest, file, size: bytes.length, sha256: sha256(bytes) };
  });
  const receipt = { schema: 3, repository: 'RichToyo/Gian-Remote', tag: 'v1.2.3', version: '1.2.3',
    sourceCommit: newRevision, sourceDevCommit: oldRevision, dataSchema: schema, images, tooling: tools };
  writeFileSync(join(incoming, 'remote-release.json'), json(receipt));
  const receiptHash = sha256(json(receipt));
  writeFileSync(join(incoming, 'SHA256SUMS'), checksumText(receipt, receiptHash));
  const state = join(base, 'state'); writeFileSync(state, oldRevision);
  const put = (name, body) => writeFileSync(join(bin, name), '#!' + process.execPath + '\n' + body, { mode: 0o755 });
  put('flock', "process.exit(process.env.LOCK_BUSY==='1'?1:0);"); put('sleep', 'process.exit(0);');
  put('mv', 'require("fs").renameSync(process.argv.at(-2),process.argv.at(-1));');
  put('docker', String.raw`const fs=require('fs'),a=process.argv.slice(2),env=process.env;
fs.appendFileSync(env.DEPLOY_LOG,JSON.stringify(a)+'\n');
const current=()=>fs.readFileSync(env.DEPLOY_STATE,'utf8');
const revision=a.includes('-f')?a[a.indexOf('-f')+1].split('/').at(-2):current();
const candidate=()=>env.IMAGE_STORE==='containerd'?'NEW_MANIFEST':'NEW_CONFIG';
const image=r=>r==='OLD_REV'?'OLD_IMAGE':candidate();
if(a[0]==='info')console.log(JSON.stringify({OSType:'linux',Architecture:env.SERVER_ARCH||'amd64'}));
else if(a[0]==='image'&&a[1]==='inspect'){
  if(env.CACHE_MISS==='1'&&a.at(-1)==='OLD_IMAGE')process.exit(1);
  const old=a.at(-1)==='OLD_IMAGE';
  if(!old&&env.AMBIGUOUS_LOCAL!=='1'&&a.at(-1)!==candidate())process.exit(1);
  const id=old?'OLD_IMAGE':env.UNBOUND_LOCAL==='1'?'sha256:'+('f'.repeat(64)):env.AMBIGUOUS_LOCAL==='1'?a.at(-1):candidate();
  console.log(JSON.stringify([{Id:id,Os:'linux',Architecture:env.LOADED_ARCH||'amd64',RootFS:{Type:'layers',Layers:env.BAD_LAYERS==='1'?[]:DIFF_IDS},
    Descriptor:{digest:env.BAD_DESCRIPTOR==='1'?'sha256:'+('f'.repeat(64)):id,mediaType:'application/vnd.oci.image.manifest.v1+json',size:MANIFEST_SIZE},
    Config:{Labels:{'org.opencontainers.image.revision':env.BAD_SOURCE==='1'?'wrong':old?'OLD_REV':'NEW_REV','org.opencontainers.image.version':'v1.2.3'}}}]));
}
else if(a[0]==='compose'&&a.includes('config'))console.log(JSON.stringify({services:{remote:{image:image(revision),
  volumes:[{type:'volume',source:'remote-data',target:'/data'}],ports:[{host_ip:'127.0.0.1',published:'8787',target:8787}]}},
  volumes:{'remote-data':{name:'current_remote-data'}}}));
else if(a[0]==='compose'&&a.includes('ps'))console.log(current());
else if(a[0]==='compose'&&a.includes('up'))fs.writeFileSync(env.DEPLOY_STATE,revision);
else if(a[0]==='inspect'){
  if(a.includes('--format'))console.log(a[a.indexOf('--format')+1]==='{{.Image}}'?image(current()):
    env.FAIL_CANDIDATE==='1'&&current()==='NEW_REV'?'unhealthy':'healthy');
  else console.log(JSON.stringify([{Image:env.CONTAINER_CONFIG_ID==='1'&&current()==='NEW_REV'?'NEW_CONFIG':image(current()),State:{Running:true},
    Config:{Image:image(current()),Labels:{'com.docker.compose.project':'current','com.docker.compose.service':'remote'},Env:['GIAN_REMOTE_BUILD_ID='+current()]},
    Mounts:[{Destination:'/data',Type:'volume',Name:env.ACTUAL_VOLUME||'current_remote-data'}],
    HostConfig:{PortBindings:{'8787/tcp':[{HostIp:'127.0.0.1',HostPort:'8787'}]}}}]));
}
else if(a[0]==='run'&&a.includes('node'))console.log(env.BAD_MIGRATIONS==='1'?'bad':'SCHEMA');
else if(a[0]==='load')console.log('Loaded image ID: sha256:'+('9'.repeat(64)));
else if(a[0]==='run'&&env.BACKUP_FAIL==='1')process.exit(1);
else if(a[0]==='exec'&&env.BAD_HEALTH_REVISION==='1'&&current()==='NEW_REV')process.exit(1);
else if(a[0]==='pull'||a[0]==='login'||a[0]==='build')process.exit(99);
`.replaceAll('OLD_REV', oldRevision).replaceAll('NEW_REV', newRevision)
    .replaceAll('OLD_IMAGE', oldImage).replaceAll('NEW_CONFIG', binding.configDigest).replaceAll('NEW_MANIFEST', binding.manifestDigest)
    .replaceAll('DIFF_IDS', JSON.stringify(binding.diffIds)).replaceAll('MANIFEST_SIZE', String(binding.manifestSize)).replaceAll('SCHEMA', schema));
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, DEPLOY_LOG: join(base, 'calls.jsonl'),
    DEPLOY_STATE: state, REMOTE_DEPLOY_HEALTH_ATTEMPTS: '1' };
  delete env.GIAN_ALLOW_DESKTOP_E2E;
  const release = join(base, 'releases', newRevision);
  const run = (mode = 'apply', flags = {}, project = 'current', volume = 'current_remote-data') => {
    const directory = existsSync(incoming) ? incoming : release;
    return spawnSync('bash', [join(directory, 'deploy.sh'), mode, base, newRevision, receiptHash, 'amd64', project, volume, '8787'],
      { env: { ...env, ...flags }, encoding: 'utf8' });
  };
  const calls = () => existsSync(env.DEPLOY_LOG) ? readFileSync(env.DEPLOY_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { base, env, incoming, release, run, calls, receipt, receiptHash, binding };
}
function noPull(calls) {
  assert.equal(calls.some(args => ['pull', 'login', 'build'].includes(args[0])), false);
  for (const args of calls.filter(args => args.includes('up'))) {
    assert.equal(args[args.indexOf('--pull') + 1], 'never');
    assert.ok(args.includes('--no-build'));
  }
  for (const args of calls.filter(args => args[0] === 'run')) assert.ok(args.includes('--pull=never'));
}

test('default staging verifies immutable files and platform without loading an image or touching the current service', t => {
  const f = fixture(t); const result = f.run('stage');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(readlinkSync(join(f.base, 'current')), 'releases/' + oldRevision);
  assert.ok(f.calls().every(args => args[0] === 'info'));
  assert.equal(f.run('stage').status, 0);
});

test('deployment verifies before stop, backs up stopped data, switches only after exact-revision health, and retries without restart', t => {
  const f = fixture(t); const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(readlinkSync(join(f.base, 'current')), 'releases/' + newRevision);
  const calls = f.calls();
  const stop = calls.findIndex(args => args.includes('stop'));
  const backup = calls.findIndex(args => args.includes('tar'));
  const start = calls.findIndex(args => args.includes('up'));
  assert.ok(calls.findIndex(args => args[0] === 'load') < stop);
  assert.ok(calls.findIndex(args => args[0] === 'image' && args.at(-1) === oldImage) < stop);
  assert.ok(stop >= 0 && backup > stop && start > backup);
  assert.equal(f.run().status, 0);
  assert.equal(f.calls().filter(args => args.includes('up')).length, 1);
  noPull(f.calls());
});

test('classic/config and containerd/manifest stores use only the uniquely resolved archive-bound ID, including retries', t => {
  for (const store of ['classic', 'containerd']) {
    const f = fixture(t);
    const flags = { IMAGE_STORE: store, CONTAINER_CONFIG_ID: '1' };
    const expected = store === 'containerd' ? f.binding.manifestDigest : f.binding.configDigest;
    const result = f.run('apply', flags);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.notEqual(f.binding.configDigest, f.binding.manifestDigest);
    assert.match(readFileSync(join(f.release, 'deploy.env'), 'utf8'), new RegExp('REMOTE_IMAGE=' + expected));
    for (const args of f.calls().filter(args => args[0] === 'image' && args[1] === 'inspect')) {
      assert.ok([oldImage, f.binding.configDigest, f.binding.manifestDigest].includes(args.at(-1)));
    }
    for (const args of f.calls().filter(args => args[0] === 'run')) assert.ok(args.includes(expected));
    assert.equal(f.run('stage', flags).status, 0);
    assert.equal(f.run('apply', flags).status, 0);
    assert.equal(f.calls().filter(args => args.includes('up')).length, 1);
    noPull(f.calls());
    const before = f.calls().length;
    const envPath = join(f.release, 'deploy.env');
    writeFileSync(envPath, readFileSync(envPath, 'utf8').replace(expected, 'sha256:' + '9'.repeat(64)));
    assert.notEqual(f.run('stage', flags).status, 0);
    assert.equal(f.calls().length, before);
  }
});

test('failed health restores only the cached previous image when migration fingerprint is unchanged', t => {
  const f = fixture(t); const result = f.run('apply', { FAIL_CANDIDATE: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /previous image restored/);
  assert.equal(readlinkSync(join(f.base, 'current')), 'releases/' + oldRevision);
  const starts = f.calls().filter(args => args.includes('up'));
  assert.equal(starts.length, 2);
  assert.ok(starts[1].some(arg => arg.includes(oldRevision)));
  noPull(f.calls());
});

test('failed migration-changing deployment stops instead of running old code on new data', t => {
  const f = fixture(t, true); const result = f.run('apply', { FAIL_CANDIDATE: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /automatic rollback withheld/);
  assert.equal(f.calls().filter(args => args.includes('up')).length, 1);
  assert.equal(readlinkSync(join(f.base, 'current')), 'releases/' + oldRevision);
  noPull(f.calls());
});

test('preflight rejects rollback cache miss, wrong platform/source/schema, target drift and busy locks before stopping', t => {
  for (const flags of [{ CACHE_MISS: '1' }, { SERVER_ARCH: 'arm64' }, { LOADED_ARCH: 'arm64' },
    { BAD_SOURCE: '1' }, { BAD_MIGRATIONS: '1' }, { BAD_LAYERS: '1' }, { AMBIGUOUS_LOCAL: '1' }, { UNBOUND_LOCAL: '1' },
    { IMAGE_STORE: 'containerd', BAD_DESCRIPTOR: '1' }, { ACTUAL_VOLUME: 'other-data' }, { LOCK_BUSY: '1' }]) {
    const f = fixture(t); const result = f.run('apply', flags);
    assert.notEqual(result.status, 0, JSON.stringify(flags));
    assert.equal(f.calls().some(args => args.includes('stop') || args.includes('up')), false);
    assert.equal(readlinkSync(join(f.base, 'current')), 'releases/' + oldRevision);
    noPull(f.calls());
  }
  for (const [project, volume] of [['other', 'current_remote-data'], ['current', 'other-data']]) {
    const f = fixture(t);
    assert.notEqual(f.run('apply', {}, project, volume).status, 0);
    assert.equal(f.calls().some(args => args.includes('stop')), false);
  }
});

test('correct outer checksums cannot authorize an ambiguous/tampered archive before load or stop', t => {
  for (const mutation of ['manifest-link', 'docker-mismatch', 'config-corrupt', 'layer-corrupt', 'multi-image', 'multi-index', 'traversal', 'duplicate']) {
    const f = fixture(t, false, mutation);
    assert.notEqual(f.run().status, 0, mutation);
    assert.equal(f.calls().some(args => args[0] === 'load' || args.includes('stop') || args.includes('up')), false);
    assert.equal(readlinkSync(join(f.base, 'current')), 'releases/' + oldRevision);
  }
});

test('partial/corrupt uploads and dirty same-release retries never disturb current service', t => {
  for (const change of ['archive', 'missing', 'extra', 'receipt', 'symlink', 'dirty-retry']) {
    const f = fixture(t);
    const archive = join(f.incoming, f.receipt.images[0].file);
    if (change === 'archive') writeFileSync(archive, 'corrupt');
    if (change === 'missing') rmSync(archive);
    if (change === 'extra') writeFileSync(join(f.incoming, 'unexpected'), 'dirty');
    if (change === 'receipt') writeFileSync(join(f.incoming, 'remote-release.json'), '{}');
    if (change === 'symlink') { rmSync(archive); symlinkSync('compose.yaml', archive); }
    if (change === 'dirty-retry') {
      assert.equal(f.run('stage').status, 0);
      writeFileSync(join(f.release, 'unexpected'), 'dirty');
    }
    assert.notEqual(f.run().status, 0, change);
    assert.equal(f.calls().some(args => args[0] === 'load' || args.includes('stop') || args.includes('up')), false);
    assert.equal(readlinkSync(join(f.base, 'current')), 'releases/' + oldRevision);
  }
});

test('adopted target keeps the existing Compose project, named data volume and rollback namespace', t => {
  const f = fixture(t); const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  for (const args of f.calls().filter(args => args[0] === 'compose')) assert.equal(args[args.indexOf('--project-name') + 1], 'current');
  assert.ok(f.calls().find(args => args.includes('tar')).includes('current_remote-data:/data:ro'));
  assert.match(readFileSync(join(f.release, 'deploy.env'), 'utf8'), /REMOTE_DATA_VOLUME=current_remote-data/);
  noPull(f.calls());
});

test('backup or exact running-revision failure cannot advance the current symlink', t => {
  for (const flags of [{ BACKUP_FAIL: '1' }, { BAD_HEALTH_REVISION: '1' }]) {
    const f = fixture(t);
    assert.notEqual(f.run('apply', flags).status, 0);
    assert.equal(readlinkSync(join(f.base, 'current')), 'releases/' + oldRevision);
    assert.match(readFileSync(join(f.release, 'data-schema'), 'utf8'), new RegExp(schema));
    noPull(f.calls());
  }
});
