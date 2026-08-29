import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCognition } from "./cognition.js";
import { RetryableDecisionError, Simulator } from "./engine.js";
import { evaluateFrozen } from "./evaluation.js";
import { sha256 } from "./hash.js";
import {
  artifactPerformance,
  discoveryFrontierAuc,
  isValidatedInvention,
} from "./metrics.js";
import type {
  EvaluationResult,
  ExperimentConfig,
  FrozenWorld,
  RunSummary,
} from "./types.js";
import { World } from "./world.js";

export interface RunResult {
  summary: RunSummary;
  tracePath: string;
  summaryPath: string;
}

function envelope(results: EvaluationResult[][]): EvaluationResult[] {
  if (!results.length) return [];
  return results[0]!.map((_, schedule) => {
    const members = results.map((r) => r[schedule]!);
    const serviceKeys = Object.keys(members[0]!.serviceAuc) as Array<
      keyof EvaluationResult["serviceAuc"]
    >;
    return {
      seed: members[0]!.seed,
      resilienceAuc: Math.max(...members.map((r) => r.resilienceAuc)),
      serviceAuc: Object.fromEntries(
        serviceKeys.map((s) => [
          s,
          Math.max(...members.map((r) => r.serviceAuc[s])),
        ]),
      ) as EvaluationResult["serviceAuc"],
      finalCoverage: Object.fromEntries(
        serviceKeys.map((s) => [
          s,
          Math.max(...members.map((r) => r.finalCoverage[s])),
        ]),
      ) as EvaluationResult["finalCoverage"],
    };
  });
}

export async function runExperiment(
  config: ExperimentConfig,
  outputDir = "runs",
): Promise<RunResult> {
  return config.condition === "independent"
    ? runIndependent(config, outputDir)
    : runShared(config, outputDir);
}

async function advance(simulator: Simulator): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await simulator.step();
      return;
    } catch (error) {
      if (!(error instanceof RetryableDecisionError) || attempt >= 4)
        throw error;
    }
  }
}

async function runShared(
  config: ExperimentConfig,
  outputDir: string,
): Promise<RunResult> {
  const simulator = new Simulator(config, createCognition(config));
  const evaluations: Record<number, EvaluationResult[]> = {};
  while (simulator.tick < config.ticks) {
    await advance(simulator);
    if (config.evaluation.checkpoints.includes(simulator.tick)) {
      const frozen = simulator.freeze();
      evaluations[simulator.tick] = config.evaluation.seeds.map((seed) =>
        evaluateFrozen(frozen, seed, config),
      );
    }
  }
  const runId = `${config.condition}-n${config.population}-s${config.seed}-${sha256(config).slice(0, 8)}`;
  const dir = join(outputDir, runId);
  await mkdir(dir, { recursive: true });
  const summary: RunSummary & { validatedInventions: number } = {
    runId,
    configHash: sha256(config),
    traceHash: simulator.trace.hash(),
    events: simulator.trace.events.length,
    artifacts: simulator.artifacts.length,
    programs: simulator.programs.size,
    discoveryFrontierAuc: discoveryFrontierAuc(
      simulator.trace.events,
      config.ticks,
    ),
    bestArtifactPerformance: Math.max(
      0,
      ...simulator.artifacts.map(artifactPerformance),
    ),
    evaluations,
    validatedInventions:
      simulator.artifacts.filter(isValidatedInvention).length,
  };
  const tracePath = join(dir, "trace.jsonl"),
    summaryPath = join(dir, "summary.json");
  await simulator.trace.write(tracePath, summary);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, tracePath, summaryPath };
}

async function runIndependent(
  config: ExperimentConfig,
  outputDir: string,
): Promise<RunResult> {
  const base = new World(
    config.seed,
    config.world.width,
    config.world.height,
    undefined,
    config.world.scenario,
  );
  const positions = base.spawnPositions(config.population);
  const memberResults: Array<{
    simulator: Simulator;
    evaluations: Record<number, EvaluationResult[]>;
    frozen: Record<number, FrozenWorld>;
  }> = [];
  for (let i = 0; i < config.population; i++) {
    const memberConfig: ExperimentConfig = {
      ...structuredClone(config),
      population: 1,
      condition: "independent",
      seed: config.seed,
    };
    const simulator = new Simulator(
      memberConfig,
      createCognition(memberConfig),
    );
    simulator.agents[0]!.position = positions[i]!;
    simulator.agents[0]!.phase = i % config.macroturnInterval;
    const evaluations: Record<number, EvaluationResult[]> = {},
      frozen: Record<number, FrozenWorld> = {};
    while (simulator.tick < config.ticks) {
      await advance(simulator);
      if (config.evaluation.checkpoints.includes(simulator.tick)) {
        frozen[simulator.tick] = simulator.freeze();
        evaluations[simulator.tick] = config.evaluation.seeds.map((seed) =>
          evaluateFrozen(frozen[simulator.tick]!, seed, config),
        );
      }
    }
    memberResults.push({ simulator, evaluations, frozen });
  }
  const evaluations = Object.fromEntries(
    config.evaluation.checkpoints.map((checkpoint) => [
      checkpoint,
      envelope(memberResults.map((r) => r.evaluations[checkpoint] ?? [])),
    ]),
  );
  const frontier = Math.max(
    ...memberResults.map((r) =>
      discoveryFrontierAuc(r.simulator.trace.events, config.ticks),
    ),
  );
  const best = Math.max(
    0,
    ...memberResults.flatMap((r) =>
      r.simulator.artifacts.map(artifactPerformance),
    ),
  );
  const runId = `independent-n${config.population}-s${config.seed}-${sha256(config).slice(0, 8)}`;
  const dir = join(outputDir, runId);
  await mkdir(dir, { recursive: true });
  const memberHashes = memberResults.map((r) => r.simulator.trace.hash());
  const summary: RunSummary & { memberTraceHashes: string[] } = {
    runId,
    configHash: sha256(config),
    traceHash: sha256(memberHashes),
    events: memberResults.reduce(
      (n, r) => n + r.simulator.trace.events.length,
      0,
    ),
    artifacts: memberResults.reduce(
      (n, r) => n + r.simulator.artifacts.length,
      0,
    ),
    programs: memberResults.reduce((n, r) => n + r.simulator.programs.size, 0),
    discoveryFrontierAuc: frontier,
    bestArtifactPerformance: best,
    evaluations,
    memberTraceHashes: memberHashes,
  };
  const tracePath = join(dir, "trace.jsonl"),
    summaryPath = join(dir, "summary.json");
  await writeFile(
    tracePath,
    memberResults
      .flatMap((r, i) =>
        r.simulator.trace.events.map((event) =>
          JSON.stringify({ member: i, ...event }),
        ),
      )
      .join("\n") + "\n",
  );
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, tracePath, summaryPath };
}
