import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  buildOverdueSettlementItems,
  type AgendaSettlementCampaign,
} from "../agenda-settlements";
import { buildSettlementPending } from "@/components/mobile/mobile-settlement-pending-sheet";
import type { MobileSettlementCampaign } from "../mobile-settlement-data";
import { SETTLEMENT_STAGE_STATUSES } from "../settlement-stage";

/**
 * 대금 지연/대기를 보여주는 **두 표면의 판정 일치 계약** (T-062, 2026-08-27).
 *
 * 데스크톱 아젠다(`buildOverdueSettlementItems`)와 모바일 대기 목록
 * (`buildSettlementPending`)은 같은 질문을 서로 다른 입력 모양(서버 `Date` vs 모바일
 * ymd 문자열)으로 받는다. 그래서 타입이 어긋남을 잡아주지 못하고, 실제로 **세 축**이
 * 갈라져 있었다(실측 2026-08-27 프로덕션):
 *
 * 1. 상태 집합이 세 파일에 손으로 박혀 있었다 → 한 곳만 넓히면 두 화면이 다른 모집단을 본다.
 * 2. 「오늘」 경계가 달랐다(아젠다 `date <= now` / 모바일 `ymd < today`).
 * 3. 조합 캠페인 접기가 달랐다(아젠다는 묶음당 1행, 모바일은 딜마다 1행 — 멤버 4건짜리
 *    묶음이 모바일에서만 4줄·4건으로 세어졌다).
 *
 * 이 계약은 두 가지를 고정한다 — ①같은 픽스처를 두 빌더에 넣어 **접힌 단위와 지연 판정이
 * 일치**하는가(행위) ②모집단 상수를 표면이 다시 선언하지 않는가(소스 스캔, 미래의 새
 * 호출부까지 덮는 유일한 수단).
 */

const NOW = new Date("2026-08-27T03:00:00.000Z"); // KST 2026-08-27 12:00
const TODAY_YMD = "2026-08-27";

type Fixture = {
  id: string;
  status: string;
  groupId: string | null;
  groupName: string | null;
  salesChannel: string;
  dealName: string;
  sellerName: string;
  expectedDepositDate: string | null;
  expectedPayoutDate: string | null;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  /** 아젠다가 그대로 합산하는 컬럼(모달 대조 금액). */
  settlementSales: number | null;
  /** 모바일 대기 금액의 근거 — 셀러몰 입금 = 실매출 − 셀러수수료(슬롯 SSOT, T-057). */
  actualSales: number | null;
  sellerExpense: number | null;
};

function fixture(over: Partial<Fixture> & { id: string }): Fixture {
  return {
    status: "SETTLEMENT_WAIT",
    groupId: null,
    groupName: null,
    salesChannel: "SELLER_MALL", // [입금(셀러), 지급(공급사)]
    dealName: "비타민",
    sellerName: "가온",
    expectedDepositDate: null,
    expectedPayoutDate: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    settlementSales: 100,
    actualSales: 140,
    sellerExpense: 40, // 입금 근거 = 100
    ...over,
  };
}

/** 서버(아젠다) 입력 모양 — 날짜는 UTC 자정 `Date`, 그룹 스칼라가 SoT. */
function toAgenda(f: Fixture): AgendaSettlementCampaign {
  const group = f.groupId
    ? {
        name: f.groupName,
        expectedDepositDate: f.expectedDepositDate ? new Date(f.expectedDepositDate) : null,
        expectedPayoutDate: f.expectedPayoutDate ? new Date(f.expectedPayoutDate) : null,
        expectedSupplierPayoutDate: null,
        isDepositReceived: f.isDepositReceived,
        isPayoutCompleted: f.isPayoutCompleted,
        isSupplierPayoutCompleted: false,
      }
    : null;
  return {
    id: f.id,
    status: f.status,
    salesChannel: f.salesChannel,
    expectedDepositDate: f.expectedDepositDate ? new Date(f.expectedDepositDate) : null,
    expectedPayoutDate: f.expectedPayoutDate ? new Date(f.expectedPayoutDate) : null,
    expectedSupplierPayoutDate: null,
    isDepositReceived: f.isDepositReceived,
    isPayoutCompleted: f.isPayoutCompleted,
    isSupplierPayoutCompleted: false,
    settlementSales: f.settlementSales,
    actualPayoutAmount: null,
    groupId: f.groupId,
    group,
    deal: { dealName: f.dealName },
    seller: { name: f.sellerName, alias: null, accountNumber: null, snsType: null },
  };
}

/** 모바일 입력 모양 — 그룹 dual-read 를 이미 거친 평면 행(ymd 문자열). */
function toMobile(f: Fixture): MobileSettlementCampaign {
  return {
    id: f.id,
    groupId: f.groupId,
    groupName: f.groupName,
    dealName: f.dealName,
    sellerName: f.sellerName,
    roundNumber: null,
    status: f.status as MobileSettlementCampaign["status"],
    salesChannel: f.salesChannel as MobileSettlementCampaign["salesChannel"],
    startDate: "2026-07-01",
    endDate: "2026-07-15",
    expectedDepositDate: f.expectedDepositDate,
    expectedPayoutDate: f.expectedPayoutDate,
    expectedSupplierPayoutDate: null,
    settlementSales: f.settlementSales,
    sellerExpense: f.sellerExpense,
    actualSales: f.actualSales,
    actualPayoutAmount: null,
    isDepositReceived: f.isDepositReceived,
    isPayoutCompleted: f.isPayoutCompleted,
    isSupplierPayoutCompleted: false,
  };
}

