#!/bin/sh
set -eu

umask 077

test -d /input/.git || {
  echo "input mount is not a Git repository" >&2
  exit 64
}
test -f /config/repository.yaml || {
  echo "missing /config/repository.yaml" >&2
  exit 64
}
test ! -e /workspace/target || {
  echo "/workspace/target must start empty" >&2
  exit 64
}

mkdir -p /tmp/home /workspace/target
rmdir /workspace/target
git -c safe.directory=/input clone --quiet --no-hardlinks /input /workspace/target

if [ -n "${SWARM_WORLD_DEPENDENCIES:-}" ]; then
  ln -s "$SWARM_WORLD_DEPENDENCIES" /workspace/target/node_modules
fi

exec node /app/dist/cli.js run \
  --config /config/repository.yaml \
  --output /output
