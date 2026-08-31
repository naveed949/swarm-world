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
import type {
  RepositoryAction,
  RepositoryAgent,
  RepositoryArtifact,
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
  RepositoryRecipe as Recipe,
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
  private readonly integrationQueue = new Set<string>();
  private readonly integratedArtifactIds = new Set<string>();
  private readonly taskClaims = new Map<string, string>();
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
    const root = await realpath(config.root);
    const readOnly = config.readOnly ?? true;
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
        ["-C", root, "rev-parse", "--verify", `${config.baseCommit}^{commit}`],
        {
          encoding: "utf8",
        },
      )
    ).stdout.trim();
    const environment = new RepositoryEnvironment(config, root, baseCommit);
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
      readOnly: config.readOnly ?? true,
      graphHash: environment.graphHash(),
      facilityPolicyHash: environment.facilityPolicyHash(),
    });
    return environment;
  }

  createAgent(id: string): { id: string } {
    if (this.agents.has(id)) throw new Error(`Agent already exists: ${id}`);
    const task = [...this.nodes.values()].find((node) => node.type === "task")!;
    this.agents.set(id, {
      id,
      focusNodeId: task.id,
      evidence: new Set(),
      observedNodes: new Set([task.id]),
      inheritedArtifacts: new Set(),
      actionsRemaining: 128,
      verificationRemaining: 32,
      writesRemaining: this.config.patch.maxChangedLines,
    });
    return { id };
  }

  traceEvents() {
    return this.trace.snapshot();
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
        ? [...this.taskClaims]
            .map(([taskId, claimedBy]) => ({ taskId, agentId: claimedBy }))
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
      affordances: this.affordances(),
      budgets: {
        context: this.config.observationLimit,
        actions: agent.actionsRemaining,
        verification: agent.verificationRemaining,
        writes: agent.writesRemaining,
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
    if (agent.actionsRemaining <= 0)
      return this.reject(agentId, action.type, "budget exhausted");
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
          if (!capabilities(this.config.condition ?? "full").taskClaims)
            return this.reject(
              agentId,
              action.type,
              "task claims disabled by treatment",
            );
          if (action.taskId !== this.config.task.id)
            return this.reject(agentId, action.type, "task unavailable");
          if (
            this.taskClaims.has(action.taskId) &&
            this.taskClaims.get(action.taskId) !== agent.id
          )
            return this.reject(agentId, action.type, "task already claimed");
          this.taskClaims.set(action.taskId, agent.id);
          return this.accept(agentId, action.type, action.taskId);
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
          this.integrationQueue.add(action.artifactId);
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
    const ordered = [...this.integrationQueue]
      .map((id) => this.artifacts.get(id)!)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    for (const artifact of ordered) {
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
      this.integrationQueue.delete(artifact.id);
    }
  }

  async freeze(): Promise<RepositoryFrozenSnapshot> {
    return {
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
      task: structuredClone(this.config.task),
    };
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
      for (const facility of this.config.facilities) {
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
    const mandatory = this.config.facilities.filter(
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
      const selected = this.config.facilities.filter((facility) =>
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
    const correctness = gateScore(frozen.task.acceptanceFacilityIds);
    const regressionSafety = gateScore(frozen.task.regressionFacilityIds);
    const maintainability = score([
      "format",
      "build",
      "typecheck",
      "lint",
      "analysis",
    ]);
    const hidden = this.config.facilities.filter(
      (facility) => facility.category === "hidden",
    );
    const robustness = hidden.length ? score(["hidden"]) : 1;
    const issueCoverage = hasArtifact
      ? frozen.acceptedArtifacts.some(
          (artifact) =>
            artifact.taskIds.includes(frozen.task.id) &&
            artifact.touchedNodes.some((nodeId) => {
              const path = this.nodes.get(nodeId)?.path;
              return path ? frozen.task.relevantPaths.includes(path) : false;
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
    if (
      action.taskId !== this.config.task.id ||
      !this.owns(agent, action.evidenceIds)
    )
      return this.reject(
        agent.id,
        action.type,
        "recipe cites unavailable task or evidence",
      );
    if (
      action.targets.some((path) => !this.permitted(path)) ||
      action.targets.some(
        (path) => !this.config.task.relevantPaths.includes(path),
      ) ||
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
    this.recipes.set(id, {
      id,
      ownerId: agent.id,
      taskId: action.taskId,
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
      stats.lines > agent.writesRemaining
    ) {
      await writeFile(target, current, "utf8");
      return this.reject(agent.id, actionType, "patch budget exceeded");
    }
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
    agent.verificationRemaining--;
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
      const unauthorized = (await this.changedPaths(recipe.worktree)).filter(
        (path) =>
          !recipe.targets.includes(path) ||
          !this.config.task.relevantPaths.includes(path) ||
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
    if (
      changed.some(
        (path) =>
          !recipe.targets.includes(path) ||
          !this.config.task.relevantPaths.includes(path) ||
          !this.permitted(path),
      )
    )
      return this.reject(
        agent.id,
        "CONSTRUCT_ARTIFACT",
        "artifact contains unauthorized paths",
      );
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
    const artifactData = {
      commit,
      baseCommit: recipe.baseCommit,
      parentArtifacts: [...this.artifacts.values()]
        .filter((artifact) => artifact.commit === recipe.baseCommit)
        .map((artifact) => artifact.id)
        .sort(),
      authorId: agent.id,
      contributors: [agent.id],
      taskIds: [recipe.taskId],
      touchedNodes,
      patchHash: recipe.patchHash,
      evidenceIds,
      priority: this.config.task.priority,
    };
    const artifact: RepositoryArtifact = {
      id: `artifact_${sha256(artifactData).slice(0, 24)}`,
      ...artifactData,
    };
    this.artifacts.set(artifact.id, artifact);
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
      ...(caps.taskClaims ? (["CLAIM_TASK"] as const) : []),
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
