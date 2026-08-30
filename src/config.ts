import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { loadScenarioPackage } from "./scenario.js";
import type { Capabilities, Condition, ExperimentConfig } from "./types.js";

const configSchema = z.object({
  seed: z.number().int().default(3201),
  population: z.number().int().positive().default(50),
  ticks: z.number().int().positive().default(800),
  macroturnInterval: z.number().int().positive().default(50),
  planLimit: z.number().int().min(1).max(12).default(12),
  condition: z
    .enum(["full", "no-communication", "no-explicit-culture", "independent"])
    .default("full"),
  cognition: z.enum(["heuristic", "pi"]).default("heuristic"),
  model: z
    .object({
      provider: z.string().default("openai-codex"),
      id: z.string().default("gpt-5.6-luna"),
      temperature: z.number().min(0).max(2).default(0.7),
      reasoning: z
        .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
        .default("low"),
    })
    .default({
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      temperature: 0.7,
      reasoning: "low",
    }),
  world: z
    .object({
      width: z.number().int().min(12).default(72),
      height: z.number().int().min(12).default(54),
      observationRadius: z.number().int().min(1).default(4),
      inventoryLimit: z.number().positive().default(8),
      disturbanceInterval: z.number().int().positive().default(64),
      disturbanceIntensity: z.number().min(0).max(2).default(0.5),
      scenarioPackage: z.string().optional(),
      scenario: z.any().optional(),
    })
    .default({
      width: 72,
      height: 54,
      observationRadius: 4,
      inventoryLimit: 8,
      disturbanceInterval: 64,
      disturbanceIntensity: 0.5,
    }),
  evaluation: z
    .object({
      checkpoints: z.array(z.number().int().positive()).default([800]),
      ticks: z.number().int().positive().default(288),
      seeds: z
        .array(z.number().int())
        .min(1)
        .default([9201, 9202, 9203, 9204, 9205, 9206, 9207, 9208]),
    })
    .default({
      checkpoints: [800],
      ticks: 288,
      seeds: [9201, 9202, 9203, 9204, 9205, 9206, 9207, 9208],
    }),
});

export async function loadConfig(path: string): Promise<ExperimentConfig> {
  const parsed = YAML.parse(await readFile(path, "utf8"));
  const config = configSchema.parse(parsed) as ExperimentConfig;
  if (config.world.scenarioPackage)
    config.world.scenario = await loadScenarioPackage(
      resolve(dirname(path), config.world.scenarioPackage),
    );
  if (config.evaluation.checkpoints.some((tick) => tick > config.ticks))
    throw new Error("Evaluation checkpoint exceeds discovery horizon");
  return config;
}

export function parseConfig(value: unknown): ExperimentConfig {
  return configSchema.parse(value) as ExperimentConfig;
}

export function capabilities(condition: Condition): Capabilities {
  if (condition === "full")
    return {
      sharedWorld: true,
      communication: true,
      publication: true,
      teaching: true,
      trade: true,
      taskClaims: true,
      authoredText: true,
      crossAgentPrograms: true,
      programForking: true,
    };
  if (condition === "no-communication")
    return {
      sharedWorld: true,
      communication: false,
      publication: false,
      teaching: false,
      trade: false,
      taskClaims: false,
      authoredText: true,
      crossAgentPrograms: true,
      programForking: true,
    };
  if (condition === "no-explicit-culture")
    return {
      sharedWorld: true,
      communication: false,
      publication: false,
      teaching: false,
      trade: false,
      taskClaims: false,
      authoredText: false,
      crossAgentPrograms: false,
      programForking: false,
    };
  return {
    sharedWorld: false,
    communication: false,
    publication: false,
    teaching: false,
    trade: false,
    taskClaims: false,
    authoredText: true,
    crossAgentPrograms: false,
    programForking: false,
  };
}
