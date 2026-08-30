#!/bin/sh
set -eu

repository=.examples/sandcastle
output=runs/sandcastle-write-container-ci
run_id=repository-n2-s3202-eb079a36
run_directory="$output/$run_id"

if [ ! -d "$repository/.git" ]; then
  sh scripts/prepare-sandcastle-example.sh "$repository"
fi

sh scripts/run-repository-container.sh \
  "$repository" \
  examples/repository/sandcastle-write.yaml \
  "$output"

node dist/cli.js verify "$run_directory/trace.jsonl"
git -C "$repository" apply --check "../../$run_directory/artifact.patch"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const summary = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (
    summary.outcome !== "completed" ||
    summary.candidateCommit !== "be8412fd27b563165a2a21d4a7b5a2ed2ab66249" ||
    summary.evaluation.hardGatesPassed !== true ||
    !summary.evaluation.checks.some(
      (check) => check.facilityId === "env-contract" && check.success === true,
    )
  ) {
    throw new Error("Sandcastle writable artifact did not pass its fixed contract");
  }
' "$run_directory/summary.json"
