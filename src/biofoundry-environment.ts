import type { Cognition } from "./cognition.js";
import { Simulator } from "./engine.js";
import type { Environment, EnvironmentResolution } from "./environment.js";
import { evaluateFrozen } from "./evaluation.js";
import type {
  Action,
  EvaluationResult,
  ExperimentConfig,
  FrozenWorld,
  LocalObservation,
} from "./types.js";

/** Compatibility adapter that exposes BioFoundry through the shared lifecycle. */
export class BioFoundryEnvironment implements Environment<
  LocalObservation,
  Action,
  FrozenWorld,
  EvaluationResult[]
> {
  readonly simulator: Simulator;

  constructor(
    readonly config: ExperimentConfig,
    cognition?: Cognition,
  ) {
    this.simulator = new Simulator(config, cognition);
  }

  observe({ agentId }: { agentId: string }): LocalObservation {
    return this.simulator.observeAgent(agentId);
  }

  resolve({
    agentId,
    action,
  }: {
    agentId: string;
    action: Action;
  }): EnvironmentResolution {
    const agent = this.simulator.agents.find(
      (candidate) => candidate.id === agentId,
    );
    if (!agent) throw new Error(`Unknown BioFoundry agent: ${agentId}`);
    const before = this.simulator.trace.events.length;
    this.simulator.resolveAction(agent, action);
    const events = this.simulator.trace.events.slice(before);
    const result = events.at(-1);
    return {
      accepted: result?.success ?? false,
      ...(result?.targetId ? { targetId: result.targetId } : {}),
      ...(!result?.success && typeof result?.data.reason === "string"
        ? { reason: result.data.reason }
        : {}),
      evidenceIds: events.map((event) => event.id),
    };
  }

  advance(): void {
    this.simulator.advanceEnvironment();
  }

  freeze(): FrozenWorld {
    return this.simulator.freeze();
  }

  evaluate(frozen: FrozenWorld): EvaluationResult[] {
    return this.config.evaluation.seeds.map((seed) =>
      evaluateFrozen(frozen, seed, this.config),
    );
  }
}
