import { describe, expect, it } from "vitest";
import { formatInboundScanToast } from "./scan-toast";
import type { ScanSummary } from "./scan";

// [캘린더수집] 「캘린더에서 가져오기」 결과 토스트 문구 — 설계 §7 「기안 N건 올림 · 해석 못 함 M건 · 이미 처리 K건」.

function summary(over: Partial<ScanSummary> = {}): ScanSummary {
  return {
    ok: true,
    scanned: 0,
    crmOwned: 0,
    newOrChanged: 0,
    proposed: 0,
    skippedUnparsed: 0,
    adoptedNoop: 0,
    dropped: 0,
    awaitingHint: 0,
    localResolved: 0,
    geminiResolved: 0,
    alreadyHandled: 0,
    errors: 0,
    ...over,
  };
}

describe("formatInboundScanToast", () => {
  it("세 칸은 0 이어도 늘 싣는다 — 「이미 처리」는 이미 처리된 것과 바꿀 것 없던 것의 합", () => {
    expect(formatInboundScanToast(summary({ proposed: 2, skippedUnparsed: 1, alreadyHandled: 3, adoptedNoop: 1 }))).toEqual({
      message: "기안 2건 올림 · 해석 못 함 1건 · 이미 처리 4건",
      tone: "success",
      openApprovals: true,
    });
    expect(formatInboundScanToast(summary())).toMatchObject({
      message: "기안 0건 올림 · 해석 못 함 0건 · 이미 처리 0건",
      openApprovals: false, // 올린 기안이 없으면 결재함 버튼을 달지 않는다
    });
  });

  it("상한에 걸려 다음 회차로 넘긴 건이 있으면 「다음에 이어서」를 덧붙인다", () => {
    expect(formatInboundScanToast(summary({ proposed: 20, dropped: 3 })).message).toBe(
      "기안 20건 올림 · 해석 못 함 0건 · 이미 처리 0건 · 다음에 이어서 3건",
    );
  });

  it("모델 해석을 기다리는 건이 있으면 「해석 대기」를 덧붙인다(0 이면 싣지 않는다)", () => {
    expect(formatInboundScanToast(summary({ proposed: 1, awaitingHint: 4 }))).toEqual({
      message: "기안 1건 올림 · 해석 못 함 0건 · 이미 처리 0건 · 해석 대기 4건",
      tone: "success",
      openApprovals: true,
    });
    expect(formatInboundScanToast(summary({ dropped: 2, awaitingHint: 1 })).message).toBe(
      "기안 0건 올림 · 해석 못 함 0건 · 이미 처리 0건 · 다음에 이어서 2건 · 해석 대기 1건",
    );
    expect(formatInboundScanToast(summary({ localResolved: 3, geminiResolved: 2 })).message).not.toContain("해석 대기");
  });

  it("다른 회차가 도는 중이면 「이미 가져오는 중」 안내만 띄운다", () => {
    expect(formatInboundScanToast(summary({ skipped: "busy" }))).toEqual({
      message: "이미 가져오는 중입니다. 잠시 뒤 다시 눌러 주세요.",
      tone: "info",
      openApprovals: false,
    });
  });

  it("처리 중 오류가 난 건이 있으면 숨기지 않고 알리고 주의 톤으로 띄운다", () => {
    expect(formatInboundScanToast(summary({ proposed: 1, errors: 2 }))).toEqual({
      message: "기안 1건 올림 · 해석 못 함 0건 · 이미 처리 0건 · 처리 실패 2건",
      tone: "warning",
      openApprovals: true,
    });
  });
});
