import { describe, expect, it } from "vitest";
import { sha256 } from "../src/hash.js";
import { RepositoryTrace } from "../src/repository-trace.js";

describe("RepositoryTrace", () => {
  it("retains bounded facility diagnostics in the authoritative trace", () => {
    const trace = new RepositoryTrace();
    const output =
      "src/example.ts(4,2): error TS2322: Type 'string' is not assignable to type 'number'.\n";

    trace.appendFacilityCompleted("agent-1", "evidence-1", {
      facilityId: "typecheck",
      success: false,
      exitCode: 2,
      outputDigest: sha256(output),
      output,
    });

    expect(trace.snapshot()).toContainEqual(
      expect.objectContaining({
        type: "facility_completed",
        accepted: false,
        actorId: "agent-1",
        targetId: "evidence-1",
        data: {
          facilityId: "typecheck",
          success: false,
          exitCode: 2,
          outputDigest: sha256(output),
          output,
        },
      }),
    );
  });
});