/** 모바일 대기 목록에서 **지연으로 판정된** 줄의 대표 캠페인 id 집합. */
function mobileOverdueIds(fixtures: Fixture[]): string[] {
  const pending = buildSettlementPending(fixtures.map(toMobile), TODAY_YMD);
  return [...pending.deposit.rows, ...pending.payout.rows]
    .filter((row) => row.overdue)
    .map((row) => row.campaign.id)
    .sort();
}

function agendaOverdueIds(fixtures: Fixture[]): string[] {
  return buildOverdueSettlementItems(fixtures.map(toAgenda), NOW)
    .map((item) => item.id)
    .sort();
}

describe("두 표면 판정 일치 — 모집단(상태 집합)", () => {
  // 상태가 8개이므로 픽스처도 8개. 정산 단계만 두 표면 모두에 들어와야 한다.
  const ALL_STATUSES = [
    "PROPOSAL",
    "PREPARATION",
    "ACTIVE",
    "CLOSED",
    "SETTLEMENT_WAIT",
    "SETTLEMENT_IN_PROGRESS",
    "COMPLETED",
    "DROPPED",
  ];

  it.each(ALL_STATUSES)("상태 %s 를 두 표면이 같게 취급한다", (status) => {
    const fixtures = [fixture({ id: "c1", status, expectedDepositDate: "2026-08-20" })];
    const inScope = (SETTLEMENT_STAGE_STATUSES as readonly string[]).includes(status);
    expect(agendaOverdueIds(fixtures)).toEqual(inScope ? ["c1"] : []);
    expect(mobileOverdueIds(fixtures)).toEqual(inScope ? ["c1"] : []);
  });
});

describe("두 표면 판정 일치 — 「오늘」 경계", () => {
  const CASES: [label: string, ymd: string, overdue: boolean][] = [
    ["그저께", "2026-08-25", true],
    ["어제", "2026-08-26", true],
    ["오늘", "2026-08-27", false],
    ["내일", "2026-08-28", false],
  ];

  it.each(CASES)("%s 예정 → 지연=%s 가 두 표면에서 같다", (_label, ymd, overdue) => {
    const fixtures = [fixture({ id: "c1", expectedDepositDate: ymd })];
    const expected = overdue ? ["c1"] : [];
    expect(agendaOverdueIds(fixtures)).toEqual(expected);
    expect(mobileOverdueIds(fixtures)).toEqual(expected);
  });
});

