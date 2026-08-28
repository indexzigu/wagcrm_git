import type { OfferDiagnosis } from "./offer-diagnostic";
import type { GateResult } from "@/lib/claims/claim-gate";

/**
 * 공구 오픈 준비 감사 (C2 M4) — 캠페인 1건이 열릴 준비가 됐는가.
 *
 * ## 왜 체크리스트가 아닌가 (오너 기존 결정 준수)
 *
 * `campaign-setup.ts` 에 실측 근거가 남아 있다: PREPARATION 체크리스트 항목은
 * **운영상 거의 체크되지 않아** 배지를 걸면 대부분이 오탐이 됐고, "기다림에는
 * 완료 버튼을 달 수 없다"(상대방의 일이므로). 그래서 이 감사는 **새 체크박스를
 * 만들지 않는다** — 오너가 이미 하는 행위에서 이미 기록된 자동 판정만 모은다:
 *
 * - **표현 게이트**(C1) — 승인 표현·필수 고지·금지 표현 판정
 * - **오퍼 진단**(C2) — 10행 루브릭
 * - **주문관리 등록**(기존) — 자사 스토어의 유일하게 살아있는 세팅 신호
 * - **최저가 방어**(기존) — 스냅샷 verdict
 *
 * 즉 이 파일은 새 정보를 요구하지 않고 **흩어진 판정을 한 자리에 모으는 일**만
 * 한다. 새 노동이 0이라 위 기각 사유(체크율)가 적용되지 않는다.
 *
 * ## 판정은 세 갈래
 *
 * - `BLOCK` — 열면 법령·계정 리스크가 나는 것. 표현 게이트가 BLOCK 이거나
 *   필수 고지가 빠진 경우. **이건 판단 문제가 아니라 사고 예방이다.**
 * - `FIX` — 열 수는 있지만 성과를 깎는 것. 오퍼 FAIL 행, 최저가 방어 실패,
 *   자사 스토어 미등록.
 * - `SHIP` — 걸리는 것이 없다.
 *
 * ⛔ **오픈을 자동으로 막지 않는다.** 판정을 보여주는 것까지가 이 함수의 일이고,
 * 열지 말지는 운영자가 정한다(C2 스펙 §2 — 자동 차단 아님).
 */

export type ReadinessLevel = "SHIP" | "FIX" | "BLOCK";

export type ReadinessItem = {
  /** 어느 판정에서 왔는가 — 운영자가 고칠 화면을 찾을 수 있게. */
  source: "CLAIMS" | "OFFER" | "SETUP" | "PRICE";
  level: "BLOCK" | "FIX";
  message: string;
  /** 무엇을 하면 풀리는가. */
  fix: string;
};

export type ReadinessAudit = {
  level: ReadinessLevel;
  items: ReadinessItem[];
  /** 판매 시작까지 남은 일수(모르면 null) — 급한지 판단에 쓴다. */
  daysUntilStart: number | null;
};

/** 검사한 문서 1건의 표현 게이트 판정. */
export type ClaimGateEntry = {
  /**
   * 어느 자료인가 — 항목 문구에 그대로 들어간다. 유형이 둘 이상이면 "어느 문서를
   * 고쳐야 하는가"가 메시지에서 바로 읽혀야 한다(가이드 2원화 2026-08-02).
   */
  label: string;
  gate: Pick<GateResult, "verdict" | "violations" | "missingDisclosures">;
};

export type ReadinessInput = {
  /**
   * C1 표현 게이트 판정 — **검사한 자료마다 1건**. 빈 배열이면 감사에서 제외한다.
   *
   * ⚠️ 단수 필드가 아니라 목록인 이유: 소비자에게 닿는 자료가 셀러용 하나뿐이라는
   * 전제가 2원화로 깨졌다. 단수로 두고 브랜드용을 덧붙이면 "그래서 `claimGate` 는
   * 어느 쪽인가"가 호출부마다 헷갈리고, 세 번째 유형이 생기면 또 필드가 는다.
   */
  claimGates: readonly ClaimGateEntry[];
  /** C2 오퍼 진단. 미실행이면 null. */
  offer: Pick<OfferDiagnosis, "rows" | "coverage" | "score"> | null;
  /** 자사 스토어인데 주문관리 등록이 안 됐는가(`needsOrderRegistration` 결과). */
  needsOrderRegistration: boolean;
  /** 판매채널 미지정인가(`needsChannelAssignment` 결과). */
  needsChannelAssignment: boolean;
  /** 판매 시작까지 남은 일수(`getDaysUntilStart` 결과). */
  daysUntilStart: number | null;
};

