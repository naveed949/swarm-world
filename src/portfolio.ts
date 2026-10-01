import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { runExperiment } from "./experiment.js";
import { loadRunConfig } from "./run-config.js";
import type {
  Condition,
  EvaluationResult,
  RunSummary,
  ServiceId,
} from "./types.js";

const serviceIds = [
  "water",
  "remediation",
  "stability",
  "healing",
  "nutrient",
] as const satisfies readonly ServiceId[];

export interface MeanStd {
  mean: number;
  std: number;
}

export interface PortfolioTrial {
  worldSeed: number;
  trial: number;
  runId: string;
  configHash: string;
  traceHash: string;
  events: number;
  artifacts: number;
  programs: number;
  discoveryFrontierAuc: number;
  bestArtifactPerformance: number;
  evaluations: Record<string, EvaluationResult[]>;
  validatedInventions?: number;
  memberTraceHashes?: string[];
}

export interface PortfolioReport {
  schemaVersion: 1;
  status: "scored";
  condition: Condition;
  cognition: "heuristic";
  configPath: string;
  worldSeeds: number[];
  trialsPerSeed: number;
  aggregates: {
    discoveryFrontierAuc: MeanStd;
    bestArtifactPerformance: MeanStd;
    evaluations: Record<
      string,
      Array<{
        seed: number;
        resilienceAuc: MeanStd;
        serviceAuc: Record<ServiceId, MeanStd>;
        finalCoverage: Record<ServiceId, MeanStd>;
      }>
    >;
  };
  trials: PortfolioTrial[];
  note: string;
}

export interface PortfolioRunOptions {
  configPath: string;
  worldSeeds: readonly number[];
  trialsPerSeed: number;
  outputPath: string;
  workDir: string;
}

const scoredNote =
  "Measured with heuristic cognition. Each trial copies runExperiment fields discoveryFrontierAuc, bestArtifactPerformance, events, artifacts, programs, and evaluateFrozen evaluations. Mean and sample standard deviation use every recorded trial and divide variance by n-1. Evaluation seeds stay separate. Heuristic plans are deterministic, so repeated trials of one world seed match. This report is not a published SwarmWorld paper figure.";

/** Sample mean and sample standard deviation (variance divided by n-1). */
export function sampleMeanStd(values: readonly number[]): MeanStd {
  if (values.length === 0) throw new Error("Cannot aggregate an empty sample");
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return { mean, std: 0 };
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return { mean, std: Math.sqrt(variance) };
}

export function parseWorldSeeds(value: string): number[] {
  const seeds = value.split(",").map((part) => {
    const token = part.trim();
    if (!/^-?\d+$/.test(token))
      throw new Error(`Invalid world seed "${part.trim()}"`);
    return Number(token);
  });
  if (seeds.length === 0)
    throw new Error("At least one world seed is required");
  return seeds;
}

export function parseTrialsPerSeed(value: string): number {
  if (!/^[1-9]\d*$/.test(value.trim()))
    throw new Error("Trials per seed must be a positive integer");
  return Number(value.trim());
}

export function assertPortfolioWorkDir(workDir: string): void {
  const portfolioRoot = resolve("runs/portfolio");
  const resolved = resolve(workDir);
  const fromPortfolio = relative(portfolioRoot, resolved);
  const inside =
    fromPortfolio === "" ||
    (!fromPortfolio.startsWith("..") && !isAbsolute(fromPortfolio));
  if (inside)
    throw new Error(
      "Portfolio work traces must be written outside runs/portfolio",
    );
}

function checkpointEvaluations(
  evaluations: RunSummary["evaluations"],
): Record<string, EvaluationResult[]> {
  return Object.fromEntries(
    Object.entries(evaluations).map(([checkpoint, rows]) => [
      checkpoint,
      rows.map((row) => structuredClone(row)),
    ]),
  );
}

export function trialFromSummary(
  summary: RunSummary,
  worldSeed: number,
  trial: number,
): PortfolioTrial {
  const extra = summary as RunSummary & {
    validatedInventions?: number;
    memberTraceHashes?: string[];
  };
  const record: PortfolioTrial = {
    worldSeed,
    trial,
    runId: summary.runId,
    configHash: summary.configHash,
    traceHash: summary.traceHash,
    events: summary.events,
    artifacts: summary.artifacts,
    programs: summary.programs,
    discoveryFrontierAuc: summary.discoveryFrontierAuc,
    bestArtifactPerformance: summary.bestArtifactPerformance,
    evaluations: checkpointEvaluations(summary.evaluations),
  };
  if (typeof extra.validatedInventions === "number")
    record.validatedInventions = extra.validatedInventions;
  if (extra.memberTraceHashes)
    record.memberTraceHashes = [...extra.memberTraceHashes];
  return record;
}

