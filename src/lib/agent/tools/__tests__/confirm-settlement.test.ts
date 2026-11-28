/**
 * confirm_settlement 도구 단위 테스트 (청사진 §3-a).
 * 이 도구는 실제 쓰기를 하지 않고 writeIntent만 반환한다 — args 형식 검증 + intent 구조만 확인.
 */
import { describe, expect, it } from "vitest";
import { confirmSettlementTool } from "../confirm-settlement";

async function run(input: unknown) {
  return confirmSettlementTool.execute(input as never);
}

describe("confirm_settlement 도구", () => {
  it("deposit 요청 시 action/args/targetEntity가 담긴 writeIntent를 반환한다(dataSources 비어있음)", async () => {
    const result = await run({ campaignId: "camp-1", target: "deposit" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.writeIntent).toMatchObject({
      action: "confirm_settlement",
      args: { campaignId: "camp-1", target: "deposit" },
      targetEntityType: "CAMPAIGN",
      targetEntityId: "camp-1",
    });
    expect(result.data.writeIntent.summary).toEqual(expect.stringContaining("입금확정"));
    expect(result.evidence.dataSources).toEqual([]);
  });

  it("payout 요청 시 summary가 지급완료를 표기한다", async () => {
    const result = await run({ campaignId: "camp-2", target: "payout" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.writeIntent.args).toEqual({ campaignId: "camp-2", target: "payout" });
    expect(result.data.writeIntent.summary).toEqual(expect.stringContaining("지급완료"));
  });

  it("supplierPayout · completedOn 을 기안 args 에 그대로 싣는다", async () => {
    const result = await run({ campaignId: "camp-3", target: "supplierPayout", completedOn: "2026-01-15" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.writeIntent.args).toEqual({ campaignId: "camp-3", target: "supplierPayout", completedOn: "2026-01-15" });
    expect(result.data.writeIntent.summary).toEqual(expect.stringContaining("공급사 지급완료"));
  });

  it("completedOn 은 실제 달력 날짜만 받는다", () => {
    const parse = (completedOn: string) =>
      confirmSettlementTool.inputSchema.safeParse({ campaignId: "c", target: "payout", completedOn }).success;
    expect(parse("2026-01-15")).toBe(true);
    expect(parse("2026-02-30")).toBe(false);
    expect(parse("1월 15일")).toBe(false);
  });

  it("설명이 채널별 칸을 말한다(봇이 공급사 지급을 셀러 지급으로 오기안하지 않게)", () => {
    const d = confirmSettlementTool.description;
    expect(d).toMatch(/자사몰.*supplierPayout.*공급사/);
    expect(d).toMatch(/셀러몰.*payout\(공급사 지급\)/);
    expect(d).toMatch(/completedOn/);
    expect(d).toMatch(/되묻습니다/);
  });

  it("campaignId가 비면 MISSING_PARAM으로 종료한다", async () => {
    const result = await run({ campaignId: "   ", target: "deposit" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_PARAM");
  });

  it("target이 enum 밖이면 zod 파싱에서 거부된다", () => {
    expect(confirmSettlementTool.inputSchema.safeParse({ campaignId: "c", target: "refund" }).success).toBe(false);
  });

  it("도구 이름은 confirm_settlement이다", () => {
    expect(confirmSettlementTool.name).toBe("confirm_settlement");
  });
});
