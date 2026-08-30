import { describe, expect, it } from "vitest";
import { sha256 } from "../src/hash.js";
import {
  createPiRepositoryPlanner,
  repositoryPlanJsonSchema,
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

  it("deterministically prevents formulation after a recipe exists", async () => {
    let phase: unknown;
    const request: RepositoryPlanRequest = async (input) => {
      phase = input.context.plannerPhase;
      return {
        actions: [
          {
            type: "FORMULATE",
            taskId: "sandcastle-issue-26",
            evidenceIds: ["evidence"],
            targets: ["src/Publisher.ts"],
            requiredFacilities: ["focused"],
          },
        ],
      };
    };
    const planner = createPiRepositoryPlanner(config, request);
    const withRecipe: RepositoryObservation = {
      ...observation,
      ownedRecipeIds: ["recipe"],
      ownedRecipes: [
        {
          id: "recipe",
          targets: ["src/Publisher.ts"],
          targetContentHashes: { "src/Publisher.ts": "hash" },
          requiredFacilityIds: ["focused"],
          patchHash: sha256(""),
          passedFacilityIds: [],
          failedFacilityIds: [],
        },
      ],
      affordances: [...observation.affordances, "FORMULATE"],
    };

    await expect(
      planner.plan({ agentId: "agent_000000", tick: 3, observation: withRecipe }),
    ).resolves.toEqual([{ type: "WAIT" }]);
    expect(phase).toEqual({
      name: "edit-recipe",
      requiredActionTypes: ["EDIT", "EDIT_REPLACE"],
      recipeId: "recipe",
      targetContentHashes: { "src/Publisher.ts": "hash" },
    });
  });

  it("constrains sidecar sampling to the current deterministic phase", () => {
    const schema = repositoryPlanJsonSchema({
      plannerPhase: {
        name: "edit-or-verify-recipe",
        requiredActionTypes: ["EDIT", "EDIT_REPLACE", "RUN_CHECK"],
        recipeId: "recipe",
        targetContentHashes: { "src/Publisher.ts": "current-hash" },
        missingFacilityIds: ["focused"],
      },
    });
    const variants = (
      ((schema.properties as Record<string, unknown>).actions as Record<
        string,
        unknown
      >).items as Record<string, unknown>
    ).oneOf as Array<Record<string, unknown>>;
    const actionTypes = variants.map((variant) => {
      const fields = variant.properties as Record<string, unknown>;
      return (fields.type as Record<string, unknown>).const;
    });

    expect(actionTypes).toEqual(["WAIT", "EDIT", "EDIT_REPLACE", "RUN_CHECK"]);
    const edit = variants[1]!;
    expect((edit.properties as Record<string, unknown>).path).toEqual({
      type: "string",
      const: "src/Publisher.ts",
    });
    expect(
      (edit.properties as Record<string, unknown>).expectedContentHash,
    ).toEqual({ type: "string", const: "current-hash" });
    const runCheck = variants.at(-1)!;
    expect(
      (runCheck.properties as Record<string, unknown>).facilityId,
    ).toEqual({ type: "string", enum: ["focused"] });
  });

  it("forces repair instead of repeating a failed check", async () => {
    let phase: unknown;
    const request: RepositoryPlanRequest = async (input) => {
      phase = input.context.plannerPhase;
      return {
        actions: [
          { type: "RUN_CHECK", recipeId: "recipe", facilityId: "focused" },
        ],
      };
    };
    const planner = createPiRepositoryPlanner(config, request);
    const failed: RepositoryObservation = {
      ...observation,
      ownedRecipeIds: ["recipe"],
      ownedRecipes: [
        {
          id: "recipe",
          targets: ["src/Publisher.ts"],
          targetContentHashes: { "src/Publisher.ts": "current" },
          requiredFacilityIds: ["focused"],
          patchHash: "non-empty",
          passedFacilityIds: [],
          failedFacilityIds: ["focused"],
        },
      ],
      affordances: [...observation.affordances, "RUN_CHECK"],
    };

    await expect(
      planner.plan({ agentId: "agent_000000", tick: 4, observation: failed }),
    ).resolves.toEqual([{ type: "WAIT" }]);
    expect(phase).toMatchObject({
      name: "repair-recipe",
      requiredActionTypes: ["EDIT", "EDIT_REPLACE"],
      missingFacilityIds: ["focused"],
    });
  });
});
