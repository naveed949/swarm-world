import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("configuration defaults", () => {
  it("uses Pi's stored Codex authentication provider by default", () => {
    const config = parseConfig({});

    expect(config.model.provider).toBe("openai-codex");
  });
});
