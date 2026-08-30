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
});
