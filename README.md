# Gian Remote

Remote Server and Remote Web are one independently built and deployed product.
Development happens in GianDev. `.gian-source.json` records the exact source
commit, shared package snapshots and file hashes. Do not hand-edit these
snapshots in the distribution repository.

## Local source checks

Requires Node 24 and pnpm 10.33.2:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

The workspace contains remote-server, remote-web, shared and chat-ui.
`@gian/remote-protocol` is an external package published by public
[Gian](https://github.com/RichToyo/Gian), not a source directory in this repo.
It does not require access to private GianDev, a checkout of the whole Gian
repository, Electron or any Provider Proxy.
GianDev retains the shared source-scan and Host/Web cross-product integration
tests. Public Remote CI runs all Remote package tests and deployment-script
regression, and builds/boots the real container.

## Remote Protocol dependency

The protocol source and public release entrypoint belong to Gian at
`packages/remote-protocol`. Pushing an immutable `remote-protocol-vX.Y.Z` tag
triggers its dedicated package workflow. Only after qualification succeeds does
the GitHub Release contain the installable `.tgz`, coordinate and checksums.
The protocol release never becomes the Desktop application's latest release.

For example, after version 1.0.0 is actually published:

```sh
npm install https://github.com/RichLogic/Gian/releases/download/remote-protocol-v1.0.0/gian-remote-protocol-1.0.0.tgz
```

This is a normal package named `@gian/remote-protocol`; imports use that name.
It is a GitHub Release archive, not an npm Registry publication. A Git tag alone
is not an installable package, and `npm install @gian/remote-protocol@1.0.0`
would require a separate Registry publication.

The generated package.json files use the exact public Gian archive URL.
pnpm-lock.yaml records the same URL and SHA-512 integrity; protocol-package.json
also records SHA-256, size and public source commit. No GitHub token is required
to download the public package. Do not substitute a mutable branch, latest URL,
private GianDev reference or a temporary signed CDN URL.

The exporter refuses a pending first publication. Import real release metadata
after verifying the published tag and archive, then export again; never invent
an archive digest to make a not-yet-published dependency appear installable.
See [pnpm's supported package sources](https://pnpm.io/cli/add#supported-package-sources).

## Connect a Gian computer

Configure `GIAN_REMOTE_GITHUB_CLIENT_ID` (GitHub Device Flow enabled) and
`GIAN_REMOTE_ENROLLMENT_GITHUB_IDS` (comma-separated numeric GitHub account IDs)
in `runtime.env`. An empty allowlist disables new registrations. Obtain your
own numeric ID using authenticated `gh api user --jq .id`.

Open `https://YOUR_SERVER/enrollment`, sign in with an allowlisted GitHub
account and generate an enrollment token. The existing remote-control page
remains at `/` and does not require browser GitHub login: it uses a short-lived
invitation, explicit Host confirmation and the paired device's private key.

The administrator CLI remains available inside the service environment:

```sh
gian-remote-server enrollment create --label 'Home Mac'
# For the shipped Compose service:
docker compose exec remote gian-remote-server enrollment create --label 'Home Mac'
```

The command prints the Server URL, token and expiry. Enter these in Gian's
Settings → Remote within 5 minutes. The verified Gian GitHub account must
match the token issuer. The token is single-use; normal reconnects
do not need another. The CLI uses the existing local admin API and the server's
`GIAN_REMOTE_ADMIN_TOKEN`, without printing the admin key. Run it inside the
container/service environment; public proxies should keep the admin API blocked.
With several allowlisted accounts, supply `--account-id NUMERIC_GITHUB_ID`.
Old unbound unused tokens are invalidated on upgrade. Allow `/enrollment` and
`/api/v1/enrollment/*` through the proxy; never expose the admin master key.

Once connected, rename the computer in Gian if needed and generate a device
pairing QR/link. A browser may pair with several computers independently and
switch using the Host menu. Open invitations in the browser you want to use
before confirming. Pairing still requires approval on the corresponding Mac.

Deploy a Server supporting `/api/v1/host/profile` before a Desktop offering
Rename. Names are metadata; renaming preserves Host identity and pairings.

## Stable release

The Remote version in release.json is independent of Desktop and Protocol.
Export a committed GianDev revision, review/sync the standalone source and
create an immutable stable vX.Y.Z tag on main. Run **Release Remote** on main
with that exact tag. Qualification, native amd64/arm64 builds and actual-image
smoke checks remain in CI. Each native image is built once, smoke-tested by its
Docker image ID, then saved from that same ID as a gzip-compressed Docker
archive. No server build, dependency download or registry pull is involved.
This uses Docker's documented [save](https://docs.docker.com/reference/cli/docker/image/save/)
and compressed [load](https://docs.docker.com/reference/cli/docker/image/load/) format.

The stable Release publishes:

- gian-remote-vX.Y.Z-linux-amd64.tar.gz and the corresponding arm64 archive.
- remote-release.json (schema 3), binding both platforms, the build daemon's
  image ID, config digest, OCI manifest digest, archive names/sizes/SHA-256,
  source commits and migration fingerprint.
- SHA256SUMS, compose.yaml, deploy.sh and offline-release.py. Deployment
  tooling hashes are in the receipt and must also match the tagged Git blobs.

Classic Docker and containerd stores can expose the config digest or the OCI
manifest digest as the local image ID. CI and server preflight share a Python
standard-library parser that reads (never extracts) the supported single-image
OCI-compatible docker-save archive, hashes its blobs and verifies the index,
Docker manifest, OCI manifest, config and uncompressed-layer links. Duplicate,
unsafe, ambiguous or unsupported shapes fail closed. The build daemon ID must
be one of those linked identities; no arbitrary load-output ID or tag is used.
See the [upstream image-store distinction](https://github.com/moby/moby/issues/51934).

A published release cannot be rebuilt or have assets replaced through this
entrypoint. Existing schema-1 and schema-2 release assets, including 1.4.1,
stay immutable; the schema-3 download/apply flow does not retrofit them.
Do not add fabricated offline metadata to an old release. Publish a new
qualified version when adopting this delivery format.

Release publication does **not** deploy anything. The old Deploy Remote
workflow is manual-only and deliberately fails with local deployment guidance;
it has no release trigger, reusable workflow, SSH secret or remote operation.
The old restricted-key/registry entrypoint also refuses execution. Do not
upload a personal SSH private key to GitHub. Existing deployment credentials
or server-installed legacy entrypoints are not automatically changed here.

The runtime bundle still copies the frozen install's actual production
dependency graph and native outputs; it never resolves semver ranges again.

## Download locally

The operator machine needs Node 24, gh and OpenSSH, but **not Docker**.
Use a current source checkout containing this CLI. The following version is
an example, not a claim that the release exists. Select the actual latest
published stable tag and the **server's** architecture, not the Mac's.

```sh
node scripts/deploy-ssh.mjs download \
  --tag v1.4.2 --arch amd64 --directory ./remote-v1.4.2-amd64
```

Download verifies the stable public release, resolves lightweight/annotated
tags to their exact main-line commit, and validates the receipt, allowlisted
file names, platform, sizes and hashes. Every release asset must expose a
supported sha256 digest through GitHub's Release API; missing/unsupported
digests fail closed. This independently binds a cached receipt and archive
to the published bytes, not just to local checksums. Tooling is additionally
bound to the exact tagged source blobs.
The digest field is documented in the [release asset API](https://docs.github.com/en/rest/releases/assets).

Files download into a private temporary directory and become the selected
local directory only after verification. No tarball is extracted. A complete
existing directory is reverified without downloading again. Partial/dirty
directories are rejected rather than merged or overwritten; choose a new
directory or explicitly remove the failed local copy after inspection.

## Upload, Then Explicitly Apply

Configure the server once as described below. Choose the real deployment
directory, existing Compose project and named data volume explicitly. Do not
infer them from these examples.

```sh
node scripts/deploy-ssh.mjs upload \
  --directory ./remote-v1.4.2-amd64 --arch amd64 --host remote-prod \
  --deploy-dir /srv/gian-remote --project current --volume current_remote-data
```

This revalidates the local/published bindings, uploads into a new private
incoming directory, checks **every** uploaded file with server-side
sha256sum before executing uploaded code, then runs full receipt/inventory
and Docker platform validation. The default only stages the immutable release:
no docker load, service stop, backup, database migration or switch occurs.

SSH uses the operator's existing config/agent/identity and known_hosts with
StrictHostKeyChecking=yes, batch mode and 15-second keepalives. An SSH alias's
configured User/Port is retained unless explicitly overridden. Optional
--user, --port, --identity-file and --known-hosts select existing local settings;
no keys/tokens are created, copied to GitHub or uploaded to the server.
--http-port overrides the default loopback HTTP port 8787 only after the
existing deployment's port has been reviewed.

To load and switch the already verified release, repeat the upload with the
separate, explicit --apply choice:

```sh
node scripts/deploy-ssh.mjs upload \
  --directory ./remote-v1.4.2-amd64 --arch amd64 --host remote-prod \
  --deploy-dir /srv/gian-remote --project current --volume current_remote-data \
  --apply
```

This retries from the same local directory without rebuilding/redownloading.
Exact same-release uploads are idempotent; different bytes, extra files,
partial content or changed already-applied settings fail closed. Failed
uploads remain in incoming.* for explicit operator inspection/cleanup; they
are never promoted on a failed transfer. Normal upload/apply only accepts
the latest stable release, not a silent downgrade.

## One-Time Server Setup

Use a dedicated Linux deployment directory/account with Docker Engine,
Compose v2, Bash, Python3, GNU sha256sum, flock, tar and SSH already installed.
The account must be allowed to run Docker. The server does not need Node,
pnpm, GitHub access, registry credentials or an outbound registry connection.
No package/tool installation is performed by the deployment CLI.

Install runtime.env in that directory with mode 0600, following
runtime.env.example. Keep real credentials, HTTPS origin and the persistent
pairing/server identity on the server. No runtime secrets belong in Git,
release assets, the operator's archive directory or Actions logs.

For an existing Compose-managed Remote, preserve its actual project and named
data volume. The administrator-only prepare-existing.py helper can prepare a
new deployment directory without restarting/copying/modifying the data.
Its --tooling directory must contain the new version's compose.yaml,
deploy.sh and offline-release.py. The helper records the cached image ID,
existing Compose configuration, source revision and migration fingerprint
for rollback. It also disables registry pulls in that saved configuration.
Review nonstandard mounts/ports separately. Do not adopt an already populated
deployment root or select a new empty volume to bypass an adoption failure.

The local CLI requires that dedicated directory to exist; it does not adopt
or create a cloud deployment implicitly. A first deployment refuses an
existing service/project or data volume without a managed current release.
No GitHub environment/SSH secrets or REMOTE_DEPLOY_ENABLED variable are used.

Remote binds 127.0.0.1:8787 by default. Keep the existing HTTPS reverse proxy,
HTTP/WebSocket forwarding, DNS, firewall and certificates. Deployment does not
modify them. Confirm public HTTPS and real paired-device reconnection
separately; container health is not cloud/client acceptance.

## Apply Preflight and Recovery

All uploaded bytes, receipt/source identity and target platform are checked
under a deployment lock. Before stopping the service, apply verifies the
actual current Compose project, named volume, port, running source/image and
**cached immutable rollback image**. A cache miss fails without pulling or
stopping. After archive linkage validation and load, it probes only the bound
config/manifest digests and requires one unique local image ID. Its platform,
source/version labels, root filesystem and migration fingerprint must match
before stop. OCI descriptor digest/size/media type must match the archive when
the local ID is a manifest digest. Generated deployment settings accept only
the same bound identities across retries; no image metadata is overridden.

Only then does it stop the old service, back up the stopped volume (SQLite,
WAL and server identity together), and start the candidate. Backup and every
candidate/rollback launch use pull=never; Compose also uses no-build/no-deps.
Running image identity and /health source revision must match before current
is atomically advanced. A short interruption during an explicit apply is
expected; clients reconnect.

Failure with the same migration fingerprint attempts the cached previous
image and still returns failure. If migrations changed, or this is the first
deployment, the failed service stays stopped and requires manual recovery.
There is no automatic old-code start on a changed schema, database restore,
volume deletion, identity replacement, image prune or registry fallback.
Preserve the failed candidate, old images and restricted stopped-data backups;
retention/cleanup is an explicit operator policy.

## Protocol rollout

New Host/Web exchange an encrypted hello after the cryptographic handshake.
The selected protocol and capabilities are bound to the device, connection and
Host generation. Explicit negotiation errors or connection failure never fall
back. To preserve already deployed Hosts that ignore hello, Web permits a
bounded 1.5-second silent-peer fallback to the existing legacy behavior. Old
Web clients may send their first business command to a new Host without hello.
This transition is not proof that arbitrary historical peers are compatible.
Remove it only as a separately planned compatibility break.

Deploying Remote does not update the user's Gian Desktop. The paired Host
change must reach a Gian release for new connections to report negotiated mode.
