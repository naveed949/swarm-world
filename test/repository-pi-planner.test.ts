import { describe, expect, it } from "vitest";
import {
  createPiRepositoryPlanner,
  type RepositoryPlanRequest,
} from "../src/repository-pi-planner.js";
import type { RepositoryRunConfig } from "../src/run-config.js";
import type { RepositoryObservation } from "../src/repository-types.js";

const config = {
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
  environment: {
    root: "/workspace/target",
    baseCommit: "abc123",
    readOnly: false,
    task: {
      id: "sandcastle-issue-26",
      title: "Publish one approved task as a draft pull request",
      acceptanceCriteria: ["Publishing requires verified approved work"],
      acceptanceFacilityIds: ["focused"],
      regressionFacilityIds: ["focused"],
      relevantPaths: ["src/Publisher.ts"],
      priority: 1,
    },
    observationRadius: 2,
    observationLimit: 16,
    allowedPaths: ["src/**"],
    excludedPaths: [".env"],
    patch: { maxFiles: 4, maxChangedLines: 500 },
    facilities: [],
  },
} satisfies RepositoryRunConfig;

const observation: RepositoryObservation = {
  revision: "abc123",
  focusNodeId: "task",
  nodes: [
    {
      id: "file",
      type: "file",
      label: "Publisher.ts",
      path: "src/Publisher.ts",
      contentHash: "hash",
    },
  ],
  edges: [],
  ownedEvidenceIds: ["evidence"],
  inspectedNodeIds: ["file"],
  ownedEvidence: [
    {
      id: "evidence",
      kind: "inspection",
      digest: "digest",
      data: { content: "export const publish = false;" },
    },
  ],
  ownedRecipeIds: [],
  ownedRecipes: [],
  ownedArtifactIds: [],
  taskClaims: [],
  messages: [],
  findings: [],
  inheritedArtifactIds: [],
  affordances: ["WAIT", "INSPECT", "EDIT"],
  budgets: { context: 16, actions: 10, verification: 4, writes: 500 },
};

describe("Pi repository planner", () => {
  it("submits the real task and grounded evidence through one deep planner seam", async () => {
    let requestContext: unknown;
    const request: RepositoryPlanRequest = async (input) => {
      requestContext = input.context;
      return { actions: [{ type: "INSPECT", nodeId: "file" }] };
    };
    const planner = createPiRepositoryPlanner(config, request);

    await expect(
      planner.plan({ agentId: "agent_000000", tick: 2, observation }),
    ).resolves.toEqual([{ type: "INSPECT", nodeId: "file" }]);
    expect(JSON.stringify(requestContext)).toContain("sandcastle-issue-26");
    expect(JSON.stringify(requestContext)).toContain(
      "export const publish = false;",
    );
  });

  it("fails closed when a collaborator proposes a write", async () => {
    const request: RepositoryPlanRequest = async () => ({
      actions: [
        {
          type: "EDIT",
          recipeId: "recipe",
          path: "src/Publisher.ts",
          expectedContentHash: "hash",
          content: "unsafe",
        },
      ],
    });
    const planner = createPiRepositoryPlanner(config, request);

    await expect(
      planner.plan({ agentId: "agent_000001", tick: 2, observation }),
    ).resolves.toEqual([{ type: "WAIT" }]);
  });

  it("surfaces provider failures instead of silently spending the run waiting", async () => {
    const request: RepositoryPlanRequest = async () => {
      throw new Error("provider unavailable");
    };
    const planner = createPiRepositoryPlanner(config, request);

    await expect(
      planner.plan({ agentId: "agent_000000", tick: 2, observation }),
    ).rejects.toThrow("provider unavailable");
  });
});
