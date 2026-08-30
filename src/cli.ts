#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { runExperiment } from "./experiment.js";
import { sha256 } from "./hash.js";
import { runRepositoryExperiment } from "./repository-experiment.js";
import { loadRunConfig } from "./run-config.js";

const program = new Command()
  .name("swarm-world")
  .description("Persistent materially grounded LLM-agent societies")
  .version("0.1.0");

program
  .command("run")
  .requiredOption("-c, --config <path>", "YAML experiment configuration")
  .option("-o, --output <dir>", "output directory", "runs")
  .action(async ({ config, output }) => {
    const resolved = await loadRunConfig(config);
    if (resolved.type === "repository") {
      console.error(
        `Running repository ${resolved.config.condition}, N=${resolved.config.population}, T=${resolved.config.ticks}`,
      );
      const result = await runRepositoryExperiment(resolved.config, output);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const biofoundry = resolved.config;
    console.error(
      `Running ${biofoundry.condition}, N=${biofoundry.population}, T=${biofoundry.ticks}, cognition=${biofoundry.cognition}`,
    );
    const result = await runExperiment(biofoundry, output);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program
  .command("matrix")
  .requiredOption("-c, --config <path>", "base YAML configuration")
  .option("-o, --output <dir>", "output directory", "runs")
  .option(
    "--conditions <list>",
    "comma-separated conditions",
    "full,no-communication,no-explicit-culture,independent",
  )
  .option("--populations <list>", "comma-separated populations", "50,100,200")
  .option("--seeds <list>", "comma-separated seeds", "3201,3202,3203,3204")
  .action(async (opts) => {
    const loaded = await loadRunConfig(opts.config);
    if (loaded.type === "repository")
      throw new Error(
        "Repository matrices require an explicit planner and isolated run configuration",
      );
    const base = loaded.config;
    const results = [];
    for (const condition of opts.conditions.split(","))
      for (const population of opts.populations.split(",").map(Number))
        for (const seed of opts.seeds.split(",").map(Number)) {
          const config = {
            ...structuredClone(base),
            condition,
            population,
            seed,
          } as typeof base;
          console.error(`Running ${condition}, N=${population}, seed=${seed}`);
          results.push((await runExperiment(config, opts.output)).summary);
        }
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  });

program
  .command("verify")
  .argument("<trace>", "trace JSONL path")
  .action(async (path) => {
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const manifest = lines[0];
    if (manifest?.type !== "manifest")
      throw new Error("Trace does not begin with a manifest");
    if (manifest.environmentType === "repository") {
      const environmentEvents = lines
        .slice(1)
        .filter((line) => line.recordType === "environment")
        .map((line) => line.event);
      const schedulerEvents = lines
        .slice(1)
        .filter((line) => line.recordType === "scheduler")
        .map((line) => line.event);
      const actual = sha256({ schedulerEvents, environmentEvents });
      const expected = manifest.summary.traceHash;
      const valid = actual === expected;
      process.stdout.write(
        `${JSON.stringify({ valid, expected, actual, events: environmentEvents.length + schedulerEvents.length }, null, 2)}\n`,
      );
      if (!valid) process.exitCode = 1;
      return;
    }
    const events = lines.slice(1).map((line) => line.event);
    const hash = sha256({
      config: manifest.config,
      manifest: manifest.manifest,
      events,
    });
    const valid = hash === manifest.summary.traceHash;
    process.stdout.write(
      `${JSON.stringify({ valid, expected: manifest.summary.traceHash, actual: hash, events: events.length }, null, 2)}\n`,
    );
    if (!valid) process.exitCode = 1;
  });

await program.parseAsync();
