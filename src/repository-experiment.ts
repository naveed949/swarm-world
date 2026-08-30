import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentPlanner } from "./environment-simulator.js";
import { EnvironmentSimulator } from "./environment-simulator.js";
import { sha256 } from "./hash.js";
import { createPiRepositoryPlanner } from "./repository-pi-planner.js";
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
  patchPath: string;
  mailboxPath: string;
}

const waitPlanner: EnvironmentPlanner<RepositoryObservation, RepositoryAction> =
  {
    plan: async () => [{ type: "WAIT" }],
  };

function surveyPlanner(
  config: RepositoryRunConfig,
): EnvironmentPlanner<RepositoryObservation, RepositoryAction> {
  return {
    plan: async ({ agentId, tick, observation }) => {
      const agentIndex = Number(agentId.slice("agent_".length));
      if (tick === 0 && agentIndex === 0)
        return [{ type: "CLAIM_TASK", taskId: config.environment.task.id }];
      if (tick === 1) {
        const inspectable = observation.nodes
          .filter((node) => node.path)
          .sort((a, b) => a.id.localeCompare(b.id));
        const node = inspectable[agentIndex % Math.max(inspectable.length, 1)];
        return node
          ? [{ type: "INSPECT", nodeId: node.id }]
          : [{ type: "WAIT" }];
      }
      const queries = config.surveyQueries ?? [];
      const query = queries[(tick + agentIndex) % Math.max(queries.length, 1)];
      return query ? [{ type: "SEARCH", query }] : [{ type: "WAIT" }];
    },
  };
}

function scriptedPlanner(
  config: RepositoryRunConfig,
): EnvironmentPlanner<RepositoryObservation, RepositoryAction> {
  const change = config.scriptedChange;
  if (!change) throw new Error("Scripted planner requires scriptedChange");
  return {
    plan: async ({ agentId, tick, observation }) => {
      const agentIndex = Number(agentId.slice("agent_".length));
      if (agentIndex !== 0) {
        const queries = config.surveyQueries ?? [];
        const query = queries[tick % Math.max(queries.length, 1)];
        return query ? [{ type: "SEARCH", query }] : [{ type: "WAIT" }];
      }
      const target = observation.nodes.find(
        (node) => node.path === change.targetPath,
      );
      if (tick === 0)
        return [{ type: "CLAIM_TASK", taskId: config.environment.task.id }];
      if (tick === 1)
        return target
          ? [{ type: "INSPECT", nodeId: target.id }]
          : [{ type: "WAIT" }];
      if (tick === 2)
        return observation.ownedEvidenceIds.length
          ? [
              {
                type: "FORMULATE",
                taskId: config.environment.task.id,
                evidenceIds: observation.ownedEvidenceIds,
                targets: [change.targetPath],
                requiredFacilities: change.requiredFacilityIds,
              },
            ]
          : [{ type: "WAIT" }];
      const recipeId = observation.ownedRecipeIds[0];
      if (tick === 3)
        return recipeId && target?.contentHash
          ? [
              {
                type: "EDIT_REPLACE",
                recipeId,
                path: change.targetPath,
                expectedContentHash: target.contentHash,
                oldText: change.oldText,
                newText: change.newText,
              },
            ]
          : [{ type: "WAIT" }];
      if (tick >= 4 && tick < 4 + change.requiredFacilityIds.length) {
        const facilityId = change.requiredFacilityIds[tick - 4];
        return recipeId && facilityId
          ? [{ type: "RUN_CHECK", recipeId, facilityId }]
          : [{ type: "WAIT" }];
      }
      if (tick === 4 + change.requiredFacilityIds.length)
        return recipeId
          ? [{ type: "CONSTRUCT_ARTIFACT", recipeId }]
          : [{ type: "WAIT" }];
      if (tick === 5 + change.requiredFacilityIds.length) {
        const artifactId = observation.ownedArtifactIds[0];
        return artifactId
          ? [{ type: "REQUEST_INTEGRATION", artifactId }]
          : [{ type: "WAIT" }];
      }
      return [{ type: "WAIT" }];
    },
  };
}

export function createRepositoryPlanner(
  config: RepositoryRunConfig,
): EnvironmentPlanner<RepositoryObservation, RepositoryAction> {
  return config.planner === "survey"
    ? surveyPlanner(config)
    : config.planner === "scripted"
      ? scriptedPlanner(config)
      : config.planner === "pi"
        ? createPiRepositoryPlanner(config)
        : waitPlanner;
}

export async function runRepositoryExperiment(
  config: RepositoryRunConfig,
  outputDir = "runs",
  planner: EnvironmentPlanner<
    RepositoryObservation,
    RepositoryAction
  > = createRepositoryPlanner(config),
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
    members.find(
      (member) =>
        member.frozen.acceptedArtifacts.length > 0 ||
        member.frozen.candidateCommit !== member.frozen.baseCommit,
    ) ??
    members[0]!;
  const frozen = winningMember.frozen;
  const runId = `repository-n${config.population}-s${config.seed}-${sha256(config).slice(0, 8)}`;
  const directory = join(outputDir, runId);
  await mkdir(directory, { recursive: true });
  const tracePath = join(directory, "trace.jsonl");
  const summaryPath = join(directory, "summary.json");
  const patchPath = join(directory, "artifact.patch");
  const mailboxPath = join(directory, "artifact.mbox");
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
  await writeFile(
    patchPath,
    await winningMember.environment.artifactPatch(frozen),
  );
  await writeFile(
    mailboxPath,
    await winningMember.environment.artifactMailbox(frozen),
  );
  return { summary, tracePath, summaryPath, patchPath, mailboxPath };
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
