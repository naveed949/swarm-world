import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { EnvironmentPlanner } from "./environment-simulator.js";
import { sha256 } from "./hash.js";
import type { RepositoryRunConfig } from "./run-config.js";
import { sidecarAuthorization } from "./pi-sidecar-auth.js";
import type {
  RepositoryAction,
  RepositoryObservation,
} from "./repository-types.js";

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("WAIT") }).strict(),
  z.object({ type: z.literal("FOCUS"), nodeId: z.string() }).strict(),
  z.object({ type: z.literal("INSPECT"), nodeId: z.string() }).strict(),
  z
    .object({
      type: z.literal("SEARCH"),
      query: z.string().min(1).max(256),
      paths: z.array(z.string()).max(32).optional(),
    })
    .strict(),
  z.object({ type: z.literal("CLAIM_TASK"), taskId: z.string() }).strict(),
  z
    .object({
      type: z.literal("PROPOSE_PROBLEM"),
      goalId: z.string().min(1),
      statement: z.string().min(1).max(5_000),
      evidenceIds: z.array(z.string()).min(1).max(64),
      goalImpact: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("CONFIRM_PROBLEM"),
      problemId: z.string(),
      evidenceIds: z.array(z.string()).min(1).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("CHALLENGE_PROBLEM"),
      problemId: z.string(),
      evidenceIds: z.array(z.string()).min(1).max(64),
      reason: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("PROPOSE_TASK"),
      goalId: z.string().min(1),
      problemId: z.string(),
      objective: z.string().min(1).max(2_000),
      expectedOutcome: z.string().min(1).max(2_000),
      relevantPaths: z.array(z.string()).min(1).max(32),
      acceptanceCriteria: z.array(z.string()).min(1).max(32),
      acceptanceFacilityIds: z.array(z.string()).min(1).max(16),
      regressionFacilityIds: z.array(z.string()).min(1).max(16),
      dependencies: z.array(z.string()).max(32),
      verificationPlan: z.array(z.string()).min(1).max(32),
      estimatedCost: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("DECOMPOSE_TASK"),
      taskId: z.string(),
      objective: z.string().min(1).max(2_000),
      relevantPaths: z.array(z.string()).min(1).max(32),
      verificationPlan: z.array(z.string()).min(1).max(32),
      estimatedCost: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("CLAIM_COMMITMENT"),
      taskId: z.string(),
      approach: z.string().min(1).max(500),
      roleLabel: z.string().min(1).max(200),
      intendedContribution: z.string().min(1).max(2_000),
      exitCondition: z.string().min(1).max(1_000),
      leaseTicks: z.number().int().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("JOIN_COMMITMENT"),
      commitmentId: z.string(),
      roleLabel: z.string().min(1).max(200),
      leaseTicks: z.number().int().min(1).max(128),
    })
    .strict(),
  z
    .object({ type: z.literal("RELEASE_COMMITMENT"), commitmentId: z.string() })
    .strict(),
  z
    .object({
      type: z.literal("COMMUNICATE"),
      recipientId: z.string(),
      text: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("TEACH_ARTIFACT"),
      recipientId: z.string(),
      artifactId: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("FORMULATE"),
      taskId: z.string(),
      evidenceIds: z.array(z.string()).min(1).max(64),
      targets: z.array(z.string()).min(1).max(16),
      requiredFacilities: z.array(z.string()).min(1).max(16),
    })
    .strict(),
  z
    .object({
      type: z.literal("EDIT"),
      recipeId: z.string(),
      path: z.string(),
      expectedContentHash: z.string(),
      content: z.string().max(100_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("EDIT_REPLACE"),
      recipeId: z.string(),
      path: z.string(),
      expectedContentHash: z.string(),
      oldText: z.string().min(1).max(50_000),
      newText: z.string().max(50_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("RUN_CHECK"),
      recipeId: z.string(),
      facilityId: z.string(),
    })
    .strict(),
  z
    .object({ type: z.literal("CONSTRUCT_ARTIFACT"), recipeId: z.string() })
    .strict(),
  z
    .object({ type: z.literal("REQUEST_VERIFICATION"), artifactId: z.string() })
    .strict(),
  z
    .object({
      type: z.literal("VERIFY_ARTIFACT"),
      artifactId: z.string(),
      facilityId: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("CHALLENGE_VERIFICATION"),
      verificationId: z.string(),
      evidenceIds: z.array(z.string()).min(1).max(64),
      reason: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({ type: z.literal("RECOMMEND_CANDIDATE"), artifactId: z.string() })
    .strict(),
  z
    .object({
      type: z.literal("PUBLISH_FINDING"),
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(5_000),
      evidenceIds: z.array(z.string()).max(64),
    })
    .strict(),
  z
    .object({ type: z.literal("REQUEST_INTEGRATION"), artifactId: z.string() })
    .strict(),
]);

const planSchema = z.object({ actions: z.array(actionSchema).min(1).max(1) });

const COMMITMENT_ACTIONS = new Set<RepositoryAction["type"]>([
  "FORMULATE",
  "EDIT",
  "EDIT_REPLACE",
  "RUN_CHECK",
  "CONSTRUCT_ARTIFACT",
]);

const REVIEW_ACTIONS = new Set<RepositoryAction["type"]>([
  "WAIT",
  "FOCUS",
  "INSPECT",
  "SEARCH",
  "COMMUNICATE",
  "PUBLISH_FINDING",
  "REQUEST_VERIFICATION",
  "VERIFY_ARTIFACT",
  "CHALLENGE_VERIFICATION",
  "RECOMMEND_CANDIDATE",
  "REQUEST_INTEGRATION",
]);

const SUPERVISOR_ACTIONS = new Set<RepositoryAction["type"]>([
  ...REVIEW_ACTIONS,
  "PROPOSE_PROBLEM",
  "CONFIRM_PROBLEM",
  "CHALLENGE_PROBLEM",
  "PROPOSE_TASK",
  "DECOMPOSE_TASK",
]);

export interface RepositoryPlanRequestInput {
  agentId: string;
  tick: number;
  role: string;
  context: Record<string, unknown>;
}

export type RepositoryPlanRequest = (
  input: RepositoryPlanRequestInput,
) => Promise<unknown>;

const SYSTEM_PROMPT = `You are a bounded repository-society agent operating toward one immutable goal. You do not have shell, GitHub mutation, push, merge, deployment, credential, or arbitrary network tools. The deterministic repository environment owns consequences.

Call submit_repository_plan exactly once with exactly one atomic action. Use only IDs, paths, content hashes, evidence, recipes, artifacts, facilities, and affordances present in the current context. Never invent state. Results from an action arrive only in a later observation.

Roles are temporary commitments, not identities. You may investigate, propose or challenge a problem, create or decompose a task, claim a differentiated approach, implement, independently verify another agent's artifact, or recommend an eligible candidate. Never verify your own artifact. Follow plannerPhase.requiredActionTypes while you own an active recipe. Prefer WAIT when the next safe action is unavailable. Never place credentials or issue-tracker mutations in code, messages, findings, or artifacts.`;

type JsonSchema = Record<string, unknown>;

export function repositoryPlanJsonSchema(
  context: Record<string, unknown>,
): JsonSchema {
  const schema = structuredClone(z.toJSONSchema(planSchema)) as JsonSchema;
  const properties = schema.properties as JsonSchema;
  const actions = properties.actions as JsonSchema;
  const items = actions.items as JsonSchema;
  const variants = items.oneOf as JsonSchema[];
  const phase = context.plannerPhase as
    | {
        requiredActionTypes?: string[];
        recipeId?: string;
        targetContentHashes?: Record<string, string>;
        missingFacilityIds?: string[];
      }
    | undefined;
  const explicitlyAllowed = context.allowedActionTypes as string[] | undefined;
  if (!explicitlyAllowed && !phase?.requiredActionTypes) return schema;
  const allowed = new Set(
    explicitlyAllowed ?? ["WAIT", ...(phase?.requiredActionTypes ?? [])],
  );
  items.oneOf = variants
    .filter((variant) => {
      const fields = variant.properties as JsonSchema;
      const type = fields.type as JsonSchema;
      return allowed.has(type.const as string);
    })
    .flatMap((variant) => {
      const fields = variant.properties as JsonSchema;
      const type = (fields.type as JsonSchema).const;
      if (phase?.recipeId && "recipeId" in fields)
        fields.recipeId = { type: "string", const: phase.recipeId };
      if (
        (type === "EDIT" || type === "EDIT_REPLACE") &&
        phase?.targetContentHashes
      )
        return Object.entries(phase.targetContentHashes).map(
          ([path, contentHash]) => {
            const targetVariant = structuredClone(variant);
            const targetFields = targetVariant.properties as JsonSchema;
            targetFields.path = { type: "string", const: path };
            targetFields.expectedContentHash = {
              type: "string",
              const: contentHash,
            };
            return targetVariant;
          },
        );
      if (type === "RUN_CHECK" && phase?.missingFacilityIds?.length)
        fields.facilityId = {
          type: "string",
          enum: phase.missingFacilityIds,
        };
      return [variant];
    });
  return schema;
}

function activeWorkPhase(observation: RepositoryObservation): {
  name: string;
  requiredActionTypes: RepositoryAction["type"][];
  recipeId?: string;
  targetContentHashes?: Record<string, string>;
  missingFacilityIds?: string[];
} {
  const artifactId = observation.ownedArtifactIds[0];
  if (artifactId) {
    if (!observation.goal)
      return {
        name: "request-integration",
        requiredActionTypes: ["REQUEST_INTEGRATION"],
      };
    const candidate = observation.candidates?.find(
      (item) => item.artifactId === artifactId,
    );
    if (!candidate?.verificationRequested)
      return {
        name: "request-verification",
        requiredActionTypes: ["REQUEST_VERIFICATION"],
      };
    if (!candidate.eligible)
      return {
        name: "await-independent-verification",
        requiredActionTypes: ["WAIT", "COMMUNICATE"],
      };
    return {
      name: "request-integration",
      requiredActionTypes: ["REQUEST_INTEGRATION"],
    };
  }
  const recipe = observation.ownedRecipes[0];
  if (!recipe)
    return {
      name: "discover-or-formulate",
      requiredActionTypes: [
        "CLAIM_TASK",
        "FOCUS",
        "INSPECT",
        "SEARCH",
        "COMMUNICATE",
        "FORMULATE",
      ],
    };
  if (recipe.patchHash === sha256(""))
    return {
      name: "edit-recipe",
      requiredActionTypes: ["EDIT", "EDIT_REPLACE"],
      recipeId: recipe.id,
      targetContentHashes: recipe.targetContentHashes,
    };
  if (recipe.failedFacilityIds.length)
    return {
      name: "repair-recipe",
      requiredActionTypes: ["EDIT", "EDIT_REPLACE"],
      recipeId: recipe.id,
      targetContentHashes: recipe.targetContentHashes,
      missingFacilityIds: recipe.failedFacilityIds,
    };
  const missingFacilityIds = recipe.requiredFacilityIds.filter(
    (id) => !recipe.passedFacilityIds.includes(id),
  );
  if (missingFacilityIds.length)
    return {
      name: "edit-or-verify-recipe",
      requiredActionTypes: ["EDIT", "EDIT_REPLACE", "RUN_CHECK"],
      recipeId: recipe.id,
      targetContentHashes: recipe.targetContentHashes,
      missingFacilityIds,
    };
  return {
    name: "construct-artifact",
    requiredActionTypes: ["CONSTRUCT_ARTIFACT"],
    recipeId: recipe.id,
  };
}

export function createPiModelRequest(
  config: RepositoryRunConfig,
): RepositoryPlanRequest {
  let runtimePromise: Promise<ModelRuntime> | undefined;
  return async ({ agentId, tick, context }) => {
    const modelConfig = config.model;
    if (!modelConfig) throw new Error("Pi repository planner requires a model");
    runtimePromise ??= ModelRuntime.create({
      ...(process.env.SWARM_WORLD_PI_AUTH_PATH
        ? { authPath: process.env.SWARM_WORLD_PI_AUTH_PATH }
        : {}),
      refreshOnCreate: false,
    });
    const runtime = await runtimePromise;
    const model = runtime.getModel(modelConfig.provider, modelConfig.id);
    if (!model)
      throw new Error(
        `Pi model not found: ${modelConfig.provider}/${modelConfig.id}`,
      );
    let submitted: unknown;
    const submitPlan = {
      name: "submit_repository_plan",
      label: "Submit Repository Plan",
      description: "Submit exactly one schema-constrained repository action.",
      parameters: Type.Unsafe(repositoryPlanJsonSchema(context)),
      constrainedSampling: {
        type: "json_schema" as const,
        strict: "prefer" as const,
      },
      execute: async (_toolCallId: string, params: unknown) => {
        submitted = params;
        return {
          content: [
            { type: "text" as const, text: "Plan submitted for validation." },
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
        thinkingLevel: modelConfig.reasoning,
        tools: [submitPlan],
        messages: [],
      },
      streamFn: (activeModel, activeContext, options) =>
        runtime.streamSimple(activeModel, activeContext, {
          ...options,
          toolChoice: "required",
          transport: "sse",
          maxTokens: 8_192,
          ...(modelConfig.reasoning === "off"
            ? {}
            : { reasoning: modelConfig.reasoning }),
        } as unknown as Parameters<ModelRuntime["streamSimple"]>[2]),
      sessionId: `swarmworld-repository-${agentId}-${tick}`,
    });
    await agent.prompt(JSON.stringify(context));
    const lastMessage = agent.state.messages.at(-1);
    if (lastMessage?.role === "assistant" && lastMessage.stopReason === "error")
      throw new Error(lastMessage.errorMessage ?? "Pi model request failed");
    if (!submitted) throw new Error("Model did not submit a repository plan");
    return submitted;
  };
}

export function createSidecarRequest(endpoint: string): RepositoryPlanRequest {
  const authorization = sidecarAuthorization(
    process.env.SWARM_WORLD_PI_SIDECAR_TOKEN ?? "",
  );
  return async (input) => {
    const response = await fetch(new URL("/plan", endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok)
      throw new Error(
        `Pi sidecar request failed with status ${response.status}`,
      );
    return response.json();
  };
}

export function createPiRepositoryPlanner(
  config: RepositoryRunConfig,
  request: RepositoryPlanRequest = process.env.SWARM_WORLD_PI_SIDECAR_URL
    ? createSidecarRequest(process.env.SWARM_WORLD_PI_SIDECAR_URL)
    : createPiModelRequest(config),
): EnvironmentPlanner<RepositoryObservation, RepositoryAction> {
  return {
    modelBacked: true,
    plan: async ({ agentId, tick, observation }) => {
      const coordinationModel =
        config.coordinationModel ??
        (config.condition === "independent"
          ? "independent-search"
          : observation.goal
            ? "emergent-society"
            : "fixed-workflow");
      const commitment = observation.commitments?.find(
        (candidate) =>
          candidate.agentId === agentId && candidate.status === "active",
      );
      const role =
        coordinationModel === "fixed-workflow"
          ? agentId === "agent_000000"
            ? "implementer"
            : "independent-verifier"
          : coordinationModel === "central-supervisor"
            ? agentId === "agent_000000"
              ? "central-supervisor"
              : (commitment?.roleLabel ?? "unassigned-worker")
            : coordinationModel === "independent-search"
              ? "independent-agent"
              : (commitment?.roleLabel ?? "uncommitted");
      const plannerPhase =
        observation.ownedRecipeIds.length || observation.ownedArtifactIds.length
          ? activeWorkPhase(observation)
          : undefined;
      const allowedActionTypes = observation.affordances.filter((type) => {
        if (
          plannerPhase &&
          !plannerPhase.requiredActionTypes.includes(type) &&
          type !== "WAIT"
        )
          return false;
        if (!commitment && COMMITMENT_ACTIONS.has(type)) return false;
        if (
          coordinationModel === "fixed-workflow" &&
          agentId !== "agent_000000" &&
          !REVIEW_ACTIONS.has(type)
        )
          return false;
        if (
          coordinationModel === "central-supervisor" &&
          agentId === "agent_000000" &&
          !SUPERVISOR_ACTIONS.has(type)
        )
          return false;
        return true;
      });
      const context = {
        role,
        tick,
        ...(plannerPhase ? { plannerPhase } : {}),
        allowedActionTypes,
        task: config.environment.task,
        patchPolicy: config.environment.patch,
        configuredFacilities: config.environment.facilities.map((facility) => ({
          id: facility.id,
          category: facility.category,
          mandatory: facility.mandatory,
          permittedPaths: facility.permittedPaths,
        })),
        coordinationModel,
        observation,
      };
      const response = await request({ agentId, tick, role, context });
      try {
        const parsed = planSchema.parse(response);
        const action = parsed.actions[0] as RepositoryAction;
        if (!observation.affordances.includes(action.type))
          return [{ type: "WAIT" }];
        if (
          plannerPhase &&
          !plannerPhase.requiredActionTypes.includes(action.type)
        )
          return [{ type: "WAIT" }];
        if (!commitment && COMMITMENT_ACTIONS.has(action.type))
          return [{ type: "WAIT" }];
        if (
          coordinationModel === "fixed-workflow" &&
          agentId !== "agent_000000" &&
          !REVIEW_ACTIONS.has(action.type)
        )
          return [{ type: "WAIT" }];
        if (
          coordinationModel === "central-supervisor" &&
          agentId === "agent_000000" &&
          !SUPERVISOR_ACTIONS.has(action.type)
        )
          return [{ type: "WAIT" }];
        return [action];
      } catch {
        return [{ type: "WAIT" }];
      }
    },
  };
}
