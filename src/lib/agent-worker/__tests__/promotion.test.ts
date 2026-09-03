import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROMOTION_THRESHOLDS, evaluatePromotion, type PromotionSample } from "../promotion";

const pass: PromotionSample = { validationResult: "pass", correction: false };
const fail: PromotionSample = { validationResult: "fail", correction: false };
const corrected: PromotionSample = { validationResult: "pass", correction: true };

const repeat = (sample: PromotionSample, count: number): PromotionSample[] => Array.from({ length: count }, () => sample);
const registered = { validatorRegistered: true };

describe("promotion evaluator thresholds (plan Task 7)", () => {
  it("pins the exact frozen thresholds", () => {
    expect(PROMOTION_THRESHOLDS).toEqual({
      minimumSamples: 100,
      minimumPassRate: 0.98,
      maximumCorrectionRate: 0.02,
      minimumConsecutivePasses: 20,
      validatorRequired: true,
    });
  });

  it("recommends promotion only when every requirement is met (100 clean samples)", () => {
    expect(evaluatePromotion(repeat(pass, 100), registered)).toEqual({ action: "recommend_promotion", unmet: [] });
  });

  it("samples boundary: 99 is unmet, 100 is met", () => {
    expect(evaluatePromotion(repeat(pass, 99), registered)).toEqual({ action: "keep_unpromoted", unmet: ["samples"] });
    expect(evaluatePromotion(repeat(pass, 100), registered).unmet).not.toContain("samples");
  });

  it("pass-rate boundary: 0.9799 is unmet, 0.98 is met", () => {
    const below = [...repeat(fail, 201), ...repeat(pass, 9_799)];
    const exact = [...repeat(fail, 200), ...repeat(pass, 9_800)];

    expect(evaluatePromotion(below, registered)).toEqual({ action: "keep_unpromoted", unmet: ["pass_rate"] });
    expect(evaluatePromotion(exact, registered)).toEqual({ action: "recommend_promotion", unmet: [] });
  });

  it("correction-rate boundary: 0.0201 is unmet, 0.02 is met", () => {
    const above = [...repeat(corrected, 201), ...repeat(pass, 9_799)];
    const exact = [...repeat(corrected, 200), ...repeat(pass, 9_800)];

    expect(evaluatePromotion(above, registered)).toEqual({ action: "keep_unpromoted", unmet: ["correction_rate"] });
    expect(evaluatePromotion(exact, registered)).toEqual({ action: "recommend_promotion", unmet: [] });
  });

  it("consecutive-pass boundary: 19 trailing passes are unmet, 20 are met", () => {
    const nineteen = [...repeat(pass, 80), fail, ...repeat(pass, 19)];
    const twenty = [...repeat(pass, 79), fail, ...repeat(pass, 20)];

    expect(evaluatePromotion(nineteen, registered)).toEqual({ action: "keep_unpromoted", unmet: ["consecutive_passes"] });
    expect(evaluatePromotion(twenty, registered)).toEqual({ action: "recommend_promotion", unmet: [] });
  });

  it("validator boundary: an unregistered validator or any not_validated sample keeps the skill unpromoted", () => {
    expect(evaluatePromotion(repeat(pass, 100), { validatorRegistered: false })).toEqual({ action: "keep_unpromoted", unmet: ["validator"] });

    const withUnvalidated = [{ validationResult: "not_validated", correction: false } as const, ...repeat(pass, 99)];
    expect(evaluatePromotion(withUnvalidated, registered)).toEqual({ action: "keep_unpromoted", unmet: ["validator"] });
  });

  it("reports every unmet requirement at once for an empty sample set", () => {
    expect(evaluatePromotion([], registered)).toEqual({
      action: "keep_unpromoted",
      unmet: ["samples", "pass_rate", "correction_rate", "consecutive_passes"],
    });
    expect(evaluatePromotion([], { validatorRegistered: false }).unmet).toEqual([
      "samples",
      "pass_rate",
      "correction_rate",
      "consecutive_passes",
      "validator",
    ]);
  });
});

describe("promotion evaluator purity", () => {
  it("returns only {action, unmet}, does not mutate its input, and is deterministic", () => {
    const samples = Object.freeze([...repeat(pass, 80), fail, ...repeat(pass, 19)]);
    const first = evaluatePromotion(samples, registered);
    const second = evaluatePromotion(samples, registered);

    expect(Object.keys(first).sort()).toEqual(["action", "unmet"]);
    expect(first).toEqual(second);
    expect(samples).toHaveLength(100);
  });

  it("never touches the filesystem or the shared routing config", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/agent-worker/promotion.ts"), "utf8");
    expect(source).not.toMatch(/node:fs|from "fs"|child_process|writeFile|local-llm-routing|\.gemini/);

    const configPath = path.join(homedir(), ".gemini", "config", "local-llm-routing.json");
    if (!existsSync(configPath)) return;
    const before = readFileSync(configPath, "utf8");
    evaluatePromotion(repeat(pass, 100), registered);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});
