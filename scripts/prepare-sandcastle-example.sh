#!/bin/sh
set -eu

destination=${1:-.examples/sandcastle}
commit=b03b295836bdc7ce67846814f02a80705c162122

test ! -e "$destination" || {
  echo "destination already exists: $destination" >&2
  exit 73
}

mkdir -p "$(dirname "$destination")"
git clone --quiet https://github.com/naveed949/sandcastle.git "$destination"
git -C "$destination" checkout --quiet --detach "$commit"

echo "$destination is pinned to $commit"
