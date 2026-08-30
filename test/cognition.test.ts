import { describe, expect, it } from "vitest";
import {
  parseAgentPlan,
  piStreamOptions,
  planToolParameters,
} from "../src/cognition.js";
import { parseConfig } from "../src/config.js";

describe("Pi cognition request options", () => {
  it("requires the model to call the plan submission tool", () => {
    const options = piStreamOptions(parseConfig({}), {});

    expect(options).toMatchObject({ toolChoice: "required" });
  });

  it("provides a data-only tool schema that Pi can clone", () => {
    expect(() => structuredClone(planToolParameters())).not.toThrow();
  });

  it("omits unsupported temperature sampling for Codex", () => {
    const options = piStreamOptions(parseConfig({}), {});

    expect(options).not.toHaveProperty("temperature");
  });

  it("uses finite-lived SSE transport for batch Codex runs", () => {
    const options = piStreamOptions(parseConfig({}), {});

    expect(options).toHaveProperty("transport", "sse");
  });
});

describe("Pi plan validation", () => {
  const research = {
    goal: "Explore",
    hypothesis: "Nearby material may be useful",
    progress: "Starting",
    nextCheckpoint: "Inspect the result",
    collaborationNeed: "None",
  };

  it("rejects moves that are not exactly one orthogonal cell", () => {
    expect(() =>
      parseAgentPlan({
        research,
        actions: [{ type: "MOVE", dx: 1, dy: 1 }],
      }),
    ).toThrow();
    expect(() =>
      parseAgentPlan({
        research,
        actions: [{ type: "MOVE", dx: 0, dy: 0 }],
      }),
    ).toThrow();
  });
});
