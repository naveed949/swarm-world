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
  timeoutMs: z.number().int().positive(),
  outputLimit: z.number().int().positive(),
  concurrency: z.number().int().positive().default(1),
  environment: z.record(z.string(), z.string()).default({}),
  mandatory: z.boolean().default(false),
});

const repositoryRunSchema = z.object({
  seed: z.number().int().default(3201),
  population: z.number().int().positive().default(1),
  ticks: z.number().int().positive().default(1),
  macroturnInterval: z.number().int().positive().default(1),
  planLimit: z.number().int().positive().max(32).default(8),
  condition: z
    .enum(["full", "no-communication", "no-explicit-culture", "independent"])
    .default("full"),
  environment: z.object({
    type: z.literal("repository"),
    root: z.string().min(1),
    baseCommit: z.string().min(1),
    readOnly: z.boolean().default(true),
    task: z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      acceptanceCriteria: z.array(z.string().min(1)).min(1),
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
      environment: {
        ...environment,
        root: resolve(dirname(path), environment.root),
        condition: parsed.condition,
        facilities: environment.facilities as RepositoryFacility[],
      },
    },
  };
}
