import { capabilities } from "./config.js";
import { InvalidPlanError, type Cognition } from "./cognition.js";
import { sha256 } from "./hash.js";
import { beginProcessing, finishProcessing } from "./materials.js";
import { Trace } from "./trace.js";
import type {
  Action,
  AgentState,
  Artifact,
  ArtifactProgram,
  EventRecord,
  ExperimentConfig,
  FrozenWorld,
  MaterialBatch,
  Message,
  Publication,
  ResourceId,
  ServiceId,
} from "./types.js";
import { executeProgram, makeProgram, validateInstructions } from "./vm.js";
import { World } from "./world.js";

const services: ServiceId[] = [
  "water",
  "remediation",
  "stability",
  "healing",
  "nutrient",
];
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);
const emptyResearch = () => ({
  goal: "Explore the local world",
  hypothesis: "Unknown",
  progress: "No observations yet",
  nextCheckpoint: "Inspect locally",
  collaborationNeed: "Unknown",
});
export class RetryableDecisionError extends Error {
  override name = "RetryableDecisionError";
}

export class Simulator {
  tick = 0;
  readonly world: World;
  readonly agents: AgentState[];
  readonly artifacts: Artifact[] = [];
  readonly programs = new Map<string, ArtifactProgram>();
  readonly messages: Message[] = [];
  readonly publications: Publication[] = [];
  readonly trace: Trace;
  readonly caps;
  private eventSequence = 0;
  private cognition: Cognition | undefined;

  constructor(
    readonly config: ExperimentConfig,
    cognition?: Cognition,
  ) {
    this.world = new World(
      config.seed,
      config.world.width,
      config.world.height,
      undefined,
      config.world.scenario,
    );
    this.caps = capabilities(config.condition);
    this.cognition = cognition;
    const positions = this.world.spawnPositions(config.population);
    this.agents = positions.map((position, i) => ({
      id: `agent_${String(i).padStart(6, "0")}`,
      position,
      phase: i % config.macroturnInterval,
      inventory: {},
      batches: [],
      pendingBatches: [],
      queue: [],
      research: emptyResearch(),
      memory: [],
      observedCells: new Map(),
      observedPrograms: new Set(),
      authoredPrograms: new Set(),
      inheritedPrograms: new Set(),
      pendingMessages: [],
      active: true,
    }));
    this.trace = new Trace(config, {
      engineRevision: 1,
      configHash: sha256(config),
      worldSeed: config.seed,
      algorithm: "proposal-consequence-separated",
    });
  }

  private event(
    type: string,
    success: boolean,
    actorId?: string,
    targetId?: string,
    data: Record<string, unknown> = {},
  ): EventRecord {
    const event = this.trace.append({
      id: `event_${String(this.eventSequence++).padStart(10, "0")}`,
      tick: this.tick,
      type,
      success,
      data,
      ...(actorId ? { actorId } : {}),
      ...(targetId ? { targetId } : {}),
    });
    if (actorId) {
      const agent = this.agents.find((a) => a.id === actorId);
      if (agent) {
        agent.memory.push({
          id: event.id,
          tick: this.tick,
          kind: type,
          text: `${success ? "accepted" : "rejected"}: ${type}`,
          evidenceIds: [event.id],
        });
        if (agent.memory.length > 64) agent.memory.shift();
      }
    }
    return event;
  }

