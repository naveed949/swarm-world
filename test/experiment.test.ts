import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { runExperiment } from "../src/experiment.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true });
  directory = undefined;
});
const makeConfig = (condition: "full" | "independent") =>
  parseConfig({
    seed: 11,
    population: 2,
    ticks: 12,
    macroturnInterval: 3,
    planLimit: 4,
    condition,
    cognition: "heuristic",
    world: {
      width: 24,
      height: 18,
      observationRadius: 4,
      disturbanceInterval: 6,
    },
    evaluation: { checkpoints: [12], ticks: 8, seeds: [99] },
  });

describe("experiment runner", () => {
  it("persists a self-verifiable shared trace and summary", async () => {
    directory = await mkdtemp(join(tmpdir(), "swarm-world-test-"));
    const result = await runExperiment(makeConfig("full"), directory);
    const trace = await readFile(result.tracePath, "utf8");
    expect(trace).toContain(result.summary.traceHash);
    expect(result.summary.evaluations[12]).toHaveLength(1);
  });
  it("builds an endpoint-wise best-of-N isolated envelope", async () => {
    directory = await mkdtemp(join(tmpdir(), "swarm-world-test-"));
    const result = await runExperiment(makeConfig("independent"), directory);
    expect(result.summary.runId).toContain("independent-n2");
    expect(result.summary.evaluations[12]).toHaveLength(1);
    expect(result.summary.traceHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
