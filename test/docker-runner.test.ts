import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("repository container runner", () => {
  it("pins the runtime base image and uses a non-root image user", () => {
    const dockerfile = readFileSync(
      "docker/repository-runner.Dockerfile",
      "utf8",
    );

    expect(dockerfile).toMatch(/node:24-bookworm-slim@sha256:[a-f0-9]{64}/);
    expect(dockerfile).toContain("USER 10001:10001");
  });

  it("keeps the target read-only and applies runtime isolation", () => {
    const script = readFileSync("scripts/run-repository-container.sh", "utf8");

    for (const constraint of [
      "--network none",
      "--read-only",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--pids-limit 128",
      "dst=/input,readonly",
    ])
      expect(script).toContain(constraint);
    expect(script).not.toContain("--privileged");
    expect(script).not.toContain("docker.sock");
  });

  it("pins the real Sandcastle example and leaves it read-only", () => {
    const config = readFileSync("examples/repository/sandcastle.yaml", "utf8");

    expect(config).toContain(
      "baseCommit: b03b295836bdc7ce67846814f02a80705c162122",
    );
    expect(config).toContain("readOnly: true");
    expect(config).toContain("planner: survey");
  });

  it("bounds the writable Sandcastle example to one non-secret file", () => {
    const config = readFileSync(
      "examples/repository/sandcastle-write.yaml",
      "utf8",
    );

    expect(config).toContain("planner: scripted");
    expect(config).toContain("targetPath: .sandcastle/.env.example");
    expect(config).toContain("maxFiles: 1");
    expect(config).toContain("ISSUE_REPOSITORY=naveed949/sandcastle");
  });

  it("isolates Pi credentials in a sidecar and keeps the repository runner internal", () => {
    const script = readFileSync(
      "scripts/run-repository-pi-container.sh",
      "utf8",
    );

    for (const constraint of [
      "--network bridge",
      "--read-only",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "dst=/input,readonly",
      "dst=/run/secrets/pi-auth.json,readonly",
      "docker network create --internal",
      "SWARM_WORLD_PI_SIDECAR_URL",
      "SWARM_WORLD_PI_SIDECAR_TOKEN",
      "SWARM_WORLD_DEPENDENCIES",
    ])
      expect(script).toContain(constraint);
    expect(script.match(/dst=\/run\/secrets\/pi-auth\.json/g)).toHaveLength(1);
    expect(script.match(/SWARM_WORLD_PI_SIDECAR_TOKEN/g)).toHaveLength(2);
    expect(script).not.toContain("SWARM_WORLD_PI_AUTH_PATH");
    expect(script).toContain('--network "$network_name"');
    expect(script).toContain("repository-dependencies-entrypoint.sh");
    expect(
      readFileSync("docker/repository-dependencies-entrypoint.sh", "utf8"),
    ).toContain("--cache /tmp/npm-cache");
    expect(script).not.toContain("docker.sock");
    expect(script).not.toContain("GH_TOKEN");
    expect(script).not.toContain("OPENAI_API_KEY");
  });

  it("binds the live Pi example to real issue 26 and its rolling base", () => {
    const config = readFileSync(
      "examples/repository/sandcastle-issue-26-pi.yaml",
      "utf8",
    );

    expect(config).toContain("planner: pi");
    expect(config).toContain("id: sandcastle-issue-26");
    expect(config).toContain(
      "baseCommit: f36d8413aec7f4b167114a55ee9b516d1c1d6c4d",
    );
    expect(config).toContain("readOnly: false");
  });
});
