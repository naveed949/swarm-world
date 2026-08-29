import { balancedCoverage, portfolioCoverage } from "./metrics.js";
import type {
  ArtifactProgram,
  EvaluationResult,
  ExperimentConfig,
  FieldId,
  FrozenWorld,
  ServiceId,
} from "./types.js";
import { executeProgram } from "./vm.js";
import { World } from "./world.js";

const serviceIds: ServiceId[] = [
  "water",
  "remediation",
  "stability",
  "healing",
  "nutrient",
];

export function evaluateFrozen(
  frozen: FrozenWorld,
  evaluationSeed: number,
  config: ExperimentConfig,
): EvaluationResult {
  const world = World.fromSnapshot(config.seed, frozen.world);
  const artifacts = structuredClone(frozen.artifacts);
  const programs = new Map<string, ArtifactProgram>(
    frozen.programs.map((p) => [p.id, p]),
  );
  const serviceSums = Object.fromEntries(
    serviceIds.map((s) => [s, 0]),
  ) as Record<ServiceId, number>;
  let resilience = 0;
  for (let tick = 0; tick < config.evaluation.ticks; tick++) {
    world.advance(tick);
    if (tick > 0 && tick % config.world.disturbanceInterval === 0)
      world.disturb(evaluationSeed, tick, config.world.disturbanceIntensity);
    for (const artifact of artifacts.filter((a) => a.active)) {
      artifact.health = Math.max(
        0,
        artifact.health -
          0.006 * world.fieldAt("contamination", artifact.position) -
          0.004 * (1 - world.fieldAt("stability", artifact.position)),
      );
      if (artifact.health <= 0) {
        artifact.active = false;
        continue;
      }
      const program = artifact.programId
        ? programs.get(artifact.programId)
        : undefined;
      if (!program) continue;
      const fieldValues = Object.fromEntries(
        Object.keys(world.fields).map((field) => [
          field,
          world.fieldAt(field as FieldId, artifact.position),
        ]),
      ) as Record<FieldId, number>;
      executeProgram(program, artifact, {
        fields: fieldValues,
        consumeWater: (amount) => {
          const v = world.fieldAt("water", artifact.position),
            a = Math.min(v, amount);
          world.setField("water", artifact.position, v - a);
          return a;
        },
        removeContamination: (amount) => {
          const v = world.fieldAt("contamination", artifact.position),
            a = Math.min(v, amount);
          world.setField("contamination", artifact.position, v - a);
          return a;
        },
      });
    }
    const coverage = portfolioCoverage(artifacts);
    resilience += balancedCoverage(coverage);
    for (const service of serviceIds) serviceSums[service] += coverage[service];
  }
  const finalCoverage = portfolioCoverage(artifacts);
  return {
    seed: evaluationSeed,
    resilienceAuc: resilience / config.evaluation.ticks,
    serviceAuc: Object.fromEntries(
      serviceIds.map((s) => [s, serviceSums[s] / config.evaluation.ticks]),
    ) as Record<ServiceId, number>,
    finalCoverage,
  };
}
