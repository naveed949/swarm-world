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
    return this.simulator.resolveAgentAction(agentId, action);
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
