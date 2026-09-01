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
import {
  checkpointSatisfiesGoal,
  createRepositoryPlanner,
  runRepositoryCoordinationComparison,
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
  writeFileSync(join(root, "notes.ts"), "export const note = 'unrelated';\n");
  writeFileSync(join(root, ".env"), "SECRET=hidden\n");
  execFileSync("git", [
    "-C",
    root,
    "add",
    "math.ts",
    "math.test.ts",
    "notes.ts",
  ]);
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
  it("rejects observed allowed files outside the approved task scope", async () => {
    const environment = await RepositoryEnvironment.create(fixture());
    environment.config.readOnly = false;
    const agent = environment.createAgent("agent-1");
    await environment.observe({ agentId: agent.id });
    const searched = await environment.resolve({
      agentId: agent.id,
      action: { type: "SEARCH", query: "unrelated", paths: ["notes.ts"] },
    });

    await expect(
      environment.resolve({
        agentId: agent.id,
        action: {
          type: "FORMULATE",
          taskId: "bug-add",
          evidenceIds: searched.evidenceIds,
          targets: ["notes.ts"],
          requiredFacilities: ["acceptance"],
        },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: "path or file-count policy rejected recipe",
    });
  });

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

  it("returns an immutable self-contained repository checkpoint", async () => {
    const environment = await RepositoryEnvironment.create(fixture());
    environment.createAgent("agent-1");

    const frozen = await environment.freeze();

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.task)).toBe(true);
    expect(Object.isFrozen(frozen.facilities)).toBe(true);
    expect(Object.isFrozen(frozen.facilities[0])).toBe(true);
    expect(Object.isFrozen(frozen.taskProposals)).toBe(true);
    expect(Object.values(frozen.nodePaths)).toEqual(
      expect.arrayContaining(["math.ts", "math.test.ts"]),
    );
  });

  it("retains task-relevant files before symbols at a tight observation limit", async () => {
    const config = fixture();
    config.observationLimit = 3;
    const environment = await RepositoryEnvironment.create(config);
    const agent = environment.createAgent("agent-1");

    const observation = await environment.observe({ agentId: agent.id });

    expect(observation.nodes.map((node) => node.type)).toEqual([
      "task",
      "file",
      "test",
    ]);
    expect(observation.nodes.map((node) => node.path).filter(Boolean)).toEqual(
      expect.arrayContaining(["math.ts", "math.test.ts"]),
    );
  });

  it("exposes an operator-approved new task path as an empty planned file", async () => {
    const config = fixture();
    config.allowedPaths.push("new.ts");
    config.task.relevantPaths.push("new.ts");
    const environment = await RepositoryEnvironment.create(config);
    const agent = environment.createAgent("agent-1");

    const observation = await environment.observe({ agentId: agent.id });

    expect(observation.nodes).toContainEqual(
      expect.objectContaining({
        path: "new.ts",
        contentHash: sha256(""),
      }),
    );
    const planned = observation.nodes.find((node) => node.path === "new.ts")!;
    await expect(
      environment.resolve({
        agentId: agent.id,
        action: { type: "INSPECT", nodeId: planned.id },
      }),
    ).resolves.toMatchObject({ accepted: true });
    expect(
      (await environment.observe({ agentId: agent.id })).inspectedNodeIds,
    ).toContain(planned.id);
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

  it("enforces treatment capabilities while admitting distinct competing commitments", async () => {
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
    const transient = enabled.createAgent("agent-3");
    await enabled.resolve({
      agentId: first.id,
      action: { type: "CLAIM_TASK", taskId: "bug-add" },
    });
    expect(
      await enabled.resolve({
        agentId: second.id,
        action: { type: "CLAIM_TASK", taskId: "bug-add" },
      }),
    ).toMatchObject({ accepted: true });
    expect((await enabled.observe({ agentId: first.id })).commitments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: first.id, status: "active" }),
        expect.objectContaining({ agentId: second.id, status: "active" }),
      ]),
    );
    expect(
      await enabled.resolve({
        agentId: transient.id,
        action: {
          type: "CLAIM_COMMITMENT",
          taskId: "bug-add",
          approach: `default-${first.id}`,
          roleLabel: "duplicate-implementer",
          intendedContribution: "Repeat the existing approach",
          exitCondition: "Candidate submitted",
          leaseTicks: 4,
        },
      }),
    ).toMatchObject({ accepted: false, reason: "duplicate active approach" });
    await enabled.resolve({
      agentId: transient.id,
      action: {
        type: "CLAIM_COMMITMENT",
        taskId: "bug-add",
        approach: "short-lived investigation",
        roleLabel: "failure-reproducer",
        intendedContribution: "Reproduce the defect",
        exitCondition: "Evidence is published",
        leaseTicks: 1,
      },
    });
    await enabled.advance();
    expect((await enabled.observe({ agentId: first.id })).commitments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: transient.id, status: "expired" }),
      ]),
    );
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

  it("loads a Pi repository planner with an explicit model", async () => {
    const environment = fixture(false);
    const directory = mkdtempSync(join(tmpdir(), "swarm-world-pi-config-"));
    const path = join(directory, "repository.json");
    writeFileSync(
      path,
      JSON.stringify({
        seed: 26,
        population: 2,
        ticks: 20,
        macroturnInterval: 1,
        planLimit: 1,
        condition: "full",
        planner: "pi",
        model: {
          provider: "openai-codex",
          id: "gpt-5.6-luna",
          temperature: 0,
          reasoning: "medium",
        },
        environment: { type: "repository", ...environment },
      }),
    );

    const loaded = await loadRunConfig(path);

    expect(loaded).toMatchObject({
      type: "repository",
      config: {
        planner: "pi",
        model: {
          provider: "openai-codex",
          id: "gpt-5.6-luna",
          reasoning: "medium",
        },
      },
    });
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

  it("shares one global budget across independent-search members", async () => {
    const environment = fixture();
    environment.goal = {
      id: "matched-independent-budget",
      statement: "Compare three independent attempts fairly",
      success: { minimumEligibleArtifacts: 1 },
      budget: {
        maxActions: 3,
        maxVerificationRuns: 3,
        maxWrites: 21,
        maxAttempts: 3,
        maxModelCalls: 3,
      },
      stop: {
        successSustainedForCheckpoints: 1,
        noProgressTicks: 10,
        checkpointInterval: 5,
      },
    };
    const directory = mkdtempSync(join(tmpdir(), "swarm-world-budget-"));
    const result = await runRepositoryExperiment(
      {
        seed: 190,
        population: 3,
        ticks: 2,
        macroturnInterval: 1,
        planLimit: 1,
        condition: "independent",
        coordinationModel: "independent-search",
        environment: { ...environment, condition: "independent" },
      },
      directory,
      { modelBacked: true, plan: async () => [{ type: "WAIT" }] },
    );
    const records = readFileSync(result.tracePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(
      records.filter((record) => record.recordType === "scheduler"),
    ).toHaveLength(3);
  });

  it("freezes periodic checkpoints and stops a stalled repository society", async () => {
    const environment = fixture();
    environment.goal = {
      id: "bounded-survey",
      statement: "Find a verified repository improvement",
      success: { minimumEligibleArtifacts: 1 },
      budget: {
        maxActions: 16,
        maxVerificationRuns: 4,
        maxWrites: 20,
        maxAttempts: 2,
        maxModelCalls: 10,
      },
      stop: {
        successSustainedForCheckpoints: 1,
        noProgressTicks: 2,
        checkpointInterval: 1,
      },
    };
    const result = await runRepositoryExperiment(
      {
        seed: 20,
        population: 3,
        ticks: 10,
        macroturnInterval: 1,
        planLimit: 1,
        condition: "full",
        environment,
      },
      mkdtempSync(join(tmpdir(), "swarm-world-stalled-")),
      { plan: async () => [{ type: "WAIT" }] },
    );

    expect(result.summary.stopReason).toBe("no-progress");
    expect(result.summary.checkpoints).toHaveLength(2);
    expect(
      result.summary.checkpoints?.every(
        (checkpoint) => !checkpoint.goalSatisfied,
      ),
    ).toBe(true);
  });

  it("never treats a failed mandatory checkpoint as goal success", () => {
    const config = fixture().task;
    expect(
      checkpointSatisfiesGoal(
        {
          id: "verified-goal",
          statement: "Pass all mandatory checks",
          success: { mandatoryChecksPass: true, minimumEligibleArtifacts: 1 },
          budget: {
            maxActions: 10,
            maxVerificationRuns: 4,
            maxWrites: 20,
            maxAttempts: 2,
          },
          stop: {
            successSustainedForCheckpoints: 1,
            noProgressTicks: 4,
            checkpointInterval: 1,
          },
        },
        {
          tick: 3,
          fingerprint: "integrated",
          eligibleArtifacts: 1,
          integratedArtifacts: 1,
          goalSatisfied: true,
        },
        {
          outcome: "evaluation inconclusive",
          revision: "candidate",
          hardGatesPassed: false,
          checks: [],
          correctness: 1,
          regressionSafety: 1,
          issueCoverage: 1,
          maintainability: 1,
          robustness: 0,
        },
      ),
    ).toBe(false);
    expect(config.acceptanceFacilityIds).toEqual(["acceptance"]);
  });

  it("compares all repository coordination models on the same pinned world", async () => {
    const environment = fixture();
    environment.goal = {
      id: "comparison",
      statement: "Compare bounded coordination",
      success: { minimumEligibleArtifacts: 1 },
      budget: {
        maxActions: 4,
        maxVerificationRuns: 2,
        maxWrites: 20,
        maxAttempts: 2,
        maxModelCalls: 2,
      },
      stop: {
        successSustainedForCheckpoints: 1,
        noProgressTicks: 1,
        checkpointInterval: 1,
      },
    };
    const config = {
      seed: 21,
      population: 3,
      ticks: 2,
      macroturnInterval: 1,
      planLimit: 1,
      condition: "full" as const,
      environment,
    };
    const comparison = await runRepositoryCoordinationComparison(
      config,
      mkdtempSync(join(tmpdir(), "swarm-world-comparison-")),
      [
        "emergent-society",
        "fixed-workflow",
        "central-supervisor",
        "independent-search",
      ],
      () => ({ plan: async () => [{ type: "WAIT" }] }),
    );

    expect(comparison.baseCommit).toBe(environment.baseCommit);
    expect(
      comparison.results.map(({ coordinationModel }) => coordinationModel),
    ).toEqual([
      "emergent-society",
      "fixed-workflow",
      "central-supervisor",
      "independent-search",
    ]);
    expect(
      comparison.results.every(
        ({ stopReason }) => stopReason === "no-progress",
      ),
    ).toBe(true);
  });

  it("enforces the bounded three-to-five-agent society contract", async () => {
    const environment = fixture();
    environment.goal = {
      id: "bounded-society",
      statement: "Use a bounded repository society",
      success: { minimumEligibleArtifacts: 1 },
      budget: {
        maxAgents: 5,
        maxActions: 10,
        maxVerificationRuns: 5,
        maxWrites: 20,
        maxAttempts: 3,
      },
      stop: {
        successSustainedForCheckpoints: 1,
        noProgressTicks: 2,
        checkpointInterval: 1,
      },
    };

    await expect(
      runRepositoryExperiment({
        seed: 211,
        population: 6,
        ticks: 1,
        macroturnInterval: 1,
        planLimit: 1,
        condition: "full",
        coordinationModel: "emergent-society",
        environment,
      }),
    ).rejects.toThrow("population");
    await expect(
      runRepositoryExperiment({
        seed: 212,
        population: 2,
        ticks: 1,
        macroturnInterval: 1,
        planLimit: 1,
        condition: "full",
        coordinationModel: "emergent-society",
        environment,
      }),
    ).rejects.toThrow("three to five agents");
  });

  it("keeps the goal immutable and admits only goal-bound operator-scoped tasks", async () => {
    const config = fixture();
    config.goal = {
      id: "repair-math",
      statement: "Repair the configured addition contract",
      success: { minimumEligibleArtifacts: 1 },
      budget: {
        maxAgents: 3,
        maxActions: 20,
        maxVerificationRuns: 4,
        maxWrites: 5,
        maxAttempts: 2,
      },
      stop: {
        successSustainedForCheckpoints: 1,
        noProgressTicks: 5,
        checkpointInterval: 1,
      },
    };
    const environment = await RepositoryEnvironment.create(config);
    config.goal.statement = "Mutated after environment creation";
    for (const id of ["author", "reviewer"]) environment.createAgent(id);
    const observed = await environment.observe({ agentId: "author" });
    expect(observed.goal?.statement).toBe(
      "Repair the configured addition contract",
    );
    const math = observed.nodes.find((node) => node.path === "math.ts")!;
    const authorEvidence = (
      await environment.resolve({
        agentId: "author",
        action: { type: "INSPECT", nodeId: math.id },
      })
    ).evidenceIds;
    const reviewerEvidence = (
      await environment.resolve({
        agentId: "reviewer",
        action: { type: "INSPECT", nodeId: math.id },
      })
    ).evidenceIds;

    await expect(
      environment.resolve({
        agentId: "author",
        action: {
          type: "PROPOSE_PROBLEM",
          goalId: "another-goal",
          statement: "Unrelated work",
          evidenceIds: authorEvidence,
          goalImpact: "Claims relevance",
        },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: "problem is off-goal",
    });
    const problem = await environment.resolve({
      agentId: "author",
      action: {
        type: "PROPOSE_PROBLEM",
        goalId: "repair-math",
        statement: "Addition violates its configured acceptance check",
        evidenceIds: authorEvidence,
        goalImpact: "The configured addition contract fails",
      },
    });
    await environment.resolve({
      agentId: "reviewer",
      action: {
        type: "CONFIRM_PROBLEM",
        problemId: problem.targetId!,
        evidenceIds: reviewerEvidence,
      },
    });

    await expect(
      environment.resolve({
        agentId: "author",
        action: {
          type: "PROPOSE_TASK",
          goalId: "repair-math",
          problemId: problem.targetId!,
          objective: "Edit unrelated notes",
          expectedOutcome: "Notes change",
          relevantPaths: ["notes.ts"],
          acceptanceCriteria: ["Anything passes"],
          acceptanceFacilityIds: ["acceptance"],
          regressionFacilityIds: ["acceptance"],
          dependencies: [],
          verificationPlan: ["Run acceptance"],
          estimatedCost: 99,
        },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: "task admission policy rejected proposal",
    });
  });

  it("budgets implementation attempts separately from commitments and teams", async () => {
    const config = fixture();
    config.goal = {
      id: "attempt-ledger",
      statement: "Produce one bounded implementation attempt",
      success: { minimumEligibleArtifacts: 1 },
      budget: {
        maxAgents: 3,
        maxActions: 30,
        maxVerificationRuns: 4,
        maxWrites: 20,
        maxAttempts: 1,
      },
      stop: {
        successSustainedForCheckpoints: 1,
        noProgressTicks: 5,
        checkpointInterval: 1,
      },
    };
    const environment = await RepositoryEnvironment.create(config);
    environment.config.readOnly = false;
    for (const id of ["first", "second", "helper"]) environment.createAgent(id);
    const initial = await environment.observe({ agentId: "first" });
    const math = initial.nodes.find((node) => node.path === "math.ts")!;
    const firstEvidence = (
      await environment.resolve({
        agentId: "first",
        action: { type: "INSPECT", nodeId: math.id },
      })
    ).evidenceIds;
    const secondEvidence = (
      await environment.resolve({
        agentId: "second",
        action: { type: "INSPECT", nodeId: math.id },
      })
    ).evidenceIds;
    const firstCommitment = await environment.resolve({
      agentId: "first",
      action: {
        type: "CLAIM_COMMITMENT",
        taskId: "bug-add",
        approach: "minimal repair",
        roleLabel: "implementer",
        intendedContribution: "Repair addition",
        exitCondition: "Candidate submitted",
        leaseTicks: 10,
      },
    });
    await environment.resolve({
      agentId: "helper",
      action: {
        type: "JOIN_COMMITMENT",
        commitmentId: firstCommitment.targetId!,
        roleLabel: "review helper",
        leaseTicks: 10,
      },
    });
    await environment.resolve({
      agentId: "second",
      action: {
        type: "CLAIM_COMMITMENT",
        taskId: "bug-add",
        approach: "compatibility repair",
        roleLabel: "implementer",
        intendedContribution: "Preserve compatibility",
        exitCondition: "Candidate submitted",
        leaseTicks: 10,
      },
    });
    expect(
      (await environment.observe({ agentId: "first" })).budgets.attempts,
    ).toBe(1);

    await expect(
      environment.resolve({
        agentId: "first",
        action: {
          type: "FORMULATE",
          taskId: "bug-add",
          evidenceIds: firstEvidence,
          targets: ["math.ts"],
          requiredFacilities: ["acceptance"],
        },
      }),
    ).resolves.toMatchObject({ accepted: true });
    const afterFirst = await environment.observe({ agentId: "first" });
    expect(afterFirst.attempts).toHaveLength(1);
    expect(afterFirst.budgets.attempts).toBe(0);
    expect(
      afterFirst.societyRecords?.map((record) => record.eventType),
    ).toEqual(
      expect.arrayContaining(["commitment-created", "attempt-started"]),
    );

    await expect(
      environment.resolve({
        agentId: "second",
        action: {
          type: "FORMULATE",
          taskId: "bug-add",
          evidenceIds: secondEvidence,
          targets: ["math.ts"],
          requiredFacilities: ["acceptance"],
        },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: "attempt budget exhausted",
    });
  });

  it("runs an emergent society from problem discovery through competing verified candidates", async () => {
    const config = fixture();
    config.goal = {
      id: "repair-math",
      statement: "Make addition correct without regressions",
      success: {
        mandatoryChecksPass: true,
        minimumEligibleArtifacts: 2,
      },
      budget: {
        maxActions: 64,
        maxVerificationRuns: 8,
        maxWrites: 20,
        maxAttempts: 4,
      },
      stop: {
        successSustainedForCheckpoints: 1,
        noProgressTicks: 10,
        checkpointInterval: 1,
      },
    };
    const environment = await RepositoryEnvironment.create(config);
    environment.config.readOnly = false;
    const candidateParent = mkdtempSync(
      join(tmpdir(), "swarm-world-candidate-test-"),
    );
    const candidateWorktree = join(candidateParent, "checkout");
    execFileSync("git", [
      "-C",
      config.root,
      "worktree",
      "add",
      "--detach",
      candidateWorktree,
      config.baseCommit,
    ]);
    (
      environment as unknown as { candidateWorktree: string }
    ).candidateWorktree = candidateWorktree;

    for (const id of ["minimalist", "compatibility", "verifier"])
      environment.createAgent(id);
    const initial = await environment.observe({ agentId: "minimalist" });
    await environment.observe({ agentId: "compatibility" });
    await environment.observe({ agentId: "verifier" });
    const math = initial.nodes.find((node) => node.path === "math.ts")!;
    const inspect = async (agentId: string) =>
      await environment.resolve({
        agentId,
        action: { type: "INSPECT", nodeId: math.id },
      });
    const minimalEvidence = (await inspect("minimalist")).evidenceIds;
    const compatibilityEvidence = (await inspect("compatibility")).evidenceIds;

    const problem = await environment.resolve({
      agentId: "minimalist",
      action: {
        type: "PROPOSE_PROBLEM",
        goalId: "repair-math",
        statement: "The add function subtracts its second operand",
        evidenceIds: minimalEvidence,
        goalImpact: "The configured acceptance behavior fails",
      },
    });
    expect(problem.accepted).toBe(true);
    expect(
      await environment.resolve({
        agentId: "compatibility",
        action: {
          type: "CONFIRM_PROBLEM",
          problemId: problem.targetId!,
          evidenceIds: compatibilityEvidence,
        },
      }),
    ).toMatchObject({ accepted: true });
    const proposedTask = await environment.resolve({
      agentId: "minimalist",
      action: {
        type: "PROPOSE_TASK",
        goalId: "repair-math",
        problemId: problem.targetId!,
        objective: "Correct add while preserving its exported contract",
        expectedOutcome: "add(2, 1) returns 3",
        relevantPaths: ["math.ts", "math.test.ts"],
        acceptanceCriteria: ["add(2, 1) returns 3"],
        acceptanceFacilityIds: ["acceptance"],
        regressionFacilityIds: ["acceptance"],
        dependencies: [],
        verificationPlan: ["Run acceptance from a clean candidate commit"],
        estimatedCost: 4,
      },
    });
    expect(proposedTask.accepted).toBe(true);
    const decomposition = await environment.resolve({
      agentId: "compatibility",
      action: {
        type: "DECOMPOSE_TASK",
        taskId: proposedTask.targetId!,
        objective: "Repair the math implementation without changing tests",
        relevantPaths: ["math.ts"],
        verificationPlan: ["Run acceptance from the candidate commit"],
        estimatedCost: 3,
      },
    });
    expect(decomposition.accepted).toBe(true);
    const taskId = decomposition.targetId!;

    expect(
      await environment.resolve({
        agentId: "minimalist",
        action: {
          type: "FORMULATE",
          taskId,
          evidenceIds: minimalEvidence,
          targets: ["math.ts"],
          requiredFacilities: ["acceptance"],
        },
      }),
    ).toMatchObject({
      accepted: false,
      reason: "an active task commitment is required",
    });

    for (const [agentId, approach, roleLabel] of [
      ["minimalist", "single-operator repair", "minimal-patch-implementer"],
      [
        "compatibility",
        "named function compatibility repair",
        "compatibility-implementer",
      ],
    ] as const)
      expect(
        await environment.resolve({
          agentId,
          action: {
            type: "CLAIM_COMMITMENT",
            taskId,
            approach,
            roleLabel,
            intendedContribution: approach,
            exitCondition: "Submit a checked candidate",
            leaseTicks: 20,
          },
        }),
      ).toMatchObject({ accepted: true });

    const formulate = async (agentId: string, evidenceIds: string[]) =>
      await environment.resolve({
        agentId,
        action: {
          type: "FORMULATE",
          taskId,
          evidenceIds,
          targets: ["math.ts"],
          requiredFacilities: ["acceptance"],
        },
      });
    const firstRecipe = await formulate("minimalist", minimalEvidence);
    const secondRecipe = await formulate(
      "compatibility",
      compatibilityEvidence,
    );
    expect(firstRecipe.accepted && secondRecipe.accepted).toBe(true);

    const editAndSubmit = async (
      agentId: string,
      recipeId: string,
      content: string,
    ) => {
      expect(
        await environment.resolve({
          agentId,
          action: {
            type: "EDIT",
            recipeId,
            path: "math.ts",
            expectedContentHash: math.contentHash!,
            content,
          },
        }),
      ).toMatchObject({ accepted: true });
      expect(
        await environment.resolve({
          agentId,
          action: { type: "RUN_CHECK", recipeId, facilityId: "acceptance" },
        }),
      ).toMatchObject({ accepted: true });
      return await environment.resolve({
        agentId,
        action: { type: "CONSTRUCT_ARTIFACT", recipeId },
      });
    };
    const minimalArtifact = await editAndSubmit(
      "minimalist",
      firstRecipe.targetId!,
      "export const add = (a: number, b: number) => a + b;\n",
    );
    const compatibilityArtifact = await editAndSubmit(
      "compatibility",
      secondRecipe.targetId!,
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    expect(minimalArtifact.accepted && compatibilityArtifact.accepted).toBe(
      true,
    );

    for (const [agentId, artifactId] of [
      ["minimalist", minimalArtifact.targetId!],
      ["compatibility", compatibilityArtifact.targetId!],
    ] as const)
      expect(
        await environment.resolve({
          agentId,
          action: { type: "REQUEST_VERIFICATION", artifactId },
        }),
      ).toMatchObject({ accepted: true });

    expect(
      await environment.resolve({
        agentId: "minimalist",
        action: {
          type: "VERIFY_ARTIFACT",
          artifactId: minimalArtifact.targetId!,
          facilityId: "acceptance",
        },
      }),
    ).toMatchObject({
      accepted: false,
      reason: "authors cannot verify their own artifacts",
    });
    for (const artifactId of [
      minimalArtifact.targetId!,
      compatibilityArtifact.targetId!,
    ])
      expect(
        await environment.resolve({
          agentId: "verifier",
          action: {
            type: "VERIFY_ARTIFACT",
            artifactId,
            facilityId: "acceptance",
          },
        }),
      ).toMatchObject({ accepted: true });

    expect(
      await environment.resolve({
        agentId: "verifier",
        action: {
          type: "REQUEST_INTEGRATION",
          artifactId: minimalArtifact.targetId!,
        },
      }),
    ).toMatchObject({ accepted: true });
    await environment.advance();
    const frozen = await environment.freeze();
    const evaluation = await environment.evaluate(frozen);

    expect(frozen.selection).toMatchObject({
      selectedArtifactId: minimalArtifact.targetId,
      eligibleArtifactIds: expect.arrayContaining([
        minimalArtifact.targetId,
        compatibilityArtifact.targetId,
      ]),
    });
    expect(frozen.acceptedArtifacts).toHaveLength(1);
    expect(frozen.acceptedArtifacts[0]?.taskIds).toEqual(
      expect.arrayContaining(["bug-add", proposedTask.targetId!, taskId]),
    );
    expect(evaluation).toMatchObject({
      outcome: "completed",
      hardGatesPassed: true,
    });
    expect(environment.progress()).toMatchObject({
      eligibleArtifacts: 2,
      integratedArtifacts: 1,
      goalSatisfied: true,
    });
  });

  it("uses an agent-free verifier for a one-member independent-search world", async () => {
    const config = fixture();
    config.condition = "independent";
    config.goal = {
      id: "independent-repair",
      statement: "Repair the pinned task independently",
      success: {
        requiredTaskIds: ["bug-add"],
        minimumEligibleArtifacts: 1,
      },
      budget: {
        maxActions: 32,
        maxVerificationRuns: 4,
        maxWrites: 20,
        maxAttempts: 1,
      },
      stop: {
        successSustainedForCheckpoints: 1,
        noProgressTicks: 8,
        checkpointInterval: 1,
      },
    };
    const environment = await RepositoryEnvironment.create(config);
    environment.config.readOnly = false;
    const candidateParent = mkdtempSync(
      join(tmpdir(), "swarm-world-independent-test-"),
    );
    const candidateWorktree = join(candidateParent, "checkout");
    execFileSync("git", [
      "-C",
      config.root,
      "worktree",
      "add",
      "--detach",
      candidateWorktree,
      config.baseCommit,
    ]);
    (
      environment as unknown as { candidateWorktree: string }
    ).candidateWorktree = candidateWorktree;
    environment.createAgent("independent-agent");
    const observation = await environment.observe({
      agentId: "independent-agent",
    });
    const math = observation.nodes.find((node) => node.path === "math.ts")!;
    const inspected = await environment.resolve({
      agentId: "independent-agent",
      action: { type: "INSPECT", nodeId: math.id },
    });
    expect(
      await environment.resolve({
        agentId: "independent-agent",
        action: { type: "CLAIM_TASK", taskId: "bug-add" },
      }),
    ).toMatchObject({ accepted: true });
    const recipe = await environment.resolve({
      agentId: "independent-agent",
      action: {
        type: "FORMULATE",
        taskId: "bug-add",
        evidenceIds: inspected.evidenceIds,
        targets: ["math.ts"],
        requiredFacilities: ["acceptance"],
      },
    });
    await environment.resolve({
      agentId: "independent-agent",
      action: {
        type: "EDIT",
        recipeId: recipe.targetId!,
        path: "math.ts",
        expectedContentHash: math.contentHash!,
        content: "export const add = (a: number, b: number) => a + b;\n",
      },
    });
    await environment.resolve({
      agentId: "independent-agent",
      action: {
        type: "RUN_CHECK",
        recipeId: recipe.targetId!,
        facilityId: "acceptance",
      },
    });
    const artifact = await environment.resolve({
      agentId: "independent-agent",
      action: { type: "CONSTRUCT_ARTIFACT", recipeId: recipe.targetId! },
    });
    expect(
      await environment.resolve({
        agentId: "independent-agent",
        action: {
          type: "REQUEST_VERIFICATION",
          artifactId: artifact.targetId!,
        },
      }),
    ).toMatchObject({ accepted: true });
    expect(
      (await environment.observe({ agentId: "independent-agent" }))
        .verifications,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: artifact.targetId,
          verifierAgentId: "environment-verifier",
          success: true,
        }),
      ]),
    );
    await environment.resolve({
      agentId: "independent-agent",
      action: { type: "REQUEST_INTEGRATION", artifactId: artifact.targetId! },
    });
    await environment.advance();
    expect(
      await environment.evaluate(await environment.freeze()),
    ).toMatchObject({
      outcome: "completed",
    });
  });
});
