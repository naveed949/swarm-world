#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 TARGET_REPOSITORY CONFIG_YAML OUTPUT_DIRECTORY" >&2
  exit 64
fi

target=$1
config=$2
output=$3
image_name=${SWARM_WORLD_IMAGE:-swarm-world-repository:local}
auth_file=${SWARM_WORLD_PI_AUTH_FILE:-${HOME}/.pi/agent/auth.json}
provider=${SWARM_WORLD_PI_PROVIDER:-openai-codex}
model=${SWARM_WORLD_PI_MODEL:-gpt-5.6-luna}
reasoning=${SWARM_WORLD_PI_REASONING:-medium}
network_name="swarm-world-pi-$$"
sidecar_name="swarm-world-pi-sidecar-$$"
dependencies_volume="swarm-world-pi-dependencies-$$"

cleanup() {
  docker rm --force "$sidecar_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  docker volume rm --force "$dependencies_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null 2>&1 || {
  echo "docker is required" >&2
  exit 69
}
test -f "$config" || {
  echo "config does not exist: $config" >&2
  exit 66
}
test -f "$auth_file" || {
  echo "Pi authentication is required; set SWARM_WORLD_PI_AUTH_FILE" >&2
  exit 66
}

target=$(git -C "$target" rev-parse --show-toplevel)
config_dir=$(cd "$(dirname "$config")" && pwd -P)
config="$config_dir/$(basename "$config")"
auth_dir=$(cd "$(dirname "$auth_file")" && pwd -P)
auth_file="$auth_dir/$(basename "$auth_file")"
mkdir -p "$output"
output=$(cd "$output" && pwd -P)

if [ "${SWARM_WORLD_SKIP_BUILD:-0}" != "1" ]; then
  docker build \
    --file docker/repository-runner.Dockerfile \
    --tag "$image_name" \
    .
fi

docker volume create "$dependencies_volume" >/dev/null
docker run --rm \
  --user 0:0 \
  --network bridge \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 256 \
  --memory 4g \
  --cpus 4 \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=4g,mode=1777 \
  --mount "type=bind,src=$target,dst=/input,readonly" \
  --mount "type=volume,src=$dependencies_volume,dst=/dependencies" \
  --env HOME=/tmp/home \
  --entrypoint /app/docker/repository-dependencies-entrypoint.sh \
  "$image_name"

docker network create --internal "$network_name" >/dev/null
docker run --detach --rm \
  --name "$sidecar_name" \
  --user "$(id -u):$(id -g)" \
  --network bridge \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --memory 1g \
  --cpus 2 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
  --mount "type=bind,src=$auth_file,dst=/run/secrets/pi-auth.json,readonly" \
  --env HOME=/tmp/home \
  --env SWARM_WORLD_PI_PROVIDER="$provider" \
  --env SWARM_WORLD_PI_MODEL="$model" \
  --env SWARM_WORLD_PI_REASONING="$reasoning" \
  --entrypoint /app/docker/pi-sidecar-entrypoint.sh \
  "$image_name" >/dev/null
docker network connect "$network_name" "$sidecar_name"

ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  if docker exec "$sidecar_name" node -e \
    'fetch("http://127.0.0.1:4317/health").then(r=>{if(!r.ok)process.exit(1)})' \
    >/dev/null 2>&1; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
test "$ready" = "1" || {
  echo "Pi sidecar did not become ready" >&2
  docker logs "$sidecar_name" >&2
  exit 70
}

docker run --rm \
  --user "$(id -u):$(id -g)" \
  --network "$network_name" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 256 \
  --memory 4g \
  --cpus 4 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777 \
  --tmpfs /workspace:rw,exec,nosuid,nodev,size=4g,mode=1777 \
  --mount "type=bind,src=$target,dst=/input,readonly" \
  --mount "type=bind,src=$config,dst=/config/repository.yaml,readonly" \
  --mount "type=bind,src=$output,dst=/output" \
  --mount "type=volume,src=$dependencies_volume,dst=/workspace/dependencies,readonly" \
  --env HOME=/tmp/home \
  --env SWARM_WORLD_PI_SIDECAR_URL="http://$sidecar_name:4317" \
  --env SWARM_WORLD_DEPENDENCIES=/workspace/dependencies \
  "$image_name"
