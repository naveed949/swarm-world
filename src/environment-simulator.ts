import type { Environment, EnvironmentResolution } from "./environment.js";
import { sha256 } from "./hash.js";

export interface EnvironmentPlanner<Observation, Action> {
  /** True only when each plan call consumes one configured model invocation. */
  modelBacked?: boolean;
  plan(input: {
    agentId: string;
    tick: number;
    observation: Observation;
  }): Promise<Action[]>;
}

export interface EnvironmentSimulatorConfig {
  macroturnInterval: number;
  planLimit: number;
  maxModelCalls?: number;
}

export interface EnvironmentSimulatorEvent<Action> {
  tick: number;
  agentId: string;
  action: Action;
  resolution: EnvironmentResolution;
  previousDigest: string;
  digest: string;
}

/** Domain-neutral scheduling core. All consequences remain environment-owned. */
export class EnvironmentSimulator<Observation, Action, Frozen, Evaluation> {
  tick = 0;
  modelCalls = 0;
  readonly events: Array<EnvironmentSimulatorEvent<Action>> = [];
  private readonly queues = new Map<string, Action[]>();
  private readonly orderedAgentIds: string[];
  private previousDigest = "genesis";

  constructor(
    readonly environment: Environment<Observation, Action, Frozen, Evaluation>,
    readonly agentIds: string[],
    readonly config: EnvironmentSimulatorConfig,
    readonly planner?: EnvironmentPlanner<Observation, Action>,
  ) {
    if (config.macroturnInterval < 1 || config.planLimit < 1)
      throw new Error("Simulator scheduling limits must be positive");
    this.orderedAgentIds = [...agentIds].sort();
    for (const id of this.orderedAgentIds) this.queues.set(id, []);
  }

  async step(): Promise<void> {
    if (this.planner) {
      const scheduled = this.orderedAgentIds.filter(
        (_, index) =>
          (this.tick - (index % this.config.macroturnInterval)) %
            this.config.macroturnInterval ===
          0,
      );
      const remainingModelCalls = this.planner.modelBacked
        ? Math.max(
            0,
            (this.config.maxModelCalls ?? Number.POSITIVE_INFINITY) -
              this.modelCalls,
          )
        : Number.POSITIVE_INFINITY;
      const due = scheduled.slice(0, remainingModelCalls);
      const proposals = await Promise.all(
        due.map(async (agentId) => ({
          agentId,
          actions: await this.planner!.plan({
            agentId,
            tick: this.tick,
            observation: await this.environment.observe({ agentId }),
          }),
        })),
      );
      if (this.planner.modelBacked) this.modelCalls += due.length;
      for (const proposal of proposals)
        this.queues.set(
          proposal.agentId,
          proposal.actions.slice(0, this.config.planLimit),
        );
    }
    for (const agentId of this.orderedAgentIds) {
      const action = this.queues.get(agentId)?.shift();
      if (action === undefined) continue;
      const resolution = await this.environment.resolve({ agentId, action });
      const base = {
        tick: this.tick,
        agentId,
        action: structuredClone(action),
        resolution: structuredClone(resolution),
        previousDigest: this.previousDigest,
      };
      const event = { ...base, digest: sha256(base) };
      this.previousDigest = event.digest;
      this.events.push(event);
    }
    await this.environment.advance();
    this.tick++;
  }

  freeze(): Frozen | Promise<Frozen> {
    return this.environment.freeze();
  }

  evaluate(frozen: Frozen): Evaluation | Promise<Evaluation> {
    return this.environment.evaluate(frozen);
  }

  traceHash(): string {
    return sha256(this.events);
  }
}
