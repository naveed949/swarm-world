import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Ajv, { type ValidateFunction } from "ajv";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const schemaPath = join(root, "schemas/portfolio-scored-report.schema.json");
const fixturePath = join(root, "runs/portfolio/report.json");

const serviceIds = [
  "water",
  "remediation",
  "stability",
  "healing",
  "nutrient",
] as const;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function gitIgnored(path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "--no-index", "-q", path], {
      cwd: root,
    });
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 1
    )
      return false;
    throw error;
  }
}

function assertObjectsClosed(schema: unknown, path = "$"): void {
  if (Array.isArray(schema)) {
    schema.forEach((item, index) =>
      assertObjectsClosed(item, `${path}[${index}]`),
    );
    return;
  }
  if (typeof schema !== "object" || schema === null) return;
  const record = schema as Record<string, unknown>;
  const isObjectSchema = record.type === "object";
  if (isObjectSchema) expect(record.additionalProperties, path).toBe(false);
  for (const [key, value] of Object.entries(record)) {
    if (key === "additionalProperties") continue;
    assertObjectsClosed(value, `${path}.${key}`);
  }
}

function services(value: number): Record<(typeof serviceIds)[number], number> {
  return Object.fromEntries(serviceIds.map((id) => [id, value])) as Record<
    (typeof serviceIds)[number],
    number
  >;
}

function meanStd(mean: number, std: number) {
  return { mean, std };
}

function serviceMeanStd(mean: number, std: number) {
  return Object.fromEntries(serviceIds.map((id) => [id, meanStd(mean, std)]));
}

describe("portfolio scored report scaffold", () => {
  let validate: ValidateFunction;

  beforeAll(async () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    validate = ajv.compile(await readJson(schemaPath));
  });

  it("closes every object schema with additionalProperties false", async () => {
    assertObjectsClosed(await readJson(schemaPath));
  });

  it("accepts the unscored placeholder and rejects measured stand-ins", async () => {
    const fixture = await readJson(fixturePath);
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      status: "unscored",
      cognition: "heuristic",
      worldSeeds: [],
      trialsPerSeed: null,
      aggregates: null,
      trials: [],
    });

    const scoredStandIn = {
      ...(fixture as Record<string, unknown>),
      aggregates: {
        discoveryFrontierAuc: meanStd(0.5, 0.1),
        bestArtifactPerformance: meanStd(0.5, 0.1),
        evaluations: {},
      },
    };
    expect(validate(scoredStandIn)).toBe(false);

    const dishonest = {
      ...(fixture as Record<string, unknown>),
      status: "scored",
      aggregates: null,
      trials: [],
      worldSeeds: [],
    };
    expect(validate(dishonest)).toBe(false);
  });

  it("rejects fields outside the SwarmWorld evaluation seam", async () => {
    const fixture = (await readJson(fixturePath)) as Record<string, unknown>;
    expect(validate({ ...fixture, adaptiveSandboxQualified: true })).toBe(
      false,
    );
    expect(validate({ ...fixture, status: "Soft-PASS" })).toBe(false);
    expect(validate({ ...fixture, authorityFlip: 1 })).toBe(false);
    expect(validate({ ...fixture, ece: 0 })).toBe(false);
  });

  it("accepts a synthetic scored shape without treating it as a measured run", () => {
    // Zeros lock the scored shape only. They are not a measured portfolio result.
    const evaluation = {
      seed: 9201,
      resilienceAuc: 0,
      serviceAuc: services(0),
      finalCoverage: services(0),
    };
    const synthetic = {
      schemaVersion: 1,
      status: "scored",
      condition: "full",
      cognition: "heuristic",
      worldSeeds: [1, 2, 3],
      trialsPerSeed: 1,
      aggregates: {
        discoveryFrontierAuc: meanStd(0, 0),
        bestArtifactPerformance: meanStd(0, 0),
        evaluations: {
          "12": [
            {
              seed: 9201,
              resilienceAuc: meanStd(0, 0),
              serviceAuc: serviceMeanStd(0, 0),
              finalCoverage: serviceMeanStd(0, 0),
            },
          ],
        },
      },
      trials: [1, 2, 3].map((worldSeed) => ({
        worldSeed,
        trial: 0,
        runId: `shape-only-s${worldSeed}`,
        configHash: "a".repeat(64),
        traceHash: "b".repeat(64),
        events: 0,
        artifacts: 0,
        programs: 0,
        discoveryFrontierAuc: 0,
        bestArtifactPerformance: 0,
        evaluations: { "12": [evaluation] },
      })),
      note: "Schema shape only. Not a measured portfolio result.",
    };
    expect(validate(synthetic), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...synthetic, worldSeeds: [1, 2] })).toBe(false);
    expect(
      validate({
        ...synthetic,
        trials: [
          {
            ...synthetic.trials[0],
            evaluations: { checkpoint: [evaluation] },
          },
        ],
      }),
    ).toBe(false);
  });

  it("tracks only the portfolio runs path", async () => {
    expect(await gitIgnored("runs/portfolio/report.json")).toBe(false);
    expect(await gitIgnored("runs/portfolio/later/summary.json")).toBe(false);
    expect(await gitIgnored("runs/summary.json")).toBe(true);
    expect(await gitIgnored("runs/sandcastle-container/summary.json")).toBe(
      true,
    );
    expect(await gitIgnored("runs/other/summary.json")).toBe(true);
  });

  it("keeps Soft-PASS and AdaptiveSandbox out of the report artifacts", async () => {
    const schemaText = await readFile(schemaPath, "utf8");
    const fixtureText = await readFile(fixturePath, "utf8");
    for (const text of [schemaText, fixtureText]) {
      expect(text).not.toContain("Soft-PASS");
      expect(text).not.toContain("adaptiveSandboxQualified");
      expect(text).not.toContain("authorityFlip");
    }
  });

  it("states the portfolio honesty non-claims and reproduce stub", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const section = readme
      .split(/^## /m)
      .find((part) => part.startsWith("Portfolio evaluation"));
    expect(section).toBeDefined();
    expect(section).toContain("Soft-PASS is unused.");
    expect(section).toContain("adaptiveSandboxQualified");
    expect(section).toContain(
      "SwarmWorld paper claims are separate from portfolio evaluation.",
    );
    expect(section).toContain("Reproduce commands (stub)");
    expect(section).toContain(
      "node dist/cli.js run --config examples/minimal.yaml --output runs",
    );
    expect(section).toContain("do not write a scored `runs/portfolio/` report");
    expect(section).toMatch(/unscored/i);
  });
});
