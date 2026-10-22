#!/usr/bin/env python3
"""Validate an offline release without extracting files or resolving a registry."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile

TOOLS = [("compose.yaml", "compose.yaml"), ("deploy.sh", "scripts/deploy.sh"),
         ("offline-release.py", "scripts/offline-release.py")]
ARCHES = ["amd64", "arm64"]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fields(value, names):
    require(isinstance(value, dict) and set(value) == set(names.split()), "Unknown or missing metadata fields")


def regular(path, limit=2 ** 31):
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= limit,
            "Missing, partial or nonregular release file: " + path.name)
    return path


def fingerprint(path):
    digest = hashlib.sha256()
    with regular(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "Duplicate JSON field in image archive")
        value[key] = item
    return value


def archive_identity(path, arch, revision, tag):
    """Read one OCI-compatible docker-save image; never extract archive paths."""
    entries = {}
    total = retained = 0
    roots = {"manifest.json", "index.json", "oci-layout"}
    with tarfile.open(regular(path), "r|gz", ignore_zeros=True) as archive:
        for member in archive:
            name = member.name
            require(name not in entries and len(entries) < 4096, "Duplicate/oversized image archive")
            require(all(part not in ["", ".", ".."] for part in name.split("/")), "Unsafe archive path")
            if member.isdir():
                require(name in ["blobs", "blobs/sha256"], "Unsupported archive directory")
                entries[name] = None
                continue
            require(member.isfile() and not member.issparse()
                    and (name in roots or re.fullmatch(r"blobs/sha256/[a-f0-9]{64}", name)),
                    "Unsupported archive path or member type")
            total += member.size
            require(0 <= member.size <= 4 * 1024 ** 3 and total <= 8 * 1024 ** 3, "Image archive exceeds bounds")
            digest = hashlib.sha256()
            read_size = 0
            chunks = [] if member.size <= 1024 * 1024 else None
            with archive.extractfile(member) as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
                    read_size += len(chunk)
                    if chunks is not None:
                        chunks.append(chunk)
            require(read_size == member.size, "Truncated image archive member")
            actual = "sha256:" + digest.hexdigest()
            if name.startswith("blobs/"):
                require(name == "blobs/sha256/" + digest.hexdigest(), "Corrupt content-addressed archive blob")
            if chunks is not None:
                retained += member.size
                require(retained <= 16 * 1024 * 1024, "Too much image metadata")
            entries[name] = {"digest": actual, "size": member.size,
                             "bytes": b"".join(chunks) if chunks is not None else None}

    def document(name):
        entry = entries.get(name)
        require(entry is not None and entry["bytes"] is not None, "Missing/bounded image metadata required")
        return json.loads(entry["bytes"], object_pairs_hook=unique_object)

    def blob(descriptor, media_type):
        require(isinstance(descriptor, dict) and descriptor.get("mediaType") == media_type
                and re.fullmatch(r"sha256:[a-f0-9]{64}", descriptor.get("digest", ""))
                and type(descriptor.get("size")) is int, "Invalid image descriptor")
        name = "blobs/sha256/" + descriptor["digest"][7:]
        entry = entries.get(name)
        require(entry is not None and entry["size"] == descriptor["size"]
                and entry["digest"] == descriptor["digest"], "Image descriptor/blob mismatch")
        return name

    require(document("oci-layout") == {"imageLayoutVersion": "1.0.0"}, "Unsupported OCI layout")
    index = document("index.json")
    require(index.get("schemaVersion") == 2 and index.get("mediaType") == "application/vnd.oci.image.index.v1+json"
            and isinstance(index.get("manifests"), list) and len(index["manifests"]) == 1,
            "Exactly one OCI image manifest is required")
    descriptor = index["manifests"][0]
    manifest_path = blob(descriptor, "application/vnd.oci.image.manifest.v1+json")
    if "platform" in descriptor:
        require(descriptor["platform"].get("os") == "linux" and descriptor["platform"].get("architecture") == arch,
                "OCI index platform mismatch")
    manifest = document(manifest_path)
    require(manifest.get("schemaVersion") == 2 and manifest.get("mediaType") == descriptor["mediaType"], "Unsupported image manifest")
    config_path = blob(manifest["config"], "application/vnd.oci.image.config.v1+json")
    config = document(config_path)
    require(config.get("os") == "linux" and config.get("architecture") == arch, "Archived image platform mismatch")
    labels = config.get("config", {}).get("Labels", {})
    require(labels.get("org.opencontainers.image.revision") == revision
            and labels.get("org.opencontainers.image.version") == tag, "Archived image source/version mismatch")
    layers = manifest.get("layers")
    require(isinstance(layers, list) and 0 < len(layers) <= 128, "Invalid archived layer set")
    # docker save emits uncompressed OCI layer blobs. Other layouts/codecs
    # need their own reviewed binding, not a guessed daemon ID.
    layer_paths = [blob(layer, "application/vnd.oci.image.layer.v1.tar") for layer in layers]
    diff_ids = [layer["digest"] for layer in layers]
    require(config.get("rootfs") == {"type": "layers", "diff_ids": diff_ids}, "Config/layer chain mismatch")
    docker_manifest = document("manifest.json")
    require(isinstance(docker_manifest, list) and len(docker_manifest) == 1, "Exactly one Docker image is required")
    image = docker_manifest[0]
    require(set(image).issubset({"Config", "RepoTags", "Layers", "LayerSources"})
            and image.get("Config") == config_path and image.get("Layers") == layer_paths
            and image.get("RepoTags") in [None, []], "Docker/OCI image mismatch or tagged archive")
    if "LayerSources" in image:
        require(image["LayerSources"] == {layer["digest"]: layer for layer in layers}, "Docker/OCI layer source mismatch")
    for name, entry in entries.items():
        if entry and name.startswith("blobs/") and entry["bytes"] and entry["bytes"].lstrip().startswith(b"{"):
            other = document(name)
            require(not (other.get("schemaVersion") == 2 and "config" in other and "layers" in other)
                    or name == manifest_path, "Ambiguous additional image manifest")
    return {"configDigest": manifest["config"]["digest"], "manifestDigest": descriptor["digest"],
            "manifestSize": descriptor["size"], "diffIds": diff_ids}


def bound_ids(image):
    return {image["configDigest"], image["manifestDigest"]}


def archive_binding(directory, value, image):
    binding = archive_identity(directory / image["file"], image["platform"].split("/")[1], value["sourceCommit"], value["tag"])
    require(all(image[key] == binding[key] for key in ["configDigest", "manifestDigest"])
            and image["buildImageId"] in bound_ids(image), "Receipt/archive image identity mismatch")
    return binding


def receipt(directory):
    path = regular(directory / "remote-release.json", 1024 * 1024)
    raw = path.read_text()
    value = json.loads(raw)
    require(json.dumps(value, indent=2, ensure_ascii=False) + "\n" == raw, "Noncanonical receipt")
    fields(value, "schema repository tag version sourceCommit sourceDevCommit dataSchema images tooling")
    require(value["schema"] == 3 and value["repository"] == "RichToyo/Gian-Remote"
            and re.fullmatch(r"v\d+\.\d+\.\d+", value["tag"])
            and value["version"] == value["tag"][1:]
            and re.fullmatch(r"[a-f0-9]{40}", value["sourceCommit"])
            and re.fullmatch(r"[a-f0-9]{40}", value["sourceDevCommit"])
            and re.fullmatch(r"[a-f0-9]{64}", value["dataSchema"]), "Invalid offline receipt")
    require(isinstance(value["images"], list) and len(value["images"]) == 2
            and isinstance(value["tooling"], list) and len(value["tooling"]) == len(TOOLS), "Invalid asset set")
    for arch, image in zip(ARCHES, value["images"]):
        fields(image, "platform buildImageId configDigest manifestDigest file size sha256")
        require(image["platform"] == "linux/" + arch
                and all(re.fullmatch(r"sha256:[a-f0-9]{64}", image[key]) for key in ["buildImageId", "configDigest", "manifestDigest"])
                and image["configDigest"] != image["manifestDigest"] and image["buildImageId"] in bound_ids(image)
                and image["file"] == "gian-remote-" + value["tag"] + "-linux-" + arch + ".tar.gz",
                "Invalid image identity or archive path")
    for (name, source), tool in zip(TOOLS, value["tooling"]):
        fields(tool, "file source size sha256")
        require(tool["file"] == name and tool["source"] == source, "Invalid versioned tooling")
    for asset in value["images"] + value["tooling"]:
        require(type(asset["size"]) is int and 0 < asset["size"] <= 2 ** 31
                and re.fullmatch(r"[a-f0-9]{64}", asset["sha256"]), "Invalid asset descriptor")
    return value


def deploy_env(base, image, arch, volume, port):
    return ("REMOTE_IMAGE=" + image + "\nREMOTE_RUNTIME_ENV=" + str(base) + "/runtime.env\n"
            + "REMOTE_PORT=" + port + "\nREMOTE_DATA_VOLUME=" + volume + "\nREMOTE_PLATFORM=linux/" + arch + "\n")


def verify(directory, revision, expected_hash, arch, base, volume, port):
    require(directory.is_dir() and not directory.is_symlink() and arch in ARCHES, "Unsafe release directory/platform")
    value = receipt(directory)
    require(value["sourceCommit"] == revision and fingerprint(directory / "remote-release.json") == expected_hash,
            "Release source/receipt identity mismatch")
    image = value["images"][ARCHES.index(arch)]
    assets = value["tooling"] + [image]
    names = {"remote-release.json", "SHA256SUMS"} | {asset["file"] for asset in assets}
    generated = {"deploy.env", "data-schema"}
    existing = {path.name for path in directory.iterdir()}
    require(existing == names or existing == names | generated, "Partial or dirty release directory")
    for asset in assets:
        path = regular(directory / asset["file"])
        require(path.stat().st_size == asset["size"] and fingerprint(path) == asset["sha256"],
                "Uploaded asset integrity mismatch: " + path.name)
    all_assets = value["images"] + value["tooling"] + [{"file": "remote-release.json", "sha256": expected_hash}]
    sums = "".join(asset["sha256"] + "  " + asset["file"] + "\n"
                   for asset in sorted(all_assets, key=lambda asset: asset["file"]))
    require(regular(directory / "SHA256SUMS", 16384).read_text() == sums, "Invalid uploaded checksums")
    archive_binding(directory, value, image)
    if "deploy.env" in existing:
        require(regular(directory / "deploy.env", 16384).read_text() in
                [deploy_env(base, identity, arch, volume, port) for identity in bound_ids(image)]
                and regular(directory / "data-schema", 128).read_text() == value["dataSchema"] + "\n",
                "Existing release deployment settings changed")
    return value, image


def docker(*args, optional=False):
    # Inherited shell variables must not override the pinned Compose env file.
    env = {key: value for key, value in os.environ.items()
           if key not in ["REMOTE_IMAGE", "REMOTE_RUNTIME_ENV", "REMOTE_PORT", "REMOTE_DATA_VOLUME", "REMOTE_PLATFORM"]}
    result = subprocess.run(["docker", *args], env=env, capture_output=True, text=True, timeout=120)
    if optional and result.returncode != 0:
        return None
    require(result.returncode == 0, "Docker preflight failed (no registry fallback)")
    return result.stdout.strip()


def platform(arch):
    info = json.loads(docker("info", "--format", "{{json .}}"))
    actual = {"x86_64": "amd64", "aarch64": "arm64"}.get(info.get("Architecture"), info.get("Architecture"))
    require(info.get("OSType") == "linux" and actual == arch, "Server Docker platform differs from selected archive")


def validate_local_image(info, image, binding, value, arch):
    labels = info.get("Config", {}).get("Labels", {})
    require(info["Id"] in bound_ids(image) and info["Os"] == "linux" and info["Architecture"] == arch
            and info.get("RootFS") == {"Type": "layers", "Layers": binding["diffIds"]}
            and labels.get("org.opencontainers.image.revision") == value["sourceCommit"]
            and labels.get("org.opencontainers.image.version") == value["tag"], "Loaded image identity/source/layers mismatch")
    if info["Id"] == image["manifestDigest"]:
        descriptor = info.get("Descriptor", {})
        require(descriptor.get("digest") == image["manifestDigest"]
                and descriptor.get("mediaType") == "application/vnd.oci.image.manifest.v1+json"
                and descriptor.get("size") == binding["manifestSize"], "Local OCI descriptor differs from verified archive")


def image_identity(directory, arch):
    value = receipt(directory)
    image = value["images"][ARCHES.index(arch)]
    binding = archive_binding(directory, value, image)
    resolved = set()
    for identity in sorted(bound_ids(image)):
        raw = docker("image", "inspect", identity, optional=True)
        if raw is None:
            continue
        infos = json.loads(raw)
        require(isinstance(infos, list) and len(infos) == 1, "Ambiguous local image lookup")
        validate_local_image(infos[0], image, binding, value, arch)
        resolved.add(infos[0]["Id"])
    require(len(resolved) == 1, "Expected one locally available archive-bound image (no tag/load-output fallback)")
    local_id = resolved.pop()
    code = ("const fs=require('fs'),c=require('crypto'),h=c.createHash('sha256'),p='/app/migrations';"
            "for(const n of fs.readdirSync(p).sort())h.update(n+'\\0').update(fs.readFileSync(p+'/'+n)).update('\\0');"
            "process.stdout.write(h.digest('hex'));")
    actual = docker("run", "--rm", "--pull=never", "--network", "none", "--read-only",
                    "--entrypoint", "node", local_id, "-e", code)
    require(actual == value["dataSchema"], "Loaded image migration fingerprint mismatch")
    return local_id


def container_identity(info, image, expected_id):
    # Container .Image may remain the config digest on an OCI-backed daemon.
    require(expected_id in bound_ids(image) and info["Image"] in bound_ids(image)
            and info["Config"].get("Image") == expected_id, "Container is not using the selected archive-bound image")


def managed_receipt(directory):
    path = directory / "remote-release.json"
    if not path.exists():
        return None
    # Existing schema-2 deployments retain the old strict local-ID check;
    # never reinterpret their immutable metadata as a schema-3 binding.
    if json.loads(regular(path, 1024 * 1024).read_text()).get("schema") == 2:
        return None
    return receipt(directory)


def previous(base, revision, project, volume, port):
    directory = base / "releases" / revision
    for name in ["compose.yaml", "deploy.env", "data-schema"]:
        regular(directory / name, 1024 * 1024)
    require(re.fullmatch(r"[a-f0-9]{64}\n?", (directory / "data-schema").read_text()), "Invalid previous migration fingerprint")
    command = ["compose", "--project-name", project, "--env-file", str(directory / "deploy.env"),
               "-f", str(directory / "compose.yaml")]
    config = json.loads(docker(*command, "config", "--format", "json"))
    service = config["services"]["remote"]
    image = service["image"]
    require(re.fullmatch(r"sha256:[a-f0-9]{64}|ghcr\.io/(?:richtoyo|richlogic)/gian-remote@sha256:[a-f0-9]{64}", image),
            "Previous release must use a cached immutable image")
    # Resolve locally before stopping; a missing rollback image is a hard failure.
    cached_info = json.loads(docker("image", "inspect", image))[0]
    cached = cached_info["Id"]
    ids = docker(*command, "ps", "-a", "-q", "remote").splitlines()
    require(len(ids) == 1, "Existing project is missing/ambiguous; review adoption before switching")
    info = json.loads(docker("inspect", ids[0]))[0]
    value = managed_receipt(directory)
    if value is not None:
        require(value["sourceCommit"] == revision, "Previous release source mismatch")
        item = next(item for item in value["images"] if item["platform"] == "linux/" + cached_info["Architecture"])
        binding = archive_binding(directory, value, item)
        validate_local_image(cached_info, item, binding, value, cached_info["Architecture"])
        container_identity(info, item, image)
    else:
        require(info["Image"] == cached, "Previous running image differs from cached image")
    labels = info["Config"].get("Labels", {})
    mounts = [mount for mount in info["Mounts"] if mount["Destination"] == "/data"]
    ports = info["HostConfig"].get("PortBindings", {}).get("8787/tcp", [])
    configured = [mount for mount in service.get("volumes", []) if mount.get("target") == "/data"]
    require(len(configured) == 1 and configured[0]["type"] == "volume"
            and config["volumes"][configured[0]["source"]]["name"] == volume,
            "Rollback Compose volume differs from explicit target")
    require(info["State"]["Running"]
            and labels.get("com.docker.compose.project") == project and labels.get("com.docker.compose.service") == "remote"
            and len(mounts) == 1 and mounts[0]["Type"] == "volume" and mounts[0]["Name"] == volume
            and ports == [{"HostIp": "127.0.0.1", "HostPort": port}], "Existing project/volume/port/image changed")
    configured_ports = service.get("ports", [])
    require(len(configured_ports) == 1 and configured_ports[0].get("host_ip") == "127.0.0.1"
            and str(configured_ports[0].get("published")) == port and configured_ports[0].get("target") == 8787,
            "Rollback Compose port differs from explicit target")
    require("GIAN_REMOTE_BUILD_ID=" + revision in info["Config"]["Env"], "Previous running source differs from current")
    return cached


if __name__ == "__main__":
    try:
        operation, *args = sys.argv[1:]
        if operation == "verify":
            value, image = verify(Path(args[0]), args[1], args[2], args[3], Path(args[4]), args[5], args[6])
            print(image["configDigest"] + "\n" + value["dataSchema"] + "\n" + image["file"])
        elif operation == "archive":
            binding = archive_identity(Path(args[0]), args[1], args[2], args[3])
            print(json.dumps({key: binding[key] for key in ["configDigest", "manifestDigest"]}))
        elif operation == "platform":
            platform(args[0])
        elif operation == "image":
            print(image_identity(Path(args[0]), args[1]))
        elif operation == "container":
            info = json.loads(docker("inspect", args[2]))[0]
            value = managed_receipt(Path(args[0]))
            if value is not None:
                container_identity(info, value["images"][ARCHES.index(args[1])], args[3])
            else:
                require(info["Image"] == args[3], "Previous container image differs from cached image")
        elif operation == "previous":
            print(previous(Path(args[0]), *args[1:]))
        else:
            raise ValueError("Unknown offline preflight operation")
    except ValueError as error:
        sys.exit("Offline release preflight failed: " + str(error))
    except (KeyError, TypeError, IndexError, AttributeError, StopIteration, OSError, tarfile.TarError, subprocess.SubprocessError):
        sys.exit("Offline release preflight failed; no service stop was requested by this check.")
