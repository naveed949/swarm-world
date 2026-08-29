import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";
import type {
  Action,
  AgentPlan,
  AgentState,
  Capabilities,
  ExperimentConfig,
  FacilityId,
  LocalObservation,
  Recipe,
  ResourceId,
} from "./types.js";

export interface Cognition {
  plan(
    agent: AgentState,
    observation: LocalObservation,
    capabilities: Capabilities,
    signal?: AbortSignal,
  ): Promise<AgentPlan>;
}
export class InvalidPlanError extends Error {
  override name = "InvalidPlanError";
}

const researchSchema = z
  .object({
    goal: z.string().max(500),
    hypothesis: z.string().max(1000),
    progress: z.string().max(1000),
    nextCheckpoint: z.string().max(500),
    collaborationNeed: z.string().max(500),
  })
  .strict();
const resourceSchema = z.enum([
  "CELLULOSE",
  "CHITIN",
  "MINERAL",
  "FUNGAL",
  "CATALYST",
  "KELP",
  "SHELL",
  "LIGNIN",
]);
const facilitySchema = z.enum([
  "WASH",
  "DRY",
  "CROSSLINK",
  "FERMENT",
  "ALIGN",
  "MINERALIZE",
]);
const instructionSchema = z
  .object({
    op: z.enum([
      "CONST",
      "SENSOR",
      "COPY",
      "ADD",
      "SUB",
      "MUL",
      "MIN",
      "MAX",
      "GT",
      "LT",
      "ACT",
    ]),
    dst: z.number().int().min(0).max(15).optional(),
    a: z.number().int().min(0).max(15).optional(),
    b: z.number().int().min(0).max(15).optional(),
    value: z.number().min(-4).max(4).optional(),
    sensor: z
      .enum([
        "temperature",
        "water",
        "stability",
        "contamination",
        "solar",
        "nutrients",
        "health",
        "maturity",
        "storage",
        "reserve",
        "opening",
        "stiffness",
        "toughness",
        "permeability",
        "adhesion",
        "healing",
        "responsiveness",
        "degradation",
      ])
      .optional(),
    actuator: z
      .enum([
        "COLLECT_WATER",
        "GROW",
        "HEAL",
        "SET_OPENING",
        "REMEDIATE",
        "EMIT_SIGNAL",
      ])
      .optional(),
  })
  .strict();
const recipeSchema = z
  .object({
    inputs: z
      .record(resourceSchema, z.number().positive())
      .refine((v) => Object.keys(v).length > 0),
    operations: z.array(facilitySchema).min(1).max(8),
    hydration: z.number().min(0).max(1),
    porosity: z.number().min(0).max(1),
    alignment: z.number().min(0).max(1),
    crosslinking: z.number().min(0).max(1),
  })
  .strict();
const specSchema = z
  .object({
    name: z.string().min(1).max(160),
    claimedFunction: z.string().min(1).max(1000),
    architecture: z.string().min(1).max(1000),
    bioInspiration: z.array(z.string().min(1).max(160)).max(12),
    predictedEffects: z.array(z.string().min(1).max(300)).max(12),
    geometry: z
      .object({
        area: z.number().positive().max(10),
        thickness: z.number().positive().max(10),
        channels: z.number().int().min(0).max(128),
      })
      .strict(),
  })
  .strict();
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("WAIT") }).strict(),
  z
    .object({
      type: z.literal("MOVE"),
      dx: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
      dy: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    })
    .strict(),
  z
    .object({
      type: z.literal("INSPECT"),
      target: z.enum(["CELL", "ARTIFACT"]),
      artifactId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("HARVEST"),
      resource: resourceSchema,
      amount: z.number().positive().max(0.5),
    })
    .strict(),
  z
    .object({
      type: z.literal("DEPOSIT"),
      resource: resourceSchema,
      amount: z.number().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("WITHDRAW"),
      resource: resourceSchema,
      amount: z.number().positive(),
    })
    .strict(),
  z.object({ type: z.literal("FORMULATE"), recipe: recipeSchema }).strict(),
  z.object({ type: z.literal("PROCESS"), pendingBatchId: z.string() }).strict(),
  z.object({ type: z.literal("TEST"), batchId: z.string() }).strict(),
  z
    .object({
      type: z.literal("CONSTRUCT"),
      batchId: z.string(),
      spec: specSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("INSTALL_PROGRAM"),
      artifactId: z.string(),
      instructions: z.array(instructionSchema).min(1).max(64),
      parentId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("FORK_PROGRAM"),
      programId: z.string(),
      instructions: z.array(instructionSchema).min(1).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("REPAIR"),
      artifactId: z.string(),
      amount: z.number().positive().max(0.25),
    })
    .strict(),
  z.object({ type: z.literal("DISMANTLE"), artifactId: z.string() }).strict(),
  z
    .object({
      type: z.literal("COMMUNICATE"),
      text: z.string().min(1).max(2000),
      recipientId: z.string().optional(),
      replyTo: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("PUBLISH"),
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(5000),
      evidenceIds: z.array(z.string()).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("TEACH"),
      recipientId: z.string(),
      text: z.string().min(1).max(3000),
      recordIds: z.array(z.string()).max(64),
      programIds: z.array(z.string()).max(16),
    })
    .strict(),
  z
    .object({
      type: z.literal("TRADE"),
      recipientId: z.string(),
      resource: resourceSchema,
      amount: z.number().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("CLAIM_TASK"),
      task: z.string().min(1).max(1000),
    })
    .strict(),
]);
const planSchema = z
  .object({ research: researchSchema, actions: z.array(actionSchema).max(12) })
  .strict();

