import { describe, expect, it } from "vitest";
import { actionHasNoTargetYet } from "../entity-type-labels";

describe("actionHasNoTargetYet", () => {
  it("새 회차 생성만 기안 시점에 대상이 없다", () => {
    expect(actionHasNoTargetYet("create_campaign_round")).toBe(true);
    expect(actionHasNoTargetYet("update_record")).toBe(false);
    expect(actionHasNoTargetYet(undefined)).toBe(false);
    expect(actionHasNoTargetYet(null)).toBe(false);
  });
});
