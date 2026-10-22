import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { architectures, archiveName, readReceipt, repository, sha256, tooling, validateReleaseReceipt, verifyOfflineBundle } from './release-metadata.mjs';

export function commandRunner(command, args, { capture = false } = {}) {
  const env = { ...process.env };
  if (command !== 'gh') {
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'REMOTE_REGISTRY_TOKEN', 'REMOTE_SSH_PRIVATE_KEY', 'REMOTE_SSH_KNOWN_HOSTS']) delete env[key];
  }
  const result = spawnSync(command, args, { env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: 60 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  // Captured SSH/gh stderr is deliberately not copied into a credential-bearing log.
  if (result.error || result.status !== 0) throw new Error(command + ' failed; inspect local SSH/gh configuration and retry (' + (result.status ?? 'unavailable') + ')');
  return capture ? result.stdout : '';
}
export function publishedRelease(tag, run = commandRunner) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('An explicit stable vX.Y.Z tag is required');
  const api = path => JSON.parse(run('gh', ['api', 'repos/' + repository + '/' + path, '--hostname', 'github.com'], { capture: true }));
  const release = api('releases/tags/' + tag);
  if (release.draft !== false || release.prerelease !== false || release.tag_name !== tag || !release.published_at
    || api('releases/latest').tag_name !== tag) throw new Error('Only the latest published stable release can be staged');
  let object = api('git/ref/tags/' + tag).object;
  for (let depth = 0; object?.type === 'tag' && depth < 4; depth++) object = api('git/tags/' + object.sha).object;
  if (object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha ?? '')) throw new Error('Unresolved release tag commit');
  const comparison = api('compare/' + object.sha + '...main');
  if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('Release source must be on main');
  const tree = api('git/trees/' + object.sha + '?recursive=1');
  if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error('Incomplete release source tree');
  return { tag, revision: object.sha, release, tree: tree.tree };
}
function verifyPublished(bundle, published) {
  validateReleaseReceipt(bundle.receipt, { repository, tag: published.tag, revision: published.revision });
  const assets = [...bundle.receipt.images, ...bundle.receipt.tooling];
  const expected = new Map(assets.map(item => [item.file, item.size]));
  expected.set('remote-release.json', undefined); expected.set('SHA256SUMS', undefined);
  const hashes = new Map(assets.map(item => [item.file, item.sha256]));
  hashes.set('remote-release.json', bundle.receiptHash);
  hashes.set('SHA256SUMS', sha256(readFileSync(join(bundle.directory, 'SHA256SUMS'))));
  const seen = new Set();
  for (const asset of published.release.assets ?? []) {
    if (seen.has(asset.name)) throw new Error('Duplicate published release asset');
    seen.add(asset.name);
    if (expected.has(asset.name) && (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size < 1
      || (expected.get(asset.name) !== undefined && asset.size !== expected.get(asset.name)))) throw new Error('Published asset size/state mismatch');
    // Local receipt/checksum agreement is not provenance. Require GitHub's
    // independently returned SHA-256 for every asset, including the receipt.
    if (expected.has(asset.name) && (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')
      || asset.digest !== 'sha256:' + hashes.get(asset.name))) throw new Error('Missing, unsupported or mismatched published asset digest: ' + asset.name);
  }
  if ([...expected.keys()].some(name => !seen.has(name))) throw new Error('Offline assets are missing; old registry receipts cannot be upgraded in place');
  for (const item of tooling) {
    const blob = published.tree.find(entry => entry.path === item.source);
    const bytes = readFileSync(join(bundle.directory, item.file));
    const gitHash = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
    if (blob?.type !== 'blob' || blob.mode !== '100644' && blob.mode !== '100755' || blob.sha !== gitHash) throw new Error('Deployment tooling differs from tagged source: ' + item.file);
  }
}
export async function downloadRelease({ tag, arch, directory }, run = commandRunner) {
  if (!architectures.includes(arch) || !directory) throw new Error('Select --arch amd64|arm64 and --directory');
  const published = publishedRelease(tag, run);
  const target = resolve(directory);
  if (existsSync(target)) {
    const bundle = { ...await verifyOfflineBundle(target, { tag, revision: published.revision, arch }), directory: target };
    verifyPublished(bundle, published);
    return bundle;
  }
  const temporary = mkdtempSync(join(dirname(target), '.remote-download-'));
  try {
    const names = ['remote-release.json', 'SHA256SUMS', ...tooling.map(item => item.file), archiveName(tag, arch)];
    // Exact, validated names only. Never download/extract a repository or tooling tarball.
    run('gh', ['release', 'download', tag, '--repo', 'github.com/' + repository, '--dir', temporary,
      ...names.flatMap(name => ['--pattern', name])]);
    const bundle = { ...await verifyOfflineBundle(temporary, { tag, revision: published.revision, arch }), directory: temporary };
    verifyPublished(bundle, published);
    if (existsSync(target)) throw new Error('Download destination appeared during transfer');
    renameSync(temporary, target);
    return { ...bundle, directory: target };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
export function deploymentTarget(options) {
  const { host = '', user = '', directory = '', project = '', volume = '', port, httpPort = '8787' } = options;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) || user && !/^[a-z_][a-z0-9_-]*$/.test(user)
    || port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    || !/^\/(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_-]+$/.test(directory)
    || ['/', '/opt', '/srv', '/home', '/root', '/tmp'].includes(directory)
    || !/^[a-z0-9][a-z0-9_-]*$/.test(project) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume)
    || !/^\d+$/.test(httpPort) || Number(httpPort) < 1024 || Number(httpPort) > 65535) throw new Error('Choose an explicit SSH target, dedicated deployment directory, Compose project, named volume and valid ports');
  return { host, user, directory, project, volume, port, httpPort };
}
export async function deploySsh(options, run = commandRunner) {
  if (options.apply !== undefined && typeof options.apply !== 'boolean') throw new Error('--apply must be an explicit boolean choice');
  const target = deploymentTarget({ ...options, directory: options.deployDir });
  const local = resolve(options.directory ?? '');
  const { receipt } = readReceipt(local);
  const published = publishedRelease(receipt.tag, run);
  const bundle = { ...await verifyOfflineBundle(local, { arch: options.arch, revision: published.revision, tag: published.tag }), directory: local };
  verifyPublished(bundle, published);
  const common = ['-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];
  for (const [option, flag] of [[options.identityFile, '-i'], [options.knownHosts, '-o']]) {
    if (!option) continue;
    const path = resolve(option);
    if (!lstatSync(path).isFile()) throw new Error('SSH identity/known_hosts arguments must be regular existing files');
    common.push(flag, flag === '-i' ? path : 'UserKnownHostsFile=' + path);
    if (flag === '-i') common.push('-o', 'IdentitiesOnly=yes');
  }
  const destination = target.user ? target.user + '@' + target.host : target.host;
  const sshPort = target.port === undefined ? [] : ['-p', target.port];
  const scpPort = target.port === undefined ? [] : ['-P', target.port];
  // This is the first remote mutation. Everything local and published has
  // already passed validation; incomplete transfers never invoke deployment.
  const incoming = run('ssh', [...common, ...sshPort, destination,
    "test -d '" + target.directory + "' && test ! -L '" + target.directory + "' && umask 077 && mktemp -d '" + target.directory + "/incoming.XXXXXXXX'"], { capture: true }).trim();
  if (!new RegExp('^' + target.directory + '/incoming\\.[A-Za-z0-9]{8}$').test(incoming)) throw new Error('Unexpected remote staging path');
  run('scp', [...common, ...scpPort, ...bundle.files.map(name => join(local, name)), destination + ':' + incoming + '/']);
  const hashes = new Map([...bundle.receipt.images, ...bundle.receipt.tooling].map(asset => [asset.file, asset.sha256]));
  hashes.set('remote-release.json', bundle.receiptHash);
  hashes.set('SHA256SUMS', sha256(readFileSync(join(local, 'SHA256SUMS'))));
  const uploadedChecksums = bundle.files.map(name => hashes.get(name) + '  ' + name + '\n').join('');
  const args = [options.apply ? 'apply' : 'stage', target.directory, receipt.sourceCommit, bundle.receiptHash,
    options.arch, target.project, target.volume, target.httpPort];
  // Bootstrap verification uses only server coreutils, not uploaded code.
  run('ssh', [...common, ...sshPort, destination, "cd '" + incoming + "' && printf '%s' '" + uploadedChecksums
    + "' | sha256sum --check --strict - && bash './deploy.sh' " + args.map(arg => "'" + arg + "'").join(' ')]);
  return { revision: receipt.sourceCommit, applied: options.apply === true };
}
export function parseArgs(args) {
  const [command, ...rest] = args;
  if (!['download', 'upload'].includes(command)) throw new Error('Usage: deploy-ssh.mjs download|upload --directory PATH --arch amd64|arm64 [--tag vX.Y.Z] [--host ALIAS --deploy-dir PATH --project NAME --volume NAME --apply]');
  const allowed = new Set(command === 'download' ? ['tag', 'arch', 'directory']
    : ['arch', 'directory', 'host', 'user', 'port', 'http-port', 'deploy-dir', 'project', 'volume', 'identity-file', 'known-hosts', 'apply']);
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index].slice(2);
    const name = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!rest[index].startsWith('--') || !allowed.has(key) || name in options) throw new Error('Unknown or duplicate argument: ' + rest[index]);
    if (key === 'apply') options[name] = true;
    else {
      if (!rest[index + 1] || rest[index + 1].startsWith('--')) throw new Error('Missing argument value: ' + key);
      options[name] = rest[++index];
    }
  }
  if (!options.directory || !architectures.includes(options.arch)) throw new Error('--directory and --arch amd64|arm64 are required');
  return { command, options };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, options } = parseArgs(process.argv.slice(2));
  const result = command === 'download' ? await downloadRelease(options) : await deploySsh(options);
  console.log(command === 'download' ? 'Verified offline release: ' + result.directory : result.applied ? 'Deployment completed.' : 'Release staged only; no image loaded or service restarted. Repeat upload with --apply to switch.');
}