const SYSTEM_PROMPT = `You are one initially homogeneous researcher embodied in a persistent, materially constrained world. No role is assigned to you. Develop bio-inspired material systems for environmental resilience through local exploration, grounded experiments, construction, and optional collaboration.

You only know the supplied local observation, private research state, retrieved evidence, and treatment-permitted records. Textual claims never change physics. Never invent possession, observations, evidence IDs, artifact IDs, batch IDs, or program IDs. You must call submit_plan exactly once. The plan contains research (goal, hypothesis, progress, nextCheckpoint, collaborationNeed) and a bounded sequence of atomic actions. The simulator validates every consequence and may reject actions. Controllers are data: straight-line instructions over registers 0-15 using CONST, SENSOR, COPY, ADD, SUB, MUL, MIN, MAX, GT, LT, ACT. They have no loops, jumps, strings-as-code, files, network, or shell access.

Prefer falsifiable local experiments and durable useful work. You receive no global reward, evaluator formula, predefined recipe, technology catalog, or assigned occupation.`;

export class PiCognition implements Cognition {
  private models = builtinModels();
  constructor(private readonly config: ExperimentConfig) {}
  async plan(
    agentState: AgentState,
    observation: LocalObservation,
    capabilities: Capabilities,
    signal?: AbortSignal,
  ): Promise<AgentPlan> {
    const model = this.models.getModel(
      this.config.model.provider,
      this.config.model.id,
    );
    if (!model)
      throw new Error(
        `Pi model not found: ${this.config.model.provider}/${this.config.model.id}`,
      );
    let submitted: unknown;
    const submitPlan = {
      name: "submit_plan",
      label: "Submit Plan",
      description:
        "Commit one schema-constrained research-state update and bounded atomic action plan.",
      parameters: Type.Unsafe<AgentPlan>(
        z.toJSONSchema(planSchema) as Record<string, unknown>,
      ),
      constrainedSampling: {
        type: "json_schema" as const,
        strict: "prefer" as const,
      },
      execute: async (_toolCallId: string, params: unknown) => {
        submitted = params;
        return {
          content: [
            {
              type: "text" as const,
              text: "Plan accepted for deterministic validation.",
            },
          ],
          details: {},
          terminate: true,
        };
      },
    };
    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model,
        thinkingLevel: this.config.model.reasoning,
        tools: [submitPlan],
        messages: [],
      },
      streamFn: (activeModel, context, options) =>
        this.models.streamSimple(activeModel, context, {
          ...options,
          temperature: this.config.model.temperature,
          maxTokens: 4096,
          ...(this.config.model.reasoning === "off"
            ? {}
            : { reasoning: this.config.model.reasoning }),
        }),
      sessionId: `swarmworld-${agentState.id}`,
    });
    if (signal?.aborted) throw signal.reason;
    const context = {
      treatmentCapabilities: capabilities,
      observation: {
        ...observation,
        cells: observation.cells.slice(0, 96),
        artifacts: observation.artifacts.slice(0, 32),
      },
      privateResearchState: agentState.research,
      recentMemory: agentState.memory.slice(-32),
    };
    await agent.prompt(JSON.stringify(context));
    try {
      if (!submitted) throw new Error("Model did not call submit_plan");
      const parsed = planSchema.parse(submitted);
      return {
        research: parsed.research,
        actions: parsed.actions.slice(0, this.config.planLimit) as Action[],
      };
    } catch (error) {
      throw new InvalidPlanError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

const starterProgram = [
  { op: "SENSOR", dst: 0, sensor: "water" },
  { op: "CONST", dst: 1, value: 0.55 },
  { op: "LT", dst: 2, a: 0, b: 1 },
  { op: "CONST", dst: 3, value: 0.04 },
  { op: "MUL", dst: 4, a: 2, b: 3 },
  { op: "ACT", a: 4, actuator: "COLLECT_WATER" },
  { op: "SENSOR", dst: 5, sensor: "contamination" },
  { op: "MUL", dst: 6, a: 5, b: 3 },
  { op: "ACT", a: 6, actuator: "REMEDIATE" },
] as import("./types.js").Instruction[];

function pathTo(
  from: { x: number; y: number },
  to: { x: number; y: number },
  limit = 10,
): Action[] {
  const actions: Action[] = [];
  let x = from.x,
    y = from.y;
  while ((x !== to.x || y !== to.y) && actions.length < limit) {
    if (x !== to.x) {
      const dx = Math.sign(to.x - x) as -1 | 1;
      actions.push({ type: "MOVE", dx, dy: 0 });
      x += dx;
    } else {
      const dy = Math.sign(to.y - y) as -1 | 1;
      actions.push({ type: "MOVE", dx: 0, dy });
      y += dy;
    }
  }
  actions.push({ type: "INSPECT", target: "CELL" });
  return actions;
}

export class HeuristicCognition implements Cognition {
  async plan(
    agent: AgentState,
    observation: LocalObservation,
    capabilities: Capabilities,
  ): Promise<AgentPlan> {
    const here = observation.cells.find(
      (c) =>
        c.position.x === agent.position.x && c.position.y === agent.position.y,
    );
    const tested = agent.batches.find((b) => b.tested);
    const untested = agent.batches.find((b) => !b.tested);
    const pending = agent.pendingBatches[0];
    const ownArtifact = observation.artifacts.find(
      (a) => a.creatorId === agent.id && !a.programId,
    );
    let actions: Action[] = [];
    if (pending) {
      const required = pending.recipe.operations[pending.nextOperationIndex];
      if (here?.facility === required)
        actions = [{ type: "PROCESS", pendingBatchId: pending.id }];
      else {
        const target = observation.cells.find(
          (cell) => cell.facility === required,
        );
        actions = target
          ? pathTo(agent.position, target.position)
          : [{ type: "WAIT" }];
      }
    } else if (ownArtifact)
      actions = [
        {
          type: "INSTALL_PROGRAM",
          artifactId: ownArtifact.id,
          instructions: starterProgram,
        },
      ];
    else if (tested)
      actions = [
        {
          type: "CONSTRUCT",
          batchId: tested.id,
          spec: {
            name: `Adaptive Lattice ${agent.id}`,
            claimedFunction:
              "locally responsive water and contamination buffering",
            architecture: "porous aligned layered lattice",
            bioInspiration: ["mycelium", "leaf stomata"],
            predictedEffects: ["water collection", "remediation"],
            geometry: { area: 1, thickness: 0.3, channels: 4 },
          },
        },
      ];
    else if (untested) actions = [{ type: "TEST", batchId: untested.id }];
    else {
      const total = Object.values(agent.inventory).reduce(
        (sum, v) => sum + (v ?? 0),
        0,
      );
      if (total >= 0.8 && here?.facility) {
        const inputs = Object.fromEntries(
          Object.entries(agent.inventory)
            .filter(([, v]) => (v ?? 0) > 0)
            .slice(0, 3)
            .map(([r, v]) => [r, Math.min(v ?? 0, 0.5)]),
        ) as Partial<Record<ResourceId, number>>;
        const recipe: Recipe = {
          inputs,
          operations: [here.facility as FacilityId],
          hydration: 0.65,
          porosity: 0.6,
          alignment: 0.55,
          crosslinking: 0.5,
        };
        actions = [{ type: "FORMULATE", recipe }];
      } else if (here?.resource && here.resource.mass > 0.1)
        actions = [
          { type: "HARVEST", resource: here.resource.id, amount: 0.4 },
        ];
      else {
        const candidates =
          total >= 0.8
            ? observation.cells.filter((c) => c.facility)
            : observation.cells.filter(
                (c) => c.resource && c.resource.mass > 0.1,
              );
        const target =
          candidates.sort(
            (a, b) =>
              Math.hypot(
                a.position.x - agent.position.x,
                a.position.y - agent.position.y,
              ) -
              Math.hypot(
                b.position.x - agent.position.x,
                b.position.y - agent.position.y,
              ),
          )[0] ??
          observation.cells
            .filter((c) => c.terrain !== "DEEP_WATER")
            .sort(
              (a, b) =>
                Math.hypot(
                  b.position.x - agent.position.x,
                  b.position.y - agent.position.y,
                ) -
                Math.hypot(
                  a.position.x - agent.position.x,
                  a.position.y - agent.position.y,
                ),
            )[
            (observation.tick + Number(agent.id.slice(-3))) %
              Math.max(1, observation.cells.length)
          ];
        actions = target
          ? pathTo(agent.position, target.position)
          : [{ type: "WAIT" }];
      }
    }
    if (
      capabilities.communication &&
      observation.agents.length &&
      agent.memory.length % 4 === 0
    )
      actions.push({
        type: "COMMUNICATE",
        recipientId: observation.agents[0]!.id,
        text: `I am testing locally grounded material systems near ${agent.position.x},${agent.position.y}.`,
      });
    return {
      research: {
        goal: "Develop a durable responsive material system",
        hypothesis:
          "Composite processing and a local controller can provide complementary services",
        progress: `At tick ${observation.tick}: ${actions[0]?.type ?? "WAIT"}`,
        nextCheckpoint: "Inspect the next simulator outcome",
        collaborationNeed: capabilities.communication
          ? "Share reproducible local evidence"
          : "Use physical traces",
      },
      actions,
    };
  }
}

export function createCognition(config: ExperimentConfig): Cognition {
  return config.cognition === "pi"
    ? new PiCognition(config)
    : new HeuristicCognition();
}