/** 감사 항목을 모아 최종 등급을 낸다 — BLOCK 이 하나라도 있으면 BLOCK. */
function levelOf(items: ReadinessItem[]): ReadinessLevel {
  if (items.some((i) => i.level === "BLOCK")) return "BLOCK";
  if (items.length > 0) return "FIX";
  return "SHIP";
}

export function auditLaunchReadiness(input: ReadinessInput): ReadinessAudit {
  const items: ReadinessItem[] = [];

  // ── 표현 게이트(C1) — 법령 리스크라 BLOCK 축이다.
  //
  // 검사한 자료마다 항목을 세운다. 유형이 둘 이상이면 **어느 문서가 걸렸는지**가
  // 문구에 들어가야 한다 — 안 그러면 운영자가 셀러용을 고치고 브랜드용이 걸린 줄
  // 모른 채 다시 조회한다(오너 결정 2026-08-02: 브랜드용도 판정에 포함).
  const multi = input.claimGates.length > 1;
  for (const { label, gate } of input.claimGates) {
    const { verdict, violations, missingDisclosures } = gate;
    const where = multi ? `${label} ` : "";
    if (verdict === "BLOCK") {
      items.push({
        source: "CLAIMS",
        level: "BLOCK",
        message: `${where}금지 표현 ${violations.length}건이 검출됐습니다`,
        fix: "표현 검사에서 해당 문구를 대체 표현으로 바꾸세요. 이대로 열면 셀러 계정과 브랜드가 함께 위험해집니다.",
      });
    } else if (violations.length > 0) {
      items.push({
        source: "CLAIMS",
        level: "FIX",
        message: `${where}주의 표현 ${violations.length}건`,
        fix: "표현 검사에서 근거를 확인하고 필요하면 문구를 다듬으세요.",
      });
    }
    if (missingDisclosures.length > 0) {
      // 고지 누락은 표현을 안 고쳐도 발생한다 — 별도 항목으로 세운다.
      items.push({
        source: "CLAIMS",
        level: "BLOCK",
        message: `${where}필수 고지 ${missingDisclosures.length}건이 빠졌습니다`,
        fix: "본문에 필수 고지를 넣으세요(공정위 추천·보증 심사지침 등 법정 표시사항).",
      });
    }
  }

  // ── 오퍼 진단(C2) — 성과 축이라 FIX 다. 열려도 사고는 아니지만 안 팔린다.
  if (input.offer) {
    const failed = input.offer.rows.filter((r) => r.verdict === "FAIL");
    if (failed.length > 0) {
      items.push({
        source: "OFFER",
        level: "FIX",
        message: `오퍼 미충족 ${failed.length}건: ${failed.map((r) => r.label).join(" · ")}`,
        fix: "오퍼 진단에서 각 행의 수정 안내를 확인하세요. 표현을 다듬기 전에 오퍼를 고치는 것이 순서입니다.",
      });
    }
    const undecided =
      input.offer.coverage.applicable - input.offer.coverage.decided;
    if (undecided > 0) {
      // 미확인은 실패가 아니다 — 다만 오픈 전에는 확인하는 게 맞다.
      items.push({
        source: "OFFER",
        level: "FIX",
        message: `오퍼 미확인 ${undecided}행`,
        fix: "오퍼 진단의 수동 항목에 답하면 점수가 발행됩니다.",
      });
    }
  }

  // ── 최저가 방어 — 오퍼 진단 안에 이미 반영되므로 여기서 중복 세우지 않는다.
  //    (진단이 미실행일 때만 별도 신호가 필요해지는데, 그건 M5 이후 과제다.)

  // ── 세팅(기존 판정 재사용) — 채널이 먼저다: 채널을 알아야 등록 필요 여부가 정해진다.
  if (input.needsChannelAssignment) {
    items.push({
      source: "SETUP",
      level: "FIX",
      message: "판매채널이 지정되지 않았습니다",
      fix: "캠페인의 판매채널을 지정하세요. 채널이 정해져야 주문관리 등록 필요 여부도 판정됩니다.",
    });
  } else if (input.needsOrderRegistration) {
    items.push({
      source: "SETUP",
      level: "FIX",
      message: "주문관리 캠페인 등록이 안 됐습니다",
      fix: "자사 스토어 판매는 주문관리 등록이 판매 개시 전제조건입니다. 주문관리에서 캠페인을 등록하세요.",
    });
  }

  return {
    level: levelOf(items),
    items,
    daysUntilStart: input.daysUntilStart,
  };
}
