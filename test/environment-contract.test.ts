import { describe, expect, it } from "vitest";
import { BioFoundryEnvironment } from "../src/biofoundry-environment.js";
import { parseConfig } from "../src/config.js";
import { EnvironmentSimulator } from "../src/environment-simulator.js";

describe("Environment lifecycle contract", () => {
  it("exposes deterministic BioFoundry behavior through the shared seam", async () => {
    const config = parseConfig({
      seed: 13,
      population: 1,
      ticks: 2,
      macroturnInterval: 2,
      cognition: "heuristic",
      world: { width: 24, height: 18, observationRadius: 3 },
      evaluation: { checkpoints: [2], ticks: 2, seeds: [91] },
    });
    const first = new BioFoundryEnvironment(config);
    const second = new BioFoundryEnvironment(config);
    const agentId = first.simulator.agents[0]!.id;

    expect(await first.observe({ agentId })).toEqual(
      await second.observe({ agentId }),
    );
    expect(
      await first.resolve({ agentId, action: { type: "WAIT" } }),
    ).toMatchObject({ accepted: true });
    await first.advance();
    const frozen = await first.freeze();
    const evaluation = await first.evaluate(frozen);

    expect(frozen.tick).toBe(1);
    expect(evaluation).toHaveLength(1);
    expect(evaluation[0]!.seed).toBe(91);
  });

  it("keeps scheduling generic and delegates consequences to the adapter", async () => {
    const config = parseConfig({
      seed: 14,
      population: 1,
      ticks: 1,
      cognition: "heuristic",
      world: { width: 24, height: 18 },
      evaluation: { checkpoints: [1], ticks: 1, seeds: [92] },
    });
    const environment = new BioFoundryEnvironment(config);
    const agentId = environment.simulator.agents[0]!.id;
    const simulator = new EnvironmentSimulator(
      environment,
      [agentId],
      { macroturnInterval: 1, planLimit: 1 },
      { plan: async () => [{ type: "WAIT" as const }] },
    );

    await simulator.step();

    expect(simulator.events).toHaveLength(1);
    expect(simulator.events[0]!.resolution.accepted).toBe(true);
    expect(simulator.traceHash()).toMatch(/^[a-f0-9]{64}$/);
  });
});
