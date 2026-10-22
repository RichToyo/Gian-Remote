import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = 'RichToyo/Gian-Remote';
export const architectures = ['amd64', 'arm64'];
export const tooling = [
  { file: 'compose.yaml', source: 'compose.yaml' },
  { file: 'deploy.sh', source: 'scripts/deploy.sh' },
  { file: 'offline-release.py', source: 'scripts/offline-release.py' },
];
const hex = /^[a-f0-9]{64}$/;
export const json = value => JSON.stringify(value, null, 2) + '\n';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const archiveName = (tag, arch) => 'gian-remote-' + tag + '-linux-' + arch + '.tar.gz';
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw new Error('Unknown or missing release metadata fields');
}
function descriptor(value, file) {
  if (value.file !== file || !hex.test(value.sha256 ?? '') || !Number.isSafeInteger(value.size)
    || value.size < 1 || value.size > 2 ** 31) throw new Error('Invalid release asset descriptor');
}
export function validateReleaseReceipt(value, expected = {}) {
  keys(value, ['schema', 'repository', 'tag', 'version', 'sourceCommit', 'sourceDevCommit', 'dataSchema', 'images', 'tooling']);
  if (value.schema !== 3 || value.repository !== repository || !/^v\d+\.\d+\.\d+$/.test(value.tag ?? '')
    || value.version !== value.tag.slice(1) || !/^[a-f0-9]{40}$/.test(value.sourceCommit ?? '')
    || !/^[a-f0-9]{40}$/.test(value.sourceDevCommit ?? '') || !hex.test(value.dataSchema ?? '')
    || Object.entries(expected).some(([key, wanted]) => value[key === 'revision' ? 'sourceCommit' : key] !== wanted)
    || !Array.isArray(value.images) || value.images.length !== 2
    || !Array.isArray(value.tooling) || value.tooling.length !== tooling.length) throw new Error('Invalid offline Remote release receipt (schema 3 required)');
  for (const [index, arch] of architectures.entries()) {
    const image = value.images[index];
    keys(image, ['platform', 'buildImageId', 'configDigest', 'manifestDigest', 'file', 'size', 'sha256']);
    descriptor(image, archiveName(value.tag, arch));
    if (image.platform !== 'linux/' + arch
      || ['buildImageId', 'configDigest', 'manifestDigest'].some(key => !/^sha256:[a-f0-9]{64}$/.test(image[key] ?? ''))
      || image.configDigest === image.manifestDigest
      || ![image.configDigest, image.manifestDigest].includes(image.buildImageId)) throw new Error('Invalid archive-bound image identities/platform');
  }
  for (const [index, item] of tooling.entries()) {
    const asset = value.tooling[index];
    keys(asset, ['file', 'source', 'size', 'sha256']);
    descriptor(asset, item.file);
    if (asset.source !== item.source) throw new Error('Invalid versioned deployment tooling');
  }
  return value;
}
export function readReceipt(directory) {
  const path = join(directory, 'remote-release.json');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Expected a regular, bounded receipt');
  const bytes = readFileSync(path, 'utf8');
  const receipt = validateReleaseReceipt(JSON.parse(bytes));
  if (json(receipt) !== bytes) throw new Error('Noncanonical or duplicate-key receipt');
  return { receipt, receiptHash: sha256(bytes) };
}
export async function describeFile(path, file) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > 2 ** 31) throw new Error('Expected a bounded regular file: ' + file);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { file, size: stat.size, sha256: hash.digest('hex') };
}
// CI only: reuse the server's standard-library parser, not another tar/OCI implementation.
function archivedIdentities(path, arch, revision, tag) {
  const result = spawnSync('python3', [fileURLToPath(new URL('./offline-release.py', import.meta.url)),
    'archive', path, arch, revision, tag], { encoding: 'utf8', timeout: 300_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Image archive binding failed: ' + (result.stderr || result.error?.message || result.status));
  const binding = JSON.parse(result.stdout);
  keys(binding, ['configDigest', 'manifestDigest']);
  return binding;
}
export function checksumText(receipt, receiptHash) {
  return [...receipt.images, ...receipt.tooling, { file: 'remote-release.json', sha256: receiptHash }]
    .sort((a, b) => a.file < b.file ? -1 : 1).map(asset => asset.sha256 + '  ' + asset.file + '\n').join('');
}
export async function verifyOfflineBundle(directory, { arch, ...expected }) {
  if (!architectures.includes(arch) || !lstatSync(directory).isDirectory()) throw new Error('Expected an archive directory and explicit amd64/arm64 architecture');
  const { receipt, receiptHash } = readReceipt(directory);
  validateReleaseReceipt(receipt, expected);
  const image = receipt.images.find(item => item.platform === 'linux/' + arch);
  const assets = [...receipt.tooling, image];
  const names = ['remote-release.json', 'SHA256SUMS', ...assets.map(item => item.file)].sort();
  if (readdirSync(directory).sort().join() !== names.join()) throw new Error('Partial or dirty archive directory; refusing to overwrite or deploy');
  for (const asset of assets) {
    const actual = await describeFile(join(directory, asset.file), asset.file);
    if (actual.size !== asset.size || actual.sha256 !== asset.sha256) throw new Error('Asset integrity mismatch: ' + asset.file);
  }
  const sums = lstatSync(join(directory, 'SHA256SUMS'));
  if (!sums.isFile() || sums.size > 16384
    || readFileSync(join(directory, 'SHA256SUMS'), 'utf8') !== checksumText(receipt, receiptHash)) throw new Error('Invalid SHA256SUMS');
  return { receipt, receiptHash, image, files: names };
}
export async function createReleaseReceipt({ repository: repo, tag, revision, directory = 'artifacts' }) {
  const config = JSON.parse(readFileSync('release.json'));
  const provenance = JSON.parse(readFileSync('.gian-source.json'));
  if (repo !== repository || repo !== config.repository || tag !== 'v' + config.version || provenance.workingTree !== false) throw new Error('Release requires a committed export and matching version/tag');
  const hash = createHash('sha256');
  for (const name of readdirSync('packages/remote-server/migrations').sort()) {
    hash.update(name + '\0').update(readFileSync('packages/remote-server/migrations/' + name)).update('\0');
  }
  const images = [];
  for (const arch of architectures) {
    const image = JSON.parse(readFileSync(join(directory, 'image-' + arch + '.json')));
    keys(image, ['sourceCommit', 'tag', 'platform', 'buildImageId', 'configDigest', 'manifestDigest', 'file', 'size', 'sha256']);
    descriptor(image, archiveName(tag, arch));
    if (image.sourceCommit !== revision || image.tag !== tag) throw new Error('Image artifact source mismatch');
    const actual = await describeFile(join(directory, image.file), archiveName(tag, arch));
    if (image.file !== actual.file || image.size !== actual.size || image.sha256 !== actual.sha256) throw new Error('Image artifact integrity mismatch');
    const binding = archivedIdentities(join(directory, image.file), arch, revision, tag);
    if (image.configDigest !== binding.configDigest || image.manifestDigest !== binding.manifestDigest) throw new Error('Image artifact identity mismatch');
    images.push({ platform: image.platform, buildImageId: image.buildImageId, ...binding, ...actual });
  }
  const tools = [];
  for (const item of tooling) tools.push({ ...await describeFile(item.source, item.file), source: item.source });
  return validateReleaseReceipt({ schema: 3, repository: repo, tag, version: config.version, sourceCommit: revision,
    sourceDevCommit: provenance.sourceCommit, dataSchema: hash.digest('hex'), images, tooling: tools }, { repository: repo, tag, revision });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, path, arch, imageId] = process.argv.slice(2);
  const inputs = { repository: process.env.GITHUB_REPOSITORY, tag: process.env.RELEASE_TAG, revision: process.env.RELEASE_SHA };
  if (mode === 'image') {
    if (!architectures.includes(arch) || !/^sha256:[a-f0-9]{64}$/.test(imageId ?? '')
      || !/^v\d+\.\d+\.\d+$/.test(inputs.tag ?? '') || !/^[a-f0-9]{40}$/.test(inputs.revision ?? '')) throw new Error('Invalid native image identity');
    const asset = await describeFile(join(path, archiveName(inputs.tag, arch)), archiveName(inputs.tag, arch));
    const binding = archivedIdentities(join(path, asset.file), arch, inputs.revision, inputs.tag);
    if (![binding.configDigest, binding.manifestDigest].includes(imageId)) throw new Error('Build daemon image ID is not bound by the saved archive');
    writeFileSync(join(path, 'image-' + arch + '.json'), json({ sourceCommit: inputs.revision, tag: inputs.tag,
      platform: 'linux/' + arch, buildImageId: imageId, ...binding, ...asset }), { flag: 'wx' });
  } else if (mode === 'create') {
    const receipt = await createReleaseReceipt(inputs);
    const bytes = json(receipt);
    writeFileSync(path, bytes, { flag: 'wx' });
    writeFileSync('SHA256SUMS', checksumText(receipt, sha256(bytes)), { flag: 'wx' });
  } else if (mode === 'verify') {
    validateReleaseReceipt(JSON.parse(readFileSync(path)), inputs);
  } else throw new Error('Expected image, create or verify');
}
