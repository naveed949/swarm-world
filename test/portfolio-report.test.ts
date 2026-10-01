import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Ajv, { type ValidateFunction } from "ajv";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runExperiment } from "../src/experiment.js";
import {
  parseTrialsPerSeed,
  parseWorldSeeds,
  portfolioReportFromTrials,
  runPortfolio,
  sampleMeanStd,
  type PortfolioTrial,
} from "../src/portfolio.js";

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

const serviceFields = [
  "water",
  "remediation",
  "stability",
  "healing",
  "nutrient",
] as const;

interface CheckedReport {
  schemaVersion: number;
  status: string;
  condition: string;
  cognition: string;
  configPath: string;
  worldSeeds: number[];
  trialsPerSeed: number;
  aggregates: {
    discoveryFrontierAuc: { mean: number; std: number };
    bestArtifactPerformance: { mean: number; std: number };
    evaluations: Record<
      string,
      Array<{
        seed: number;
        resilienceAuc: { mean: number; std: number };
        serviceAuc: Record<string, { mean: number; std: number }>;
        finalCoverage: Record<string, { mean: number; std: number }>;
      }>
    >;
  };
  trials: Array<{
    worldSeed: number;
    trial: number;
    runId: string;
    configHash: string;
    traceHash: string;
    events: number;
    artifacts: number;
    programs: number;
    discoveryFrontierAuc: number;
    bestArtifactPerformance: number;
    evaluations: Record<
      string,
      Array<{
        seed: number;
        resilienceAuc: number;
        serviceAuc: Record<string, number>;
        finalCoverage: Record<string, number>;
      }>
    >;
    validatedInventions?: number;
  }>;
  note: string;
}

function independentMeanStd(values: number[]): { mean: number; std: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return { mean, std: 0 };
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return { mean, std: Math.sqrt(variance) };
}

let validate: ValidateFunction;

beforeAll(async () => {
  const ajv = new Ajv({ allErrors: true, strict: true });
  validate = ajv.compile(await readJson(schemaPath));
});

