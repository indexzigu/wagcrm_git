import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeWithholdingFilingSummary,
  formatDDay,
  getDDayLevel,
  isTaxFilingKind,
  resolveCampaignWithholdingStatus,
  SIMPLIFIED_STATEMENT_INDUSTRY_CODE,
  SIMPLIFIED_STATEMENT_INDUSTRY_NAME,
  TAX_FILING_KINDS,
} from "../tax-filing-log";

describe("resolveCampaignWithholdingStatus", () => {
  const RETURN_LOG = { kind: "WITHHOLDING_RETURN", completedAt: "2026-08-10T01:00:00.000Z" };
  const STATEMENT_LOG = { kind: "SIMPLIFIED_STATEMENT", completedAt: "2026-08-10T01:05:00.000Z" };
  const LOCAL_LOG = { kind: "LOCAL_INCOME_TAX", completedAt: "2026-08-10T01:10:00.000Z" };

  it("지급 미완료면 귀속월이 없으므로 AWAITING_PAYOUT 이고 남은 건수를 세지 않는다", () => {
    // ⛔ pendingCount 를 3으로 두면 오너가 아직 대상도 아닌 건을 밀린 일로 읽는다 —
    //    `computeWithholdingFilingSummary` 가 hasFilingTarget=false 에 0을 내는 것과 같은 규율.
    for (const payout of [null, undefined, "", "미정"]) {
      const status = resolveCampaignWithholdingStatus(payout, [RETURN_LOG, STATEMENT_LOG, LOCAL_LOG]);
      expect(status.state).toBe("AWAITING_PAYOUT");
      expect(status.month).toBeNull();
      expect(status.pendingCount).toBeNull();
      expect(status.filedAt).toBeNull();
    }
  });

  it("귀속월은 지급완료일의 월이다 — buildWithholdingReport 와 같은 축", () => {
    expect(resolveCampaignWithholdingStatus("2026-07-27", []).month).toBe("2026-07");
  });

  it("완료 0건이면 NOT_FILED 이고 3건이 남는다", () => {
    const status = resolveCampaignWithholdingStatus("2026-07-27", []);
    expect(status.state).toBe("NOT_FILED");
    expect(status.pendingCount).toBe(TAX_FILING_KINDS.length);
    expect(status.filedAt).toBeNull();
  });

  it("일부만 완료면 PARTIALLY_FILED 이고 남은 건수를 정확히 센다", () => {
    const status = resolveCampaignWithholdingStatus("2026-07-27", [RETURN_LOG]);
    expect(status.state).toBe("PARTIALLY_FILED");
    expect(status.pendingCount).toBe(2);
  });

  it("3절차 전부 완료여야 FILED 다 (오너 확정 2026-08-12)", () => {
    const status = resolveCampaignWithholdingStatus("2026-07-27", [RETURN_LOG, STATEMENT_LOG, LOCAL_LOG]);
    expect(status.state).toBe("FILED");
    expect(status.pendingCount).toBe(0);
  });

  it("원천세 신고만으로는 FILED 가 아니다 — 1번 카드 단독 기준으로 되돌리지 말 것", () => {
    expect(resolveCampaignWithholdingStatus("2026-07-27", [RETURN_LOG]).state).not.toBe("FILED");
  });

  it("filedAt 은 1번 원천세 신고 기준이다 — 부분 완료여도 그 사실은 남는다", () => {
    expect(resolveCampaignWithholdingStatus("2026-07-27", [RETURN_LOG]).filedAt).toBe("2026-08-10");
    // 다른 절차만 완료된 경우 신고일은 아직 없다.
    expect(resolveCampaignWithholdingStatus("2026-07-27", [STATEMENT_LOG, LOCAL_LOG]).filedAt).toBeNull();
  });

  it("신고일은 KST 로 자른다 — UTC 로 자르면 밤에 체크한 건이 전날로 표시된다", () => {
    // 2026-08-10T15:30Z = KST 2026-08-11 00:30. slice(0,10) 이면 08-10 이 되어 하루 어긋난다.
    const status = resolveCampaignWithholdingStatus("2026-07-27", [
      { kind: "WITHHOLDING_RETURN", completedAt: "2026-08-10T15:30:00.000Z" },
    ]);
    expect(status.filedAt).toBe("2026-08-11");
  });

  it("모르는 kind 는 완료로 세지 않는다 — 낡은 배포가 보낸 값이 신고를 완료로 굳히면 안 된다", () => {
    const status = resolveCampaignWithholdingStatus("2026-07-27", [
      RETURN_LOG,
      STATEMENT_LOG,
      { kind: "SOMETHING_ELSE", completedAt: "2026-08-10T01:00:00.000Z" },
    ]);
    expect(status.state).toBe("PARTIALLY_FILED");
    expect(status.pendingCount).toBe(1);
  });

  it("깨진 completedAt 은 신고일을 지어내지 않고 null 로 둔다", () => {
    const status = resolveCampaignWithholdingStatus("2026-07-27", [
      { kind: "WITHHOLDING_RETURN", completedAt: "not-a-date" },
    ]);
    expect(status.filedAt).toBeNull();
    // 완료 사실 자체는 기록에 있으므로 건수에서는 빠진다.
    expect(status.pendingCount).toBe(2);
  });
});

