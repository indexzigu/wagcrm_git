import { describe, expect, it } from "vitest";
import { evaluateResourceGate } from "../resource-gate";

const healthySnapshot = {
  colimaRunning: false,
  memoryFreePercent: 20,
  swapUsedBytes: 512 * 1024 * 1024,
  swapIncreaseBytesInFiveMinutes: 256 * 1024 * 1024,
  dockerDbHealthy: true,
  anotherOllamaModelLoaded: false,
} as const;

describe("evaluateResourceGate", () => {
  it("allows the exact healthy boundary for an approved local model", () => {
    expect(evaluateResourceGate(healthySnapshot, "qwen3.5:9b")).toEqual({ status: "ALLOW_LOCAL" });
  });

  it("defers local execution when a locked resource threshold is exceeded", () => {
    expect(
      evaluateResourceGate(
        { ...healthySnapshot, memoryFreePercent: 19 },
        "qwen3.5:9b",
      ),
    ).toEqual({ status: "RESOURCE_DEFERRED", reason: "MEMORY_LOW" });
  });

  it("rejects the prohibited local model without substituting another route", () => {
    expect(evaluateResourceGate(healthySnapshot, "gpt-oss:20b")).toEqual({
      status: "RESOURCE_DEFERRED",
      reason: "MODEL_UNSUPPORTED",
    });
  });
});
