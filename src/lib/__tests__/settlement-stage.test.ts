import { describe, it, expect } from "vitest";
import {
  PRE_SETTLEMENT_SALE_STATUSES,
  RETURN_PERIOD_DAYS,
  SETTLEMENT_STAGE_STATUSES,
  foldByGroup,
  foldedUnitLabel,
  isOverdueKst,
  overdueDaysKst,
  resolveSettlementStartDueDate,
  resolveSettlementStartOverdue,
} from "../settlement-stage";

/**
 * 정산 단계 축 판정 SSOT (T-062). ⏰ 고정 「오늘」 픽스처 금지(P9) — 기준 시각을 명시적으로
 * 주입하고 그 기준의 **상대 날짜**만 쓴다.
 */
const NOW = new Date("2026-08-27T03:00:00.000Z"); // KST 2026-08-27 12:00

describe("isOverdueKst — 「늦었다」의 경계", () => {
  it("어제 예정은 지연이다", () => {
    expect(isOverdueKst(new Date("2026-08-26T00:00:00.000Z"), NOW)).toBe(true);
  });

  it("오늘 예정은 아직 지연이 아니다", () => {
    // 예정일은 전부 UTC 자정(=KST 09:00) 저장이다. 종전 데스크톱 식 `date <= now` 는
    // KST 09:00 을 넘긴 이 시각에 참이 되어 오늘 예정 건을 지연으로 봤다.
    const todayUtcMidnight = new Date("2026-08-27T00:00:00.000Z");
    expect(todayUtcMidnight <= NOW).toBe(true); // 종전 식은 참
    expect(isOverdueKst(todayUtcMidnight, NOW)).toBe(false); // 새 경계는 거짓
  });

  it("내일 예정은 지연이 아니다", () => {
    expect(isOverdueKst(new Date("2026-08-28T00:00:00.000Z"), NOW)).toBe(false);
  });

  it("KST 로 날짜가 넘어가는 UTC 늦저녁도 KST 달력일로 본다", () => {
    // UTC 08-26 20:00 = KST 08-27 05:00 → 오늘이므로 지연 아님
    expect(isOverdueKst(new Date("2026-08-26T20:00:00.000Z"), NOW)).toBe(false);
  });

  it("null·빈 문자열·잘못된 날짜는 지연이 아니다 — 모르는 것을 지연으로 세지 않는다", () => {
    expect(isOverdueKst(null, NOW)).toBe(false);
    expect(isOverdueKst(undefined, NOW)).toBe(false);
    expect(isOverdueKst("", NOW)).toBe(false);
    expect(isOverdueKst("not-a-date", NOW)).toBe(false);
  });

  it("ymd 문자열도 같은 판정이다(모바일 경로)", () => {
    expect(isOverdueKst("2026-08-26", NOW)).toBe(true);
    expect(isOverdueKst("2026-08-27", NOW)).toBe(false);
  });
});

describe("overdueDaysKst", () => {
  it("지연 경과일을 KST 달력일 차로 센다", () => {
    expect(overdueDaysKst(new Date("2026-08-20T00:00:00.000Z"), NOW)).toBe(7);
  });

  it("오늘·미래는 0이다", () => {
    expect(overdueDaysKst(new Date("2026-08-27T00:00:00.000Z"), NOW)).toBe(0);
    expect(overdueDaysKst(new Date("2026-09-01T00:00:00.000Z"), NOW)).toBe(0);
  });
});

