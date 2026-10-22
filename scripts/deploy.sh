#!/usr/bin/env bash
set -euo pipefail
# Linux: Docker Compose v2, Python3, flock. No registry authentication.
mode=${1:?stage or apply required}
base=${2:?deployment directory required}
revision=${3:?revision required}
receipt_hash=${4:?published receipt hash required}
arch=${5:?architecture required}
project=${6:?existing Compose project required}
volume=${7:?existing named data volume required}
port=${8:?HTTP port required}
[[ "$mode" == stage || "$mode" == apply ]] || exit 64
[[ "$base" =~ ^/([a-zA-Z0-9_-]+/)+[a-zA-Z0-9_-]+$ && "$base" != /home && "$base" != /opt && "$base" != /srv && "$base" != /root && "$base" != /tmp ]] || exit 64
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$receipt_hash" =~ ^[a-f0-9]{64}$ && ( "$arch" == amd64 || "$arch" == arm64 ) ]] || exit 64
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ && "$volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 64
[[ "$port" =~ ^[0-9]+$ && "$port" -ge 1024 && "$port" -le 65535 ]] || exit 64
[[ -d "$base" && ! -L "$base" && ! -L "$base/releases" && ! -L "$base/backups" && ! -L "$base/deploy.lock" ]] || exit 65
script_dir=$(cd -P -- "$(dirname -- "$0")" && pwd)
release="$base/releases/$revision"
[[ "$script_dir" =~ ^$base/incoming\.[A-Za-z0-9]{8}$ || "$script_dir" == "$release" ]] || exit 65
cd "$base"
exec 9>deploy.lock
flock -n 9 || { echo 'Another Remote deployment is running'; exit 75; }
umask 077
verifier="$script_dir/offline-release.py"
verify() { python3 "$verifier" verify "$1" "$revision" "$receipt_hash" "$arch" "$base" "$volume" "$port"; }
metadata=$(verify "$script_dir")
python3 "$script_dir/offline-release.py" platform "$arch"
mkdir -p releases
[[ ! -L "$release" ]] || exit 65
if [[ "$script_dir" != "$release" ]]; then
  if [[ -e "$release" ]]; then
    # Exact retries are allowed; conflicting, dirty or partial releases are not.
    verify "$release" >/dev/null
    rm -rf -- "$script_dir"
  else
    mv -T -- "$script_dir" "$release"
  fi
fi
verifier="$release/offline-release.py"
if [[ "$mode" == stage ]]; then
  echo "Verified release staged: $revision (no load or restart)"
  exit 0
fi
[[ -f runtime.env && ! -L runtime.env ]] || { echo 'Missing regular runtime.env'; exit 65; }
image=${metadata%%$'\n'*}
rest=${metadata#*$'\n'}
schema=${rest%%$'\n'*}
archive=${rest#*$'\n'}
compose() {
  env -u REMOTE_IMAGE -u REMOTE_RUNTIME_ENV -u REMOTE_PORT -u REMOTE_DATA_VOLUME -u REMOTE_PLATFORM \
    docker compose --project-name "$project" --env-file "$1/deploy.env" -f "$1/compose.yaml" "${@:2}"
}
healthy() {
  local directory=$1 expected_revision=$2 expected_image=$3 id state
  for ((attempt=0; attempt<${REMOTE_DEPLOY_HEALTH_ATTEMPTS:-30}; attempt++)); do
    id=$(compose "$directory" ps -q remote)
    if [[ -n "$id" ]]; then
      python3 "$release/offline-release.py" container "$directory" "$arch" "$id" "$expected_image" || return 1
      state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")
      if [[ "$state" == healthy ]]; then
        docker exec "$id" node -e \
          "fetch('http://127.0.0.1:8787/health').then(async r=>{const h=await r.json();if(!r.ok||!h.ok||h.build_id!==process.argv[1])process.exit(1)}).catch(()=>process.exit(1))" \
          "$expected_revision" && return 0
        return 1
      fi
      [[ "$state" == unhealthy ]] && return 1
    fi
    sleep 2
  done
  return 1
}
previous='' previous_image='' previous_revision=''
if [[ -L current ]]; then
  previous=$(readlink current)
  [[ "$previous" =~ ^releases/[a-f0-9]{40}$ && ! -L "$previous" ]] || exit 65
  previous_revision=${previous#releases/}
  previous="$base/$previous"
  previous_image=$(python3 "$release/offline-release.py" previous "$base" "$previous_revision" "$project" "$volume" "$port")
elif [[ -e current ]]; then
  echo 'current must be a managed release symlink'; exit 65
else
  # A pre-existing service or volume needs explicit non-disruptive adoption.
  [[ -z "$(docker ps -a --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=remote -q)" ]] || exit 65
  if docker volume inspect "$volume" >/dev/null 2>&1; then echo 'Existing data volume requires adoption'; exit 65; fi
fi
# Integrity, server platform and cached rollback availability passed. Loading
# and inspecting the candidate still happen before any current service stop.
docker load --input "$release/$archive"
image=$(python3 "$release/offline-release.py" image "$release" "$arch")
if [[ "$previous" == "$release" ]] && healthy "$release" "$revision" "$image"; then
  echo 'This exact release is already healthy'; exit 0
fi
printf 'REMOTE_IMAGE=%s\nREMOTE_RUNTIME_ENV=%s/runtime.env\nREMOTE_PORT=%s\nREMOTE_DATA_VOLUME=%s\nREMOTE_PLATFORM=linux/%s\n' \
  "$image" "$base" "$port" "$volume" "$arch" > "$release/deploy.env"
printf '%s\n' "$schema" > "$release/data-schema"
changed=0
rollback() {
  local status=$?
  trap - EXIT
  if [[ "$status" != 0 && "$changed" == 1 ]]; then
    compose "$release" stop remote || true
    if [[ -n "$previous" && "$(<"$previous/data-schema")" == "$schema" ]]; then
      # --pull never applies even to legacy/adopted Compose files.
      if docker image inspect "$previous_image" >/dev/null 2>&1 \
        && compose "$previous" up -d --no-build --no-deps --pull never remote \
        && healthy "$previous" "$previous_revision" "$previous_image"; then
        echo 'Deployment failed; previous image restored (unchanged database migration set).'
      else
        echo 'Deployment and rollback both failed; operator intervention required (no registry fallback).'
      fi
    else
      echo 'Deployment failed; automatic rollback withheld because the database migration set changed or this is the first deployment. Stopped service; preserve data and use the backup for manual recovery.'
    fi
  fi
  exit "$status"
}
trap rollback EXIT
if [[ -n "$previous" ]]; then
  changed=1
  compose "$previous" stop remote
  backup="$base/backups/$(date -u +%Y%m%dT%H%M%SZ)-$revision-$$"
  mkdir -p "$backup"
  # Stopped SQLite, WAL and identity are backed up together. No registry access.
  docker run --rm --pull=never --network none --user 0 --entrypoint tar \
    -v "$volume:/data:ro" -v "$backup:/backup" \
    "$image" -czf /backup/data.tar.gz -C /data .
fi
changed=1
compose "$release" up -d --no-build --no-deps --pull never remote
healthy "$release" "$revision" "$image"
next="$base/current.next.$revision.$$"
ln -s "releases/$revision" "$next"
mv -Tf "$next" "$base/current"
changed=0
echo "Remote deployment healthy: $revision"
