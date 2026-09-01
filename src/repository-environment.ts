import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { capabilities } from "./config.js";
import type { Environment, EnvironmentResolution } from "./environment.js";
import { sha256 } from "./hash.js";
import { RepositoryTrace } from "./repository-trace.js";
import {
  rankRepositoryCandidates,
  RepositorySocietyLedger,
} from "./repository-society.js";
import type {
  RepositoryAction,
  RepositoryAgent,
  RepositoryArtifact,
  RepositoryAttempt,
  RepositoryCommitment,
  RepositoryEdge,
  RepositoryEdgeType,
  RepositoryEnvironmentConfig,
  RepositoryEvaluation,
  RepositoryEvidence as Evidence,
  RepositoryFacility,
  RepositoryFrozenSnapshot,
  RepositoryNode,
  RepositoryNodeType,
  RepositoryObservation,
  RepositoryProblem,
  RepositoryRecipe as Recipe,
  RepositorySelection,
  RepositoryTask,
  RepositoryTaskProposal,
  RepositoryVerification,
} from "./repository-types.js";

export type {
  RepositoryAction,
  RepositoryArtifact,
  RepositoryEdge,
  RepositoryEdgeType,
  RepositoryEnvironmentConfig,
  RepositoryEvaluation,
  RepositoryFacility,
  RepositoryFrozenSnapshot,
  RepositoryGoal,
  RepositoryNode,
  RepositoryNodeType,
  RepositoryObservation,
  RepositoryTask,
} from "./repository-types.js";

const run = promisify(execFile);

function glob(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "__GLOBSTAR_SLASH__")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__GLOBSTAR_SLASH__/g, "(?:.*/)?")
    .replace(/__GLOBSTAR__/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function sameMembers(left: string[], right: string[]): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
  }
  return value;
}

export class RepositoryEnvironment implements Environment<
  RepositoryObservation,
  RepositoryAction,
  RepositoryFrozenSnapshot,
  RepositoryEvaluation
