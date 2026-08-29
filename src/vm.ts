import { sha256 } from "./hash.js";
import type {
  Actuator,
  Artifact,
  ArtifactProgram,
  FieldId,
  Instruction,
  MaterialProperties,
  Sensor,
} from "./types.js";

export interface VmEnvironment {
  fields: Record<FieldId, number>;
  consumeWater(amount: number): number;
  removeContamination(amount: number): number;
}
export interface VmResult {
  actuators: Partial<Record<Actuator, number>>;
  services: Artifact["lastServices"];
}
const clip = (x: number, lo = -4, hi = 4) =>
  Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : 0));

export function validateInstructions(instructions: Instruction[]): void {
  if (instructions.length < 1 || instructions.length > 64)
    throw new Error("Controller requires 1-64 instructions");
  for (const ins of instructions) {
    if (
      ins.dst !== undefined &&
      (!Number.isInteger(ins.dst) || ins.dst < 0 || ins.dst > 15)
    )
      throw new Error("Register out of range");
    for (const r of [ins.a, ins.b])
      if (r !== undefined && (!Number.isInteger(r) || r < 0 || r > 15))
        throw new Error("Register out of range");
    if (ins.op === "SENSOR" && !ins.sensor)
      throw new Error("SENSOR requires sensor");
    if (ins.op === "ACT" && (!ins.actuator || ins.a === undefined))
      throw new Error("ACT requires actuator and source register");
  }
}

export function makeProgram(
  instructions: Instruction[],
  authorId: string,
  parentId?: string,
): ArtifactProgram {
  validateInstructions(instructions);
  const id = `program_${sha256(instructions).slice(0, 20)}`;
  return {
    id,
    instructions: structuredClone(instructions),
    authorId,
    ...(parentId ? { parentId } : {}),
  };
}

function sensorValue(
  sensor: Sensor,
  artifact: Artifact,
  env: VmEnvironment,
): number {
  if (sensor in env.fields) return env.fields[sensor as FieldId];
  if (sensor in artifact.properties)
    return artifact.properties[sensor as keyof MaterialProperties];
  return artifact[
    sensor as "health" | "maturity" | "storage" | "reserve" | "opening"
  ];
}

export function executeProgram(
  program: ArtifactProgram,
  artifact: Artifact,
  env: VmEnvironment,
): VmResult {
  const r = new Float64Array(16);
  const actuators: Partial<Record<Actuator, number>> = {};
  for (const ins of program.instructions) {
    const a = r[ins.a ?? 0] ?? 0,
      b = r[ins.b ?? 0] ?? 0,
      dst = ins.dst ?? 0;
    switch (ins.op) {
      case "CONST":
        r[dst] = clip(ins.value ?? 0);
        break;
      case "SENSOR":
        r[dst] = clip(sensorValue(ins.sensor!, artifact, env));
        break;
      case "COPY":
        r[dst] = a;
        break;
      case "ADD":
        r[dst] = clip(a + b);
        break;
      case "SUB":
        r[dst] = clip(a - b);
        break;
      case "MUL":
        r[dst] = clip(a * b);
        break;
      case "MIN":
        r[dst] = Math.min(a, b);
        break;
      case "MAX":
        r[dst] = Math.max(a, b);
        break;
      case "GT":
        r[dst] = a > b ? 1 : 0;
        break;
      case "LT":
        r[dst] = a < b ? 1 : 0;
        break;
      case "ACT":
        actuators[ins.actuator!] = Math.max(0, Math.min(0.05, a));
        break;
    }
  }
  const request = (name: Actuator) => actuators[name] ?? 0;
  const collected = env.consumeWater(
    Math.min(
      artifact.properties.permeability >= 0.2 ? request("COLLECT_WATER") : 0,
      Math.max(0, 1 - artifact.storage),
    ),
  );
  artifact.storage += collected;
  const grow = Math.min(
    artifact.properties.degradation + artifact.properties.healing >= 0.4
      ? request("GROW")
      : 0,
    artifact.reserve,
    Math.max(0, 1 - artifact.maturity),
  );
  artifact.reserve -= grow;
  artifact.maturity += grow;
  const heal = Math.min(
    artifact.properties.healing >= 0.2 ? request("HEAL") : 0,
    artifact.reserve,
    Math.max(0, 1 - artifact.health),
  );
  artifact.reserve -= heal;
  artifact.health += heal;
  if (
    actuators.SET_OPENING !== undefined &&
    artifact.properties.responsiveness >= 0.2
  )
    artifact.opening = Math.max(0, Math.min(1, request("SET_OPENING")));
  const remediated = env.removeContamination(
    Math.min(
      artifact.properties.adhesion + artifact.properties.responsiveness >= 0.5
        ? request("REMEDIATE")
        : 0,
      artifact.reserve,
    ),
  );
  artifact.reserve -= remediated;
  artifact.signal = request("EMIT_SIGNAL");
  const p = artifact.properties;
  const services = {
    water: clip(artifact.storage * p.permeability * artifact.opening, 0, 1),
    remediation: clip(
      (remediated * 20 * (p.responsiveness + p.adhesion)) / 2,
      0,
      1,
    ),
    stability: clip(
      (artifact.health * artifact.maturity * (p.stiffness + p.toughness)) / 2,
      0,
      1,
    ),
    healing: clip(heal * 20 * p.healing, 0, 1),
    nutrient: clip(
      (artifact.signal * (p.degradation + p.responsiveness)) / 2,
      0,
      1,
    ),
  };
  artifact.lastServices = services;
  artifact.peakPerformance = Math.max(
    artifact.peakPerformance,
    Object.values(services).reduce((a, b) => a + b, 0) / 5,
  );
  return { actuators, services };
}
