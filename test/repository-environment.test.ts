import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/hash.js";
import {
  RepositoryEnvironment,
  type RepositoryEnvironmentConfig,
} from "../src/repository-environment.js";
import { runRepositoryExperiment } from "../src/repository-experiment.js";
import { loadRunConfig } from "../src/run-config.js";

function fixture(readOnly = true): RepositoryEnvironmentConfig {
  const root = mkdtempSync(join(tmpdir(), "swarm-world-repository-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "fixture@example.com",
  ]);
  execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
  writeFileSync(
    join(root, "math.ts"),
    "export const add = (a: number, b: number) => a - b;\n",
  );
  writeFileSync(
    join(root, "math.test.ts"),
    "import { add } from './math.ts';\nif (add(2, 1) !== 3) process.exit(1);\n",
  );
  writeFileSync(join(root, ".env"), "SECRET=hidden\n");
  execFileSync("git", ["-C", root, "add", "math.ts", "math.test.ts"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  const baseCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return {
    root,
    baseCommit,
    readOnly,
    task: {
      id: "bug-add",
      title: "add subtracts",
      acceptanceCriteria: ["add(2, 1) returns 3"],
      relevantPaths: ["math.ts", "math.test.ts"],
      priority: 1,
    },
    observationRadius: 2,
    observationLimit: 12,
    allowedPaths: ["**/*.ts"],
    excludedPaths: [".env", "node_modules/**"],
    patch: { maxFiles: 2, maxChangedLines: 20 },
    facilities: [
      {
        id: "acceptance",
        category: "test",
        executable: process.execPath,
        args: ["--experimental-strip-types", "math.test.ts"],
        workingDirectory: ".",
        permittedPaths: ["**/*.ts"],
        mutationClass: "none",
        timeoutMs: 2_000,
        outputLimit: 2_000,
        concurrency: 1,
        environment: {},
        mandatory: true,
      },
    ],
  };
}

describe("RepositoryEnvironment", () => {
  it("observes a deterministic, bounded, repository-native graph", async () => {
    const environment = await RepositoryEnvironment.create(fixture());
    const agent = environment.createAgent("agent-1");

    const first = await environment.observe({ agentId: agent.id });
    const second = await environment.observe({ agentId: agent.id });

    expect(second).toEqual(first);
    expect(first.nodes.length).toBeLessThanOrEqual(12);
    expect(first.nodes.map((node) => node.type)).toContain("task");
    expect(first.nodes.map((node) => node.type)).toContain("facility");
    expect(first.nodes.map((node) => node.path)).not.toContain(".env");
    expect(first.edges.some((edge) => edge.type === "test_relation")).toBe(
      true,
    );
  });

  it("allows focus movement only across visible graph relationships", async () => {
    const environment = await RepositoryEnvironment.create(fixture());
    const agent = environment.createAgent("agent-1");
    const observation = await environment.observe({ agentId: agent.id });
    const file = observation.nodes.find((node) => node.path === "math.ts")!;
    const facility = observation.nodes.find(
      (node) => node.type === "facility",
    )!;

    expect(
      await environment.resolve({
        agentId: agent.id,
        action: { type: "FOCUS", nodeId: file.id },
      }),
    ).toMatchObject({ accepted: true });
    expect(
      await environment.resolve({
        agentId: agent.id,
        action: { type: "FOCUS", nodeId: facility.id },
      }),
    ).toMatchObject({
      accepted: false,
      reason: "focus target is not on a visible graph relationship",
    });
  });

  it("enforces treatment capabilities and exclusive authoritative claims", async () => {
    const disabled = await RepositoryEnvironment.create({
      ...fixture(),
      condition: "no-communication",
    });
    const disabledAgent = disabled.createAgent("agent-1");
    disabled.createAgent("agent-2");
    const observation = await disabled.observe({ agentId: disabledAgent.id });
    expect(observation.affordances).not.toContain("COMMUNICATE");
    expect(
      await disabled.resolve({
        agentId: disabledAgent.id,
        action: { type: "CLAIM_TASK", taskId: "bug-add" },
      }),
    ).toMatchObject({ accepted: false });

    const enabled = await RepositoryEnvironment.create(fixture());
    const first = enabled.createAgent("agent-1");
    const second = enabled.createAgent("agent-2");
    await enabled.resolve({
      agentId: first.id,
      action: { type: "CLAIM_TASK", taskId: "bug-add" },
    });
    expect(
      await enabled.resolve({
        agentId: second.id,
        action: { type: "CLAIM_TASK", taskId: "bug-add" },
      }),
    ).toMatchObject({ accepted: false, reason: "task already claimed" });
  });

  it("records inspections as owned evidence and rejects writes in dry-run mode", async () => {
    const environment = await RepositoryEnvironment.create(fixture());
    const agent = environment.createAgent("agent-1");
    const file = (await environment.observe({ agentId: agent.id })).nodes.find(
      (node) => node.path === "math.ts",
    )!;

    const inspected = await environment.resolve({
      agentId: agent.id,
      action: { type: "INSPECT", nodeId: file.id },
    });
    const edited = await environment.resolve({
      agentId: agent.id,
      action: {
        type: "EDIT",
        recipeId: "missing",
        path: "math.ts",
        expectedContentHash: file.contentHash!,
        content: "export const add = (a: number, b: number) => a + b;\n",
      },
    });

    expect(inspected.accepted).toBe(true);
    expect(inspected.evidenceIds).toHaveLength(1);
    expect(edited).toMatchObject({
      accepted: false,
      reason: "permission blocked",
    });
  });

  it("creates, verifies, integrates, freezes, and evaluates an isolated patch", async () => {
    const config = fixture(false);
    const baseBefore = readFileSync(join(config.root, "math.ts"), "utf8");
    const environment = await RepositoryEnvironment.create(config);
    const agent = environment.createAgent("agent-1");
    const observation = await environment.observe({ agentId: agent.id });
    const file = observation.nodes.find((node) => node.path === "math.ts")!;
    const inspected = await environment.resolve({
      agentId: agent.id,
      action: { type: "INSPECT", nodeId: file.id },
    });
    const recipe = await environment.resolve({
      agentId: agent.id,
      action: {
        type: "FORMULATE",
        taskId: "bug-add",
        evidenceIds: inspected.evidenceIds,
        targets: ["math.ts"],
        requiredFacilities: ["acceptance"],
      },
    });
    const edited = await environment.resolve({
      agentId: agent.id,
      action: {
        type: "EDIT",
        recipeId: recipe.targetId!,
        path: "math.ts",
        expectedContentHash: file.contentHash!,
        content: "export const add = (a: number, b: number) => a + b;\n",
      },
    });
    const checked = await environment.resolve({
      agentId: agent.id,
      action: {
        type: "RUN_CHECK",
        recipeId: recipe.targetId!,
        facilityId: "acceptance",
      },
    });
    const artifact = await environment.resolve({
      agentId: agent.id,
      action: { type: "CONSTRUCT_ARTIFACT", recipeId: recipe.targetId! },
    });
    const integrated = await environment.resolve({
      agentId: agent.id,
      action: { type: "REQUEST_INTEGRATION", artifactId: artifact.targetId! },
    });
    await environment.advance();
    const frozen = await environment.freeze();
    const evaluation = await environment.evaluate(frozen);

    expect(edited.accepted).toBe(true);
    expect(checked).toMatchObject({ accepted: true });
    expect(artifact.accepted).toBe(true);
    expect(integrated.accepted).toBe(true);
    expect(frozen.candidateCommit).not.toBe(config.baseCommit);
    expect(evaluation).toMatchObject({
      outcome: "completed",
      hardGatesPassed: true,
    });
    expect(readFileSync(join(config.root, "math.ts"), "utf8")).toBe(baseBefore);
  });

  it("invalidates successful checks after any later edit", async () => {
    const environment = await RepositoryEnvironment.create(fixture(false));
    const agent = environment.createAgent("agent-1");
    const file = (await environment.observe({ agentId: agent.id })).nodes.find(
      (node) => node.path === "math.ts",
    )!;
    const inspected = await environment.resolve({
      agentId: agent.id,
      action: { type: "INSPECT", nodeId: file.id },
    });
    const recipe = await environment.resolve({
      agentId: agent.id,
      action: {
        type: "FORMULATE",
        taskId: "bug-add",
        evidenceIds: inspected.evidenceIds,
        targets: ["math.ts"],
        requiredFacilities: ["acceptance"],
      },
    });
    const fixed = "export const add = (a: number, b: number) => a + b;\n";
    await environment.resolve({
      agentId: agent.id,
      action: {
        type: "EDIT",
        recipeId: recipe.targetId!,
        path: "math.ts",
        expectedContentHash: file.contentHash!,
        content: fixed,
      },
    });
    await environment.resolve({
      agentId: agent.id,
      action: {
        type: "RUN_CHECK",
        recipeId: recipe.targetId!,
        facilityId: "acceptance",
      },
    });
    await environment.resolve({
      agentId: agent.id,
      action: {
        type: "EDIT",
        recipeId: recipe.targetId!,
        path: "math.ts",
        expectedContentHash: sha256(fixed),
        content: `${fixed}\n`,
      },
    });

    const artifact = await environment.resolve({
      agentId: agent.id,
      action: { type: "CONSTRUCT_ARTIFACT", recipeId: recipe.targetId! },
    });

    expect(artifact).toMatchObject({
      accepted: false,
      reason: "mandatory checks are missing or stale",
    });
  });

  it("withholds hidden facilities from discovery and rejects direct execution", async () => {
    const config = fixture(false);
    config.facilities.push({
      ...config.facilities[0]!,
      id: "hidden-regression",
      category: "hidden",
      mandatory: true,
    });
    const environment = await RepositoryEnvironment.create(config);
    const agent = environment.createAgent("agent-1");
    const observation = await environment.observe({ agentId: agent.id });
    const file = observation.nodes.find((node) => node.path === "math.ts")!;
    expect(observation.nodes.map((node) => node.label)).not.toContain(
      "hidden-regression",
    );
    const inspected = await environment.resolve({
      agentId: agent.id,
      action: { type: "INSPECT", nodeId: file.id },
    });
    const recipe = await environment.resolve({
      agentId: agent.id,
      action: {
        type: "FORMULATE",
        taskId: "bug-add",
        evidenceIds: inspected.evidenceIds,
        targets: ["math.ts"],
        requiredFacilities: ["acceptance"],
      },
    });

    expect(
      await environment.resolve({
        agentId: agent.id,
        action: {
          type: "RUN_CHECK",
          recipeId: recipe.targetId!,
          facilityId: "hidden-regression",
        },
      }),
    ).toMatchObject({
      accepted: false,
      reason: "hidden evaluation facilities are unavailable during discovery",
    });
  });

  it("selects repository runs from configuration and reports incomplete dry runs honestly", async () => {
    const environment = fixture();
    const directory = mkdtempSync(join(tmpdir(), "swarm-world-run-config-"));
    const path = join(directory, "repository.json");
    writeFileSync(
      path,
      JSON.stringify({
        seed: 17,
        population: 1,
        ticks: 1,
        macroturnInterval: 1,
        planLimit: 1,
        condition: "full",
        environment: { type: "repository", ...environment },
      }),
    );

    const loaded = await loadRunConfig(path);
    expect(loaded.type).toBe("repository");
    if (loaded.type !== "repository") throw new Error("wrong run type");
    const result = await runRepositoryExperiment(
      loaded.config,
      join(directory, "runs"),
    );

    expect(result.summary).toMatchObject({
      outcome: "no eligible artifact",
      baseCommit: environment.baseCommit,
      candidateCommit: environment.baseCommit,
    });
  });
});
