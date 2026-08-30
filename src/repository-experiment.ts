import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentPlanner } from "./environment-simulator.js";
import { EnvironmentSimulator } from "./environment-simulator.js";
import { sha256 } from "./hash.js";
import {
  RepositoryEnvironment,
  type RepositoryAction,
  type RepositoryEvaluation,
  type RepositoryObservation,
} from "./repository-environment.js";
import type { RepositoryRunConfig } from "./run-config.js";

export interface RepositoryRunResult {
  summary: {
    runId: string;
    outcome: RepositoryEvaluation["outcome"];
    baseCommit: string;
    candidateCommit: string;
    traceHash: string;
    environmentTraceHash: string;
    evaluation: RepositoryEvaluation;
  };
  tracePath: string;
  summaryPath: string;
}

const waitPlanner: EnvironmentPlanner<RepositoryObservation, RepositoryAction> =
  {
    plan: async () => [{ type: "WAIT" }],
  };

export async function runRepositoryExperiment(
  config: RepositoryRunConfig,
  outputDir = "runs",
  planner: EnvironmentPlanner<
    RepositoryObservation,
    RepositoryAction
  > = waitPlanner,
): Promise<RepositoryRunResult> {
  const environment = await RepositoryEnvironment.create(config.environment);
  const agentIds = Array.from({ length: config.population }, (_, index) => {
    const id = `agent_${String(index).padStart(6, "0")}`;
    environment.createAgent(id);
    return id;
  });
  const simulator = new EnvironmentSimulator(
    environment,
    agentIds,
    {
      macroturnInterval: config.macroturnInterval,
      planLimit: config.planLimit,
    },
    planner,
  );
  while (simulator.tick < config.ticks) await simulator.step();
  const frozen = await simulator.freeze();
  const evaluation = await simulator.evaluate(frozen);
  const runId = `repository-n${config.population}-s${config.seed}-${sha256(config).slice(0, 8)}`;
  const directory = join(outputDir, runId);
  await mkdir(directory, { recursive: true });
  const tracePath = join(directory, "trace.jsonl");
  const summaryPath = join(directory, "summary.json");
  const summary: RepositoryRunResult["summary"] = {
    runId,
    outcome: evaluation.outcome,
    baseCommit: frozen.baseCommit,
    candidateCommit: frozen.candidateCommit,
    traceHash: simulator.traceHash(),
    environmentTraceHash: frozen.traceHash,
    evaluation,
  };
  await writeFile(
    tracePath,
    `${simulator.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, tracePath, summaryPath };
}