describe("SIMPLIFIED_STATEMENT_INDUSTRY_CODE", () => {
  it("기타자영업 코드 940909로 확정돼 있다 (오너 확정, 2026-08-04)", () => {
    expect(SIMPLIFIED_STATEMENT_INDUSTRY_CODE).toBe("940909");
  });

  it("업종명이 코드와 짝으로 존재한다 — 화면은 둘 다 낸다 (오너 결정, 2026-08-11)", () => {
    expect(SIMPLIFIED_STATEMENT_INDUSTRY_NAME).toBe("기타자영업");
  });
});

describe("isTaxFilingKind", () => {
  it("세 절차 kind만 허용한다", () => {
    for (const kind of TAX_FILING_KINDS) {
      expect(isTaxFilingKind(kind)).toBe(true);
    }
    expect(isTaxFilingKind("UNKNOWN")).toBe(false);
    expect(isTaxFilingKind(123)).toBe(false);
    expect(isTaxFilingKind(null)).toBe(false);
  });
});

const DUE_DATES = {
  WITHHOLDING_RETURN: "2026-08-10",
  LOCAL_INCOME_TAX: "2026-08-10",
  SIMPLIFIED_STATEMENT: "2026-08-31",
} as const;

describe("computeWithholdingFilingSummary", () => {
  it("신고 대상이 없으면(hasFilingTarget=false) 완료 여부와 무관하게 미처리 0건이다", () => {
    const summary = computeWithholdingFilingSummary(false, new Set(), DUE_DATES);
    expect(summary).toEqual({ pendingCount: 0, nextDueDate: null });
  });

  it("대상이 있고 아무것도 완료되지 않았으면 3건 미처리, 가장 가까운 기한을 낸다", () => {
    const summary = computeWithholdingFilingSummary(true, new Set(), DUE_DATES);
    expect(summary.pendingCount).toBe(3);
    // 8/10(원천세·지방소득세)이 8/31(지급명세)보다 빠르다.
    expect(summary.nextDueDate).toBe("2026-08-10");
  });

  it("일부만 완료되면 나머지만 센다", () => {
    const summary = computeWithholdingFilingSummary(
      true,
      new Set(["WITHHOLDING_RETURN", "LOCAL_INCOME_TAX"]),
      DUE_DATES,
    );
    expect(summary.pendingCount).toBe(1);
    expect(summary.nextDueDate).toBe("2026-08-31");
  });

  it("셋 다 완료되면 미처리 0건·기한 null이다", () => {
    const summary = computeWithholdingFilingSummary(true, new Set(TAX_FILING_KINDS), DUE_DATES);
    expect(summary).toEqual({ pendingCount: 0, nextDueDate: null });
  });
});

describe("formatDDay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("미래 기한은 D-n으로 표기한다", () => {
    vi.setSystemTime(new Date("2026-08-04T00:00:00+09:00"));
    expect(formatDDay("2026-08-10")).toBe("D-6");
  });

  it("오늘이 기한이면 D-day를 표기한다", () => {
    vi.setSystemTime(new Date("2026-08-10T00:00:00+09:00"));
    expect(formatDDay("2026-08-10")).toBe("D-day");
  });

  it("기한이 지났으면 '기한 초과'를 표기한다", () => {
    vi.setSystemTime(new Date("2026-08-15T00:00:00+09:00"));
    expect(formatDDay("2026-08-10")).toBe("기한 초과");
  });
});