  async step(): Promise<void> {
    const decisionAgents = this.agents.filter(
      (a) =>
        a.active && (this.tick - a.phase) % this.config.macroturnInterval === 0,
    );
    if (this.cognition) {
      const staged = await Promise.all(
        decisionAgents.map(async (agent) => {
          try {
            const observation = this.world.observe(
              this.tick,
              agent,
              this.agents,
              this.artifacts,
              this.messages.filter(
                (m) => agent.pendingMessages.includes(m.id) || !m.recipientId,
              ),
              this.publications,
              this.config.world.observationRadius,
              this.caps.communication || this.caps.publication,
              this.caps.crossAgentPrograms,
            );
            const proposal = await this.cognition!.plan(
              agent,
              observation,
              this.caps,
            );
            return { agent, proposal };
          } catch (error) {
            return { agent, error };
          }
        }),
      );
      const infrastructureFailure = staged.find(
        (result) =>
          "error" in result && !(result.error instanceof InvalidPlanError),
      );
      if (infrastructureFailure && "error" in infrastructureFailure) {
        this.event(
          "decision_transport_retry",
          false,
          infrastructureFailure.agent.id,
          undefined,
          {
            error:
              infrastructureFailure.error instanceof Error
                ? infrastructureFailure.error.message
                : String(infrastructureFailure.error),
          },
        );
        throw new RetryableDecisionError(
          "Retryable cognition failure; world time did not advance",
        );
      }
      for (const result of staged) {
        if ("proposal" in result) {
          result.agent.research = result.proposal.research;
          result.agent.queue = result.proposal.actions.slice(
            0,
            this.config.planLimit,
          );
          result.agent.pendingMessages = [];
          this.event("decision_committed", true, result.agent.id, undefined, {
            actionCount: result.agent.queue.length,
            research: result.proposal.research,
          });
        } else {
          result.agent.queue = [];
          this.event("decision_rejected", false, result.agent.id, undefined, {
            error:
              result.error instanceof Error
                ? result.error.message
                : String(result.error),
          });
        }
      }
    }
    const attempted = this.agents
      .filter((a) => a.active)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((agent) => ({
        agent,
        action: agent.queue.shift() ?? ({ type: "WAIT" } as Action),
      }));
    for (const { agent, action } of attempted)
      this.resolveAction(agent, action);
    this.advanceEnvironment();
  }

  advanceEnvironment(): void {
    this.world.advance(this.tick);
    if (
      this.tick > 0 &&
      this.tick % this.config.world.disturbanceInterval === 0
    ) {
      const disturbance = this.world.disturb(
        this.config.seed ^ 0xd157,
        this.tick,
        this.config.world.disturbanceIntensity,
      );
      this.event(
        "disturbance_applied",
        true,
        undefined,
        undefined,
        disturbance,
      );
    }
    this.executeArtifacts();
    this.tick++;
  }

