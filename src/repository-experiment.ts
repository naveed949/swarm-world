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
    memberCandidateCommits?: string[];
    memberTraceHashes?: string[];
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
  const ids = Array.from(
    { length: config.population },
    (_, index) => `agent_${String(index).padStart(6, "0")}`,
  );
  const members =
    config.condition === "independent"
      ? await Promise.all(ids.map((id) => runMember(config, [id], planner)))
      : [await runMember(config, ids, planner)];
  const evaluation = envelope(members.map((member) => member.evaluation));
  const winningMember =
    members.find((member) => member.evaluation.outcome === "completed") ??
    members[0]!;
  const frozen = winningMember.frozen;
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
    traceHash: sha256({
      schedulerEvents: members.flatMap((member) => member.simulator.events),
      environmentEvents: members.flatMap((member) =>
        member.environment.traceEvents(),
      ),
    }),
    environmentTraceHash: sha256(
      members.map((member) => member.frozen.traceHash),
    ),
    evaluation,
    ...(members.length > 1
      ? {
          memberCandidateCommits: members.map(
            (member) => member.frozen.candidateCommit,
          ),
          memberTraceHashes: members.map((member) =>
            sha256({
              schedulerEvents: member.simulator.events,
              environmentEvents: member.environment.traceEvents(),
            }),
          ),
        }
      : {}),
  };
  await writeFile(
    tracePath,
    `${[
      JSON.stringify({
        type: "manifest",
        environmentType: "repository",
        summary,
      }),
      ...members.flatMap((member, index) =>
        member.environment.traceEvents().map((event) =>
          JSON.stringify({
            recordType: "environment",
            member: index,
            event,
          }),
        ),
      ),
      ...members.flatMap((member, index) =>
        member.simulator.events.map((event) =>
          JSON.stringify({ recordType: "scheduler", member: index, event }),
        ),
      ),
    ].join("\n")}\n`,
  );
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, tracePath, summaryPath };
}

async function runMember(
  config: RepositoryRunConfig,
  agentIds: string[],
  planner: EnvironmentPlanner<RepositoryObservation, RepositoryAction>,
) {
  const environment = await RepositoryEnvironment.create(config.environment);
  for (const id of agentIds) environment.createAgent(id);
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
  return {
    environment,
    simulator,
    frozen,
    evaluation: await simulator.evaluate(frozen),
  };
}

function envelope(results: RepositoryEvaluation[]): RepositoryEvaluation {
  const first = results[0]!;
  const checks = [
    ...new Set(
      results.flatMap((result) =>
        result.checks.map((check) => check.facilityId),
      ),
    ),
  ]
    .sort()
    .map(
      (facilityId) =>
        results
          .flatMap((result) => result.checks)
          .filter((check) => check.facilityId === facilityId)
          .sort((a, b) => Number(b.success) - Number(a.success))[0]!,
    );
  return {
    ...first,
    outcome: results.some((result) => result.outcome === "completed")
      ? "completed"
      : results.some((result) => result.outcome === "evaluation inconclusive")
        ? "evaluation inconclusive"
        : "no eligible artifact",
    hardGatesPassed: results.some((result) => result.hardGatesPassed),
    checks,
    correctness: Math.max(...results.map((result) => result.correctness)),
    regressionSafety: Math.max(
      ...results.map((result) => result.regressionSafety),
    ),
    issueCoverage: Math.max(...results.map((result) => result.issueCoverage)),
    maintainability: Math.max(
      ...results.map((result) => result.maintainability),
    ),
    robustness: Math.max(...results.map((result) => result.robustness)),
  };
}
