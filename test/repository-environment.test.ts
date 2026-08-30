import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RepositoryEnvironment,
  type RepositoryEnvironmentConfig,
} from "../src/repository-environment.js";
import {
  createRepositoryPlanner,
  runRepositoryExperiment,
} from "../src/repository-experiment.js";
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
      acceptanceFacilityIds: ["acceptance"],
      regressionFacilityIds: ["acceptance"],
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

  it("runs a deterministic read-only multi-agent survey", async () => {
    const environment = fixture();
    const result = await runRepositoryExperiment(
      {
        seed: 3201,
        population: 2,
        ticks: 3,
        macroturnInterval: 1,
        planLimit: 1,
        condition: "full",
        planner: "survey",
        surveyQueries: ["export"],
        environment,
      },
      mkdtempSync(join(tmpdir(), "swarm-world-survey-")),
    );
    const trace = readFileSync(result.tracePath, "utf8");

    expect(result.summary.outcome).toBe("no eligible artifact");
    expect(result.summary.evaluation.hardGatesPassed).toBe(false);
    expect(trace).toContain('"type":"CLAIM_TASK"');
    expect(trace).toContain('"type":"INSPECT"');
    expect(trace).toContain('"type":"SEARCH"');
  });

  it("plans a bounded evidence-preconditioned replacement lifecycle", async () => {
    const environment = fixture(false);
    const world = await RepositoryEnvironment.create({
      ...environment,
      readOnly: true,
    });
    world.createAgent("agent_000000");
    const observation = await world.observe({ agentId: "agent_000000" });
    const planner = createRepositoryPlanner({
      seed: 3201,
      population: 1,
      ticks: 7,
      macroturnInterval: 1,
      planLimit: 1,
      condition: "full",
      planner: "scripted",
      scriptedChange: {
        targetPath: "math.ts",
        oldText: "a - b",
        newText: "a + b",
        requiredFacilityIds: ["acceptance"],
      },
      environment,
    });
    const plan = async (
      tick: number,
      overrides: Partial<typeof observation> = {},
    ) =>
      await planner.plan({
        agentId: "agent_000000",
        tick,
        observation: { ...observation, ...overrides },
      });

    expect((await plan(0))[0]?.type).toBe("CLAIM_TASK");
    expect((await plan(1))[0]?.type).toBe("INSPECT");
    expect((await plan(2, { ownedEvidenceIds: ["evidence"] }))[0]?.type).toBe(
      "FORMULATE",
    );
    expect((await plan(3, { ownedRecipeIds: ["recipe"] }))[0]).toMatchObject({
      type: "EDIT_REPLACE",
      oldText: "a - b",
      newText: "a + b",
    });
    expect((await plan(4, { ownedRecipeIds: ["recipe"] }))[0]?.type).toBe(
      "RUN_CHECK",
    );
    expect((await plan(5, { ownedRecipeIds: ["recipe"] }))[0]?.type).toBe(
      "CONSTRUCT_ARTIFACT",
    );
    expect((await plan(6, { ownedArtifactIds: ["artifact"] }))[0]).toEqual({
      type: "REQUEST_INTEGRATION",
      artifactId: "artifact",
    });
  });

  it("refuses writable experiments outside the container boundary", async () => {
    const environment = fixture(false);
    await expect(RepositoryEnvironment.create(environment)).rejects.toThrow(
      "Writable repository experiments require the hardened container runner",
    );
    await expect(
      runRepositoryExperiment(
        {
          seed: 3201,
          population: 1,
          ticks: 7,
          macroturnInterval: 1,
          planLimit: 1,
          condition: "full",
          planner: "scripted",
          scriptedChange: {
            targetPath: "math.ts",
            oldText: "a - b",
            newText: "a + b",
            requiredFacilityIds: ["acceptance"],
          },
          environment,
        },
        mkdtempSync(join(tmpdir(), "swarm-world-host-write-")),
      ),
    ).rejects.toThrow(
      "Writable repository experiments require the hardened container runner",
    );
  });

  it("defaults omitted readOnly configuration to a host-safe survey", async () => {
    const config = fixture();
    delete config.readOnly;

    const environment = await RepositoryEnvironment.create(config);
    const agent = environment.createAgent("agent-1");

    expect(
      (await environment.observe({ agentId: agent.id })).affordances,
    ).not.toContain("EDIT");
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

  it("withholds hidden facilities from discovery", async () => {
    const config = fixture();
    config.facilities.push({
      ...config.facilities[0]!,
      id: "hidden-regression",
      category: "hidden",
      mandatory: true,
    });
    const environment = await RepositoryEnvironment.create(config);
    const agent = environment.createAgent("agent-1");
    const observation = await environment.observe({ agentId: agent.id });
    expect(observation.nodes.map((node) => node.label)).not.toContain(
      "hidden-regression",
    );
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
    const records = readFileSync(result.tracePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.some((record) => record.recordType === "environment")).toBe(
      true,
    );
    expect(records.some((record) => record.recordType === "scheduler")).toBe(
      true,
    );
  });

  it("runs independent-search agents in separate repository worlds", async () => {
    const environment = fixture();
    const directory = mkdtempSync(join(tmpdir(), "swarm-world-independent-"));
    const result = await runRepositoryExperiment(
      {
        seed: 19,
        population: 2,
        ticks: 1,
        macroturnInterval: 1,
        planLimit: 1,
        condition: "independent",
        environment: { ...environment, condition: "independent" },
      },
      directory,
      { plan: async () => [{ type: "WAIT" }] },
    );

    expect(result.summary.memberCandidateCommits).toEqual([
      environment.baseCommit,
      environment.baseCommit,
    ]);
    expect(result.summary.memberTraceHashes).toHaveLength(2);
  });
});