describe("두 표면 판정 일치 — 조합 캠페인 접기", () => {
  const members = [
    fixture({
      id: "m1",
      groupId: "g1",
      groupName: "여름 공구 묶음",
      dealName: "딜A",
      expectedDepositDate: "2026-08-20",
      settlementSales: 100,
      actualSales: 140,
      sellerExpense: 40,
    }),
    fixture({
      id: "m2",
      groupId: "g1",
      groupName: "여름 공구 묶음",
      dealName: "딜B",
      expectedDepositDate: "2026-08-20",
      settlementSales: 250,
      actualSales: 300,
      sellerExpense: 50,
    }),
    fixture({
      id: "m3",
      groupId: "g1",
      groupName: "여름 공구 묶음",
      dealName: "딜C",
      expectedDepositDate: "2026-08-20",
      settlementSales: 400,
      actualSales: 460,
      sellerExpense: 60,
    }),
  ];

  it("멤버 3건이 두 표면 모두 한 줄로 접히고 대표가 같다", () => {
    expect(agendaOverdueIds(members)).toEqual(["m1"]);
    expect(mobileOverdueIds(members)).toEqual(["m1"]);
  });

  it("접힌 줄의 이름이 두 표면에서 같다", () => {
    const agendaTitle = buildOverdueSettlementItems(members.map(toAgenda), NOW)[0].title;
    const mobileTitle = buildSettlementPending(members.map(toMobile), TODAY_YMD).deposit.rows[0]
      .title;
    expect(agendaTitle).toBe("여름 공구 묶음");
    expect(mobileTitle).toBe("여름 공구 묶음");
  });

  it("묶음 이름이 없으면 두 표면 모두 「외 N건」 폴백을 쓴다", () => {
    const unnamed = members.map((m) => ({ ...m, groupName: null }));
    const agendaTitle = buildOverdueSettlementItems(unnamed.map(toAgenda), NOW)[0].title;
    const mobileTitle = buildSettlementPending(unnamed.map(toMobile), TODAY_YMD).deposit.rows[0]
      .title;
    // 구분자만 다르다 — 아젠다는 `딜 - 셀러`, 모바일은 `딜 · 셀러` 로 각 화면의 기존 표기다.
    expect(agendaTitle).toBe("딜A - 가온 외 2건");
    expect(mobileTitle).toBe("딜A · 가온 외 2건");
  });

  /**
   * ⚠️ **두 표면은 서로 다른 양을 잰다** — 아젠다의 `settlementSales` 는 모달이 대조할
   * 컬럼 합계이고, 모바일의 `amount` 는 슬롯 근거로 계산한 대기 금액이다(셀러몰 입금 =
   * 실매출 − 셀러수수료, T-057). 그래서 값이 같아야 한다고 단언하면 안 된다.
   * **공유하는 규칙은 「대표 하나가 아니라 멤버 합산」** 하나이고, 이 테스트가 그걸 본다.
   */
  it("금액은 두 표면 모두 대표가 아니라 멤버 합산이다", () => {
    const agendaAmount = buildOverdueSettlementItems(members.map(toAgenda), NOW)[0]
      .settlementSales;
    const mobileAmount = buildSettlementPending(members.map(toMobile), TODAY_YMD).deposit.rows[0]
      .amount;
    const expectedAgenda = members.reduce((sum, m) => sum + (m.settlementSales ?? 0), 0);
    const expectedMobile = members.reduce(
      (sum, m) => sum + ((m.actualSales ?? 0) - (m.sellerExpense ?? 0)),
      0,
    );
    expect(agendaAmount).toBe(expectedAgenda);
    expect(mobileAmount).toBe(expectedMobile);
    // 대표 한 명의 값이 아님을 못박는다 — 멤버가 3건이므로 대표값과 달라야 한다.
    expect(agendaAmount).not.toBe(members[0].settlementSales);
    expect(mobileAmount).not.toBe((members[0].actualSales ?? 0) - (members[0].sellerExpense ?? 0));
  });

  it("미그룹과 묶음이 섞여도 단위 수가 같다", () => {
    const mixed = [...members, fixture({ id: "solo", expectedDepositDate: "2026-08-20" })];
    expect(agendaOverdueIds(mixed)).toEqual(["m1", "solo"]);
    expect(mobileOverdueIds(mixed)).toEqual(["m1", "solo"]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 소스 스캔 — 모집단 상수를 표면이 다시 선언하지 않는가.
 *
 * 🪤 **주석을 걷어내고 스캔한다.** 이 계약을 설명하는 경고 주석이 금지 문자열을 인용하면
 * 자기 자신을 위반으로 잡는다(이 레포가 세 번 밟은 함정). 판정은 정규식이 아니라 AST 로
 * 한다 — 손수 만든 스트리퍼는 정규식 리터럴을 삼키고 그 고장이 초록으로 보인다.
 * ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");

/**
 * 대금 대기/지연을 만드는 표면 — 상태 집합을 스스로 정하면 두 화면이 갈라진다.
 *
 * ⚠️ **손으로 적은 목록이라 새 표면은 자동으로 안 걸린다.** 전체 소스를 훑는 방식
 * (`cron-auth.contract.test.ts` 선례)을 쓰지 않은 이유는, 이 상태 문자열이 **다른 질문에도
 * 정당하게 쓰이기 때문**이다 — 정산 리포트는 `[SETTLEMENT_IN_PROGRESS, COMPLETED]`, 명세서
 * 허용 상태는 셋, 대시보드 캐시는 여섯 개다. 전수 스캔은 그 정당한 사용처를 전부 위반으로
 * 잡는다. ⛔ 그러니 대금 대기/지연을 만드는 표면을 새로 만들면 **이 배열에 등재할 것.**
 */
const MONEY_SURFACES = [
  join(SRC, "app", "api", "agenda", "route.ts"),
  join(SRC, "lib", "mobile-settlement-data.ts"),
  join(SRC, "components", "mobile", "mobile-settlement-pending-sheet.tsx"),
];

/** 파일 안의 모든 문자열 리터럴(주석 제외 — AST 는 주석을 노드로 만들지 않는다). */
function stringLiteralsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    node.forEachChild(walk);
  };
  walk(sf);
  return out;
}

describe("모집단 상수 소스 스캔", () => {
  it.each(MONEY_SURFACES)("%s 는 정산 단계 상태를 문자열로 다시 적지 않는다", (file) => {
    const literals = stringLiteralsOf(file);
    const restated = SETTLEMENT_STAGE_STATUSES.filter((status) => literals.includes(status));
    expect(restated).toEqual([]);
  });

  it.each(MONEY_SURFACES)("%s 는 settlement-stage 의 상수를 import 한다", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain("SETTLEMENT_STAGE_STATUSES");
    expect(source).toMatch(/from ["'](?:@\/lib\/|\.\/|\.\.\/)?settlement-stage["']/);
  });

  it("양성 대조군 — 스캐너가 실제로 문자열을 본다", () => {
    // 이 파일 자신에는 위 상태 문자열이 리터럴로 존재한다(ALL_STATUSES 픽스처).
    const literals = stringLiteralsOf(join(SRC, "lib", "__tests__", "settlement-surface-parity.contract.test.ts"));
    expect(literals).toContain("SETTLEMENT_WAIT");
  });
});
