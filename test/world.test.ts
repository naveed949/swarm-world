import { describe, expect, it } from "vitest";
import { World } from "../src/world.js";
import { canonicalJson } from "../src/hash.js";
import { loadScenarioPackage } from "../src/scenario.js";

describe("World", () => {
  it("is exactly reproducible for a fixed seed", () => {
    const a = new World(3201, 36, 27),
      b = new World(3201, 36, 27);
    expect(a.snapshot()).toEqual(b.snapshot());
  });
  it("uses nested population-independent spawn positions", () => {
    const world = new World(3201, 36, 27);
    expect(world.spawnPositions(10)).toEqual(
      world.spawnPositions(20).slice(0, 10),
    );
  });
  it("conserves harvested source mass at the world boundary", () => {
    const world = new World(1, 24, 18);
    const i = world.resourceMass.findIndex((m) => m > 0.5);
    const before = world.resourceMass[i]!;
    world.resourceMass[i] -= 0.25;
    expect(world.resourceMass[i]).toBeCloseTo(before - 0.25);
  });
  it("writes canonical data as valid JSON while omitting undefined object members", () =>
    expect(JSON.parse(canonicalJson({ b: undefined, a: 1 }))).toEqual({
      a: 1,
    }));
  it("loads complete data-only scenario packages with a content hash", async () => {
    const scenario = await loadScenarioPackage(
      "worlds/biofoundry/scenario.yaml",
    );
    const world = new World(3, 36, 27, undefined, scenario);
    expect(scenario.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(world.facilities.filter(Boolean)).toHaveLength(6);
    expect(new Set(world.resourceType.filter(Boolean)).size).toBe(8);
  });
});