describe("portfolio scored report", () => {
  it("closes every object schema with additionalProperties false", async () => {
    assertObjectsClosed(await readJson(schemaPath));
  });

  it("keeps an unscored report empty and refuses a scored report without measurements", () => {
    const unscored = {
      schemaVersion: 1,
      status: "unscored",
      condition: "full",
      cognition: "heuristic",
      configPath: "examples/minimal.yaml",
      worldSeeds: [],
      trialsPerSeed: null,
      aggregates: null,
      trials: [],
      note: "Scoring unavailable. Aggregates stay null.",
    };
    expect(validate(unscored), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({
        ...unscored,
        aggregates: {
          discoveryFrontierAuc: meanStd(0.5, 0.1),
          bestArtifactPerformance: meanStd(0.5, 0.1),
          evaluations: {},
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...unscored,
        status: "scored",
        aggregates: null,
        trials: [],
        worldSeeds: [],
      }),
    ).toBe(false);
  });

  it("accepts the checked-in scored report and recomputes its mean and std", async () => {
    const fixture = (await readJson(fixturePath)) as CheckedReport;
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(fixture.status).toBe("scored");
    expect(fixture.cognition).toBe("heuristic");
    expect(fixture.worldSeeds.length).toBeGreaterThanOrEqual(3);
    expect(fixture.trialsPerSeed).toBeGreaterThanOrEqual(1);
    expect(fixture.trials).toHaveLength(
      fixture.worldSeeds.length * fixture.trialsPerSeed,
    );
    for (const worldSeed of fixture.worldSeeds) {
      const trials = fixture.trials.filter(
        (trial) => trial.worldSeed === worldSeed,
      );
      expect(trials).toHaveLength(fixture.trialsPerSeed);
      expect(trials.map((trial) => trial.trial)).toEqual(
        Array.from({ length: fixture.trialsPerSeed }, (_, index) => index),
      );
    }
    expect(fixture.aggregates.discoveryFrontierAuc).toEqual(
      independentMeanStd(
        fixture.trials.map((trial) => trial.discoveryFrontierAuc),
      ),
    );
    expect(fixture.aggregates.bestArtifactPerformance).toEqual(
      independentMeanStd(
        fixture.trials.map((trial) => trial.bestArtifactPerformance),
      ),
    );
    for (const [checkpoint, aggregates] of Object.entries(
      fixture.aggregates.evaluations,
    )) {
      for (const aggregate of aggregates) {
        const rows = fixture.trials.map((trial) => {
          const row = trial.evaluations[checkpoint]?.find(
            (item) => item.seed === aggregate.seed,
          );
          expect(row).toBeDefined();
          return row!;
        });
        expect(aggregate.resilienceAuc).toEqual(
          independentMeanStd(rows.map((row) => row.resilienceAuc)),
        );
        for (const field of ["serviceAuc", "finalCoverage"] as const)
          for (const service of serviceFields)
            expect(aggregate[field][service]).toEqual(
              independentMeanStd(rows.map((row) => row[field][service]!)),
            );
      }
    }
    expect(fixture.note).toContain("n-1");
    expect(fixture.note).toContain("evaluateFrozen");
    expect(fixture.note).toContain("not a published SwarmWorld paper figure");
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
    expect(await gitIgnored("runs/portfolio-work/summary.json")).toBe(true);
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

  it("states measured mean±std, the reproduce command, and the unscored refusal", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const section = readme
      .split(/^## /m)
      .find((part) => part.startsWith("Portfolio evaluation"));
    const fixture = (await readJson(fixturePath)) as CheckedReport;
    expect(section).toBeDefined();
    expect(section).toContain("Soft-PASS is unused.");
    expect(section).toContain("adaptiveSandboxQualified");
    expect(section).toContain(
      "SwarmWorld paper claims are separate from portfolio evaluation.",
    );
    expect(section).toContain("unscored");
    expect(section).toContain("not a pass");
    expect(section).not.toContain("Reproduce commands (stub)");
    expect(section).not.toContain(
      "do not write a scored `runs/portfolio/` report",
    );
    expect(section).toContain(
      `node dist/cli.js portfolio --config ${fixture.configPath} --seeds ${fixture.worldSeeds.join(",")} --trials ${fixture.trialsPerSeed} --output runs/portfolio/report.json`,
    );
    expect(section).toContain(
      `${fixture.aggregates.discoveryFrontierAuc.mean} ± ${fixture.aggregates.discoveryFrontierAuc.std}`,
    );
    expect(section).toContain(
      `${fixture.aggregates.bestArtifactPerformance.mean} ± ${fixture.aggregates.bestArtifactPerformance.std}`,
    );
    for (const aggregates of Object.values(fixture.aggregates.evaluations))
      for (const aggregate of aggregates)
        expect(section).toContain(
          `${aggregate.resilienceAuc.mean} ± ${aggregate.resilienceAuc.std}`,
        );
  });
});

const portfolioYaml = `seed: 1
population: 4
ticks: 80
macroturnInterval: 8
planLimit: 8
condition: full
cognition: heuristic
world:
  width: 24
  height: 18
  observationRadius: 5
  disturbanceInterval: 16
evaluation:
  checkpoints: [40, 80]
  ticks: 24
  seeds: [9201, 9202]
`;

describe("portfolio runner", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("copies evaluateFrozen scores and writes schema-valid mean±std", async () => {
    directory = await mkdtemp(join(tmpdir(), "swarm-portfolio-"));
    const configPath = join(directory, "portfolio.yaml");
    await writeFile(configPath, portfolioYaml);
    const outputPath = join(directory, "report.json");
    const report = await runPortfolio({
      configPath,
      worldSeeds: [3201, 3202, 3203],
      trialsPerSeed: 2,
      outputPath,
      workDir: join(directory, "work"),
    });
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.trials).toHaveLength(6);
    expect(
      report.trials.some(
        (trial) =>
          trial.discoveryFrontierAuc > 0 ||
          Object.values(trial.evaluations).some((rows) =>
            rows.some((row) => row.resilienceAuc > 0),
          ),
      ),
    ).toBe(true);
    const repeated = report.trials.filter((trial) => trial.worldSeed === 3201);
    expect(repeated[0]?.traceHash).toBe(repeated[1]?.traceHash);
    expect(repeated[0]?.evaluations).toEqual(repeated[1]?.evaluations);
    const directConfig = {
      ...structuredClone(await loadConfig(configPath)),
      seed: 3201,
    };
    const direct = await runExperiment(directConfig, join(directory, "direct"));
    expect(repeated[0]?.discoveryFrontierAuc).toBe(
      direct.summary.discoveryFrontierAuc,
    );
    expect(repeated[0]?.bestArtifactPerformance).toBe(
      direct.summary.bestArtifactPerformance,
    );
    expect(repeated[0]?.traceHash).toBe(direct.summary.traceHash);
    expect(repeated[0]?.configHash).toBe(direct.summary.configHash);
    expect(repeated[0]?.evaluations).toEqual(
      Object.fromEntries(
        Object.entries(direct.summary.evaluations).map(([checkpoint, rows]) => [
          checkpoint,
          rows,
        ]),
      ),
    );
    expect(report.aggregates.discoveryFrontierAuc).toEqual(
      sampleMeanStd(report.trials.map((trial) => trial.discoveryFrontierAuc)),
    );
    const written = await readJson(outputPath);
    expect(written).toEqual(report);
  });

  it("matches the checked-in first trial to a fresh heuristic run", async () => {
    const fixture = (await readJson(fixturePath)) as CheckedReport;
    const first = fixture.trials[0];
    expect(first).toBeDefined();
    directory = await mkdtemp(join(tmpdir(), "swarm-portfolio-check-"));
    const config = {
      ...structuredClone(await loadConfig(join(root, fixture.configPath))),
      seed: first!.worldSeed,
    };
    const direct = await runExperiment(config, directory);
    expect(first!.discoveryFrontierAuc).toBe(
      direct.summary.discoveryFrontierAuc,
    );
    expect(first!.bestArtifactPerformance).toBe(
      direct.summary.bestArtifactPerformance,
    );
    expect(first!.traceHash).toBe(direct.summary.traceHash);
    expect(first!.configHash).toBe(direct.summary.configHash);
    expect(first!.events).toBe(direct.summary.events);
    expect(first!.artifacts).toBe(direct.summary.artifacts);
    expect(first!.programs).toBe(direct.summary.programs);
    expect(first!.evaluations).toEqual(direct.summary.evaluations);
    expect(first!.validatedInventions).toBe(
      (direct.summary as { validatedInventions?: number }).validatedInventions,
    );
    const twin = fixture.trials.find(
      (trial) => trial.worldSeed === first!.worldSeed && trial.trial === 1,
    );
    expect(twin?.traceHash).toBe(first!.traceHash);
  });

  it("refuses provider cognition and does not write a report", async () => {
    directory = await mkdtemp(join(tmpdir(), "swarm-portfolio-pi-"));
    const configPath = join(directory, "pi.yaml");
    await writeFile(
      configPath,
      portfolioYaml.replace("cognition: heuristic", "cognition: pi"),
    );
    const outputPath = join(directory, "report.json");
    await expect(
      runPortfolio({
        configPath,
        worldSeeds: [1, 2, 3],
        trialsPerSeed: 1,
        outputPath,
        workDir: join(directory, "work"),
      }),
    ).rejects.toThrow(/heuristic/);
    await expect(readFile(outputPath, "utf8")).rejects.toThrow();
  });

  it("refuses fewer than three seeds, duplicate seeds, and portfolio work dirs", async () => {
    expect(() => parseWorldSeeds("1, 2, x")).toThrow(/Invalid world seed/);
    expect(parseWorldSeeds("3201,3202,3203")).toEqual([3201, 3202, 3203]);
    expect(() => parseTrialsPerSeed("0")).toThrow(/positive integer/);
    expect(parseTrialsPerSeed("2")).toBe(2);
    directory = await mkdtemp(join(tmpdir(), "swarm-portfolio-refuse-"));
    const configPath = join(directory, "portfolio.yaml");
    await writeFile(configPath, portfolioYaml);
    await expect(
      runPortfolio({
        configPath,
        worldSeeds: [1, 2],
        trialsPerSeed: 1,
        outputPath: join(directory, "report.json"),
        workDir: join(directory, "work"),
      }),
    ).rejects.toThrow(/at least 3 world seeds/);
    expect(() =>
      portfolioReportFromTrials({
        condition: "full",
        configPath: "examples/minimal.yaml",
        worldSeeds: [1, 1, 2],
        trialsPerSeed: 1,
        trials: [],
      }),
    ).toThrow(/unique/);
    await expect(
      runPortfolio({
        configPath,
        worldSeeds: [1, 2, 3],
        trialsPerSeed: 1,
        outputPath: join(directory, "report.json"),
        workDir: join("runs/portfolio", "raw"),
      }),
    ).rejects.toThrow(/outside runs\/portfolio/);
  });

  it("rejects trials that do not share checkpoints", () => {
    const trial = {
      worldSeed: 1,
      trial: 0,
      runId: "shape",
      configHash: "a".repeat(64),
      traceHash: "b".repeat(64),
      events: 1,
      artifacts: 0,
      programs: 0,
      discoveryFrontierAuc: 1,
      bestArtifactPerformance: 2,
      evaluations: {
        "12": [
          {
            seed: 9,
            resilienceAuc: 0.2,
            serviceAuc: services(0.2),
            finalCoverage: services(0.1),
          },
        ],
      },
    } satisfies PortfolioTrial;
    const trials = [1, 2, 3].map((worldSeed) => ({ ...trial, worldSeed }));
    expect(
      portfolioReportFromTrials({
        condition: "full",
        configPath: "examples/minimal.yaml",
        worldSeeds: [1, 2, 3],
        trialsPerSeed: 1,
        trials,
      }).aggregates.discoveryFrontierAuc,
    ).toEqual({ mean: 1, std: 0 });
    expect(() =>
      portfolioReportFromTrials({
        condition: "full",
        configPath: "examples/minimal.yaml",
        worldSeeds: [1, 2, 3],
        trialsPerSeed: 1,
        trials: [trials[0]!, trials[1]!, { ...trials[2]!, evaluations: {} }],
      }),
    ).toThrow(/checkpoints/);
    expect(() =>
      portfolioReportFromTrials({
        condition: "full",
        configPath: "examples/minimal.yaml",
        worldSeeds: [1, 2, 3],
        trialsPerSeed: 1,
        trials: [
          trials[0]!,
          trials[1]!,
          {
            ...trials[2]!,
            evaluations: {
              "12": [
                {
                  ...trial.evaluations["12"][0]!,
                  seed: 8,
                },
              ],
            },
          },
        ],
      }),
    ).toThrow(/evaluation seeds differ/);
    expect(sampleMeanStd([4])).toEqual({ mean: 4, std: 0 });
    expect(sampleMeanStd([1, 3])).toEqual({ mean: 2, std: Math.sqrt(2) });
  });
});
