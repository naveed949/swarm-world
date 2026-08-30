export interface EnvironmentRequest<Action> {
  agentId: string;
  action: Action;
}

export interface EnvironmentResolution {
  accepted: boolean;
  reason?: string;
  targetId?: string;
  evidenceIds: string[];
}

/** The authoritative lifecycle seam shared by all SwarmWorld domains. */
export interface Environment<Observation, Action, Frozen, Evaluation> {
  observe(input: { agentId: string }): Observation | Promise<Observation>;
  resolve(
    input: EnvironmentRequest<Action>,
  ): EnvironmentResolution | Promise<EnvironmentResolution>;
  advance(): void | Promise<void>;
  freeze(): Frozen | Promise<Frozen>;
  evaluate(frozen: Frozen): Evaluation | Promise<Evaluation>;
}