  observeAgent(agentId: string) {
    const agent = this.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`Unknown BioFoundry agent: ${agentId}`);
    return this.world.observe(
      this.tick,
      agent,
      this.agents,
      this.artifacts,
      this.messages.filter(
        (message) =>
          agent.pendingMessages.includes(message.id) || !message.recipientId,
      ),
      this.publications,
      this.config.world.observationRadius,
      this.caps.communication || this.caps.publication,
      this.caps.crossAgentPrograms,
    );
  }

  private reject(agent: AgentState, action: Action, reason: string): void {
    this.event("action_rejected", false, agent.id, undefined, {
      action,
      reason,
    });
  }
  private accept(
    agent: AgentState,
    action: Action,
    data: Record<string, unknown> = {},
    targetId?: string,
  ): EventRecord {
    return this.event(
      `action_${action.type.toLowerCase()}`,
      true,
      agent.id,
      targetId,
      { action, ...data },
    );
  }
  private batch(agent: AgentState, id: string): MaterialBatch | undefined {
    return agent.batches.find((b) => b.id === id);
  }

  resolveAction(agent: AgentState, action: Action): void {
    try {
      switch (action.type) {
        case "WAIT":
          this.accept(agent, action);
          return;
        case "MOVE": {
          if (Math.abs(action.dx) + Math.abs(action.dy) !== 1)
            return this.reject(
              agent,
              action,
              "Movement must be one orthogonal cell",
            );
          const next = {
            x: agent.position.x + action.dx,
            y: agent.position.y + action.dy,
          };
          if (!this.world.walkable(next))
            return this.reject(agent, action, "Target is not walkable");
          agent.position = next;
          this.accept(agent, action, { position: next });
          return;
        }
        case "INSPECT": {
          if (action.target === "ARTIFACT") {
            const artifact = this.artifacts.find(
              (a) => a.id === action.artifactId && a.active,
            );
            if (!artifact || distance(agent.position, artifact.position) > 1.5)
              return this.reject(
                agent,
                action,
                "Artifact is not locally observable",
              );
            if (artifact.programId && this.caps.crossAgentPrograms)
              agent.observedPrograms.add(artifact.programId);
            this.accept(
              agent,
              action,
              {
                services: artifact.lastServices,
                properties: artifact.properties,
                programId: this.caps.crossAgentPrograms
                  ? artifact.programId
                  : undefined,
              },
              artifact.id,
            );
            return;
          }
          const i = this.world.index(agent.position);
          this.accept(agent, action, {
            terrain: this.world.terrain[i],
            resource: this.world.resourceType[i],
            mass: this.world.resourceMass[i],
            fields: Object.fromEntries(
              Object.entries(this.world.fields).map(([k, v]) => [k, v[i]]),
            ),
          });
          return;
        }
        case "HARVEST": {
          const i = this.world.index(agent.position);
          if (this.world.resourceType[i] !== action.resource)
            return this.reject(
              agent,
              action,
              "Requested resource is absent locally",
            );
          const total = Object.values(agent.inventory).reduce(
              (a, b) => a + (b ?? 0),
              0,
            ),
            amount = Math.min(
              Math.max(0, action.amount),
              0.5,
              this.world.resourceMass[i]!,
              this.config.world.inventoryLimit - total,
            );
          if (amount <= 0)
            return this.reject(agent, action, "No harvest capacity");
          this.world.resourceMass[i] = this.world.resourceMass[i]! - amount;
          agent.inventory[action.resource] =
            (agent.inventory[action.resource] ?? 0) + amount;
          this.accept(agent, action, { amount });
          return;
        }
        case "DEPOSIT": {
          const amount = Math.min(
            Math.max(0, action.amount),
            agent.inventory[action.resource] ?? 0,
          );
          if (amount <= 0)
            return this.reject(agent, action, "Resource not possessed");
          const depot = this.world.depots[this.world.index(agent.position)]!;
          agent.inventory[action.resource] =
            (agent.inventory[action.resource] ?? 0) - amount;
          depot[action.resource] = (depot[action.resource] ?? 0) + amount;
          this.accept(agent, action, { amount });
          return;
        }
        case "WITHDRAW": {
          const depot = this.world.depots[this.world.index(agent.position)]!;
          const inventoryMass = Object.values(agent.inventory).reduce(
            (total, amount) => total + (amount ?? 0),
            0,
          );
          const amount = Math.min(
            Math.max(0, action.amount),
            depot[action.resource] ?? 0,
            this.config.world.inventoryLimit - inventoryMass,
          );
          if (amount <= 0)
            return this.reject(
              agent,
              action,
              "No deposited resource or inventory capacity",
            );
          depot[action.resource] = (depot[action.resource] ?? 0) - amount;
          agent.inventory[action.resource] =
            (agent.inventory[action.resource] ?? 0) + amount;
          this.accept(agent, action, { amount });
          return;
        }
        case "FORMULATE": {
          const facility =
            this.world.facilities[this.world.index(agent.position)];
          if (!facility || action.recipe.operations[0] !== facility)
            return this.reject(
              agent,
              action,
              "Formulation requires the recipe's first operation facility",
            );
          const evidence = agent.memory
            .filter(
              (m) => m.kind.includes("inspect") || m.kind.includes("harvest"),
            )
            .slice(-8)
            .map((m) => m.id);
          const pending = beginProcessing(agent, action.recipe, evidence);
          if (pending.nextOperationIndex >= pending.recipe.operations.length) {
            const batch = finishProcessing(agent, pending);
            agent.batches.push(batch);
            this.accept(
              agent,
              action,
              {
                batchId: batch.id,
                recipe: batch.recipe,
                completedOperations: batch.recipe.operations,
              },
              batch.id,
            );
            return;
          }
          agent.pendingBatches.push(pending);
          this.accept(
            agent,
            action,
            {
              pendingBatchId: pending.id,
              completedOperation: facility,
              nextOperation:
                pending.recipe.operations[pending.nextOperationIndex],
            },
            pending.id,
          );
          return;
        }
        case "PROCESS": {
          const pending = agent.pendingBatches.find(
            (batch) => batch.id === action.pendingBatchId,
          );
          if (!pending)
            return this.reject(agent, action, "Pending batch not owned");
          const facility =
            this.world.facilities[this.world.index(agent.position)];
          const required =
            pending.recipe.operations[pending.nextOperationIndex];
          if (!facility || facility !== required)
            return this.reject(
              agent,
              action,
              `Ordered processing requires ${required ?? "no further operation"}`,
            );
          pending.nextOperationIndex++;
          if (pending.nextOperationIndex < pending.recipe.operations.length) {
            this.accept(
              agent,
              action,
              {
                pendingBatchId: pending.id,
                completedOperation: facility,
                nextOperation:
                  pending.recipe.operations[pending.nextOperationIndex],
              },
              pending.id,
            );
            return;
          }
          const batch = finishProcessing(agent, pending);
          agent.pendingBatches = agent.pendingBatches.filter(
            (candidate) => candidate.id !== pending.id,
          );
          agent.batches.push(batch);
          this.accept(
            agent,
            action,
            {
              batchId: batch.id,
              pendingBatchId: pending.id,
              completedOperations: batch.recipe.operations,
            },
            batch.id,
          );
          return;
        }
        case "TEST": {
          const batch = this.batch(agent, action.batchId);
          if (!batch) return this.reject(agent, action, "Batch not owned");
          batch.tested = true;
          this.accept(
            agent,
            action,
            { properties: batch.properties, quality: batch.quality },
            batch.id,
          );
          return;
        }
        case "CONSTRUCT": {
          const batch = this.batch(agent, action.batchId);
          if (!batch?.tested)
            return this.reject(
              agent,
              action,
              "Construction requires an owned tested batch",
            );
          const id = `artifact_${sha256({ agent: agent.id, tick: this.tick, batch: batch.id, n: this.artifacts.length }).slice(0, 16)}`;
          const artifact: Artifact = {
            id,
            position: { ...agent.position },
            creatorId: agent.id,
            contributors: [...batch.contributors],
            batchId: batch.id,
            properties: structuredClone(batch.properties),
            ...(this.caps.authoredText
              ? { spec: structuredClone(action.spec) }
              : {}),
            health: 1,
            maturity: 0.35,
            storage: 0,
            reserve: Math.min(
              1,
              Object.values(batch.recipe.inputs).reduce(
                (a, b) => a + (b ?? 0),
                0,
              ),
            ),
            opening: 0.5,
            signal: 0,
            active: true,
            programHistory: [],
            peakPerformance: 0,
            lastServices: Object.fromEntries(
              services.map((s) => [s, 0]),
            ) as Record<ServiceId, number>,
          };
          this.artifacts.push(artifact);
          agent.batches = agent.batches.filter((b) => b.id !== batch.id);
          this.accept(agent, action, { artifactId: id }, id);
          return;
        }
        case "INSTALL_PROGRAM": {
          const artifact = this.artifacts.find(
            (a) => a.id === action.artifactId && a.active,
          );
          if (!artifact || distance(agent.position, artifact.position) > 1.5)
            return this.reject(agent, action, "Artifact unavailable locally");
          if (
            artifact.creatorId !== agent.id &&
            !artifact.contributors.includes(agent.id)
          )
            return this.reject(
              agent,
              action,
              "Installation requires creator or contributor access",
            );
          validateInstructions(action.instructions);
          if (action.parentId) {
            const parent = this.programs.get(action.parentId);
            if (!parent)
              return this.reject(agent, action, "Unknown parent program");
            const permitted =
              parent.authorId === agent.id ||
              agent.observedPrograms.has(parent.id) ||
              agent.inheritedPrograms.has(parent.id);
            if (!this.caps.programForking || !permitted)
              return this.reject(
                agent,
                action,
                "Program forking not permitted or grounded",
              );
            if (sha256(parent.instructions) === sha256(action.instructions))
              return this.reject(
                agent,
                action,
                "Fork must change an instruction",
              );
          }
          const program = makeProgram(
            action.instructions,
            agent.id,
            action.parentId,
          );
          this.programs.set(program.id, program);
          agent.authoredPrograms.add(program.id);
          artifact.programId = program.id;
          artifact.programHistory.push(program.id);
          this.accept(
            agent,
            action,
            { programId: program.id, parentId: program.parentId },
            artifact.id,
          );
          return;
        }
        case "FORK_PROGRAM": {
          const parent = this.programs.get(action.programId);
          if (!parent || !this.caps.programForking)
            return this.reject(agent, action, "Forking unavailable");
          if (!(
            parent.authorId === agent.id ||
            agent.observedPrograms.has(parent.id) ||
            agent.inheritedPrograms.has(parent.id)
          ))
            return this.reject(
              agent,
              action,
              "Parent program not empirically grounded",
            );
          if (sha256(parent.instructions) === sha256(action.instructions))
            return this.reject(
              agent,
              action,
              "Fork must change an instruction",
            );
          const child = makeProgram(action.instructions, agent.id, parent.id);
          this.programs.set(child.id, child);
          agent.authoredPrograms.add(child.id);
          this.accept(
            agent,
            action,
            { programId: child.id, parentId: parent.id },
            child.id,
          );
          return;
        }
        case "REPAIR": {
          const artifact = this.artifacts.find(
            (a) => a.id === action.artifactId && a.active,
          );
          if (!artifact || distance(agent.position, artifact.position) > 1.5)
            return this.reject(agent, action, "Artifact unavailable locally");
          const resource = (Object.keys(agent.inventory) as ResourceId[]).find(
            (r) => (agent.inventory[r] ?? 0) > 0,
          );
          if (!resource)
            return this.reject(agent, action, "Repair needs embodied material");
          const amount = Math.min(
            0.25,
            Math.max(0, action.amount),
            agent.inventory[resource]!,
            1 - artifact.health,
          );
          agent.inventory[resource]! -= amount;
          artifact.health += amount;
          if (!artifact.contributors.includes(agent.id))
            artifact.contributors.push(agent.id);
          this.accept(agent, action, { amount, resource }, artifact.id);
          return;
        }
        case "DISMANTLE": {
          const artifact = this.artifacts.find(
            (a) => a.id === action.artifactId && a.active,
          );
          if (!artifact || distance(agent.position, artifact.position) > 1.5)
            return this.reject(agent, action, "Artifact unavailable locally");
          artifact.active = false;
          this.accept(agent, action, {}, artifact.id);
          return;
        }
        case "COMMUNICATE": {
          if (!this.caps.communication)
            return this.reject(
              agent,
              action,
              "Communication disabled by treatment",
            );
          if (
            action.recipientId &&
            !this.agents.some(
              (a) =>
                a.id === action.recipientId &&
                distance(a.position, agent.position) <=
                  this.config.world.observationRadius,
            )
          )
            return this.reject(agent, action, "Recipient is not nearby");
          const id = `message_${sha256({ tick: this.tick, sender: agent.id, text: action.text, n: this.messages.length }).slice(0, 16)}`;
          const message: Message = {
            id,
            tick: this.tick,
            senderId: agent.id,
            position: { ...agent.position },
            text: action.text,
            ...(action.recipientId ? { recipientId: action.recipientId } : {}),
            ...(action.replyTo ? { replyTo: action.replyTo } : {}),
          };
          this.messages.push(message);
          if (action.recipientId)
            this.agents
              .find((a) => a.id === action.recipientId)
              ?.pendingMessages.push(id);
          this.accept(agent, action, { messageId: id }, action.recipientId);
          return;
        }
        case "PUBLISH": {
          if (!this.caps.publication)
            return this.reject(
              agent,
              action,
              "Publication disabled by treatment",
            );
          if (
            action.evidenceIds.some(
              (id) => !agent.memory.some((m) => m.id === id),
            )
          )
            return this.reject(
              agent,
              action,
              "Publication cites unowned evidence",
            );
          const id = `publication_${sha256({ tick: this.tick, author: agent.id, title: action.title }).slice(0, 16)}`;
          this.publications.push({
            id,
            tick: this.tick,
            authorId: agent.id,
            title: action.title,
            body: action.body,
            evidenceIds: action.evidenceIds,
          });
          this.accept(agent, action, { publicationId: id }, id);
          return;
        }
        case "TEACH": {
          if (!this.caps.teaching)
            return this.reject(agent, action, "Teaching disabled by treatment");
          const recipient = this.agents.find(
            (a) => a.id === action.recipientId,
          );
          if (
            !recipient ||
            distance(recipient.position, agent.position) >
              this.config.world.observationRadius
          )
            return this.reject(agent, action, "Recipient not nearby");
          const records = agent.memory.filter((m) =>
            action.recordIds.includes(m.id),
          );
          if (records.length !== action.recordIds.length)
            return this.reject(agent, action, "Teaching cites unknown records");
          for (const programId of action.programIds) {
            if (
              !agent.authoredPrograms.has(programId) &&
              !agent.inheritedPrograms.has(programId)
            )
              return this.reject(agent, action, "Program not teachable");
            recipient.inheritedPrograms.add(programId);
          }
          recipient.memory.push(
            ...records.map((m) => ({
              ...structuredClone(m),
              kind: "taught_evidence",
            })),
          );
          this.accept(
            agent,
            action,
            { recordIds: action.recordIds, programIds: action.programIds },
            recipient.id,
          );
          return;
        }
        case "TRADE": {
          if (!this.caps.trade)
            return this.reject(agent, action, "Trade disabled by treatment");
          const recipient = this.agents.find(
            (a) => a.id === action.recipientId,
          );
          if (!recipient || distance(recipient.position, agent.position) > 1.5)
            return this.reject(agent, action, "Trade requires co-location");
          const amount = Math.min(
            Math.max(0, action.amount),
            agent.inventory[action.resource] ?? 0,
          );
          if (amount <= 0)
            return this.reject(agent, action, "Resource not possessed");
          agent.inventory[action.resource] =
            (agent.inventory[action.resource] ?? 0) - amount;
          recipient.inventory[action.resource] =
            (recipient.inventory[action.resource] ?? 0) + amount;
          this.accept(
            agent,
            action,
            { resource: action.resource, amount },
            recipient.id,
          );
          return;
        }
        case "CLAIM_TASK":
          if (!this.caps.taskClaims)
            return this.reject(
              agent,
              action,
              "Task claims disabled by treatment",
            );
          this.accept(agent, action);
          return;
      }
    } catch (error) {
      this.reject(
        agent,
        action,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private executeArtifacts(): void {
    for (const artifact of this.artifacts.filter((a) => a.active)) {
      const contamination = this.world.fieldAt(
          "contamination",
          artifact.position,
        ),
        stability = this.world.fieldAt("stability", artifact.position);
      artifact.health = Math.max(
        0,
        artifact.health - 0.006 * contamination - 0.004 * (1 - stability),
      );
      if (artifact.health <= 0) {
        artifact.active = false;
        this.event("artifact_failed", true, undefined, artifact.id);
        continue;
      }
      if (!artifact.programId) continue;
      const program = this.programs.get(artifact.programId);
      if (!program) continue;
      const fieldValues = Object.fromEntries(
        Object.keys(this.world.fields).map((field) => [
          field,
          this.world.fieldAt(field as any, artifact.position),
        ]),
      ) as any;
      const result = executeProgram(program, artifact, {
        fields: fieldValues,
        consumeWater: (amount) => {
          const available = this.world.fieldAt("water", artifact.position);
          const actual = Math.min(amount, available);
          this.world.setField("water", artifact.position, available - actual);
          return actual;
        },
        removeContamination: (amount) => {
          const available = this.world.fieldAt(
            "contamination",
            artifact.position,
          );
          const actual = Math.min(amount, available);
          this.world.setField(
            "contamination",
            artifact.position,
            available - actual,
          );
          return actual;
        },
      });
      this.event("artifact_program_executed", true, undefined, artifact.id, {
        programId: program.id,
        services: result.services,
        actuators: result.actuators,
      });
    }
  }

  freeze(): FrozenWorld {
    return {
      tick: this.tick,
      world: this.world.snapshot(),
      artifacts: structuredClone(this.artifacts),
      programs: structuredClone([...this.programs.values()]),
    };
  }
}
