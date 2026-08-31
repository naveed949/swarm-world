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

export interface RepositoryPlanRequestInput {
  agentId: string;
  tick: number;
  role: "implementer" | "collaborator";
  context: Record<string, unknown>;
}

export type RepositoryPlanRequest = (
  input: RepositoryPlanRequestInput,
) => Promise<unknown>;

const COLLABORATOR_ACTIONS = new Set<RepositoryAction["type"]>([
  "WAIT",
  "FOCUS",
  "INSPECT",
  "SEARCH",
  "COMMUNICATE",
  "TEACH_ARTIFACT",
  "PUBLISH_FINDING",
]);

const SYSTEM_PROMPT = `You are a bounded repository agent operating on one real task. You do not have shell, GitHub mutation, push, merge, deployment, credential, or arbitrary network tools. The deterministic repository environment owns consequences.

Call submit_repository_plan exactly once with exactly one atomic action. Use only IDs, paths, content hashes, evidence, recipes, artifacts, facilities, and affordances present in the current context. Never invent state. Results from an action arrive only in a later observation.

The implementer must follow plannerPhase.requiredActionTypes. Once it owns a recipe it must not explore or formulate again: edit the recipe, run every missing fixed check, construct the artifact, then request integration. A collaborator is read-only and should inspect/search, communicate grounded findings to agent_000000, or publish a finding. Prefer WAIT when the next safe action is unavailable. Never place credentials or issue-tracker mutations in code, messages, findings, or artifacts.`;

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
  if (!phase?.requiredActionTypes) return schema;
  const allowed = new Set(["WAIT", ...phase.requiredActionTypes]);
  items.oneOf = variants
    .filter((variant) => {
      const fields = variant.properties as JsonSchema;
      const type = fields.type as JsonSchema;
      return allowed.has(type.const as string);
    })
    .flatMap((variant) => {
      const fields = variant.properties as JsonSchema;
      const type = (fields.type as JsonSchema).const;
      if (phase.recipeId && "recipeId" in fields)
        fields.recipeId = { type: "string", const: phase.recipeId };
      if (
        (type === "EDIT" || type === "EDIT_REPLACE") &&
        phase.targetContentHashes
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
      if (type === "RUN_CHECK" && phase.missingFacilityIds?.length)
        fields.facilityId = {
          type: "string",
          enum: phase.missingFacilityIds,
        };
      return [variant];
    });
  return schema;
}

function implementerPhase(observation: RepositoryObservation): {
  name: string;
  requiredActionTypes: RepositoryAction["type"][];
  recipeId?: string;
  targetContentHashes?: Record<string, string>;
  missingFacilityIds?: string[];
} {
  const artifactId = observation.ownedArtifactIds[0];
  if (artifactId)
    return {
      name: "request-integration",
      requiredActionTypes: ["REQUEST_INTEGRATION"],
    };
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
    plan: async ({ agentId, tick, observation }) => {
      const role = agentId === "agent_000000" ? "implementer" : "collaborator";
      const plannerPhase =
        role === "implementer" ? implementerPhase(observation) : undefined;
      const context = {
        role,
        tick,
        ...(plannerPhase ? { plannerPhase } : {}),
        task: config.environment.task,
        patchPolicy: config.environment.patch,
        configuredFacilities: config.environment.facilities.map((facility) => ({
          id: facility.id,
          category: facility.category,
          mandatory: facility.mandatory,
          permittedPaths: facility.permittedPaths,
        })),
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
        if (role === "collaborator" && !COLLABORATOR_ACTIONS.has(action.type))
          return [{ type: "WAIT" }];
        return [action];
      } catch {
        return [{ type: "WAIT" }];
      }
    },
  };
}