> {
  private readonly agents = new Map<string, RepositoryAgent>();
  private readonly evidence = new Map<string, Evidence>();
  private readonly recipes = new Map<string, Recipe>();
  private readonly artifacts = new Map<string, RepositoryArtifact>();
  private readonly attempts = new Map<string, RepositoryAttempt>();
  private readonly society = new RepositorySocietyLedger();
  private readonly problems = new Map<string, RepositoryProblem>();
  private readonly taskProposals = new Map<string, RepositoryTaskProposal>();
  private readonly commitments = new Map<string, RepositoryCommitment>();
  private readonly verifications = new Map<string, RepositoryVerification>();
  private readonly verificationRequests = new Set<string>();
  private readonly verificationChallenges = new Map<string, string[]>();
  private readonly candidateRecommendations = new Map<string, Set<string>>();
  private readonly integrationQueue = new Set<string>();
  private readonly integratedArtifactIds = new Set<string>();
  private readonly messages: RepositoryObservation["messages"] = [];
  private readonly findings: RepositoryObservation["findings"] = [];
  private readonly facilityActive = new Map<string, number>();
  private readonly facilityExecutableHashes = new Map<string, string>();
  private readonly facilitySandboxHashes = new Map<string, string>();
  private readonly trace = new RepositoryTrace();
  private readonly nodes = new Map<string, RepositoryNode>();
  private readonly edges: RepositoryEdge[] = [];
  private readonly root: string;
  private candidateCommit: string;
  private candidateWorktree = "";
  private selection?: RepositorySelection;
  private tick = 0;
  private actionsUsed = 0;
  private verificationRunsUsed = 0;
  private writesUsed = 0;

  private constructor(
    readonly config: RepositoryEnvironmentConfig,
    root: string,
    readonly baseCommit: string,
  ) {
    this.root = root;
    this.candidateCommit = baseCommit;
  }

  static async create(
    config: RepositoryEnvironmentConfig,
  ): Promise<RepositoryEnvironment> {
    const authoritativeConfig = structuredClone(config);
    if (authoritativeConfig.goal) deepFreeze(authoritativeConfig.goal);
    const root = await realpath(authoritativeConfig.root);
    const readOnly = authoritativeConfig.readOnly ?? true;
    if (!readOnly) {
      const dockerBoundary =
        process.platform === "linux" &&
        root === "/workspace/target" &&
        (await access("/.dockerenv").then(
          () => true,
          () => false,
        ));
      if (!dockerBoundary)
        throw new Error(
          "Writable repository experiments require the hardened container runner",
        );
    }
    const top = (
      await run("git", ["-C", root, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      })
    ).stdout.trim();
    if ((await realpath(top)) !== root)
      throw new Error("Repository root must be the canonical Git top level");
    const baseCommit = (
      await run(
        "git",
        [
          "-C",
          root,
          "rev-parse",
          "--verify",
          `${authoritativeConfig.baseCommit}^{commit}`,
        ],
        {
          encoding: "utf8",
        },
      )
    ).stdout.trim();
    const environment = new RepositoryEnvironment(
      authoritativeConfig,
      root,
      baseCommit,
    );
    await environment.validateConfiguration();
    await environment.buildGraph();
    if (!readOnly) {
      const parent = await mkdtemp(join(tmpdir(), "swarm-world-candidate-"));
      environment.candidateWorktree = join(parent, "checkout");
      await run("git", [
        "-C",
        root,
        "worktree",
        "add",
        "--detach",
        environment.candidateWorktree,
        baseCommit,
      ]);
    }
    environment.record("environment_created", true, undefined, baseCommit, {
      rootHash: sha256(root),
      baseCommit,
      readOnly: authoritativeConfig.readOnly ?? true,
      graphHash: environment.graphHash(),
      facilityPolicyHash: environment.facilityPolicyHash(),
    });
    return environment;
  }

  createAgent(id: string): { id: string } {
    if (this.agents.has(id)) throw new Error(`Agent already exists: ${id}`);
    const task = [...this.nodes.values()].find((node) => node.type === "task")!;
    const budget = this.config.goal?.budget;
    this.agents.set(id, {
      id,
      focusNodeId: task.id,
      evidence: new Set(),
      observedNodes: new Set([task.id]),
      inheritedArtifacts: new Set(),
      actionsRemaining: budget?.maxActions ?? 128,
      verificationRemaining: budget?.maxVerificationRuns ?? 32,
      writesRemaining: Math.min(
        budget?.maxWrites ?? this.config.patch.maxChangedLines,
        this.config.patch.maxChangedLines,
      ),
    });
    return { id };
  }

  traceEvents() {
    return this.trace.snapshot();
  }

  progress(): {
    tick: number;
    fingerprint: string;
    eligibleArtifacts: number;
    integratedArtifacts: number;
    goalSatisfied: boolean;
  } {
    const eligibleArtifacts = [...this.artifacts.values()].filter((artifact) =>
      this.artifactEligible(artifact),
    ).length;
    const integratedArtifacts = this.integratedArtifactIds.size;
    const requiredTaskIds = this.config.goal?.success.requiredTaskIds ?? [];
    const completedTaskIds = new Set(
      [...this.artifacts.values()]
        .filter((artifact) => this.integratedArtifactIds.has(artifact.id))
        .flatMap((artifact) => artifact.taskIds),
    );
    const goalSatisfied =
      integratedArtifacts > 0 &&
      requiredTaskIds.every((taskId) => completedTaskIds.has(taskId)) &&
      eligibleArtifacts >=
        (this.config.goal?.success.minimumEligibleArtifacts ?? 1);
    return {
      tick: this.tick,
      fingerprint: sha256({
        eligibleArtifacts,
        integratedArtifacts,
        problems: [...this.problems.values()].map(({ id, status }) => ({
          id,
          status,
        })),
        tasks: [...this.taskProposals.values()].map(({ id, status }) => ({
          id,
          status,
        })),
        commitments: [...this.commitments.values()].map(({ id, status }) => ({
          id,
          status,
        })),
        artifacts: [...this.artifacts.values()].map(({ id, status }) => ({
          id,
          status,
        })),
      }),
      eligibleArtifacts,
      integratedArtifacts,
      goalSatisfied,
    };
  }

  async observe({
    agentId,
  }: {
    agentId: string;
  }): Promise<RepositoryObservation> {
    const agent = this.agent(agentId);
    const visible = new Set([agent.focusNodeId]);
    let frontier = [agent.focusNodeId];
    for (let depth = 0; depth < this.config.observationRadius; depth++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const edge of this.edges)
          if (edge.from === id || edge.to === id) {
            const neighbor = edge.from === id ? edge.to : edge.from;
            if (!visible.has(neighbor)) {
              visible.add(neighbor);
              next.push(neighbor);
            }
          }
      frontier = next.sort();
    }
    const nodePriority: Record<RepositoryNodeType, number> = {
      task: 0,
      problem: 0,
      task_proposal: 0,
      commitment: 1,
      verification: 2,
      file: 1,
      test: 1,
      facility: 2,
      module: 3,
      symbol: 4,
      pending_patch: 5,
      diagnostic: 6,
      accepted_artifact: 7,
    };
    const nodes = [...visible]
      .map((id) => this.nodes.get(id)!)
      .filter(Boolean)
      .sort(
        (a, b) =>
          nodePriority[a.type] - nodePriority[b.type] ||
          a.id.localeCompare(b.id),
      )
      .slice(0, this.config.observationLimit);
    const ids = new Set(nodes.map((node) => node.id));
    for (const id of ids) agent.observedNodes.add(id);
    const caps = capabilities(this.config.condition ?? "full");
    const ownedRecipes = await Promise.all(
      [...this.recipes.values()]
        .filter((recipe) => recipe.ownerId === agent.id)
        .map(async (recipe) => ({
          id: recipe.id,
          targets: [...recipe.targets],
          targetContentHashes: Object.fromEntries(
            await Promise.all(
              recipe.targets.map(async (path) => [
                path,
                sha256(
                  await readFile(resolve(recipe.worktree, path), "utf8").catch(
                    () => "",
                  ),
                ),
              ]),
            ),
          ),
          requiredFacilityIds: [...recipe.requiredFacilities],
          patchHash: recipe.patchHash,
          passedFacilityIds: [...recipe.checks.keys()].sort(),
          failedFacilityIds: [...agent.evidence]
            .map((id) => this.evidence.get(id))
            .filter(
              (evidence): evidence is Evidence =>
                evidence?.kind === "facility_result" &&
                evidence.data.patchHash === recipe.patchHash &&
                evidence.data.success === false &&
                typeof evidence.data.facilityId === "string",
            )
            .map((evidence) => evidence.data.facilityId as string)
            .filter((id, index, values) => values.indexOf(id) === index)
            .sort(),
        })),
    );
    return {
      revision: this.candidateCommit,
      focusNodeId: agent.focusNodeId,
      nodes: structuredClone(nodes),
      edges: this.edges
        .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
        .sort((a, b) =>
          `${a.from}:${a.type}:${a.to}`.localeCompare(
            `${b.from}:${b.type}:${b.to}`,
          ),
        ),
      ownedEvidenceIds: [...agent.evidence].sort(),
      inspectedNodeIds: [...agent.evidence]
        .map((id) => this.evidence.get(id))
        .filter(
          (evidence): evidence is Evidence =>
            evidence?.kind === "inspection" &&
            typeof evidence.data.nodeId === "string",
        )
        .map((evidence) => evidence.data.nodeId as string)
        .filter((id, index, values) => values.indexOf(id) === index)
        .sort(),
      ownedEvidence: [...agent.evidence]
        .map((id) => this.evidence.get(id))
        .filter((evidence): evidence is Evidence => evidence !== undefined)
        .slice(-6)
        .map((evidence) => ({
          id: evidence.id,
          kind: evidence.kind,
          digest: evidence.digest,
          data: this.boundedEvidenceData(evidence.data),
        })),
      ownedRecipeIds: [...this.recipes.values()]
        .filter((recipe) => recipe.ownerId === agent.id)
        .map((recipe) => recipe.id)
        .sort(),
      ownedRecipes: ownedRecipes.sort((a, b) => a.id.localeCompare(b.id)),
      ownedArtifactIds: [...this.artifacts.values()]
        .filter((artifact) => artifact.authorId === agent.id)
        .map((artifact) => artifact.id)
        .sort(),
      taskClaims: caps.taskClaims
        ? [...this.commitments.values()]
            .filter((commitment) => commitment.status === "active")
            .map(({ taskId, agentId }) => ({ taskId, agentId }))
            .sort((a, b) => a.taskId.localeCompare(b.taskId))
        : [],
      messages: caps.communication
        ? structuredClone(
            this.messages.filter((message) => message.recipientId === agent.id),
          )
        : [],
      findings: caps.publication ? structuredClone(this.findings) : [],
      inheritedArtifactIds: caps.crossAgentPrograms
        ? [...agent.inheritedArtifacts].sort()
        : [],
      ...(this.config.goal ? { goal: structuredClone(this.config.goal) } : {}),
      problems: structuredClone(
        [...this.problems.values()].sort((a, b) => a.id.localeCompare(b.id)),
      ),
      taskProposals: structuredClone(
        [...this.taskProposals.values()].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      ),
      commitments: structuredClone(
        [...this.commitments.values()].sort((a, b) => a.id.localeCompare(b.id)),
      ),
      candidates: [...this.artifacts.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((artifact) => ({
          artifactId: artifact.id,
          authorId: artifact.authorId,
          taskIds: [...artifact.taskIds],
          patchHash: artifact.patchHash,
          verificationFacilityIds: this.artifactVerifications(artifact.id)
            .filter((verification) => verification.success)
            .map((verification) => verification.facilityId)
            .sort(),
          verificationRequested: this.verificationRequests.has(artifact.id),
          eligible: this.artifactEligible(artifact),
        })),
      verifications: structuredClone(
        [...this.verifications.values()].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      ),
      attempts: structuredClone(
        [...this.attempts.values()].sort((a, b) => a.id.localeCompare(b.id)),
      ),
      societyRecords: this.society.snapshot(),
      ...(this.selection ? { selection: structuredClone(this.selection) } : {}),
      affordances: this.affordances(),
      budgets: {
        context: this.config.observationLimit,
        actions: agent.actionsRemaining,
        verification: agent.verificationRemaining,
        writes: agent.writesRemaining,
        ...(this.config.goal
          ? {
              globalActions: Math.max(
                0,
                this.config.goal.budget.maxActions - this.actionsUsed,
              ),
              globalVerification: Math.max(
                0,
                this.config.goal.budget.maxVerificationRuns -
                  this.verificationRunsUsed,
              ),
              globalWrites: Math.max(
                0,
                this.config.goal.budget.maxWrites - this.writesUsed,
              ),
              attempts: Math.max(
                0,
                this.config.goal.budget.maxAttempts - this.attempts.size,
              ),
            }
          : {}),
      },
    };
  }

  private boundedEvidenceData(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const content = data.content;
    if (typeof content !== "string" || content.length <= 30_000)
      return structuredClone(data);
    return {
      ...structuredClone(data),
      content: content.slice(0, 30_000),
      contentTruncated: true,
    };
  }

  async resolve({
    agentId,
    action,
  }: {
    agentId: string;
    action: RepositoryAction;
  }): Promise<EnvironmentResolution> {
    const agent = this.agent(agentId);
    if (
      this.config.goal &&
      this.actionsUsed >= this.config.goal.budget.maxActions
    )
      return this.reject(
        agentId,
        action.type,
        "global action budget exhausted",
      );
    if (agent.actionsRemaining <= 0)
      return this.reject(agentId, action.type, "budget exhausted");
    this.actionsUsed++;
    agent.actionsRemaining--;
    try {
      switch (action.type) {
        case "WAIT":
          return this.accept(agentId, action.type);
        case "FOCUS":
          if (
            !agent.observedNodes.has(action.nodeId) ||
            !this.edges.some(
              (edge) =>
                (edge.from === agent.focusNodeId &&
                  edge.to === action.nodeId) ||
                (edge.to === agent.focusNodeId && edge.from === action.nodeId),
            )
          )
            return this.reject(
              agentId,
              action.type,
              "focus target is not on a visible graph relationship",
            );
          agent.focusNodeId = action.nodeId;
          return this.accept(agentId, action.type, action.nodeId);
        case "INSPECT":
          return this.inspect(agent, action.nodeId);
        case "SEARCH":
          return this.search(agent, action.query, action.paths);
        case "CLAIM_TASK":
          if (
            !capabilities(this.config.condition ?? "full").taskClaims &&
            this.config.condition !== "independent"
          )
            return this.reject(
              agentId,
              action.type,
              "task claims disabled by treatment",
            );
          if (!this.taskById(action.taskId))
            return this.reject(agentId, action.type, "task unavailable");
          return this.createCommitment(
            agent,
            {
              taskId: action.taskId,
              approach: `default-${agent.id}`,
              roleLabel: "implementer",
              intendedContribution: "Implement and verify a candidate",
              exitCondition: "A candidate artifact is submitted",
              leaseTicks: 16,
            },
            action.type,
          );
        case "PROPOSE_PROBLEM":
          return this.proposeProblem(agent, action);
        case "CONFIRM_PROBLEM":
          return this.confirmProblem(
            agent,
            action.problemId,
            action.evidenceIds,
          );
        case "CHALLENGE_PROBLEM":
          return this.challengeProblem(agent, action);
        case "PROPOSE_TASK":
          return this.proposeTask(agent, action);
        case "DECOMPOSE_TASK":
          return this.decomposeTask(agent, action);
        case "CLAIM_COMMITMENT":
          return this.createCommitment(agent, action, action.type);
        case "JOIN_COMMITMENT":
          return this.joinCommitment(agent, action);
        case "RELEASE_COMMITMENT":
          return this.releaseCommitment(agent, action.commitmentId);
        case "COMMUNICATE":
          if (!capabilities(this.config.condition ?? "full").communication)
            return this.reject(
              agentId,
              action.type,
              "communication disabled by treatment",
            );
          if (!this.agents.has(action.recipientId))
            return this.reject(agentId, action.type, "recipient unavailable");
          this.messages.push({
            senderId: agent.id,
            recipientId: action.recipientId,
            text: action.text.slice(0, 2_000),
          });
          return this.accept(agentId, action.type, action.recipientId);
        case "TEACH_ARTIFACT": {
          if (!capabilities(this.config.condition ?? "full").teaching)
            return this.reject(
              agentId,
              action.type,
              "teaching disabled by treatment",
            );
          const artifact = this.artifacts.get(action.artifactId);
          const recipient = this.agents.get(action.recipientId);
          if (!artifact || !recipient || artifact.authorId !== agent.id)
            return this.reject(
              agentId,
              action.type,
              "artifact is not teachable",
            );
          recipient.inheritedArtifacts.add(artifact.id);
          return this.accept(agentId, action.type, recipient.id);
        }
        case "FORMULATE":
          return await this.formulate(agent, action);
        case "EDIT":
          return await this.edit(agent, action);
        case "EDIT_REPLACE": {
          const recipe = this.recipes.get(action.recipeId);
          if (
            !recipe ||
            recipe.ownerId !== agent.id ||
            !recipe.targets.includes(action.path)
          )
            return this.reject(agent.id, action.type, "patch unavailable");
          const current = await readFile(
            await this.safeWorktreePath(recipe.worktree, action.path),
            "utf8",
          );
          if (
            !action.oldText ||
            action.oldText === action.newText ||
            current.split(action.oldText).length !== 2
          )
            return this.reject(
              agent.id,
              action.type,
              "replacement must match exactly once",
            );
          return await this.edit(
            agent,
            {
              type: "EDIT",
              recipeId: action.recipeId,
              path: action.path,
              expectedContentHash: action.expectedContentHash,
              content: current.replace(action.oldText, action.newText),
            },
            "EDIT_REPLACE",
          );
        }
        case "RUN_CHECK":
          return await this.runCheck(agent, action.recipeId, action.facilityId);
        case "CONSTRUCT_ARTIFACT":
          return await this.constructArtifact(agent, action.recipeId);
        case "REQUEST_VERIFICATION": {
          const artifact = this.artifacts.get(action.artifactId);
          if (!artifact)
            return this.reject(agentId, action.type, "artifact unavailable");
          if (this.config.condition === "independent") {
            const requiredRuns = this.config.facilities.filter(
              (facility) =>
                facility.mandatory && facility.category !== "hidden",
            ).length;
            if (
              this.config.goal &&
              this.verificationRunsUsed + requiredRuns >
                this.config.goal.budget.maxVerificationRuns
            )
              return this.reject(
                agentId,
                action.type,
                "global verification budget exhausted",
              );
            this.verificationRequests.add(artifact.id);
            await this.verifyArtifactAsEngine(artifact);
          } else this.verificationRequests.add(artifact.id);
          return this.accept(agentId, action.type, artifact.id);
        }
        case "VERIFY_ARTIFACT":
          return await this.verifyArtifact(
            agent,
            action.artifactId,
            action.facilityId,
          );
        case "CHALLENGE_VERIFICATION":
          return this.challengeVerification(agent, action);
        case "RECOMMEND_CANDIDATE":
          return this.recommendCandidate(agent, action.artifactId);
        case "PUBLISH_FINDING":
          if (!capabilities(this.config.condition ?? "full").publication)
            return this.reject(
              agentId,
              action.type,
              "publication disabled by treatment",
            );
          if (!this.owns(agent, action.evidenceIds))
            return this.reject(
              agentId,
              action.type,
              "publication cites unowned evidence",
            );
          {
            const id = `finding_${sha256({ agentId, action }).slice(0, 16)}`;
            this.findings.push({
              id,
              authorId: agent.id,
              title: action.title,
              body: action.body,
              evidenceIds: [...action.evidenceIds],
            });
            return this.accept(agentId, action.type, id, action.evidenceIds);
          }
        case "REQUEST_INTEGRATION":
          if (!this.artifacts.has(action.artifactId))
            return this.reject(agentId, action.type, "artifact unavailable");
          if (!this.artifactEligible(this.artifacts.get(action.artifactId)!))
            return this.reject(
              agentId,
              action.type,
              "artifact lacks independent verification",
            );
          if (
            this.config.goal &&
            [...this.artifacts.values()].some(
              (artifact) => !this.artifactVerificationComplete(artifact),
            )
          )
            return this.reject(
              agentId,
              action.type,
              "candidate portfolio verification incomplete",
            );
          if (
            this.config.goal &&
            [...this.artifacts.values()].filter((artifact) =>
              this.artifactEligible(artifact),
            ).length < (this.config.goal.success.minimumEligibleArtifacts ?? 1)
          )
            return this.reject(
              agentId,
              action.type,
              "minimum eligible candidate portfolio not reached",
            );
          for (const artifact of this.artifacts.values())
            if (this.artifactEligible(artifact))
              this.integrationQueue.add(artifact.id);
          return this.accept(agentId, action.type, action.artifactId);
      }
    } catch (error) {
      return this.reject(
        agentId,
        action.type,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async advance(): Promise<void> {
    this.tick++;
    for (const commitment of this.commitments.values())
      if (
        commitment.status === "active" &&
        commitment.leaseExpiresAtTick <= this.tick
      ) {
        const expired = { ...commitment, status: "expired" as const };
        this.commitments.set(commitment.id, expired);
        this.society.append(
          this.tick,
          "commitment",
          expired.id,
          "commitment-expired",
          expired,
        );
        for (const attempt of this.attempts.values())
          if (
            attempt.commitmentId === commitment.id &&
            attempt.status === "active"
          ) {
            const expiredAttempt = {
              ...attempt,
              status: "expired" as const,
            };
            this.attempts.set(attempt.id, expiredAttempt);
            this.society.append(
              this.tick,
              "attempt",
              attempt.id,
              "attempt-expired",
              expiredAttempt,
            );
          }
        this.record(
          "commitment_expired",
          true,
          commitment.agentId,
          commitment.id,
          {
            taskId: commitment.taskId,
          },
        );
      }
    const eligible = [...this.integrationQueue]
      .map((id) => this.artifacts.get(id)!)
      .filter((artifact) => this.artifactEligible(artifact))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    if (!eligible.length) return;
    const artifact = this.selectCandidate(eligible);
    this.integrationQueue.clear();
    {
      try {
        const commitDate = await this.commitDate(artifact.commit);
        await run(
          "git",
          ["-C", this.candidateWorktree, "cherry-pick", artifact.commit],
          {
            env: {
              ...process.env,
              GIT_COMMITTER_NAME: "SwarmWorld Engine",
              GIT_COMMITTER_EMAIL: "engine@swarm-world.invalid",
              GIT_COMMITTER_DATE: commitDate,
            },
          },
        );
        this.candidateCommit = (
          await run(
            "git",
            ["-C", this.candidateWorktree, "rev-parse", "HEAD"],
            { encoding: "utf8" },
          )
        ).stdout.trim();
        this.integratedArtifactIds.add(artifact.id);
        artifact.status = "accepted";
        for (const candidate of eligible)
          if (candidate.id !== artifact.id) candidate.status = "superseded";
        await this.refreshContentIdentities();
        this.record("artifact_integrated", true, undefined, artifact.id, {
          candidateCommit: this.candidateCommit,
        });
      } catch (error) {
        await run("git", [
          "-C",
          this.candidateWorktree,
          "cherry-pick",
          "--abort",
        ]).catch(() => undefined);
        this.record("integration_conflict", false, undefined, artifact.id, {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async freeze(): Promise<RepositoryFrozenSnapshot> {
    return deepFreeze({
      candidateCommit: this.candidateCommit,
      baseCommit: this.baseCommit,
      graphHash: this.graphHash(),
      facilityPolicyHash: this.facilityPolicyHash(),
      traceHash: this.traceHash(),
      acceptedArtifacts: structuredClone(
        [...this.artifacts.values()]
          .filter((artifact) => this.integratedArtifactIds.has(artifact.id))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
      facilities: structuredClone(this.config.facilities),
      task: structuredClone(this.config.task),
      ...(this.config.goal ? { goal: structuredClone(this.config.goal) } : {}),
      ...(this.selection ? { selection: structuredClone(this.selection) } : {}),
      problems: structuredClone([...this.problems.values()]),
      taskProposals: structuredClone([...this.taskProposals.values()]),
      nodePaths: Object.fromEntries(
        [...this.nodes.values()].flatMap((node) =>
          node.path ? [[node.id, node.path]] : [],
        ),
      ),
      attempts: structuredClone([...this.attempts.values()]),
      societyRecords: this.society.snapshot(),
    });
  }

  async evaluate(
    frozen: RepositoryFrozenSnapshot,
  ): Promise<RepositoryEvaluation> {
    const checks: RepositoryEvaluation["checks"] = [];
    const parent = await mkdtemp(join(tmpdir(), "swarm-world-evaluation-"));
    const checkout = join(parent, "checkout");
    await run("git", [
      "-C",
      this.root,
      "worktree",
      "add",
      "--detach",
      checkout,
      frozen.candidateCommit,
    ]);
    try {
      for (const facility of frozen.facilities) {
        const result = await this.executeFacility(facility, checkout);
        checks.push({
          facilityId: facility.id,
          success: result.success,
          outputDigest: result.outputDigest,
          revision: frozen.candidateCommit,
          facilityPolicyHash: frozen.facilityPolicyHash,
          executionEnvironment: sha256({
            platform: process.platform,
            architecture: process.arch,
            node: process.version,
          }),
        });
      }
    } finally {
      await run("git", [
        "-C",
        this.root,
        "worktree",
        "remove",
        "--force",
        checkout,
      ]).catch(() => undefined);
    }
    const mandatory = frozen.facilities.filter(
      (facility) => facility.mandatory,
    );
    const hardGatesPassed = mandatory.every(
      (facility) =>
        checks.find((check) => check.facilityId === facility.id)?.success,
    );
    const hasArtifact =
      frozen.acceptedArtifacts.length > 0 &&
      frozen.candidateCommit !== frozen.baseCommit;
    const score = (categories: RepositoryFacility["category"][]) => {
      const selected = frozen.facilities.filter((facility) =>
        categories.includes(facility.category),
      );
      return selected.length
        ? selected.filter(
            (facility) =>
              checks.find((check) => check.facilityId === facility.id)?.success,
          ).length / selected.length
        : 0;
    };
    const gateScore = (ids: string[]) =>
      ids.filter(
        (id) => checks.find((check) => check.facilityId === id)?.success,
      ).length / ids.length;
    const frozenTaskById = (taskId: string): RepositoryTask | undefined =>
      taskId === frozen.task.id
        ? frozen.task
        : frozen.taskProposals.find((task) => task.id === taskId);
    // Only the operator-authored root task controls evaluation. Agent-authored
    // subtasks may narrow execution, but cannot select easier scoring gates.
    const correctness = gateScore(frozen.task.acceptanceFacilityIds);
    const regressionSafety = gateScore(frozen.task.regressionFacilityIds);
    const maintainability = score([
      "format",
      "build",
      "typecheck",
      "lint",
      "analysis",
    ]);
    const hidden = frozen.facilities.filter(
      (facility) => facility.category === "hidden",
    );
    const robustness = hidden.length ? score(["hidden"]) : 1;
    const issueCoverage = hasArtifact
      ? frozen.acceptedArtifacts.some((artifact) =>
          artifact.taskIds.some((taskId) => {
            const task = frozenTaskById(taskId);
            return (
              task !== undefined &&
              artifact.touchedNodes.some((nodeId) => {
                const path = frozen.nodePaths[nodeId];
                return path ? task.relevantPaths.includes(path) : false;
              })
            );
          }),
        )
        ? 1
        : 0
      : 0;
    const completionEligible =
      hardGatesPassed &&
      hasArtifact &&
      issueCoverage === 1 &&
      correctness === 1 &&
      regressionSafety === 1;
    return {
      outcome: completionEligible
        ? "completed"
        : hasArtifact
          ? "evaluation inconclusive"
          : "no eligible artifact",
      revision: frozen.candidateCommit,
      hardGatesPassed,
      checks,
      correctness,
      regressionSafety,
      issueCoverage,
      maintainability,
      robustness,
    };
  }

  async artifactPatch(frozen: RepositoryFrozenSnapshot): Promise<string> {
    if (frozen.candidateCommit === frozen.baseCommit) return "";
    return (
      await run(
        "git",
        [
          "-C",
          this.root,
          "diff",
          "--binary",
          frozen.baseCommit,
          frozen.candidateCommit,
        ],
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      )
    ).stdout;
  }

  async artifactMailbox(frozen: RepositoryFrozenSnapshot): Promise<string> {
    if (frozen.candidateCommit === frozen.baseCommit) return "";
    return (
      await run(
        "git",
        [
          "-C",
          this.root,
          "format-patch",
          "--stdout",
          "--binary",
          `${frozen.baseCommit}..${frozen.candidateCommit}`,
        ],
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      )
    ).stdout;
  }

  private async validateConfiguration(): Promise<void> {
    if (this.config.observationRadius < 0 || this.config.observationLimit < 1)
      throw new Error("Invalid observation policy");
    if (!this.config.allowedPaths.length)
      throw new Error("At least one allowed path is required");
    const ids = this.config.facilities.map((facility) => facility.id);
    if (new Set(ids).size !== ids.length)
      throw new Error("Facility IDs must be unique");
    const declaredTaskFacilities = [
      ...this.config.task.acceptanceFacilityIds,
      ...this.config.task.regressionFacilityIds,
    ];
    if (
      declaredTaskFacilities.some((id) => !ids.includes(id)) ||
      this.config.task.acceptanceFacilityIds.some(
        (id) =>
          !this.config.facilities.some(
            (facility) =>
              facility.id === id &&
              (facility.category === "test" || facility.category === "hidden"),
          ),
      )
    )
      throw new Error("Task gates must reference configured test facilities");
    if (
      this.config.facilities.some(
        (facility) => !isAbsolute(facility.executable),
      )
    )
      throw new Error("Facility executables must use fixed absolute paths");
    for (const facility of this.config.facilities) {
      const isNodeFacility =
        (await realpath(facility.executable)) ===
        (await realpath(process.execPath));
      if (
        isAbsolute(facility.workingDirectory) ||
        facility.workingDirectory.split(/[\\/]/).includes("..") ||
        !facility.permittedPaths.length ||
        facility.concurrency < 1 ||
        facility.timeoutMs < 1 ||
        facility.outputLimit < 1
      )
        throw new Error(`Invalid facility policy: ${facility.id}`);
      if (
        !isNodeFacility &&
        (!facility.sandbox || !isAbsolute(facility.sandbox.executable))
      )
        throw new Error(
          `Non-Node facility requires an absolute sandbox wrapper: ${facility.id}`,
        );
      this.facilityExecutableHashes.set(
        facility.id,
        sha256((await readFile(facility.executable)).toString("base64")),
      );
      if (facility.sandbox)
        this.facilitySandboxHashes.set(
          facility.id,
          sha256(
            (await readFile(facility.sandbox.executable)).toString("base64"),
          ),
        );
    }
    const status = (
      await run(
        "git",
        ["-C", this.root, "status", "--porcelain=v1", "--untracked-files=all"],
        { encoding: "utf8" },
      )
    ).stdout;
    const unsafeDirty = status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3))
      .filter((path) => !this.excluded(path));
    if (!(this.config.readOnly ?? true) && unsafeDirty.length)
      throw new Error("Writable repository runs require a clean base checkout");
  }

  private async buildGraph(): Promise<void> {
    const tracked = (
      await run(
        "git",
        ["-C", this.root, "ls-tree", "-r", "--name-only", this.baseCommit],
        { encoding: "utf8" },
      )
    ).stdout
      .split("\n")
      .filter((path) => path && this.permitted(path));
    const taskNode = this.node(
      "task",
      this.config.task.id,
      this.config.task.title,
    );
    const modules = new Map<string, RepositoryNode>();
    const files = new Map<string, RepositoryNode>();
    for (const path of tracked.sort()) {
      const content = await this.gitShow(this.baseCommit, path);
      const type: RepositoryNodeType =
        /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/.test(path)
          ? "test"
          : "file";
      const file = this.node(type, path, basename(path), path, sha256(content));
      files.set(path, file);
      const modulePath = dirname(path) === "." ? "." : dirname(path);
      let module = modules.get(modulePath);
      if (!module) {
        module = this.node("module", modulePath, modulePath);
        modules.set(modulePath, module);
      }
      this.edge(module.id, file.id, "containment");
      if (this.config.task.relevantPaths.includes(path))
        this.edge(taskNode.id, file.id, "task_relevance");
      for (const match of content.matchAll(
        /(?:export\s+)?(?:const|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/g,
      )) {
        const symbol = this.node(
          "symbol",
          `${path}#${match[1]}`,
          match[1]!,
          path,
          sha256(`${file.contentHash}:${match[1]}`),
        );
        this.edge(file.id, symbol.id, "containment");
      }
    }
    for (const path of this.config.task.relevantPaths
      .filter((path) => this.permitted(path) && !files.has(path))
      .sort()) {
      const type: RepositoryNodeType = /\.(test|spec)\.[^.]+$/.test(path)
        ? "test"
        : "file";
      const file = this.node(type, path, basename(path), path, sha256(""));
      files.set(path, file);
      const modulePath = dirname(path) === "." ? "." : dirname(path);
      let module = modules.get(modulePath);
      if (!module) {
        module = this.node("module", modulePath, modulePath);
        modules.set(modulePath, module);
      }
      this.edge(module.id, file.id, "containment");
      this.edge(taskNode.id, file.id, "task_relevance");
    }
    for (const [path, source] of files) {
      const content = await this.gitShow(this.baseCommit, path).catch(() => "");
      for (const match of content.matchAll(
        /(?:from\s+|import\s*\()?["'](\.[^"']+)["']/g,
      )) {
        const target = this.resolveImport(path, match[1]!, files);
        if (target) {
          this.edge(source.id, target.id, "import");
          if (source.type === "test")
            this.edge(source.id, target.id, "test_relation");
        }
      }
    }
    for (const facility of this.config.facilities)
      if (facility.category !== "hidden") {
        const node = this.node("facility", facility.id, facility.id);
        this.edge(taskNode.id, node.id, "task_relevance");
      }
  }

  private resolveImport(
    from: string,
    specifier: string,
    files: Map<string, RepositoryNode>,
  ): RepositoryNode | undefined {
    const base = resolve("/", dirname(from), specifier)
      .slice(1)
      .replace(/\.js$/, "");
    return (
      files.get(base) ??
      files.get(`${base}.ts`) ??
      files.get(`${base}.tsx`) ??
      files.get(`${base}/index.ts`)
    );
  }

  private async inspect(
    agent: RepositoryAgent,
    nodeId: string,
  ): Promise<EnvironmentResolution> {
    const node = this.nodes.get(nodeId);
    if (!node || !agent.observedNodes.has(nodeId))
      return this.reject(agent.id, "INSPECT", "node not observed");
    const content = node.path
      ? await this.gitShow(this.candidateCommit, node.path).catch((error) => {
          if (node.contentHash === sha256("")) return "";
          throw error;
        })
      : JSON.stringify(node);
    const evidence = this.makeEvidence(
      agent.id,
      "inspection",
      this.candidateCommit,
      { nodeId, content },
      sha256(content),
    );
    return this.accept(agent.id, "INSPECT", nodeId, [evidence.id]);
  }

  private async search(
    agent: RepositoryAgent,
    query: string,
    paths?: string[],
  ): Promise<EnvironmentResolution> {
    if (!query || query.length > 256)
      return this.reject(agent.id, "SEARCH", "invalid search query");
    const requested = paths?.length
      ? paths
      : [...this.nodes.values()].flatMap((node) =>
          node.path ? [node.path] : [],
        );
    const results: Array<{ path: string; line: number; text: string }> = [];
    for (const path of unique(requested)
      .filter((path) => this.permitted(path))
      .sort()) {
      const content = await this.gitShow(this.candidateCommit, path).catch(
        () => "",
      );
      content.split("\n").forEach((text, index) => {
        if (
          results.length < this.config.observationLimit &&
          text.includes(query)
        )
          results.push({ path, line: index + 1, text });
      });
    }
    for (const result of results)
      for (const node of this.nodes.values())
        if (node.path === result.path) agent.observedNodes.add(node.id);
    const evidence = this.makeEvidence(
      agent.id,
      "search",
      this.candidateCommit,
      { query, results },
      sha256(results),
    );
    return this.accept(agent.id, "SEARCH", undefined, [evidence.id]);
  }

  private async formulate(
    agent: RepositoryAgent,
    action: Extract<RepositoryAction, { type: "FORMULATE" }>,
  ): Promise<EnvironmentResolution> {
    if (this.config.readOnly ?? true)
      return this.reject(agent.id, action.type, "permission blocked");
    const task = this.taskById(action.taskId);
    if (!task || !this.owns(agent, action.evidenceIds))
      return this.reject(
        agent.id,
        action.type,
        "recipe cites unavailable task or evidence",
      );
    const commitment = [...this.commitments.values()].find(
      (candidate) =>
        candidate.agentId === agent.id &&
        candidate.taskId === action.taskId &&
        candidate.status === "active",
    );
    if (this.config.goal && !commitment)
      return this.reject(
        agent.id,
        action.type,
        "an active task commitment is required",
      );
    if (
      this.config.goal &&
      this.attempts.size >= this.config.goal.budget.maxAttempts
    )
      return this.reject(agent.id, action.type, "attempt budget exhausted");
    if (
      action.targets.some((path) => !this.permitted(path)) ||
      action.targets.some((path) => !task.relevantPaths.includes(path)) ||
      action.targets.some(
        (path) =>
          ![...agent.observedNodes].some(
            (nodeId) => this.nodes.get(nodeId)?.path === path,
          ),
      ) ||
      action.targets.length > this.config.patch.maxFiles
    )
      return this.reject(
        agent.id,
        action.type,
        "path or file-count policy rejected recipe",
      );
    if (
      action.requiredFacilities.some(
        (id) =>
          !this.config.facilities.some(
            (facility) => facility.id === id && facility.category !== "hidden",
          ),
      )
    )
      return this.reject(
        agent.id,
        action.type,
        "recipe cites unavailable facility",
      );
    const id = `patch_${sha256({ owner: agent.id, action, base: this.candidateCommit }).slice(0, 20)}`;
    const parent = await mkdtemp(join(tmpdir(), "swarm-world-patch-"));
    const worktree = join(parent, "checkout");
    await run("git", [
      "-C",
      this.root,
      "worktree",
      "add",
      "--detach",
      worktree,
      this.candidateCommit,
    ]);
    const attemptData = commitment
      ? {
          commitmentId: commitment.id,
          agentId: agent.id,
          taskId: action.taskId,
          approach: commitment.approach,
          createdAtTick: this.tick,
        }
      : undefined;
    const attempt: RepositoryAttempt | undefined = attemptData
      ? {
          id: `attempt_${sha256(attemptData).slice(0, 20)}`,
          ...attemptData,
          status: "active",
        }
      : undefined;
    if (attempt) {
      this.attempts.set(attempt.id, attempt);
      this.society.append(
        this.tick,
        "attempt",
        attempt.id,
        "attempt-started",
        attempt,
      );
    }
    this.recipes.set(id, {
      id,
      ownerId: agent.id,
      taskId: action.taskId,
      ...(attempt ? { attemptId: attempt.id } : {}),
      evidenceIds: [...action.evidenceIds],
      targets: unique(action.targets).sort(),
      requiredFacilities: unique(action.requiredFacilities).sort(),
      worktree,
      baseCommit: this.candidateCommit,
      patchHash: sha256(""),
      checks: new Map(),
    });
    this.node("pending_patch", id, id);
    return this.accept(agent.id, action.type, id);
  }

  private async edit(
    agent: RepositoryAgent,
    action: Extract<RepositoryAction, { type: "EDIT" }>,
    actionType: "EDIT" | "EDIT_REPLACE" = "EDIT",
  ): Promise<EnvironmentResolution> {
    if (this.config.readOnly ?? true)
      return this.reject(agent.id, actionType, "permission blocked");
    const recipe = this.recipes.get(action.recipeId);
    if (
      !recipe ||
      recipe.ownerId !== agent.id ||
      recipe.invalid ||
      !recipe.targets.includes(action.path)
    )
      return this.reject(agent.id, actionType, "patch or target unavailable");
    const target = await this.safeWorktreePath(recipe.worktree, action.path);
    const current = await readFile(target, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return "";
      throw error;
    });
    if (sha256(current) !== action.expectedContentHash)
      return this.reject(agent.id, actionType, "stale content precondition");
    await writeFile(target, action.content, "utf8");
    const stats = await this.diffStats(recipe.worktree);
    if (
      stats.files > this.config.patch.maxFiles ||
      stats.lines > this.config.patch.maxChangedLines ||
      stats.lines > agent.writesRemaining ||
      (this.config.goal !== undefined &&
        this.writesUsed + stats.lines > this.config.goal.budget.maxWrites)
    ) {
      await writeFile(target, current, "utf8");
      return this.reject(agent.id, actionType, "patch budget exceeded");
    }
    this.writesUsed += stats.lines;
    agent.writesRemaining = this.config.patch.maxChangedLines - stats.lines;
    recipe.patchHash = await this.patchHash(recipe.worktree);
    recipe.checks.clear();
    const evidence = this.makeEvidence(
      agent.id,
      "structured_patch",
      recipe.patchHash,
      { path: action.path, patchHash: recipe.patchHash },
      sha256(action.content),
    );
    return this.accept(agent.id, actionType, recipe.id, [evidence.id]);
  }

  private async runCheck(
    agent: RepositoryAgent,
    recipeId: string,
    facilityId: string,
  ): Promise<EnvironmentResolution> {
    const recipe = this.recipes.get(recipeId);
    const facility = this.config.facilities.find(
      (candidate) => candidate.id === facilityId,
    );
    if (!recipe || recipe.ownerId !== agent.id || !facility)
      return this.reject(
        agent.id,
        "RUN_CHECK",
        "patch or facility unavailable",
      );
    if (facility.category === "hidden")
      return this.reject(
        agent.id,
        "RUN_CHECK",
        "hidden evaluation facilities are unavailable during discovery",
      );
    if (
      recipe.targets.some(
        (path) =>
          !facility.permittedPaths.some((pattern) => glob(pattern, path)),
      )
    )
      return this.reject(
        agent.id,
        "RUN_CHECK",
        "patch targets are outside facility path scope",
      );
    if ((this.facilityActive.get(facility.id) ?? 0) >= facility.concurrency)
      return this.reject(agent.id, "RUN_CHECK", "facility capacity exhausted");
    if (agent.verificationRemaining <= 0)
      return this.reject(agent.id, "RUN_CHECK", "budget exhausted");
    if (
      this.config.goal &&
      this.verificationRunsUsed >= this.config.goal.budget.maxVerificationRuns
    )
      return this.reject(
        agent.id,
        "RUN_CHECK",
        "global verification budget exhausted",
      );
    agent.verificationRemaining--;
    this.verificationRunsUsed++;
    this.facilityActive.set(
      facility.id,
      (this.facilityActive.get(facility.id) ?? 0) + 1,
    );
    let treeHash: string;
    let result: Awaited<ReturnType<RepositoryEnvironment["executeFacility"]>>;
    try {
      const changed = await this.changedPaths(recipe.worktree);
      if (!changed.length) throw new Error("patch is empty");
      await run("git", ["-C", recipe.worktree, "add", "--", ...changed]);
      treeHash = (
        await run("git", ["-C", recipe.worktree, "write-tree"], {
          encoding: "utf8",
        })
      ).stdout.trim();
      result = await this.executeFacility(facility, recipe.worktree);
      const recipeTask = this.taskById(recipe.taskId)!;
      const unauthorized = (await this.changedPaths(recipe.worktree)).filter(
        (path) =>
          !recipe.targets.includes(path) ||
          !recipeTask.relevantPaths.includes(path) ||
          !this.permitted(path),
      );
      if (unauthorized.length) {
        recipe.invalid = true;
        const output =
          `${result.output}\nFacility changed unauthorized paths`.slice(
            0,
            facility.outputLimit,
          );
        result = {
          success: false,
          exitCode: 126,
          output,
          outputDigest: sha256(output),
        };
      }
    } finally {
      this.facilityActive.set(
        facility.id,
        (this.facilityActive.get(facility.id) ?? 1) - 1,
      );
    }
    const evidence = this.makeEvidence(
      agent.id,
      "facility_result",
      treeHash,
      {
        facilityId,
        patchHash: recipe.patchHash,
        baseCommit: recipe.baseCommit,
        treeHash,
        facilityPolicyHash: this.facilityPolicyHash(),
        executionEnvironment: {
          platform: process.platform,
          architecture: process.arch,
          node: process.version,
        },
        eventSequence: this.trace.length,
        ...result,
      },
      result.outputDigest,
    );
    this.trace.appendFacilityCompleted(agent.id, evidence.id, {
      facilityId,
      success: result.success,
      exitCode: result.exitCode,
      outputDigest: result.outputDigest,
      output: result.output,
    });
    if (result.success) recipe.checks.set(facilityId, evidence.id);
    else {
      const diagnostic = this.node(
        "diagnostic",
        evidence.id,
        `${facility.id} failed`,
        undefined,
        result.outputDigest,
      );
      this.edge(recipe.id, diagnostic.id, "containment");
    }
    const resolution = result.success
      ? this.accept(agent.id, "RUN_CHECK", facilityId, [evidence.id])
      : this.reject(agent.id, "RUN_CHECK", "configured check failed", [
          evidence.id,
        ]);
    return resolution;
  }

  private async constructArtifact(
    agent: RepositoryAgent,
    recipeId: string,
  ): Promise<EnvironmentResolution> {
    const recipe = this.recipes.get(recipeId);
    if (!recipe || recipe.ownerId !== agent.id || recipe.invalid)
      return this.reject(agent.id, "CONSTRUCT_ARTIFACT", "patch unavailable");
    const currentHash = await this.patchHash(recipe.worktree);
    if (currentHash === sha256("") || currentHash !== recipe.patchHash)
      return this.reject(
        agent.id,
        "CONSTRUCT_ARTIFACT",
        "patch identity changed or is empty",
      );
    const mandatory = this.config.facilities
      .filter(
        (facility) => facility.mandatory && facility.category !== "hidden",
      )
      .map((facility) => facility.id);
    if (
      mandatory.some((id) => !recipe.checks.has(id)) ||
      recipe.requiredFacilities.some((id) => !recipe.checks.has(id))
    )
      return this.reject(
        agent.id,
        "CONSTRUCT_ARTIFACT",
        "mandatory checks are missing or stale",
      );
    const changed = await this.changedPaths(recipe.worktree);
    const recipeTask = this.taskById(recipe.taskId)!;
    if (
      changed.some(
        (path) =>
          !recipe.targets.includes(path) ||
          !recipeTask.relevantPaths.includes(path) ||
          !this.permitted(path),
      )
    )
      return this.reject(
        agent.id,
        "CONSTRUCT_ARTIFACT",
        "artifact contains unauthorized paths",
      );
    const artifactStats = await this.diffStats(recipe.worktree);
    await run("git", ["-C", recipe.worktree, "add", "--", ...changed]);
    const commitDate = await this.commitDate(recipe.baseCommit);
    await run(
      "git",
      ["-C", recipe.worktree, "commit", "-m", `Fix ${recipe.taskId}`],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: agent.id,
          GIT_AUTHOR_EMAIL: `${agent.id}@swarm-world.invalid`,
          GIT_AUTHOR_DATE: commitDate,
          GIT_COMMITTER_NAME: "SwarmWorld Engine",
          GIT_COMMITTER_EMAIL: "engine@swarm-world.invalid",
          GIT_COMMITTER_DATE: commitDate,
        },
      },
    );
    const commit = (
      await run("git", ["-C", recipe.worktree, "rev-parse", "HEAD"], {
        encoding: "utf8",
      })
    ).stdout.trim();
    const touchedNodes = recipe.targets
      .map(
        (path) =>
          [...this.nodes.values()].find((node) => node.path === path)?.id,
      )
      .filter((id): id is string => Boolean(id));
    const evidenceIds = unique([
      ...recipe.evidenceIds,
      ...recipe.checks.values(),
    ]).sort();
    const commitment = [...this.commitments.values()].find(
      (candidate) =>
        candidate.agentId === agent.id &&
        candidate.taskId === recipe.taskId &&
        candidate.status === "active",
    );
    const artifactData = {
      commit,
      baseCommit: recipe.baseCommit,
      parentArtifacts: [...this.artifacts.values()]
        .filter((artifact) => artifact.commit === recipe.baseCommit)
        .map((artifact) => artifact.id)
        .sort(),
      authorId: agent.id,
      contributors: [agent.id],
      taskIds: this.taskLineage(recipe.taskId),
      touchedNodes,
      patchHash: recipe.patchHash,
      evidenceIds,
      priority: recipeTask.priority,
      ...(commitment
        ? {
            approach: commitment.approach,
            hypothesis: commitment.intendedContribution,
          }
        : {}),
      changedLines: artifactStats.lines,
      status: "submitted" as const,
    };
    const artifact: RepositoryArtifact = {
      id: `artifact_${sha256(artifactData).slice(0, 24)}`,
      ...artifactData,
    };
    this.artifacts.set(artifact.id, artifact);
    for (const commitment of this.commitments.values())
      if (
        commitment.agentId === agent.id &&
        commitment.taskId === recipe.taskId &&
        commitment.status === "active"
      ) {
        const completed = { ...commitment, status: "completed" as const };
        this.commitments.set(commitment.id, completed);
        this.society.append(
          this.tick,
          "commitment",
          commitment.id,
          "commitment-completed",
          completed,
        );
      }
    if (recipe.attemptId) {
      const attempt = this.attempts.get(recipe.attemptId);
      if (attempt) {
        const submitted = {
          ...attempt,
          status: "submitted" as const,
          artifactId: artifact.id,
        };
        this.attempts.set(attempt.id, submitted);
        this.society.append(
          this.tick,
          "attempt",
          attempt.id,
          "attempt-submitted",
          submitted,
        );
      }
    }
    const node = this.node(
      "accepted_artifact",
      artifact.id,
      artifact.id,
      undefined,
      artifact.patchHash,
    );
    for (const parent of artifact.parentArtifacts)
      this.edge(node.id, parent, "artifact_ancestry");
    return this.accept(
      agent.id,
      "CONSTRUCT_ARTIFACT",
      artifact.id,
      evidenceIds,
    );
  }

  private taskById(id: string): RepositoryTask | undefined {
    if (id === this.config.task.id) return this.config.task;
    const proposal = this.taskProposals.get(id);
    return proposal?.status === "admitted" ? proposal : undefined;
  }

  private taskLineage(taskId: string, seen = new Set<string>()): string[] {
    if (seen.has(taskId)) return [];
    seen.add(taskId);
    if (taskId === this.config.task.id) return [taskId];
    const proposal = this.taskProposals.get(taskId);
    if (!proposal) return [taskId];
    return unique([
      taskId,
      ...proposal.dependencies.flatMap((dependency) =>
        this.taskLineage(dependency, seen),
      ),
    ]).sort();
  }

  private proposeProblem(
    agent: RepositoryAgent,
    action: Extract<RepositoryAction, { type: "PROPOSE_PROBLEM" }>,
  ): EnvironmentResolution {
    if (!this.config.goal || action.goalId !== this.config.goal.id)
      return this.reject(agent.id, action.type, "problem is off-goal");
    if (
      !this.owns(agent, action.evidenceIds) ||
      !action.statement.trim() ||
      !action.goalImpact.trim()
    )
      return this.reject(
        agent.id,
        action.type,
        "problem requires owned evidence",
      );
    const id = `problem_${sha256({ goalId: action.goalId, statement: action.statement, evidenceIds: [...action.evidenceIds].sort() }).slice(0, 20)}`;
    if (this.problems.has(id))
      return this.reject(agent.id, action.type, "duplicate problem");
    const problem: RepositoryProblem = {
      id,
      goalId: action.goalId,
      authorAgentId: agent.id,
      statement: action.statement,
      evidenceIds: [...action.evidenceIds],
      goalImpact: action.goalImpact,
      status: "proposed",
      confirmations: [],
      challenges: [],
    };
    this.problems.set(id, problem);
    this.society.append(this.tick, "problem", id, "problem-proposed", problem);
    const node = this.node("problem", id, action.statement.slice(0, 120));
    this.edge(this.taskNodeId(), node.id, "task_relevance");
    return this.accept(agent.id, action.type, id, action.evidenceIds);
  }

  private confirmProblem(
    agent: RepositoryAgent,
    problemId: string,
    evidenceIds: string[],
  ): EnvironmentResolution {
    const problem = this.problems.get(problemId);
    if (!problem || problem.authorAgentId === agent.id)
      return this.reject(
        agent.id,
        "CONFIRM_PROBLEM",
        "independent confirmation required",
      );
    if (!this.owns(agent, evidenceIds))
      return this.reject(
        agent.id,
        "CONFIRM_PROBLEM",
        "confirmation requires owned evidence",
      );
    const confirmed = {
      ...problem,
      confirmations: problem.confirmations.includes(agent.id)
        ? [...problem.confirmations]
        : [...problem.confirmations, agent.id],
      status: "confirmed" as const,
    };
    this.problems.set(problemId, confirmed);
    this.society.append(
      this.tick,
      "problem",
      problemId,
      "problem-confirmed",
      confirmed,
    );
    return this.accept(agent.id, "CONFIRM_PROBLEM", problemId, evidenceIds);
  }

  private challengeProblem(
    agent: RepositoryAgent,
    action: Extract<RepositoryAction, { type: "CHALLENGE_PROBLEM" }>,
  ): EnvironmentResolution {
    const problem = this.problems.get(action.problemId);
    if (!problem || !this.owns(agent, action.evidenceIds))
      return this.reject(
        agent.id,
        action.type,
        "challenge requires a problem and owned evidence",
      );
    const challenged = {
      ...problem,
      challenges: [
        ...problem.challenges,
        {
          agentId: agent.id,
          evidenceIds: [...action.evidenceIds],
          reason: action.reason,
        },
      ],
      status: "challenged" as const,
    };
    this.problems.set(problem.id, challenged);
    this.society.append(
      this.tick,
      "problem",
      problem.id,
      "problem-challenged",
      challenged,
    );
    return this.accept(agent.id, action.type, problem.id, action.evidenceIds);
  }

  private proposeTask(
    agent: RepositoryAgent,
    action: Extract<RepositoryAction, { type: "PROPOSE_TASK" }>,
  ): EnvironmentResolution {
    const problem = this.problems.get(action.problemId);
    const facilities = new Set(
      this.config.facilities.map((facility) => facility.id),
    );
    const requiredVerificationRuns = new Set([
      ...this.config.task.acceptanceFacilityIds,
      ...this.config.task.regressionFacilityIds,
      ...this.config.facilities
        .filter(
          (facility) => facility.mandatory && facility.category !== "hidden",
        )
        .map((facility) => facility.id),
    ]).size;
    if (
      !this.config.goal ||
      action.goalId !== this.config.goal.id ||
      !problem ||
      problem.goalId !== action.goalId ||
      problem.status !== "confirmed"
    )
      return this.reject(
        agent.id,
        action.type,
        "task requires a confirmed problem",
      );
    if (
      !action.relevantPaths.length ||
      !action.objective.trim() ||
      !action.expectedOutcome.trim() ||
      !action.acceptanceCriteria.length ||
      !action.acceptanceFacilityIds.length ||
      !action.regressionFacilityIds.length ||
      !action.verificationPlan.length ||
      action.estimatedCost < 1 ||
      action.estimatedCost > agent.writesRemaining ||
      action.estimatedCost >
        this.config.goal.budget.maxActions - this.actionsUsed ||
      action.estimatedCost >
        this.config.goal.budget.maxWrites - this.writesUsed ||
      this.attempts.size >= this.config.goal.budget.maxAttempts ||
      requiredVerificationRuns >
        this.config.goal.budget.maxVerificationRuns -
          this.verificationRunsUsed ||
      action.relevantPaths.some((path) => !this.permitted(path)) ||
      action.relevantPaths.some(
        (path) => !this.config.task.relevantPaths.includes(path),
      ) ||
      !sameMembers(
        action.acceptanceFacilityIds,
        this.config.task.acceptanceFacilityIds,
      ) ||
      !sameMembers(
        action.regressionFacilityIds,
        this.config.task.regressionFacilityIds,
      ) ||
      action.dependencies.some((id) => !this.taskById(id)) ||
      [...action.acceptanceFacilityIds, ...action.regressionFacilityIds].some(
        (id) => !facilities.has(id),
      ) ||
      action.acceptanceFacilityIds.some(
        (id) =>
          !this.config.facilities.some(
            (facility) =>
              facility.id === id &&
              (facility.category === "test" || facility.category === "hidden"),
          ),
      )
    )
      return this.reject(
        agent.id,
        action.type,
        "task admission policy rejected proposal",
      );
    const fingerprint = sha256({
      objective: action.objective.trim().toLowerCase(),
      paths: [...action.relevantPaths].sort(),
    });
    if (
      [...this.taskProposals.values()].some(
        (task) =>
          sha256({
            objective: task.objective.trim().toLowerCase(),
            paths: [...task.relevantPaths].sort(),
          }) === fingerprint,
      )
    )
      return this.reject(agent.id, action.type, "duplicate task proposal");
    const id = `task_${fingerprint.slice(0, 20)}`;
    const task: RepositoryTaskProposal = {
      id,
      goalId: action.goalId,
      problemId: problem.id,
      authorAgentId: agent.id,
      title: action.objective,
      objective: action.objective,
      expectedOutcome: action.expectedOutcome,
      acceptanceCriteria: [...action.acceptanceCriteria],
      acceptanceFacilityIds: [...action.acceptanceFacilityIds],
      regressionFacilityIds: [...action.regressionFacilityIds],
      relevantPaths: unique(action.relevantPaths).sort(),
      dependencies: unique([
        this.config.task.id,
        ...action.dependencies,
      ]).sort(),
      verificationPlan: [...action.verificationPlan],
      estimatedCost: action.estimatedCost,
      priority: this.taskProposals.size + 1,
      status: "admitted",
    };
    this.taskProposals.set(id, task);
    this.society.append(this.tick, "task", id, "task-admitted", task);
    const node = this.node("task_proposal", id, task.title);
    this.edge(
      this.nodeIdForStableKey("problem", problem.id),
      node.id,
      "task_relevance",
    );
    for (const path of task.relevantPaths) {
      const file = [...this.nodes.values()].find(
        (candidate) => candidate.path === path,
      );
      if (file) this.edge(node.id, file.id, "task_relevance");
    }
    return this.accept(agent.id, action.type, id);
  }

  private decomposeTask(
    agent: RepositoryAgent,
    action: Extract<RepositoryAction, { type: "DECOMPOSE_TASK" }>,
  ): EnvironmentResolution {
    const parent = this.taskById(action.taskId);
    if (
      !parent ||
      action.relevantPaths.some((path) => !parent.relevantPaths.includes(path))
    )
      return this.reject(
        agent.id,
        action.type,
        "decomposition exceeds parent task scope",
      );
    const source = this.taskProposals.get(parent.id);
    const problemId = source?.problemId ?? `seed_${parent.id}`;
    if (!this.problems.has(problemId))
      this.problems.set(problemId, {
        id: problemId,
        goalId: this.config.goal?.id ?? `legacy-${parent.id}`,
        authorAgentId: "operator",
        statement: parent.title,
        evidenceIds: [],
        goalImpact: "Operator-seeded task",
        status: "confirmed",
        confirmations: ["operator"],
        challenges: [],
      });
    return this.proposeTask(agent, {
      type: "PROPOSE_TASK",
      goalId: this.config.goal?.id ?? `legacy-${parent.id}`,
      problemId,
      objective: action.objective,
      expectedOutcome: action.objective,
      relevantPaths: action.relevantPaths,
      acceptanceCriteria: parent.acceptanceCriteria,
      acceptanceFacilityIds: parent.acceptanceFacilityIds,
      regressionFacilityIds: parent.regressionFacilityIds,
      dependencies: [parent.id],
      verificationPlan: action.verificationPlan,
      estimatedCost: action.estimatedCost,
    });
  }

  private createCommitment(
    agent: RepositoryAgent,
    action: {
      taskId: string;
      approach: string;
      roleLabel: string;
      intendedContribution: string;
      exitCondition: string;
      leaseTicks: number;
    },
    actionType: "CLAIM_TASK" | "CLAIM_COMMITMENT",
  ): EnvironmentResolution {
    if (
      !this.taskById(action.taskId) ||
      action.leaseTicks < 1 ||
      action.leaseTicks > 128
    )
      return this.reject(agent.id, actionType, "invalid commitment");
    const active = [...this.commitments.values()].filter(
      (commitment) => commitment.status === "active",
    );
    if (
      active.some(
        (commitment) =>
          commitment.agentId === agent.id &&
          commitment.taskId === action.taskId,
      )
    )
      return this.reject(
        agent.id,
        actionType,
        "agent already committed to task",
      );
    if (
      active.some(
        (commitment) =>
          commitment.taskId === action.taskId &&
          commitment.approach.trim().toLowerCase() ===
            action.approach.trim().toLowerCase(),
      )
    )
      return this.reject(agent.id, actionType, "duplicate active approach");
    const data = {
      agentId: agent.id,
      taskId: action.taskId,
      approach: action.approach,
      roleLabel: action.roleLabel,
      intendedContribution: action.intendedContribution,
      exitCondition: action.exitCondition,
      createdAtTick: this.tick,
      leaseExpiresAtTick: this.tick + action.leaseTicks,
    };
    const commitment: RepositoryCommitment = {
      id: `commitment_${sha256(data).slice(0, 20)}`,
      ...data,
      status: "active",
    };
    this.commitments.set(commitment.id, commitment);
    this.society.append(
      this.tick,
      "commitment",
      commitment.id,
      "commitment-created",
      commitment,
    );
    const node = this.node("commitment", commitment.id, commitment.roleLabel);
    this.edge(this.taskNodeFor(commitment.taskId), node.id, "ownership");
    return this.accept(agent.id, actionType, commitment.id);
  }

  private joinCommitment(
    agent: RepositoryAgent,
    action: Extract<RepositoryAction, { type: "JOIN_COMMITMENT" }>,
  ): EnvironmentResolution {
    const parent = this.commitments.get(action.commitmentId);
    if (!parent || parent.status !== "active" || parent.agentId === agent.id)
      return this.reject(agent.id, action.type, "commitment unavailable");
    return this.createCommitment(
      agent,
      {
        taskId: parent.taskId,
        approach: `${parent.approach}/support/${agent.id}`,
        roleLabel: action.roleLabel,
        intendedContribution: `Support ${parent.id}`,
        exitCondition: parent.exitCondition,
        leaseTicks: action.leaseTicks,
      },
      "CLAIM_COMMITMENT",
    );
  }

  private releaseCommitment(
    agent: RepositoryAgent,
    id: string,
  ): EnvironmentResolution {
    const commitment = this.commitments.get(id);
    if (
      !commitment ||
      commitment.agentId !== agent.id ||
      commitment.status !== "active"
    )
      return this.reject(
        agent.id,
        "RELEASE_COMMITMENT",
        "commitment unavailable",
      );
    const released = { ...commitment, status: "released" as const };
    this.commitments.set(id, released);
    this.society.append(
      this.tick,
      "commitment",
      id,
      "commitment-released",
      released,
    );
    for (const attempt of this.attempts.values())
      if (attempt.commitmentId === id && attempt.status === "active") {
        const abandoned = { ...attempt, status: "abandoned" as const };
        this.attempts.set(attempt.id, abandoned);
        this.society.append(
          this.tick,
          "attempt",
          attempt.id,
          "attempt-abandoned",
          abandoned,
        );
      }
    return this.accept(agent.id, "RELEASE_COMMITMENT", id);
  }

  private async verifyArtifact(
    agent: RepositoryAgent,
    artifactId: string,
    facilityId: string,
  ): Promise<EnvironmentResolution> {
    const artifact = this.artifacts.get(artifactId);
    const facility = this.config.facilities.find(
      (candidate) =>
        candidate.id === facilityId && candidate.category !== "hidden",
    );
    if (!artifact || !facility)
      return this.reject(
        agent.id,
        "VERIFY_ARTIFACT",
        "artifact or facility unavailable",
      );
    if (!this.verificationRequests.has(artifact.id))
      return this.reject(
        agent.id,
        "VERIFY_ARTIFACT",
        "verification was not requested",
      );
    if (artifact.authorId === agent.id)
      return this.reject(
        agent.id,
        "VERIFY_ARTIFACT",
        "authors cannot verify their own artifacts",
      );
    if (agent.verificationRemaining <= 0)
      return this.reject(agent.id, "VERIFY_ARTIFACT", "budget exhausted");
    if (
      this.config.goal &&
      this.verificationRunsUsed >= this.config.goal.budget.maxVerificationRuns
    )
      return this.reject(
        agent.id,
        "VERIFY_ARTIFACT",
        "global verification budget exhausted",
      );
    agent.verificationRemaining--;
    this.verificationRunsUsed++;
    const parent = await mkdtemp(join(tmpdir(), "swarm-world-verification-"));
    const checkout = join(parent, "checkout");
    await run("git", [
      "-C",
      this.root,
      "worktree",
      "add",
      "--detach",
      checkout,
      artifact.commit,
    ]);
    let completed: Awaited<
      ReturnType<RepositoryEnvironment["executeIndependentVerification"]>
    >;
    try {
      completed = await this.executeIndependentVerification(
        artifact,
        facility,
        agent.id,
        checkout,
      );
    } finally {
      await run("git", [
        "-C",
        this.root,
        "worktree",
        "remove",
        "--force",
        checkout,
      ]).catch(() => undefined);
    }
    if (this.artifactEligible(artifact))
      this.artifacts.set(artifact.id, { ...artifact, status: "eligible" });
    return completed.result.success
      ? this.accept(agent.id, "VERIFY_ARTIFACT", completed.verification.id, [
          completed.evidenceId!,
        ])
      : this.reject(
          agent.id,
          "VERIFY_ARTIFACT",
          "independent verification failed",
          [completed.evidenceId!],
        );
  }

  private async verifyArtifactAsEngine(
    artifact: RepositoryArtifact,
  ): Promise<void> {
    const facilities = this.config.facilities.filter(
      (facility) => facility.mandatory && facility.category !== "hidden",
    );
    const parent = await mkdtemp(
      join(tmpdir(), "swarm-world-independent-verification-"),
    );
    const checkout = join(parent, "checkout");
    await run("git", [
      "-C",
      this.root,
      "worktree",
      "add",
      "--detach",
      checkout,
      artifact.commit,
    ]);
    try {
      for (const facility of facilities) {
        this.verificationRunsUsed++;
        await this.executeIndependentVerification(
          artifact,
          facility,
          "environment-verifier",
          checkout,
        );
      }
    } finally {
      await run("git", [
        "-C",
        this.root,
        "worktree",
        "remove",
        "--force",
        checkout,
      ]).catch(() => undefined);
    }
    if (this.artifactEligible(artifact))
      this.artifacts.set(artifact.id, { ...artifact, status: "eligible" });
  }

  private async executeIndependentVerification(
    artifact: RepositoryArtifact,
    facility: RepositoryFacility,
    verifierAgentId: string,
    checkout: string,
  ): Promise<{
    result: Awaited<ReturnType<RepositoryEnvironment["executeFacility"]>>;
    verification: RepositoryVerification;
    evidenceId?: string;
  }> {
    const result = await this.executeFacility(facility, checkout);
    const data = {
      artifactId: artifact.id,
      verifierAgentId,
      facilityId: facility.id,
      success: result.success,
      outputDigest: result.outputDigest,
      revision: artifact.commit,
      facilityPolicyHash: this.facilityPolicyHash(),
      recommendation: result.success
        ? ("accept" as const)
        : ("revise" as const),
    };
    const verification: RepositoryVerification = {
      id: `verification_${sha256(data).slice(0, 24)}`,
      ...data,
    };
    this.verifications.set(verification.id, verification);
    this.society.append(
      this.tick,
      "verification",
      verification.id,
      "verification-completed",
      verification,
    );
    const evidence = this.agents.has(verifierAgentId)
      ? this.makeEvidence(
          verifierAgentId,
          "independent_verification",
          artifact.commit,
          { ...data, output: result.output },
          result.outputDigest,
        )
      : undefined;
    this.trace.appendFacilityCompleted(
      verifierAgentId,
      evidence?.id ?? verification.id,
      {
        facilityId: facility.id,
        success: result.success,
        exitCode: result.exitCode,
        outputDigest: result.outputDigest,
        output: result.output,
      },
    );
    const node = this.node(
      "verification",
      verification.id,
      `${facility.id}: ${verification.recommendation}`,
    );
    this.edge(artifact.id, node.id, "test_relation");
    if (!evidence)
      this.record(
        "engine_verification",
        result.success,
        verifierAgentId,
        verification.id,
        {
          artifactId: artifact.id,
          facilityId: facility.id,
          outputDigest: result.outputDigest,
        },
      );
    return {
      result,
      verification,
      ...(evidence ? { evidenceId: evidence.id } : {}),
    };
  }

  private challengeVerification(
    agent: RepositoryAgent,
    action: Extract<RepositoryAction, { type: "CHALLENGE_VERIFICATION" }>,
  ): EnvironmentResolution {
    if (
      !this.verifications.has(action.verificationId) ||
      !this.owns(agent, action.evidenceIds)
    )
      return this.reject(
        agent.id,
        action.type,
        "challenge requires verification and owned evidence",
      );
    const challenges =
      this.verificationChallenges.get(action.verificationId) ?? [];
    challenges.push(`${agent.id}: ${action.reason}`);
    this.verificationChallenges.set(action.verificationId, challenges);
    this.society.append(
      this.tick,
      "verification",
      action.verificationId,
      "verification-challenged",
      {
        verification: this.verifications.get(action.verificationId),
        challenges: [...challenges],
      },
    );
    return this.accept(
      agent.id,
      action.type,
      action.verificationId,
      action.evidenceIds,
    );
  }

  private recommendCandidate(
    agent: RepositoryAgent,
    artifactId: string,
  ): EnvironmentResolution {
    const artifact = this.artifacts.get(artifactId);
    if (
      !artifact ||
      artifact.authorId === agent.id ||
      !this.artifactEligible(artifact)
    )
      return this.reject(
        agent.id,
        "RECOMMEND_CANDIDATE",
        "candidate is not independently recommendable",
      );
    const recommendations =
      this.candidateRecommendations.get(artifactId) ?? new Set<string>();
    recommendations.add(agent.id);
    this.candidateRecommendations.set(artifactId, recommendations);
    return this.accept(agent.id, "RECOMMEND_CANDIDATE", artifactId);
  }

  private artifactVerifications(artifactId: string): RepositoryVerification[] {
    return [...this.verifications.values()].filter(
      (verification) => verification.artifactId === artifactId,
    );
  }

  private artifactEligible(artifact: RepositoryArtifact): boolean {
    if (!this.config.goal) return true;
    const mandatory = this.config.facilities
      .filter(
        (facility) => facility.mandatory && facility.category !== "hidden",
      )
      .map((facility) => facility.id);
    const verifications = this.artifactVerifications(artifact.id).filter(
      (verification) =>
        verification.verifierAgentId !== artifact.authorId &&
        verification.success &&
        !this.verificationChallenges.get(verification.id)?.length,
    );
    return mandatory.every((id) =>
      verifications.some((verification) => verification.facilityId === id),
    );
  }

  private artifactVerificationComplete(artifact: RepositoryArtifact): boolean {
    const mandatory = this.config.facilities
      .filter(
        (facility) => facility.mandatory && facility.category !== "hidden",
      )
      .map((facility) => facility.id);
    const verifications = this.artifactVerifications(artifact.id).filter(
      (verification) => verification.verifierAgentId !== artifact.authorId,
    );
    return mandatory.every((id) =>
      verifications.some((verification) => verification.facilityId === id),
    );
  }

  private selectCandidate(
    candidates: RepositoryArtifact[],
  ): RepositoryArtifact {
    const scored = rankRepositoryCandidates(
      candidates,
      (artifactId) =>
        new Set(
          this.artifactVerifications(artifactId)
            .filter((verification) => verification.success)
            .map((verification) => verification.facilityId),
        ).size,
      (artifactId) => this.candidateRecommendations.get(artifactId)?.size ?? 0,
    );
    const winner = scored[0]!;
    const data = {
      selectedArtifactId: winner.artifact.id,
      eligibleArtifactIds: scored.map(({ artifact }) => artifact.id),
      rejected: scored.slice(1).map(({ artifact }) => ({
        artifactId: artifact.id,
        reason: "lower deterministic evidence score",
      })),
      score: {
        passedFacilities: winner.passedFacilities,
        taskCoverage: winner.taskCoverage,
        changedLines: winner.changedLines,
      },
    };
    this.selection = { id: `selection_${sha256(data).slice(0, 24)}`, ...data };
    this.society.append(
      this.tick,
      "selection",
      this.selection.id,
      "candidate-selected",
      this.selection,
    );
    this.record("candidate_selected", true, undefined, winner.artifact.id, {
      ...this.selection,
    });
    return winner.artifact;
  }

  private taskNodeId(): string {
    return this.nodeIdForStableKey("task", this.config.task.id);
  }

  private taskNodeFor(taskId: string): string {
    return taskId === this.config.task.id
      ? this.taskNodeId()
      : this.nodeIdForStableKey("task_proposal", taskId);
  }

  private nodeIdForStableKey(
    type: RepositoryNodeType,
    stableKey: string,
  ): string {
    return `${type}_${sha256({ type, stableKey }).slice(0, 20)}`;
  }

  private async executeFacility(
    facility: RepositoryFacility,
    worktree: string,
  ): Promise<{
    success: boolean;
    exitCode: number;
    outputDigest: string;
    output: string;
  }> {
    const canonicalWorktree = await realpath(worktree);
    const cwd = resolve(canonicalWorktree, facility.workingDirectory);
    const relativeCwd = relative(canonicalWorktree, cwd);
    if (relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`))
      throw new Error("Facility working directory escapes its worktree");
    const realCwd = await realpath(cwd);
    if (
      relative(canonicalWorktree, realCwd) === ".." ||
      relative(canonicalWorktree, realCwd).startsWith(`..${sep}`)
    )
      throw new Error(
        "Facility working directory resolves outside its worktree",
      );
    const before = await this.workspaceStateHash(worktree);
    const pathsBefore = await this.changedPaths(worktree);
    const isNodeFacility =
      (await realpath(facility.executable)) ===
      (await realpath(process.execPath));
    const executable = isNodeFacility
      ? facility.executable
      : facility.sandbox!.executable;
    const configuredDependencyPath = process.env.SWARM_WORLD_DEPENDENCIES;
    const dependencyPath = isNodeFacility
      ? await realpath(join(canonicalWorktree, "node_modules"))
          .then(async (resolved) => {
            const relativeDependency = relative(canonicalWorktree, resolved);
            if (
              relativeDependency !== ".." &&
              !relativeDependency.startsWith(`..${sep}`)
            )
              return resolved;
            if (
              configuredDependencyPath &&
              resolved === (await realpath(configuredDependencyPath))
            )
              return resolved;
            throw new Error("Untrusted dependency path escapes its worktree");
          })
          .catch((error: unknown) => {
            if (
              error instanceof Error &&
              error.message === "Untrusted dependency path escapes its worktree"
            )
              throw error;
            return undefined;
          })
      : undefined;
    const args = isNodeFacility
      ? [
          "--permission",
          `--allow-fs-read=${canonicalWorktree}`,
          ...(dependencyPath ? [`--allow-fs-read=${dependencyPath}`] : []),
          "--allow-worker",
          ...(facility.mutationClass === "worktree"
            ? [`--allow-fs-write=${canonicalWorktree}`]
            : []),
          ...facility.args,
        ]
      : [...facility.sandbox!.args, facility.executable, ...facility.args];
    try {
      const result = await run(executable, args, {
        cwd,
        timeout: facility.timeoutMs,
        maxBuffer: Math.max(facility.outputLimit, 1),
        env: { ...facility.environment },
        encoding: "utf8",
      });
      const output = `${result.stdout}${result.stderr}`.slice(
        0,
        facility.outputLimit,
      );
      const mutated =
        facility.mutationClass === "none" &&
        before !== (await this.workspaceStateHash(worktree));
      const pathsAfter = await this.changedPaths(worktree);
      const outOfScope = pathsAfter.some(
        (path) =>
          !pathsBefore.includes(path) &&
          !facility.permittedPaths.some((pattern) => glob(pattern, path)),
      );
      const policyViolation = mutated || outOfScope;
      const boundedOutput = policyViolation
        ? `${output}\nFacility violated its mutation or path policy`.slice(
            0,
            facility.outputLimit,
          )
        : output;
      return {
        success: !policyViolation,
        exitCode: policyViolation ? 126 : 0,
        outputDigest: sha256(boundedOutput),
        output: boundedOutput,
      };
    } catch (error) {
      const value = error as {
        code?: string | number;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      const output = `${value.stdout ?? ""}${value.stderr ?? ""}`.slice(
        0,
        facility.outputLimit,
      );
      return {
        success: false,
        exitCode:
          typeof value.code === "number" ? value.code : value.killed ? 124 : 1,
        outputDigest: sha256(output),
        output,
      };
    }
  }

  private affordances(): RepositoryAction["type"][] {
    const caps = capabilities(this.config.condition ?? "full");
    const read: RepositoryAction["type"][] = [
      "WAIT",
      "FOCUS",
      "INSPECT",
      "SEARCH",
      ...(caps.taskClaims || this.config.condition === "independent"
        ? (["CLAIM_TASK"] as const)
        : []),
      ...(this.config.goal &&
      (caps.taskClaims || this.config.condition === "independent")
        ? ([
            "PROPOSE_PROBLEM",
            "CONFIRM_PROBLEM",
            "CHALLENGE_PROBLEM",
            "PROPOSE_TASK",
            "DECOMPOSE_TASK",
            "CLAIM_COMMITMENT",
            "JOIN_COMMITMENT",
            "RELEASE_COMMITMENT",
          ] as const)
        : []),
      ...(caps.communication ? (["COMMUNICATE"] as const) : []),
      ...(caps.teaching ? (["TEACH_ARTIFACT"] as const) : []),
      ...(caps.publication ? (["PUBLISH_FINDING"] as const) : []),
    ];
    return (this.config.readOnly ?? true)
      ? read
      : [
          ...read,
          "FORMULATE",
          "EDIT",
          "EDIT_REPLACE",
          "RUN_CHECK",
          "CONSTRUCT_ARTIFACT",
          "REQUEST_VERIFICATION",
          "VERIFY_ARTIFACT",
          "CHALLENGE_VERIFICATION",
          "RECOMMEND_CANDIDATE",
          "REQUEST_INTEGRATION",
        ];
  }

  private node(
    type: RepositoryNodeType,
    stableKey: string,
    label: string,
    path?: string,
    contentHash?: string,
  ): RepositoryNode {
    const id = `${type}_${sha256({ type, stableKey }).slice(0, 20)}`;
    const node: RepositoryNode = {
      id,
      type,
      label,
      ...(path ? { path } : {}),
      ...(contentHash ? { contentHash } : {}),
    };
    this.nodes.set(id, node);
    return node;
  }

  private edge(from: string, to: string, type: RepositoryEdgeType): void {
    if (
      !this.edges.some(
        (edge) => edge.from === from && edge.to === to && edge.type === type,
      )
    )
      this.edges.push({ from, to, type });
  }

  private permitted(path: string): boolean {
    return (
      !path.startsWith("/") &&
      !path.split("/").includes("..") &&
      this.config.allowedPaths.some((pattern) => glob(pattern, path)) &&
      !this.excluded(path)
    );
  }

  private excluded(path: string): boolean {
    return this.config.excludedPaths.some((pattern) => glob(pattern, path));
  }

  private async safeWorktreePath(
    worktree: string,
    path: string,
  ): Promise<string> {
    if (!this.permitted(path)) throw new Error("path policy rejected edit");
    const canonicalWorktree = await realpath(worktree);
    const target = resolve(canonicalWorktree, path);
    if (
      relative(canonicalWorktree, target).startsWith(`..${sep}`) ||
      relative(canonicalWorktree, target) === ".."
    )
      throw new Error("path escapes worktree");
    let cursor = canonicalWorktree;
    for (const segment of path.split("/").slice(0, -1)) {
      cursor = join(cursor, segment);
      const entry = await lstat(cursor).catch(() => undefined);
      if (entry?.isSymbolicLink())
        throw new Error("symlink parent paths are forbidden");
      if (!entry) break;
    }
    await mkdir(dirname(target), { recursive: true });
    const realParent = await realpath(dirname(target));
    if (
      relative(canonicalWorktree, realParent) === ".." ||
      relative(canonicalWorktree, realParent).startsWith(`..${sep}`)
    )
      throw new Error("edit parent resolves outside worktree");
    const existing = await lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink())
      throw new Error("symlink edits are forbidden");
    return target;
  }

  private async gitShow(revision: string, path: string): Promise<string> {
    if (!this.permitted(path))
      throw new Error("path is outside repository policy");
    return (
      await run("git", ["-C", this.root, "show", `${revision}:${path}`], {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout;
  }

  private async commitDate(revision: string): Promise<string> {
    return (
      await run(
        "git",
        ["-C", this.root, "show", "-s", "--format=%aI", revision],
        {
          encoding: "utf8",
        },
      )
    ).stdout.trim();
  }

  private async refreshContentIdentities(): Promise<void> {
    for (const node of this.nodes.values())
      if (node.path && (node.type === "file" || node.type === "test")) {
        const content = await this.gitShow(
          this.candidateCommit,
          node.path,
        ).catch(() => undefined);
        if (content === undefined) delete node.contentHash;
        else node.contentHash = sha256(content);
      }
  }

  private async patchHash(worktree: string): Promise<string> {
    const trackedDiff = (
      await run("git", ["-C", worktree, "diff", "--binary", "HEAD"], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
    const untracked = await this.untrackedPaths(worktree);
    if (!trackedDiff && !untracked.length) return sha256("");
    const untrackedContent = await Promise.all(
      untracked.map(async (path) => ({
        path,
        contentHash: sha256(await readFile(resolve(worktree, path))),
      })),
    );
    return sha256({ trackedDiff, untracked: untrackedContent });
  }

  private async workspaceStateHash(worktree: string): Promise<string> {
    const status = (
      await run(
        "git",
        ["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"],
        { encoding: "utf8" },
      )
    ).stdout;
    return sha256({ status, patchHash: await this.patchHash(worktree) });
  }

  private async changedPaths(worktree: string): Promise<string[]> {
    const status = (
      await run(
        "git",
        ["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"],
        { encoding: "utf8" },
      )
    ).stdout;
    return status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).split(" -> ").at(-1)!)
      .sort();
  }

  private async untrackedPaths(worktree: string): Promise<string[]> {
    return (
      await run(
        "git",
        ["-C", worktree, "ls-files", "--others", "--exclude-standard"],
        { encoding: "utf8" },
      )
    ).stdout
      .split("\n")
      .filter(Boolean)
      .sort();
  }

  private async diffStats(
    worktree: string,
  ): Promise<{ files: number; lines: number }> {
    const output = (
      await run("git", ["-C", worktree, "diff", "--numstat", "HEAD"], {
        encoding: "utf8",
      })
    ).stdout.trim();
    const rows = output ? output.split("\n") : [];
    for (const path of await this.untrackedPaths(worktree)) {
      const content = await readFile(resolve(worktree, path), "utf8");
      rows.push(
        `${content === "" ? 0 : content.split("\n").length}\t0\t${path}`,
      );
    }
    if (!rows.length) return { files: 0, lines: 0 };
    return {
      files: rows.length,
      lines: rows.reduce((total, row) => {
        const [added, removed] = row.split("\t");
        return total + (Number(added) || 0) + (Number(removed) || 0);
      }, 0),
    };
  }

  private agent(id: string): RepositoryAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Unknown repository agent: ${id}`);
    return agent;
  }

  private owns(agent: RepositoryAgent, ids: string[]): boolean {
    return ids.every(
      (id) =>
        agent.evidence.has(id) && this.evidence.get(id)?.ownerId === agent.id,
    );
  }

  private makeEvidence(
    ownerId: string,
    kind: string,
    revision: string,
    data: Record<string, unknown>,
    digest: string,
  ): Evidence {
    const id = `evidence_${sha256({ ownerId, kind, revision, data, digest, sequence: this.trace.length }).slice(0, 24)}`;
    const evidence = { id, ownerId, kind, revision, digest, data };
    this.evidence.set(id, evidence);
    this.agent(ownerId).evidence.add(id);
    return evidence;
  }

  private accept(
    actorId: string,
    type: string,
    targetId?: string,
    evidenceIds: string[] = [],
  ): EnvironmentResolution {
    this.record(`action_${type.toLowerCase()}`, true, actorId, targetId, {
      evidenceIds,
    });
    return { accepted: true, ...(targetId ? { targetId } : {}), evidenceIds };
  }

  private reject(
    actorId: string,
    type: string,
    reason: string,
    evidenceIds: string[] = [],
  ): EnvironmentResolution {
    this.record("action_rejected", false, actorId, undefined, {
      actionType: type,
      reason,
      evidenceIds,
    });
    return { accepted: false, reason, evidenceIds };
  }

  private record(
    type: string,
    accepted: boolean,
    actorId: string | undefined,
    targetId: string | undefined,
    data: Record<string, unknown>,
  ): void {
    this.trace.append(type, accepted, actorId, targetId, data);
  }

  private graphHash(): string {
    return sha256({
      nodes: [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...this.edges].sort((a, b) =>
        `${a.from}:${a.type}:${a.to}`.localeCompare(
          `${b.from}:${b.type}:${b.to}`,
        ),
      ),
    });
  }

  private facilityPolicyHash(): string {
    return sha256(
      this.config.facilities
        .map((facility) => ({
          ...facility,
          executableContentHash: this.facilityExecutableHashes.get(facility.id),
          sandboxContentHash: this.facilitySandboxHashes.get(facility.id),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  private traceHash(): string {
    return this.trace.hash();
  }
}
