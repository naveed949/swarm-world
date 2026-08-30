import { describe, expect, it } from "vitest";
import {
  PI_ACTION_GUIDANCE,
  parseAgentPlan,
  piObservationForModel,
  piStreamOptions,
  planToolParameters,
} from "../src/cognition.js";
import { parseConfig } from "../src/config.js";
import type { LocalObservation } from "../src/types.js";

describe("Pi cognition request options", () => {
  it("requires the model to call the plan submission tool", () => {
    const options = piStreamOptions(parseConfig({}), {});

    expect(options).toMatchObject({ toolChoice: "required" });
  });

  it("provides a data-only tool schema that Pi can clone", () => {
    expect(() => structuredClone(planToolParameters())).not.toThrow();
  });

  it("does not tell Pi that every resource is a required recipe input", () => {
    expect(JSON.stringify(planToolParameters())).not.toContain(
      '"required":["CELLULOSE","CHITIN","MINERAL","FUNGAL","CATALYST","KELP","SHELL","LIGNIN"]',
    );
  });

  it("omits unsupported temperature sampling for Codex", () => {
    const options = piStreamOptions(parseConfig({}), {});

    expect(options).not.toHaveProperty("temperature");
  });

  it("uses finite-lived SSE transport for batch Codex runs", () => {
    const options = piStreamOptions(parseConfig({}), {});

    expect(options).toHaveProperty("transport", "sse");
  });

  it("tells Pi the material lifecycle preconditions", () => {
    expect(PI_ACTION_GUIDANCE).toContain(
      "FORMULATE only while standing at recipe.operations[0]",
    );
    expect(PI_ACTION_GUIDANCE).toContain(
      "PROCESS only an owned pending batch while standing at its nextOperation facility",
    );
    expect(PI_ACTION_GUIDANCE).toContain("TEST only an owned completed batch");
    expect(PI_ACTION_GUIDANCE).toContain(
      "CONSTRUCT only an owned tested batch",
    );
    expect(PI_ACTION_GUIDANCE).toContain(
      "never reference a future ID in the same plan",
    );
    expect(PI_ACTION_GUIDANCE).toContain(
      "FORMULATE completes recipe.operations[0]",
    );
    expect(PI_ACTION_GUIDANCE).toContain(
      "Any possessed resource may be used by itself",
    );
    expect(PI_ACTION_GUIDANCE).toContain(
      "observation.self and materialActionOptions are current authority",
    );
    expect(PI_ACTION_GUIDANCE).toContain(
      "Once material is possessed and a facility is visible, prioritize a small formulation",
    );
    expect(PI_ACTION_GUIDANCE).toContain(
      "After CONSTRUCT, prioritize installing the controller",
    );
  });

  it("exposes the next required facility directly to Pi", () => {
    const observation = {
      tick: 81,
      self: {
        id: "agent_000001",
        position: { x: 14, y: 12 },
        inventory: { LIGNIN: 0.87 },
        batches: [],
        pendingBatches: [
          {
            id: "pending_1",
            ownerId: "agent_000001",
            recipe: {
              inputs: { LIGNIN: 1 },
              operations: ["WASH", "DRY", "ALIGN"],
              hydration: 0.45,
              porosity: 0.3,
              alignment: 0.7,
              crosslinking: 0.65,
            },
            nextOperationIndex: 1,
            contributors: ["agent_000001"],
            evidenceIds: [],
          },
        ],
      },
      cells: [],
      agents: [],
      artifacts: [],
      messages: [],
      publications: [],
      affordances: [],
    } satisfies LocalObservation;

    expect(
      piObservationForModel(observation).self.pendingBatches[0],
    ).toHaveProperty("nextOperation", "DRY");
    expect(
      piObservationForModel(observation).materialActionOptions,
    ).toContainEqual({
      type: "PROCESS",
      pendingBatchId: "pending_1",
      requiredFacility: "DRY",
      ready: false,
    });
  });

  it("exposes TEST, not PROCESS, for a completed untested batch", () => {
    const recipe = {
      inputs: { LIGNIN: 0.4 },
      operations: ["WASH", "DRY", "CROSSLINK", "ALIGN"],
      hydration: 0.35,
      porosity: 0.65,
      alignment: 0.7,
      crosslinking: 0.6,
    } as const;
    const properties = {
      stiffness: 0.5,
      toughness: 0.5,
      permeability: 0.5,
      adhesion: 0.5,
      healing: 0.5,
      responsiveness: 0.5,
      degradation: 0.5,
    };
    const observation = {
      tick: 66,
      self: {
        id: "agent_000001",
        position: { x: 17, y: 15 },
        inventory: { LIGNIN: 0.1 },
        pendingBatches: [],
        batches: [
          {
            id: "batch_1b6ac80c81f08f67",
            ownerId: "agent_000001",
            recipe,
            properties,
            quality: 0.8,
            tested: false,
            contributors: ["agent_000001"],
            evidenceIds: [],
          },
        ],
      },
      cells: [],
      agents: [],
      artifacts: [],
      messages: [],
      publications: [],
      affordances: [],
    } satisfies LocalObservation;

    expect(piObservationForModel(observation).materialActionOptions).toEqual([
      {
        type: "TEST",
        batchId: "batch_1b6ac80c81f08f67",
        ready: true,
      },
    ]);
  });

  it("directs an agent with inventory toward a visible formulation facility", () => {
    const observation = {
      tick: 90,
      self: {
        id: "agent_000000",
        position: { x: 17, y: 5 },
        inventory: { CATALYST: 4.87 },
        pendingBatches: [],
        batches: [],
      },
      cells: [
        {
          position: { x: 17, y: 10 },
          terrain: "WORKSPACE",
          facility: "DRY",
          fields: {
            temperature: 0.5,
            water: 0.5,
            stability: 0.5,
            contamination: 0.02,
            solar: 0.6,
            nutrients: 0.5,
          },
        },
      ],
      agents: [],
      artifacts: [],
      messages: [],
      publications: [],
      affordances: [],
    } satisfies LocalObservation;

    expect(piObservationForModel(observation).materialActionOptions).toEqual([
      {
        type: "FORMULATE",
        ready: false,
        currentFacility: null,
        availableInputs: { CATALYST: 4.87 },
        visibleFacilities: [{ facility: "DRY", position: { x: 17, y: 10 } }],
      },
    ]);
  });

  it("directs a creator to install a useful controller on an unprogrammed artifact", () => {
    const observation = {
      tick: 76,
      self: {
        id: "agent_000001",
        position: { x: 17, y: 15 },
        inventory: {},
        pendingBatches: [],
        batches: [],
      },
      cells: [],
      agents: [],
      artifacts: [
        {
          id: "artifact_1",
          position: { x: 17, y: 15 },
          creatorId: "agent_000001",
          contributors: ["agent_000001"],
          batchId: "batch_1",
          properties: {
            stiffness: 1,
            toughness: 0.92,
            permeability: 0.11,
            adhesion: 0.45,
            healing: 0.1,
            responsiveness: 0.15,
            degradation: 0,
          },
          health: 1,
          maturity: 0.35,
          storage: 0,
          reserve: 0.4,
          opening: 0.5,
          signal: 0,
          active: true,
          programHistory: [],
          peakPerformance: 0,
          lastServices: {
            water: 0,
            remediation: 0,
            stability: 0,
            healing: 0,
            nutrient: 0,
          },
        },
      ],
      messages: [],
      publications: [],
      affordances: [],
    } satisfies LocalObservation;

    expect(piObservationForModel(observation).materialActionOptions).toEqual([
      {
        type: "INSTALL_PROGRAM",
        artifactId: "artifact_1",
        ready: true,
        instructions: expect.arrayContaining([
          { op: "ACT", a: expect.any(Number), actuator: "COLLECT_WATER" },
          { op: "ACT", a: expect.any(Number), actuator: "REMEDIATE" },
        ]),
      },
    ]);
  });
});

