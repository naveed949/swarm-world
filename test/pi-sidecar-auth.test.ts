import { describe, expect, it } from "vitest";
import {
  isAuthorizedSidecarRequest,
  requireSidecarToken,
  sidecarAuthorization,
} from "../src/pi-sidecar-auth.js";

describe("Pi sidecar authentication", () => {
  const token = "a".repeat(64);

  it("accepts only the exact per-run bearer capability", () => {
    expect(isAuthorizedSidecarRequest(sidecarAuthorization(token), token)).toBe(
      true,
    );
    expect(isAuthorizedSidecarRequest(undefined, token)).toBe(false);
    expect(isAuthorizedSidecarRequest(`Bearer ${"b".repeat(64)}`, token)).toBe(
      false,
    );
  });

  it("rejects missing and weak capabilities", () => {
    expect(() => requireSidecarToken(undefined)).toThrow(
      "missing or too short",
    );
    expect(() => requireSidecarToken("short")).toThrow("missing or too short");
  });
});
