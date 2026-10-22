#!/usr/bin/env python3
"""Validate an offline release without extracting files or resolving a registry."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

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


def receipt(directory):
    path = regular(directory / "remote-release.json", 1024 * 1024)
    raw = path.read_text()
    value = json.loads(raw)
    require(json.dumps(value, indent=2, ensure_ascii=False) + "\n" == raw, "Noncanonical receipt")
    fields(value, "schema repository tag version sourceCommit sourceDevCommit dataSchema images tooling")
    require(value["schema"] == 2 and value["repository"] == "RichToyo/Gian-Remote"
            and re.fullmatch(r"v\d+\.\d+\.\d+", value["tag"])
            and value["version"] == value["tag"][1:]
            and re.fullmatch(r"[a-f0-9]{40}", value["sourceCommit"])
            and re.fullmatch(r"[a-f0-9]{40}", value["sourceDevCommit"])
            and re.fullmatch(r"[a-f0-9]{64}", value["dataSchema"]), "Invalid offline receipt")
    require(isinstance(value["images"], list) and len(value["images"]) == 2
            and isinstance(value["tooling"], list) and len(value["tooling"]) == len(TOOLS), "Invalid asset set")
    for arch, image in zip(ARCHES, value["images"]):
        fields(image, "platform imageId file size sha256")
        require(image["platform"] == "linux/" + arch
                and re.fullmatch(r"sha256:[a-f0-9]{64}", image["imageId"])
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
    if "deploy.env" in existing:
        require(regular(directory / "deploy.env", 16384).read_text() == deploy_env(base, image["imageId"], arch, volume, port)
                and regular(directory / "data-schema", 128).read_text() == value["dataSchema"] + "\n",
                "Existing release deployment settings changed")
    return value, image


def docker(*args):
    # Inherited shell variables must not override the pinned Compose env file.
    env = {key: value for key, value in os.environ.items()
           if key not in ["REMOTE_IMAGE", "REMOTE_RUNTIME_ENV", "REMOTE_PORT", "REMOTE_DATA_VOLUME", "REMOTE_PLATFORM"]}
    result = subprocess.run(["docker", *args], env=env, capture_output=True, text=True, timeout=120)
    require(result.returncode == 0, "Docker preflight failed (no registry fallback)")
    return result.stdout.strip()


def platform(arch):
    info = json.loads(docker("info", "--format", "{{json .}}"))
    actual = {"x86_64": "amd64", "aarch64": "arm64"}.get(info.get("Architecture"), info.get("Architecture"))
    require(info.get("OSType") == "linux" and actual == arch, "Server Docker platform differs from selected archive")


def image_identity(directory, arch):
    value = receipt(directory)
    image = value["images"][ARCHES.index(arch)]
    info = json.loads(docker("image", "inspect", image["imageId"]))[0]
    labels = info.get("Config", {}).get("Labels", {})
    require(info["Id"] == image["imageId"] and info["Os"] == "linux" and info["Architecture"] == arch
            and labels.get("org.opencontainers.image.revision") == value["sourceCommit"]
            and labels.get("org.opencontainers.image.version") == value["tag"], "Loaded image identity/source mismatch")
    code = ("const fs=require('fs'),c=require('crypto'),h=c.createHash('sha256'),p='/app/migrations';"
            "for(const n of fs.readdirSync(p).sort())h.update(n+'\\0').update(fs.readFileSync(p+'/'+n)).update('\\0');"
            "process.stdout.write(h.digest('hex'));")
    actual = docker("run", "--rm", "--pull=never", "--network", "none", "--read-only",
                    "--entrypoint", "node", image["imageId"], "-e", code)
    require(actual == value["dataSchema"], "Loaded image migration fingerprint mismatch")


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
    cached = json.loads(docker("image", "inspect", image))[0]["Id"]
    ids = docker(*command, "ps", "-a", "-q", "remote").splitlines()
    require(len(ids) == 1, "Existing project is missing/ambiguous; review adoption before switching")
    info = json.loads(docker("inspect", ids[0]))[0]
    labels = info["Config"].get("Labels", {})
    mounts = [mount for mount in info["Mounts"] if mount["Destination"] == "/data"]
    ports = info["HostConfig"].get("PortBindings", {}).get("8787/tcp", [])
    configured = [mount for mount in service.get("volumes", []) if mount.get("target") == "/data"]
    require(len(configured) == 1 and configured[0]["type"] == "volume"
            and config["volumes"][configured[0]["source"]]["name"] == volume,
            "Rollback Compose volume differs from explicit target")
    require(info["Image"] == cached and info["State"]["Running"]
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
            print(image["imageId"] + "\n" + value["dataSchema"] + "\n" + image["file"])
        elif operation == "platform":
            platform(args[0])
        elif operation == "image":
            image_identity(Path(args[0]), args[1])
        elif operation == "previous":
            print(previous(Path(args[0]), *args[1:]))
        else:
            raise ValueError("Unknown offline preflight operation")
    except ValueError as error:
        sys.exit("Offline release preflight failed: " + str(error))
    except (KeyError, TypeError, IndexError, OSError, subprocess.SubprocessError):
        sys.exit("Offline release preflight failed; no service stop was requested by this check.")
