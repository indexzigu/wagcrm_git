import { describe, expect, it } from "vitest";
import {
  SETUP_WINDOW_DAYS,
  getDaysUntilStart,
  isInSetupWindow,
  needsChannelAssignment,
  needsOrderRegistration,
} from "../campaign-setup";
import { isStagnantAfterDays } from "../stagnant";
import type { SalesChannel } from "../crm-types";

// 판정 기준일 — 모든 케이스가 이 날짜 대비 상대로 계산된다.
const NOW = new Date("2026-07-17T09:00:00.000Z");

/** NOW 로부터 `days` 뒤의 판매 시작일(YYYY-MM-DD). */
function startIn(days: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function campaign(days: number) {
  return { startDate: startIn(days) };
}

function withChannel(salesChannel: SalesChannel, isOrderRegistered?: boolean) {
  return { salesChannel, isOrderRegistered };
}

describe("getDaysUntilStart", () => {
  it("미래 시작은 양수, 오늘은 0, 이미 시작했으면 음수", () => {
    expect(getDaysUntilStart(campaign(10), NOW)).toBe(10);
    expect(getDaysUntilStart(campaign(0), NOW)).toBe(0);
    expect(getDaysUntilStart(campaign(-5), NOW)).toBe(-5);
  });

  it("빈값·파싱 불가는 null(판정 불가)", () => {
    expect(getDaysUntilStart({ startDate: "" }, NOW)).toBeNull();
    expect(getDaysUntilStart({ startDate: "not-a-date" }, NOW)).toBeNull();
  });
});

describe("isInSetupWindow", () => {
  it(`경계 포함 — D-${SETUP_WINDOW_DAYS} 는 창 안, D-${SETUP_WINDOW_DAYS + 1} 은 창 밖`, () => {
    // 오너 확정: "세팅은 보통 일주일전에 시작해 아무리 빨라도 10일". 가장 이른 착수
    // 시점이 경계다 — 좁히면 8~10일 전 착수 건이 접혀서 안 보인다.
    expect(isInSetupWindow(campaign(SETUP_WINDOW_DAYS), NOW)).toBe(true);
    expect(isInSetupWindow(campaign(SETUP_WINDOW_DAYS + 1), NOW)).toBe(false);
  });

  it("이미 시작한 건도 창 안 — 세팅 대기에 남아 판매일이 지났으면 봐야 할 카드다", () => {
    expect(isInSetupWindow(campaign(-1), NOW)).toBe(true);
  });

  it("startDate 판정 불가는 창 안으로 보수적 판정(접어서 지우지 않는다)", () => {
    expect(isInSetupWindow({ startDate: "" }, NOW)).toBe(true);
  });

  it("길게 확정된 일정이 섞인 컬럼에서 임박한 건만 창 안으로 걸러진다", () => {
    // 판매 일정이 길게 확정되는 특성상 대부분이 창 밖(날짜만 기다림)이고, 세팅 창
    // 안(임박)은 소수다 — 이 분리가 컬럼 비대 착시를 없앤다. 경계를 검증하는 합성 분포.
    const leadDays = [3, 8, 15, 30, 90, 240];
    const inWindow = leadDays.filter((d) => isInSetupWindow(campaign(d), NOW));
    expect(inWindow).toEqual([3, 8]);
  });
});

describe("needsOrderRegistration", () => {
  it("자사 스토어(네이버·기타) + 미등록 = 할 일 있음", () => {
    // 오너 확정: OWN_MALL(자사몰 기타)도 등록 대상.
    expect(needsOrderRegistration(withChannel("OWN_MALL_NAVER", false))).toBe(true);
    expect(needsOrderRegistration(withChannel("OWN_MALL", false))).toBe(true);
  });

  it("자사 스토어 + 등록됨 = 세팅 완료", () => {
    expect(needsOrderRegistration(withChannel("OWN_MALL_NAVER", true))).toBe(false);
    expect(needsOrderRegistration(withChannel("OWN_MALL", true))).toBe(false);
  });

  it("isOrderRegistered 미지정은 미등록으로 읽는다(부분 구성 시 안전 실패)", () => {
    expect(needsOrderRegistration(withChannel("OWN_MALL_NAVER", undefined))).toBe(true);
  });

  it("외부 스토어·카카오는 등록 개념이 없다", () => {
    // 남의 스토어(브랜드몰·셀러몰)는 주문 접근 권한이 없어 등록 불가.
    // 자사몰(카카오)는 오너가 API 세팅을 안 했다("거의 이용 안 할 것").
    const others: SalesChannel[] = ["BRAND_MALL", "SELLER_MALL", "OWN_MALL_KAKAO"];
    for (const salesChannel of others) {
      expect(needsOrderRegistration({ salesChannel, isOrderRegistered: false })).toBe(false);
    }
  });

  it("미지정 채널은 등록 판정 이전 — 등록이 아니라 채널 지정이 선행", () => {
    expect(needsOrderRegistration(withChannel("UNSPECIFIED", false))).toBe(false);
    expect(needsChannelAssignment(withChannel("UNSPECIFIED"))).toBe(true);
  });
});

describe("needsChannelAssignment", () => {
  it("미지정만 채널 지정 대상 — 정해진 채널은 아니다", () => {
    // 오너 확정: UNSPECIFIED 는 채워야 하는 값이다.
    expect(needsChannelAssignment(withChannel("UNSPECIFIED"))).toBe(true);
    const assigned: SalesChannel[] = [
      "OWN_MALL_NAVER",
      "OWN_MALL",
      "OWN_MALL_KAKAO",
      "BRAND_MALL",
      "SELLER_MALL",
    ];
    for (const salesChannel of assigned) {
      expect(needsChannelAssignment({ salesChannel })).toBe(false);
    }
  });
});

describe("정체 판정 회귀 잠금 — 세팅 대기는 updatedAt 을 보지 않는다", () => {
  it("아무리 오래 방치돼도 PREPARATION 은 정체가 아니다", () => {
    // 이 단계는 판매 시작일이라는 일정 앵커가 있어 대기가 정상이다.
    // 임계값을 되살리면 날짜만 기다리는 카드들이 정체로 오탐된다.
    expect(isStagnantAfterDays("PREPARATION", 3)).toBe(false);
    expect(isStagnantAfterDays("PREPARATION", 7)).toBe(false);
    expect(isStagnantAfterDays("PREPARATION", 9999)).toBe(false);
  });

  it("일정 앵커가 없는 단계는 여전히 정체를 판정한다", () => {
    // PROPOSAL 은 확정일이 없어 updatedAt 이 유일한(약한) 신호다 — 남겨둔다.
    expect(isStagnantAfterDays("PROPOSAL", 2)).toBe(false);
    expect(isStagnantAfterDays("PROPOSAL", 3)).toBe(true);
  });

  it("화면과 크론이 같은 경계를 쓴다 — 임계 당일 발화(>=)", () => {
    // 통합 전: 화면 `>=`(3일에 발화) vs 크론 `>`(4일에 발화)로 하루 어긋나 있었다.
    expect(isStagnantAfterDays("ACTIVE", 2)).toBe(true);
    expect(isStagnantAfterDays("SETTLEMENT_WAIT", 5)).toBe(true);
  });

  it("종결 상태는 판정하지 않는다", () => {
    expect(isStagnantAfterDays("COMPLETED", 9999)).toBe(false);
    expect(isStagnantAfterDays("DROPPED", 9999)).toBe(false);
  });
});
