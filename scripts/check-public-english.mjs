import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicEnglish, isPublicPath, loadMediaReviews, scanPublicEntries } from './public-english.mjs';

function git(cwd, args, maxBuffer = 64 * 1024 * 1024) {
  const result = spawnSync('git', args, { cwd, maxBuffer });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.toString() || `git ${args[0]} failed`);
  return result.stdout;
}

function readBlobs(root, items) {
  const byOid = new Map();
  const unique = [];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.oid)) continue;
    seen.add(item.oid);
    unique.push(item);
  }
  let batch = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length === 0) return;
    const result = spawnSync('git', ['cat-file', '--batch', '--end-of-options'], {
      cwd: root,
      input: `${batch.map(item => item.oid).join('\n')}\n`,
      maxBuffer: bytes + batch.length * 128 + 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr?.toString() || 'git cat-file failed');
    let offset = 0;
    const stdout = result.stdout;
    for (const item of batch) {
      const newline = stdout.indexOf(0x0a, offset);
      if (newline < 0) throw new Error(`Missing cat-file header for ${item.path}`);
      const header = stdout.subarray(offset, newline).toString('utf8');
      const size = parseCatFileHeader(header, item);
      const start = newline + 1;
      const end = start + size;
      if (end > stdout.length) throw new Error(`Truncated public blob ${item.path}`);
      byOid.set(item.oid, Buffer.from(stdout.subarray(start, end)));
      offset = end + 1;
    }
    if (offset !== stdout.length) throw new Error('Unexpected cat-file trailer');
    batch = [];
    bytes = 0;
  };
  for (const item of unique) {
    if (batch.length > 0 && bytes + item.size > 8 * 1024 * 1024) flush();
    batch.push(item);
    bytes += item.size;
  }
  flush();
  return byOid;
}

/** `curated` is explicit. The public CLI scans every tracked blob of the
 * selected revision and does not infer that from working-tree files. */
export function publicEntriesFromGit(root, revision = 'HEAD', curated = false) {
  const commit = git(root, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).toString().trim();
  const listed = git(root, ['ls-tree', '-r', '-l', '-z', '--end-of-options', commit]).toString('utf8');
  const metas = [];
  for (const line of listed.split('\0').filter(Boolean)) {
    const entry = parseTreeEntry(line);
    if (curated && !isPublicPath(entry.path)) continue;
    metas.push(entry);
  }
  const blobs = readBlobs(root, metas);
  return {
    commit,
    curated,
    entries: metas.map(item => ({ path: item.path, bytes: blobs.get(item.oid), mode: item.mode })),
  };
}

function main() {
  const args = process.argv.slice(2);
  let root = process.cwd();
  let revision = 'HEAD';
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') root = resolve(args[++index] ?? '');
    else if (args[index] === '--ref') revision = args[++index];
    else if (args[index] === '--json') json = true;
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (revision.startsWith('-')) throw new Error('Revision must not look like an option');
  const reviews = loadMediaReviews();
  const tree = publicEntriesFromGit(root, revision);
  const result = scanPublicEntries(tree.entries, reviews);
  const summary = {
    ok: result.ok,
    commit: tree.commit,
    curated: tree.curated,
    scanned: tree.entries.length,
    reviewedMedia: result.reviewedMedia.length,
    violations: result.violations,
  };
  if (json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!result.ok) {
    try { assertPublicEnglish(tree.entries, reviews); } catch (error) {
      process.stderr.write(`${error.message}\n`);
    }
    process.exitCode = 1;
    return;
  }
  if (!json) {
    process.stdout.write(`Public English gate passed (${summary.scanned} files, ${summary.reviewedMedia} reviewed media)\n`);
  }
}

function parseTreeEntry(line) {
  const tab = line.indexOf('\t');
  if (tab < 0) throw new Error('Unreadable git tree entry');
  const path = line.slice(tab + 1);
  const fields = line.slice(0, tab).trim().split(/ +/);
  if (fields.length !== 4 || !/^[0-7]{6}$/.test(fields[0]) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[2])) {
    throw new Error(`Unreadable git tree entry: ${path}`);
  }
  const [mode, type, oid, sizeText] = fields;
  if (type !== 'blob' || !['100644', '100755'].includes(mode) || !/^\d+$/.test(sizeText)) {
    throw new Error(`Public English gate refuses a non-file entry: ${path}`);
  }
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Public English gate refuses an unreadable size: ${path}`);
  return { path, mode, oid, size };
}

function parseCatFileHeader(header, item) {
  const fields = header.split(' ');
  const [oid, type, sizeText] = fields;
  const size = Number(sizeText);
  if (fields.length !== 3 || oid !== item.oid || type !== 'blob' || !/^\d+$/.test(sizeText ?? '')
    || !Number.isSafeInteger(size) || size !== item.size) {
    throw new Error(`Cannot read public blob ${item.path}: ${header}`);
  }
  return size;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