describe("resolveSettlementStartDueDate", () => {
  it("반품기간 종료일이 있으면 그것이 정본이다", () => {
    const due = resolveSettlementStartDueDate({
      endDate: "2026-08-01T00:00:00.000Z",
      returnPeriodEndDate: "2026-08-10T00:00:00.000Z",
    });
    expect(due?.toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });

  it("없으면 판매 종료 + RETURN_PERIOD_DAYS 로 떨어진다", () => {
    const due = resolveSettlementStartDueDate({ endDate: "2026-08-01T00:00:00.000Z" });
    expect(RETURN_PERIOD_DAYS).toBe(14);
    expect(due?.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("종료일조차 없으면 판정 불가(null)다", () => {
    expect(resolveSettlementStartDueDate({ endDate: null })).toBeNull();
  });
});

describe("resolveSettlementStartOverdue — 모집단", () => {
  const ENDED = "2026-07-01T00:00:00.000Z"; // 기준일 07-15 → 43일 경과

  it("판매 진행중·마감만 대상이다", () => {
    expect(PRE_SETTLEMENT_SALE_STATUSES).toEqual(["ACTIVE", "CLOSED"]);
    for (const status of PRE_SETTLEMENT_SALE_STATUSES) {
      expect(resolveSettlementStartOverdue({ status, endDate: ENDED }, NOW).overdue).toBe(true);
    }
  });

  it("정산 단계는 이미 착수했으므로 대상이 아니다", () => {
    for (const status of SETTLEMENT_STAGE_STATUSES) {
      expect(resolveSettlementStartOverdue({ status, endDate: ENDED }, NOW).overdue).toBe(false);
    }
  });

  it("제안·세팅 대기는 대상이 아니다 — 판매한 적 없는 방치 건이 목록을 채운다", () => {
    for (const status of ["PROPOSAL", "PREPARATION"]) {
      expect(resolveSettlementStartOverdue({ status, endDate: ENDED }, NOW).overdue).toBe(false);
    }
  });

  it("지연이면 경과일을 함께 낸다", () => {
    const verdict = resolveSettlementStartOverdue({ status: "CLOSED", endDate: ENDED }, NOW);
    expect(verdict).toMatchObject({ overdue: true, daysOverdue: 43 });
  });
});

describe("foldByGroup — 조합 캠페인 접기", () => {
  it("그룹당 1묶음, 미그룹은 자기 혼자인 묶음", () => {
    const units = foldByGroup([
      { id: "solo1", groupId: null },
      { id: "g1a", groupId: "g1" },
      { id: "g1b", groupId: "g1" },
      { id: "solo2", groupId: null },
      { id: "g1c", groupId: "g1" },
    ]);
    expect(units.map((u) => u.map((r) => r.id))).toEqual([
      ["solo1"],
      ["g1a", "g1b", "g1c"],
      ["solo2"],
    ]);
  });

  it("입력 순서를 보존한다 — 대표(첫 멤버)가 흔들리면 라벨·링크가 매번 바뀐다", () => {
    const units = foldByGroup([
      { id: "g2a", groupId: "g2" },
      { id: "g1a", groupId: "g1" },
    ]);
    expect(units[0][0].id).toBe("g2a");
    expect(units[1][0].id).toBe("g1a");
  });

  it("groupId 미제공(구 호출부)은 미그룹으로 본다", () => {
    const rows: { id: string; groupId?: string | null }[] = [{ id: "x" }];
    expect(foldByGroup(rows)).toEqual([[{ id: "x" }]]);
  });
});

describe("foldedUnitLabel", () => {
  it("저장된 묶음 이름이 있으면 그것을 쓴다", () => {
    expect(foldedUnitLabel(["딜A · 셀러1", "딜B · 셀러1"], "여름 공구")).toBe("여름 공구");
  });

  it("공백뿐인 이름은 없는 것으로 본다", () => {
    expect(foldedUnitLabel(["딜A · 셀러1", "딜B · 셀러1"], "   ")).toBe("딜A · 셀러1 외 1건");
  });

  it("이름이 없으면 대표 + 「외 N건」", () => {
    expect(foldedUnitLabel(["딜A · 셀러1", "딜B · 셀러1", "딜C · 셀러1"], null)).toBe(
      "딜A · 셀러1 외 2건",
    );
  });

  it("멤버가 하나면 「외 N건」을 붙이지 않는다", () => {
    expect(foldedUnitLabel(["딜A · 셀러1"], null)).toBe("딜A · 셀러1");
  });
});