describe("Pi plan validation", () => {
  const research = {
    goal: "Explore",
    hypothesis: "Nearby material may be useful",
    progress: "Starting",
    nextCheckpoint: "Inspect the result",
    collaborationNeed: "None",
  };

  it("rejects moves that are not exactly one orthogonal cell", () => {
    expect(() =>
      parseAgentPlan({
        research,
        actions: [{ type: "MOVE", dx: 1, dy: 1 }],
      }),
    ).toThrow();
    expect(() =>
      parseAgentPlan({
        research,
        actions: [{ type: "MOVE", dx: 0, dy: 0 }],
      }),
    ).toThrow();
  });

  it("accepts a recipe containing only the resources the agent will use", () => {
    expect(() =>
      parseAgentPlan({
        research,
        actions: [
          {
            type: "FORMULATE",
            recipe: {
              inputs: { LIGNIN: 0.4, FUNGAL: 0.4 },
              operations: ["WASH"],
              hydration: 0.65,
              porosity: 0.6,
              alignment: 0.55,
              crosslinking: 0.5,
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a recipe without any inputs", () => {
    expect(() =>
      parseAgentPlan({
        research,
        actions: [
          {
            type: "FORMULATE",
            recipe: {
              inputs: {},
              operations: ["WASH"],
              hydration: 0.65,
              porosity: 0.6,
              alignment: 0.55,
              crosslinking: 0.5,
            },
          },
        ],
      }),
    ).toThrow();
  });
});
