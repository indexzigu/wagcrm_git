import { describe, expect, it } from "vitest";
import { parseRouterDecision } from "../router";

describe("parseRouterDecision", () => {
  it("accepts the authoritative Python decide stdout shape without inferring the model", () => {
    const result = parseRouterDecision(
      JSON.stringify({
        route: "local_shadow",
        model: "qwen3.5:9b",
        reason: "not_promoted",
        mode: "shadow",
      }),
    );

    expect(result).toEqual({
      status: "ACCEPTED",
      route: "local_shadow",
      model: "qwen3.5:9b",
      reason: "not_promoted",
    });
  });

  it.each([
    "[]",
    JSON.stringify({ route: "gemini", model: "gemini", reason: "bulk" }),
    JSON.stringify({ route: "gemini", model: "gemini", reason: "bulk", mode: "active" }),
    JSON.stringify({ route: "unknown", model: "unknown", reason: "none", mode: "shadow" }),
    JSON.stringify({ route: "gemini", model: 1, reason: "bulk", mode: "shadow" }),
    JSON.stringify({ route: "gemini", model: "gemini", reason: "bulk", mode: "shadow", extra: "x" }),
  ])("fails closed as FAILED_SECURITY for malformed decide JSON: %s", (stdout) => {
    expect(parseRouterDecision(stdout)).toEqual({ status: "FAILED_SECURITY" });
  });
});
