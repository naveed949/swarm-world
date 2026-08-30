#!/bin/sh
set -eu

test -d /input/.git || {
  echo "input mount is not a Git repository" >&2
  exit 64
}
test -d /dependencies || {
  echo "missing dependency volume" >&2
  exit 64
}

mkdir -p /tmp/home /tmp/npm-cache
git -c safe.directory=/input clone --quiet --no-hardlinks /input /tmp/target
npm --prefix /tmp/target ci --ignore-scripts --cache /tmp/npm-cache
cp -R /tmp/target/node_modules/. /dependencies/
