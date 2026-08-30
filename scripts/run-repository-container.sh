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

command -v docker >/dev/null 2>&1 || {
  echo "docker is required" >&2
  exit 69
}
test -f "$config" || {
  echo "config does not exist: $config" >&2
  exit 66
}

target=$(git -C "$target" rev-parse --show-toplevel)
config_dir=$(cd "$(dirname "$config")" && pwd -P)
config="$config_dir/$(basename "$config")"
mkdir -p "$output"
output=$(cd "$output" && pwd -P)

if [ "${SWARM_WORLD_SKIP_BUILD:-0}" != "1" ]; then
  docker build \
    --file docker/repository-runner.Dockerfile \
    --tag "$image_name" \
    .
fi

exec docker run --rm \
  --user "$(id -u):$(id -g)" \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --memory 2g \
  --cpus 2 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777 \
  --tmpfs /workspace:rw,noexec,nosuid,nodev,size=2g,mode=1777 \
  --mount "type=bind,src=$target,dst=/input,readonly" \
  --mount "type=bind,src=$config,dst=/config/repository.yaml,readonly" \
  --mount "type=bind,src=$output,dst=/output" \
  --env HOME=/tmp/home \
  "$image_name"