describe("getDDayLevel", () => {
  // 실제 "지금"에 의존하지 않도록 매 케이스에서 "지금"을 임의로 고정하고, 기한은 그
  // 고정된 "지금"으로부터의 상대 오프셋으로 계산한다 — 실행 시점이 언제든 diffDays
  // 가 항상 같은 값이 된다(실 날짜 하드코딩 시한폭탄 방지, docs/agents/dev-qa.md).
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // computeDueDiffDays(tax-filing-log.ts)와 정확히 같은 산식으로 오프셋을 만든다 —
  // KST 로 변환한 "오늘" 날짜 문자열을 UTC 자정으로 다시 파싱해 날짜 단위로 더한다.
  // 테스트 실행 머신의 로컬 타임존에 좌우되는 `Date#setDate`(로컬 시간 기준)를 쓰면
  // KST 기준 계산과 하루 어긋날 수 있어 피한다.
  function dueDateOffsetFromNow(now: Date, offsetDays: number): string {
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const todayStr = kst.toISOString().slice(0, 10);
    const due = new Date(`${todayStr}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + offsetDays);
    return due.toISOString().slice(0, 10);
  }

  it("기한이 지났으면 urgent다", () => {
    const now = new Date("2027-03-01T00:00:00+09:00");
    vi.setSystemTime(now);
    expect(getDDayLevel(dueDateOffsetFromNow(now, -1))).toBe("urgent");
  });

  it("오늘이 기한이면 urgent다", () => {
    const now = new Date("2027-03-01T00:00:00+09:00");
    vi.setSystemTime(now);
    expect(getDDayLevel(dueDateOffsetFromNow(now, 0))).toBe("urgent");
  });

  it("경계값 — 3일 남으면 caution, 4일 남으면 normal이다", () => {
    const now = new Date("2027-03-01T00:00:00+09:00");
    vi.setSystemTime(now);
    expect(getDDayLevel(dueDateOffsetFromNow(now, 3))).toBe("caution");
    expect(getDDayLevel(dueDateOffsetFromNow(now, 4))).toBe("normal");
  });

  it("한참 남았으면(30일) normal이다", () => {
    const now = new Date("2027-03-01T00:00:00+09:00");
    vi.setSystemTime(now);
    expect(getDDayLevel(dueDateOffsetFromNow(now, 30))).toBe("normal");
  });
});

// 계약 #6 — TaxFilingLog 유니크: 같은 (month, kind) 중복 완료가 거부된다.
// 실 SQLite(dev.db, 다른 realdb 테스트와 같은 관례 — kakao txt-ingest-idempotency.test.ts
// 참조)로 확인한다 — 순수 함수 목만으로는 DB 제약 자체(@@unique)가 실제로 걸려 있는지
// 증명하지 못한다.
describe("TaxFilingLog @@unique([month, kind]) — 실 SQLite", () => {
  const TEST_MONTH = "2099-01"; // 실제 데이터와 충돌하지 않는 미래 월을 키로 쓴다.

  async function loadPrisma() {
    vi.resetModules();
    process.env.DATABASE_URL = "file:./dev.db";
    const { getPrisma } = await import("@/lib/prisma");
    return getPrisma();
  }

  afterEach(async () => {
    const prisma = await loadPrisma();
    await prisma.taxFilingLog.deleteMany({ where: { month: TEST_MONTH } });
  });

  it("같은 (month, kind) 두 번째 생성은 유니크 제약 위반으로 거부된다", async () => {
    const prisma = await loadPrisma();
    await prisma.taxFilingLog.create({
      data: { month: TEST_MONTH, kind: "WITHHOLDING_RETURN", completedAt: new Date() },
    });

    await expect(
      prisma.taxFilingLog.create({
        data: { month: TEST_MONTH, kind: "WITHHOLDING_RETURN", completedAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it("다른 kind는 같은 month에서도 독립적으로 허용된다", async () => {
    const prisma = await loadPrisma();
    await prisma.taxFilingLog.create({
      data: { month: TEST_MONTH, kind: "WITHHOLDING_RETURN", completedAt: new Date() },
    });
    await prisma.taxFilingLog.create({
      data: { month: TEST_MONTH, kind: "LOCAL_INCOME_TAX", completedAt: new Date() },
    });

    const rows = await prisma.taxFilingLog.findMany({ where: { month: TEST_MONTH } });
    expect(rows).toHaveLength(2);
  });

  // Round 2 리뷰 지적 — 완료 API(`/api/settlement/tax-filing-log` POST)는 find-then-create가
  // 아니라 upsert를 써야 진짜 멱등하다. find-then-create는 두 요청이 동시에 "없음"을
  // 본 뒤 둘 다 create를 시도하면 두 번째가 이 유니크 제약으로 500을 내는 경쟁
  // 창이 있었다(체크박스가 실패로 보이지만 실제로는 커밋된 상태). upsert가 그 경쟁을
  // DB 레벨에서 원자적으로 흡수하는지 실 SQLite로 확인한다.
  it("upsert를 두 번 호출해도 에러 없이 같은 행 하나만 남는다(라우트의 POST와 동일 패턴)", async () => {
    const prisma = await loadPrisma();
    const first = await prisma.taxFilingLog.upsert({
      where: { month_kind: { month: TEST_MONTH, kind: "WITHHOLDING_RETURN" } },
      update: {},
      create: { month: TEST_MONTH, kind: "WITHHOLDING_RETURN", completedAt: new Date() },
    });
    const second = await prisma.taxFilingLog.upsert({
      where: { month_kind: { month: TEST_MONTH, kind: "WITHHOLDING_RETURN" } },
      update: {},
      create: { month: TEST_MONTH, kind: "WITHHOLDING_RETURN", completedAt: new Date() },
    });

    expect(second.id).toBe(first.id);
    expect(second.completedAt).toEqual(first.completedAt); // update: {} — 최초 완료 시각을 덮어쓰지 않는다.

    const rows = await prisma.taxFilingLog.findMany({
      where: { month: TEST_MONTH, kind: "WITHHOLDING_RETURN" },
    });
    expect(rows).toHaveLength(1);
  });
});
