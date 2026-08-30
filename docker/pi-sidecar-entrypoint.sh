#!/bin/sh
set -eu

umask 077
test -f /run/secrets/pi-auth.json || {
  echo "missing Pi authentication" >&2
  exit 66
}
cp /run/secrets/pi-auth.json /tmp/pi-auth.json
chmod 600 /tmp/pi-auth.json
export SWARM_WORLD_PI_AUTH_PATH=/tmp/pi-auth.json

exec node /app/dist/pi-sidecar.js
