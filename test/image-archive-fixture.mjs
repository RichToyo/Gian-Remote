import { spawnSync } from 'node:child_process';

// Test data is written by Python's tarfile, not a second archive parser.
export function imageArchive({ arch = 'amd64', revision = 'a'.repeat(40), tag = 'v1.2.3', mutation = '' } = {}) {
  const result = spawnSync('python3', ['-c', String.raw`
import base64, gzip, hashlib, io, json, sys, tarfile
options = json.load(sys.stdin)
arch, revision, tag, mutation = [options[key] for key in ["arch", "revision", "tag", "mutation"]]
encode = lambda value: json.dumps(value, separators=(",", ":")).encode()
digest = lambda value: "sha256:" + hashlib.sha256(value).hexdigest()
blob_path = lambda value: "blobs/sha256/" + value[7:]
layer_io = io.BytesIO()
with tarfile.open(fileobj=layer_io, mode="w", format=tarfile.USTAR_FORMAT) as archive:
    data = ("fixture layer " + arch).encode()
    member = tarfile.TarInfo("fixture.txt")
    member.size = len(data)
    archive.addfile(member, io.BytesIO(data))
layer = layer_io.getvalue()
diff_ids = [digest(layer)]
config = encode({"architecture": "other" if mutation == "wrong-platform" else arch, "os": "linux",
                 "config": {"Labels": {"org.opencontainers.image.revision": revision, "org.opencontainers.image.version": tag}},
                 "rootfs": {"type": "layers", "diff_ids": diff_ids}})
config_id = digest(config)
layer_descriptor = {"mediaType": "application/vnd.oci.image.layer.v1.tar", "digest": digest(layer), "size": len(layer)}
manifest = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": config_id, "size": len(config)},
            "layers": [layer_descriptor]}
if mutation == "manifest-link":
    manifest["config"]["digest"] = "sha256:" + "f" * 64
if mutation == "unsupported-layer":
    manifest["layers"][0]["mediaType"] += "+gzip"
manifest_bytes = encode(manifest)
manifest_id = digest(manifest_bytes)
descriptor = {"mediaType": manifest["mediaType"], "digest": manifest_id, "size": len(manifest_bytes)}
index = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [descriptor]}
docker_image = {"Config": blob_path(config_id), "RepoTags": None, "Layers": [blob_path(digest(layer))],
                "LayerSources": {digest(layer): layer_descriptor}}
if mutation == "docker-mismatch":
    docker_image["Config"] = blob_path(digest(layer))
docker_manifest = [docker_image]
if mutation == "multi-image":
    docker_manifest.append(docker_image.copy())
if mutation == "multi-index":
    index["manifests"].append(descriptor.copy())
files = {blob_path(config_id): config, blob_path(digest(layer)): layer, blob_path(manifest_id): manifest_bytes,
         "index.json": encode(index), "manifest.json": encode(docker_manifest),
         "oci-layout": encode({"imageLayoutVersion": "1.0.0"})}
# Real Docker exports also include legacy per-layer compatibility JSON blobs.
legacy = encode({"id": "fixture", "created": "1970-01-01T00:00:00Z", "os": "linux"})
files[blob_path(digest(legacy))] = legacy
if mutation == "extra-manifest":
    extra = encode({**manifest, "annotations": {"fixture": "ambiguous"}})
    files[blob_path(digest(extra))] = extra
if mutation == "config-corrupt":
    files[blob_path(config_id)] = config[:-1] + b" "
if mutation == "layer-corrupt":
    files[blob_path(digest(layer))] = b"x" + layer[1:]
if mutation == "missing-index":
    del files["index.json"]
if mutation == "duplicate-json":
    files["manifest.json"] = files["manifest.json"].replace(b'{"Config":', b'{"Config":"duplicate","Config":', 1)
output = io.BytesIO()
with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
    for name in ["blobs", "blobs/sha256"]:
        member = tarfile.TarInfo(name)
        member.type = tarfile.DIRTYPE
        archive.addfile(member)
    for name, data in files.items():
        member = tarfile.TarInfo(name)
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    if mutation in ["duplicate", "traversal"]:
        member = tarfile.TarInfo("manifest.json" if mutation == "duplicate" else "../unsafe")
        member.size = 2
        archive.addfile(member, io.BytesIO(b"{}"))
    if mutation == "symlink":
        member = tarfile.TarInfo("blobs/sha256/" + "0" * 64)
        member.type = tarfile.SYMTYPE
        member.linkname = "../unsafe"
        archive.addfile(member)
print(json.dumps({"bytes": base64.b64encode(gzip.compress(output.getvalue(), mtime=0)).decode(),
                  "configDigest": config_id, "manifestDigest": manifest_id,
                  "manifestSize": len(manifest_bytes), "diffIds": diff_ids}))
`], { input: JSON.stringify({ arch, revision, tag, mutation }), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Archive fixture failed');
  const value = JSON.parse(result.stdout);
  return { ...value, bytes: Buffer.from(value.bytes, 'base64') };
}
