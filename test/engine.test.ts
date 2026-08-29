import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { HeuristicCognition } from "../src/cognition.js";
import { RetryableDecisionError, Simulator } from "../src/engine.js";
import type { Cognition } from "../src/cognition.js";
import { evaluateFrozen } from "../src/evaluation.js";

const config = parseConfig({
  seed: 7,
  population: 4,
  ticks: 20,
  macroturnInterval: 4,
  condition: "full",
  cognition: "heuristic",
  world: {
    width: 24,
    height: 18,
    observationRadius: 5,
    disturbanceInterval: 8,
  },
  evaluation: { checkpoints: [20], ticks: 12, seeds: [9] },
});

describe("Simulator", () => {
  it("is deterministic without model nondeterminism", async () => {
    const a = new Simulator(config, new HeuristicCognition()),
      b = new Simulator(config, new HeuristicCognition());
    for (let i = 0; i < 20; i++) {
      await a.step();
      await b.step();
    }
    expect(a.trace.hash()).toBe(b.trace.hash());
    expect(
      a.trace.events.every(
        (event, i) =>
          event.previousDigest ===
          (i ? a.trace.events[i - 1]!.digest : "genesis"),
      ),
    ).toBe(true);
  });
  it("removes cultural actions from the executable treatment contract", async () => {
    const c = parseConfig({ ...config, condition: "no-explicit-culture" });
    const sim = new Simulator(c);
    const agent = sim.agents[0]!;
    agent.queue = [{ type: "COMMUNICATE", text: "claim" }];
    await sim.step();
    expect(
      sim.trace.events.some(
        (e) =>
          e.type === "action_rejected" &&
          (e.data.reason as string).includes("disabled"),
      ),
    ).toBe(true);
  });
  it("evaluates frozen artifacts without agents or cognition", () => {
    const sim = new Simulator(config);
    const results = evaluateFrozen(sim.freeze(), 9201, config);
    expect(results.seed).toBe(9201);
    expect(results.resilienceAuc).toBe(0);
  });
  it("grounds ordered recipes at each required workstation", async () => {
    const sim = new Simulator(config);
    const agent = sim.agents[0]!;
    const wash = sim.world.facilities.findIndex((value) => value === "WASH");
    const dry = sim.world.facilities.findIndex((value) => value === "DRY");
    const align = sim.world.facilities.findIndex((value) => value === "ALIGN");
    agent.position = sim.world.point(wash);
    agent.inventory.CELLULOSE = 1;
    agent.queue = [
      {
        type: "FORMULATE",
        recipe: {
          inputs: { CELLULOSE: 0.8 },
          operations: ["WASH", "DRY"],
          hydration: 0.5,
          porosity: 0.5,
          alignment: 0.5,
          crosslinking: 0.5,
        },
      },
    ];
    await sim.step();
    expect(agent.inventory.CELLULOSE).toBeCloseTo(0.2);
    expect(agent.pendingBatches).toHaveLength(1);
    const pendingId = agent.pendingBatches[0]!.id;

    agent.position = sim.world.point(align);
    agent.queue = [{ type: "PROCESS", pendingBatchId: pendingId }];
    await sim.step();
    expect(agent.pendingBatches[0]!.nextOperationIndex).toBe(1);

    agent.position = sim.world.point(dry);
    agent.queue = [{ type: "PROCESS", pendingBatchId: pendingId }];
    await sim.step();
    expect(agent.pendingBatches).toHaveLength(0);
    expect(agent.batches).toHaveLength(1);
    expect(agent.batches[0]!.recipe.operations).toEqual(["WASH", "DRY"]);
  });
  it("supports conserved shared-depot deposit and withdrawal", async () => {
    const sim = new Simulator(config);
    const depositor = sim.agents[0]!;
    const adopter = sim.agents[1]!;
    adopter.position = depositor.position;
    depositor.inventory.CHITIN = 0.6;
    depositor.queue = [{ type: "DEPOSIT", resource: "CHITIN", amount: 0.4 }];
    await sim.step();
    adopter.queue = [{ type: "WITHDRAW", resource: "CHITIN", amount: 0.25 }];
    await sim.step();
    const depot = sim.world.depots[sim.world.index(adopter.position)]!;
    expect(depositor.inventory.CHITIN).toBeCloseTo(0.2);
    expect(adopter.inventory.CHITIN).toBeCloseTo(0.25);
    expect(depot.CHITIN).toBeCloseTo(0.15);
  });
  it("does not advance world time on retryable cognition failures", async () => {
    const failing: Cognition = {
      plan: async () => {
        throw new Error("transport unavailable");
      },
    };
    const sim = new Simulator(config, failing);
    await expect(sim.step()).rejects.toBeInstanceOf(RetryableDecisionError);
    expect(sim.tick).toBe(0);
    expect(sim.agents.every((a) => a.queue.length === 0)).toBe(true);
  });
});