function sameNumbers(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function serviceAggregate(
  rows: readonly EvaluationResult[],
  field: "serviceAuc" | "finalCoverage",
): Record<ServiceId, MeanStd> {
  return Object.fromEntries(
    serviceIds.map((service) => {
      const values = rows.map((row) => {
        const value = row[field][service];
        if (typeof value !== "number")
          throw new Error(
            `Missing ${field}.${service} on an evaluation result`,
          );
        return value;
      });
      return [service, sampleMeanStd(values)];
    }),
  ) as Record<ServiceId, MeanStd>;
}

export function portfolioReportFromTrials(input: {
  condition: Condition;
  configPath: string;
  worldSeeds: readonly number[];
  trialsPerSeed: number;
  trials: readonly PortfolioTrial[];
}): PortfolioReport {
  const worldSeeds = [...input.worldSeeds];
  if (worldSeeds.length < 3)
    throw new Error("A scored portfolio report needs at least 3 world seeds");
  if (new Set(worldSeeds).size !== worldSeeds.length)
    throw new Error("World seeds must be unique");
  if (!Number.isInteger(input.trialsPerSeed) || input.trialsPerSeed < 1)
    throw new Error("Trials per seed must be a positive integer");
  for (const worldSeed of worldSeeds) {
    if (!Number.isInteger(worldSeed))
      throw new Error(`World seed ${worldSeed} is not an integer`);
    const count = input.trials.filter(
      (trial) => trial.worldSeed === worldSeed,
    ).length;
    if (count !== input.trialsPerSeed)
      throw new Error(
        `World seed ${worldSeed} has ${count} trials; expected ${input.trialsPerSeed}`,
      );
  }
  if (input.trials.length !== worldSeeds.length * input.trialsPerSeed)
    throw new Error(
      "Trial list does not match world seeds times trials per seed",
    );
  const first = input.trials[0];
  if (!first) throw new Error("A scored portfolio report needs trials");
  const checkpoints = Object.keys(first.evaluations).sort(
    (a, b) => Number(a) - Number(b),
  );
  if (checkpoints.length === 0)
    throw new Error(
      "Portfolio scoring needs evaluateFrozen checkpoint results",
    );
  for (const trial of input.trials) {
    const keys = Object.keys(trial.evaluations).sort(
      (a, b) => Number(a) - Number(b),
    );
    if (keys.join(",") !== checkpoints.join(","))
      throw new Error("Trials do not share evaluation checkpoints");
  }
  const evaluations = Object.fromEntries(
    checkpoints.map((checkpoint) => {
      const baseline = first.evaluations[checkpoint];
      if (!baseline?.length)
        throw new Error(
          `Checkpoint ${checkpoint} has no evaluateFrozen results`,
        );
      const seeds = baseline.map((row) => row.seed);
      for (const trial of input.trials) {
        const trialRows = trial.evaluations[checkpoint];
        if (
          !trialRows ||
          !sameNumbers(
            trialRows.map((row) => row.seed),
            seeds,
          )
        )
          throw new Error(
            `Trial ${trial.worldSeed}:${trial.trial} evaluation seeds differ at checkpoint ${checkpoint}`,
          );
      }
      return [
        checkpoint,
        seeds.map((seed) => {
          const rows = input.trials.map((trial) => {
            const row = trial.evaluations[checkpoint]?.find(
              (item) => item.seed === seed,
            );
            if (!row)
              throw new Error(
                `Trial ${trial.worldSeed}:${trial.trial} is missing checkpoint ${checkpoint} seed ${seed}`,
              );
            return row;
          });
          return {
            seed,
            resilienceAuc: sampleMeanStd(rows.map((row) => row.resilienceAuc)),
            serviceAuc: serviceAggregate(rows, "serviceAuc"),
            finalCoverage: serviceAggregate(rows, "finalCoverage"),
          };
        }),
      ];
    }),
  );

  return {
    schemaVersion: 1,
    status: "scored",
    condition: input.condition,
    cognition: "heuristic",
    configPath: input.configPath,
    worldSeeds,
    trialsPerSeed: input.trialsPerSeed,
    aggregates: {
      discoveryFrontierAuc: sampleMeanStd(
        input.trials.map((trial) => trial.discoveryFrontierAuc),
      ),
      bestArtifactPerformance: sampleMeanStd(
        input.trials.map((trial) => trial.bestArtifactPerformance),
      ),
      evaluations,
    },
    trials: input.trials.map((trial) => structuredClone(trial)),
    note: scoredNote,
  };
}

export async function runPortfolio(
  options: PortfolioRunOptions,
): Promise<PortfolioReport> {
  assertPortfolioWorkDir(options.workDir);
  if (options.worldSeeds.length < 3)
    throw new Error("A scored portfolio report needs at least 3 world seeds");
  const loaded = await loadRunConfig(options.configPath);
  if (loaded.type !== "biofoundry")
    throw new Error("Portfolio scoring uses the biofoundry experiment runner");
  if (loaded.config.cognition !== "heuristic")
    throw new Error(
      "Portfolio scoring requires heuristic cognition and does not call a model provider",
    );
  const trials: PortfolioTrial[] = [];
  for (const worldSeed of options.worldSeeds) {
    for (let trial = 0; trial < options.trialsPerSeed; trial++) {
      const config = {
        ...structuredClone(loaded.config),
        seed: worldSeed,
      };
      const result = await runExperiment(config, options.workDir);
      trials.push(trialFromSummary(result.summary, worldSeed, trial));
    }
  }
  const report = portfolioReportFromTrials({
    condition: loaded.config.condition,
    configPath: options.configPath,
    worldSeeds: options.worldSeeds,
    trialsPerSeed: options.trialsPerSeed,
    trials,
  });
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
