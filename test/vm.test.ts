import { describe, expect, it } from "vitest";
import {
  makeProgram,
  validateInstructions,
  executeProgram,
} from "../src/vm.js";
import type { Artifact } from "../src/types.js";

const artifact: Artifact = {
  id: "a",
  position: { x: 0, y: 0 },
  creatorId: "x",
  contributors: ["x"],
  batchId: "b",
  properties: {
    stiffness: 0.8,
    toughness: 0.7,
    permeability: 0.8,
    adhesion: 0.5,
    healing: 0.8,
    responsiveness: 0.7,
    degradation: 0.2,
  },
  health: 0.5,
  maturity: 0.5,
  storage: 0,
  reserve: 1,
  opening: 0.5,
  signal: 0,
  active: true,
  programHistory: [],
  peakPerformance: 0,
  lastServices: {
    water: 0,
    remediation: 0,
    stability: 0,
    healing: 0,
    nutrient: 0,
  },
};

describe("artifact VM", () => {
  it("hashes canonical instructions into content identities", () =>
    expect(makeProgram([{ op: "CONST", dst: 0, value: 0.05 }], "a").id).toBe(
      makeProgram([{ op: "CONST", dst: 0, value: 0.05 }], "b").id,
    ));
  it("rejects unbounded programs and invalid registers", () => {
    expect(() => validateInstructions([])).toThrow();
    expect(() =>
      validateInstructions([{ op: "CONST", dst: 16, value: 1 }]),
    ).toThrow();
  });
  it("caps extensive actuators and conserves environmental water", () => {
    let water = 0.03;
    const p = makeProgram(
      [
        { op: "CONST", dst: 0, value: 4 },
        { op: "ACT", a: 0, actuator: "COLLECT_WATER" },
      ],
      "x",
    );
    const a = structuredClone(artifact);
    const result = executeProgram(p, a, {
      fields: {
        temperature: 0.5,
        water,
        stability: 0.5,
        contamination: 0,
        solar: 0.5,
        nutrients: 0.5,
      },
      consumeWater: (n) => {
        const x = Math.min(n, water);
        water -= x;
        return x;
      },
      removeContamination: () => 0,
    });
    expect(result.actuators.COLLECT_WATER).toBe(0.05);
    expect(a.storage).toBe(0.03);
    expect(water).toBe(0);
  });
});
