import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { loadConfig } from "./config.js";
import type {
  RepositoryEnvironmentConfig,
  RepositoryFacility,
} from "./repository-environment.js";
import type { Condition, ExperimentConfig } from "./types.js";

export interface RepositoryRunConfig {
  seed: number;
  population: number;
  ticks: number;
  macroturnInterval: number;
  planLimit: number;
  condition: Condition;
  planner?: "wait" | "survey" | "scripted" | "pi";
  model?: {
    provider: string;
    id: string;
    temperature: number;
    reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  };
  surveyQueries?: string[];
  scriptedChange?: {
    targetPath: string;
    oldText: string;
    newText: string;
    requiredFacilityIds: string[];
  };
  environment: RepositoryEnvironmentConfig;
}

export type RunConfig =
  | { type: "biofoundry"; config: ExperimentConfig }
  | { type: "repository"; config: RepositoryRunConfig };

const facilitySchema = z.object({
  id: z.string().min(1),
  category: z.enum([
    "format",
    "build",
    "test",
    "typecheck",
    "lint",
    "analysis",
    "hidden",
  ]),
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  workingDirectory: z.string().default("."),
  permittedPaths: z.array(z.string()).min(1),
  mutationClass: z.enum(["none", "worktree"]).default("none"),
  sandbox: z
    .object({ executable: z.string().min(1), args: z.array(z.string()) })
    .optional(),
  timeoutMs: z.number().int().positive(),
  outputLimit: z.number().int().positive(),
  concurrency: z.number().int().positive().default(1),
  environment: z.record(z.string(), z.string()).default({}),
  mandatory: z.boolean().default(false),
});

const repositoryRunSchema = z
  .object({
    seed: z.number().int().default(3201),
    population: z.number().int().positive().default(1),
    ticks: z.number().int().positive().default(1),
    macroturnInterval: z.number().int().positive().default(1),
    planLimit: z.number().int().positive().max(32).default(8),
    condition: z
      .enum(["full", "no-communication", "no-explicit-culture", "independent"])
      .default("full"),
    planner: z.enum(["wait", "survey", "scripted", "pi"]).default("wait"),
    model: z
      .object({
        provider: z.string().min(1),
        id: z.string().min(1),
        temperature: z.number().min(0).max(2).default(0),
        reasoning: z
          .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
          .default("medium"),
      })
      .optional(),
    surveyQueries: z.array(z.string().min(1).max(256)).default([]),
    scriptedChange: z
      .object({
        targetPath: z.string().min(1),
        oldText: z.string().min(1),
        newText: z.string(),
        requiredFacilityIds: z.array(z.string().min(1)).min(1),
      })
      .optional(),
    environment: z.object({
      type: z.literal("repository"),
      root: z.string().min(1),
      baseCommit: z.string().min(1),
      readOnly: z.boolean().default(true),
      task: z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        acceptanceCriteria: z.array(z.string().min(1)).min(1),
        acceptanceFacilityIds: z.array(z.string().min(1)).min(1),
        regressionFacilityIds: z.array(z.string().min(1)).min(1),
        relevantPaths: z.array(z.string()).min(1),
        priority: z.number().int().default(0),
      }),
      observationRadius: z.number().int().nonnegative().default(2),
      observationLimit: z.number().int().positive().default(64),
      allowedPaths: z.array(z.string()).min(1),
      excludedPaths: z.array(z.string()).default([]),
      patch: z.object({
        maxFiles: z.number().int().positive(),
        maxChangedLines: z.number().int().positive(),
      }),
      facilities: z.array(facilitySchema).min(1),
    }),
  })
  .superRefine((config, context) => {
    if (config.planner === "pi" && !config.model)
      context.addIssue({
        code: "custom",
        message: "Pi repository planner requires a model",
        path: ["model"],
      });
    if (config.planner !== "scripted") return;
    if (!config.scriptedChange)
      context.addIssue({
        code: "custom",
        message: "Scripted planner requires scriptedChange",
        path: ["scriptedChange"],
      });
    if (config.environment.readOnly)
      context.addIssue({
        code: "custom",
        message: "Scripted planner requires writable repository mode",
        path: ["environment", "readOnly"],
      });
    if (
      config.scriptedChange &&
      !config.environment.task.relevantPaths.includes(
        config.scriptedChange.targetPath,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Scripted target must be task-relevant",
        path: ["scriptedChange", "targetPath"],
      });
    if (
      config.scriptedChange?.requiredFacilityIds.some(
        (id) =>
          !config.environment.facilities.some(
            (facility) => facility.id === id && facility.category !== "hidden",
          ),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Scripted checks must reference visible facilities",
        path: ["scriptedChange", "requiredFacilityIds"],
      });
  });

export async function loadRunConfig(path: string): Promise<RunConfig> {
  const source = YAML.parse(await readFile(path, "utf8")) as unknown;
  if (
    typeof source !== "object" ||
    source === null ||
    !("environment" in source) ||
    typeof source.environment !== "object" ||
    source.environment === null ||
    !("type" in source.environment) ||
    source.environment.type !== "repository"
  )
    return { type: "biofoundry", config: await loadConfig(path) };
  const parsed = repositoryRunSchema.parse(source);
  const { type: _, ...environment } = parsed.environment;
  void _;
  return {
    type: "repository",
    config: {
      seed: parsed.seed,
      population: parsed.population,
      ticks: parsed.ticks,
      macroturnInterval: parsed.macroturnInterval,
      planLimit: parsed.planLimit,
      condition: parsed.condition,
      planner: parsed.planner,
      ...(parsed.model ? { model: parsed.model } : {}),
      surveyQueries: parsed.surveyQueries,
      ...(parsed.scriptedChange
        ? { scriptedChange: parsed.scriptedChange }
        : {}),
      environment: {
        ...environment,
        root: resolve(dirname(path), environment.root),
        condition: parsed.condition,
        facilities: environment.facilities as RepositoryFacility[],
      },
    },
  };
}
