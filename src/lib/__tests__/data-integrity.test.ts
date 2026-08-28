import { describe, it, expect } from "vitest";
import { computeDataIntegrityIssues, type IntegrityCampaign } from "../data-integrity";

const NOW = new Date("2026-07-07T00:00:00.000Z");

function campaign(over: Partial<IntegrityCampaign> & { id: string }): IntegrityCampaign {
  return {
    campaignName: null,
    dealName: "보바 보조배터리",
    sellerName: "김본명",
    sellerAlias: null,
    endDate: "2026-06-01T00:00:00.000Z", // 과거(종료됨)
    actualSales: 1000000,
    status: "SETTLEMENT_WAIT",
    isDepositReceived: false,
    isPayoutCompleted: false,
    ...over,
  };
}

describe("computeDataIntegrityIssues", () => {
  it("종료됐는데 매출 미입력을 잡는다", () => {
    const issues = computeDataIntegrityIssues([campaign({ id: "a", actualSales: null })], NOW);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ type: "MISSING_SALES", campaignId: "a" });
    expect(issues[0].campaignName).toBe("보바 보조배터리 - 김본명");
  });

  it("아직 진행 중(종료일 미래)이면 매출 미입력은 정상으로 본다", () => {
    const issues = computeDataIntegrityIssues(
      [campaign({ id: "a", actualSales: null, endDate: "2026-08-01T00:00:00.000Z" })],
      NOW
    );
    expect(issues).toHaveLength(0);
  });

  it("COMPLETED인데 입금·지급 플래그 미완을 잡고 어느 쪽인지 표기한다", () => {
    const issues = computeDataIntegrityIssues(
      [campaign({ id: "a", status: "COMPLETED", isDepositReceived: true, isPayoutCompleted: false })],
      NOW
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("SETTLEMENT_INCOMPLETE");
    expect(issues[0].label).toContain("지급");
    expect(issues[0].label).not.toContain("입금");
  });

  it("COMPLETED이고 입금·지급 모두 완료면 문제없음", () => {
    const issues = computeDataIntegrityIssues(
      [campaign({ id: "a", status: "COMPLETED", isDepositReceived: true, isPayoutCompleted: true })],
      NOW
    );
    expect(issues).toHaveLength(0);
  });

  it("음수 매출을 잡는다", () => {
    const issues = computeDataIntegrityIssues([campaign({ id: "a", actualSales: -500 })], NOW);
    expect(issues.find((i) => i.type === "NEGATIVE_SALES")).toBeTruthy();
  });

  it("alias가 있으면 표시명에 우선한다", () => {
    const issues = computeDataIntegrityIssues(
      [campaign({ id: "a", actualSales: null, sellerAlias: "와이그라운드" })],
      NOW
    );
    expect(issues[0].campaignName).toBe("보바 보조배터리 - 와이그라운드");
  });

  it("campaignName이 있으면 그것을 우선 표기(구분자 정규화)", () => {
    const issues = computeDataIntegrityIssues(
      [campaign({ id: "a", actualSales: null, campaignName: "보바 · 김본명 3차" })],
      NOW
    );
    expect(issues[0].campaignName).toBe("보바 - 김본명 3차");
  });

  it("복수 문제는 각각 항목으로, 심각도(음수>정산>누락) 순 정렬", () => {
    const issues = computeDataIntegrityIssues(
      [
        campaign({ id: "miss", actualSales: null }), // MISSING
        campaign({ id: "settle", status: "COMPLETED", isDepositReceived: false, isPayoutCompleted: false }), // SETTLEMENT
        campaign({ id: "neg", actualSales: -1 }), // NEGATIVE
      ],
      NOW
    );
    expect(issues.map((i) => i.type)).toEqual(["NEGATIVE_SALES", "SETTLEMENT_INCOMPLETE", "MISSING_SALES"]);
  });

  it("문제 없으면 빈 배열", () => {
    const issues = computeDataIntegrityIssues(
      // 종료일이 미래여야 정말 깨끗하다 — 과거 종료 + ACTIVE 는 아래 SETTLEMENT_NOT_STARTED 대상이다.
      [campaign({ id: "a", actualSales: 1000000, status: "ACTIVE", endDate: "2026-08-01T00:00:00.000Z" })],
      NOW
    );
    expect(issues).toEqual([]);
  });
});

/**
 * 「정산 착수 지연」(T-062) — 판매도 반품기간도 끝났는데 아직 정산 단계로 안 넘어온 건.
 *
 * 실측 배경(2026-08-27 프로덕션): 정산 단계 밖에는 정산 **예정일이 한 건도 없어서**
 * 상태 필터를 넓혀도 지연 목록에 추가되는 건이 0건이었다. 그래서 오너 결정은
 * "예정일 대신 경과일로 잡는다"였고 그 판정이 이 유형이다.
 *
 * ⏰ 고정 날짜 픽스처 금지(P9) — 위 `NOW` 기준 상대 날짜만 쓴다.
 */
describe("computeDataIntegrityIssues — SETTLEMENT_NOT_STARTED", () => {
  // NOW = 2026-07-07. 반품기간 기본값은 종료 +14일이므로 종료가 2026-06-01 이면 기준일은 06-15.
  const ENDED_LONG_AGO = "2026-06-01T00:00:00.000Z";

  it("반품기간(종료 +14일)이 지난 CLOSED 캠페인을 잡는다", () => {
    const issues = computeDataIntegrityIssues(
      [campaign({ id: "a", status: "CLOSED", endDate: ENDED_LONG_AGO })],
      NOW
    );
    const hit = issues.find((i) => i.type === "SETTLEMENT_NOT_STARTED");
    expect(hit).toBeTruthy();
    expect(hit!.campaignId).toBe("a");
    expect(hit!.label).toContain("22일 경과");
  });

  it("아직 판매 중(ACTIVE)이어도 반품기간이 지났으면 잡는다 — 마감 처리 누락", () => {
    const issues = computeDataIntegrityIssues(
      [campaign({ id: "a", status: "ACTIVE", endDate: ENDED_LONG_AGO })],
      NOW
    );
    expect(issues.some((i) => i.type === "SETTLEMENT_NOT_STARTED")).toBe(true);
  });

  it("반품기간 종료일이 입력돼 있으면 그것이 기준이다(종료 +14일 폴백보다 우선)", () => {
    const issues = computeDataIntegrityIssues(
      [
        campaign({
          id: "a",
          status: "CLOSED",
          endDate: ENDED_LONG_AGO,
          // 폴백(06-15)이면 지연이지만, 실제 반품기간은 아직 안 끝났다.
          returnPeriodEndDate: "2026-07-20T00:00:00.000Z",
        }),
      ],
      NOW
    );
    expect(issues.some((i) => i.type === "SETTLEMENT_NOT_STARTED")).toBe(false);
  });

  it("기준일이 오늘이면 아직 지연이 아니다 — 경계는 KST 달력일", () => {
    const issues = computeDataIntegrityIssues(
      [
        campaign({
          id: "a",
          status: "CLOSED",
          endDate: ENDED_LONG_AGO,
          returnPeriodEndDate: "2026-07-07T00:00:00.000Z",
        }),
      ],
      NOW
    );
    expect(issues.some((i) => i.type === "SETTLEMENT_NOT_STARTED")).toBe(false);
  });

  // 상태가 8개이므로 픽스처도 8개 — 어느 상태가 대상인지를 표로 못박는다.
  const STATUS_EXPECTATION: [string, boolean][] = [
    ["PROPOSAL", false], // 판매한 적 없는 방치 건이 목록을 채운다(실측 10건·경과 중앙 386일)
    ["PREPARATION", false], // 판매 시작 전이라 착수를 물을 수 없다
    ["ACTIVE", true],
    ["CLOSED", true],
    ["SETTLEMENT_WAIT", false], // 이미 정산 단계 — 착수는 했다
    ["SETTLEMENT_IN_PROGRESS", false],
    ["COMPLETED", false],
    ["DROPPED", false],
  ];

  it.each(STATUS_EXPECTATION)("상태 %s 는 착수 지연 대상=%s", (status, expected) => {
    const issues = computeDataIntegrityIssues(
      [campaign({ id: "a", status, endDate: ENDED_LONG_AGO })],
      NOW
    );
    expect(issues.some((i) => i.type === "SETTLEMENT_NOT_STARTED")).toBe(expected);
  });

  it("그룹은 묶음당 1건으로 접고 가장 오래 밀린 멤버의 경과일을 쓴다", () => {
    const issues = computeDataIntegrityIssues(
      [
        campaign({
          id: "m1",
          status: "CLOSED",
          endDate: ENDED_LONG_AGO,
          groupId: "g1",
          group: { name: "여름 공구 묶음", isDepositReceived: false, isPayoutCompleted: false },
        }),
        campaign({
          id: "m2",
          status: "CLOSED",
          endDate: "2026-06-10T00:00:00.000Z", // 기준일 06-24 → 13일 경과(더 짧다)
          groupId: "g1",
          group: { name: "여름 공구 묶음", isDepositReceived: false, isPayoutCompleted: false },
        }),
      ],
      NOW
    );
    const hits = issues.filter((i) => i.type === "SETTLEMENT_NOT_STARTED");
    expect(hits).toHaveLength(1);
    expect(hits[0].campaignName).toBe("여름 공구 묶음");
    expect(hits[0].campaignId).toBe("m1");
    expect(hits[0].label).toContain("22일 경과");
    expect(hits[0].label).toContain("멤버 2건");
  });

  /**
   * 라벨 **형태** 회귀 — 초판이 두 가지를 어겼다(ss-ux 검토 2026-08-27).
   * ①묶음일 때 `…(22일 경과)(멤버 2건)` 으로 괄호가 두 쌍 붙어 오타처럼 읽혔다.
   * ②형제 라벨보다 길어서, 소비 행이 라벨 쪽을 `shrink-0` 으로 두는 탓에
   *   **어느 캠페인인지가 대신 잘렸다**(캠페인명에만 `truncate` 가 걸려 있다).
   */
  it("괄호는 접미사 한 쌍뿐이다 — 묶음일 때도", () => {
    const solo = computeDataIntegrityIssues(
      [campaign({ id: "a", status: "CLOSED", endDate: ENDED_LONG_AGO })],
      NOW
    ).find((i) => i.type === "SETTLEMENT_NOT_STARTED")!;
    expect(solo.label).not.toContain("(");

    const grouped = computeDataIntegrityIssues(
      [
        campaign({
          id: "m1",
          status: "CLOSED",
          endDate: ENDED_LONG_AGO,
          groupId: "g1",
          group: { name: "묶음", isDepositReceived: false, isPayoutCompleted: false },
        }),
        campaign({
          id: "m2",
          status: "CLOSED",
          endDate: ENDED_LONG_AGO,
          groupId: "g1",
          group: { name: "묶음", isDepositReceived: false, isPayoutCompleted: false },
        }),
      ],
      NOW
    ).find((i) => i.type === "SETTLEMENT_NOT_STARTED")!;
    expect(grouped.label.match(/\(/g)).toHaveLength(1);
    expect(grouped.label.match(/\)/g)).toHaveLength(1);
  });

  it("형제 최장 라벨보다 길지 않다 — 길면 캠페인명이 대신 잘린다", () => {
    // 비교군은 하드코딩이 아니라 같은 함수가 만든 형제 라벨이다(문구가 바뀌어도 따라간다).
    const sibling = computeDataIntegrityIssues(
      [
        campaign({
          id: "s",
          status: "COMPLETED",
          isDepositReceived: false,
          isPayoutCompleted: false,
        }),
      ],
      NOW
    ).find((i) => i.type === "SETTLEMENT_INCOMPLETE")!;
    const mine = computeDataIntegrityIssues(
      [campaign({ id: "a", status: "CLOSED", endDate: ENDED_LONG_AGO })],
      NOW
    ).find((i) => i.type === "SETTLEMENT_NOT_STARTED")!;
    expect(mine.label.length).toBeLessThanOrEqual(sibling.label.length);
  });

  it("심각도는 정산 불일치 아래, 실매출 미입력 위다", () => {
    const issues = computeDataIntegrityIssues(
      [
        campaign({ id: "miss", actualSales: null }),
        campaign({ id: "start", status: "CLOSED", endDate: ENDED_LONG_AGO }),
        campaign({
          id: "settle",
          status: "COMPLETED",
          isDepositReceived: false,
          isPayoutCompleted: false,
        }),
      ],
      NOW
    );
    expect(issues.map((i) => i.type)).toEqual([
      "SETTLEMENT_INCOMPLETE",
      "SETTLEMENT_NOT_STARTED",
      "MISSING_SALES",
    ]);
  });
});

/**
 * 그룹캠페인(CG-1) 접기 회귀 — 그룹은 실캠페인 1개의 딜별 분할이므로 멤버별 이슈를
 * 나열하면 같은 실물 문제가 멤버 수만큼 부풀려진다. (그룹, 유형)당 1건으로 접고,
 * 정산 플래그 유형은 그룹 플래그(SoT)로 판정한다.
 */
describe("computeDataIntegrityIssues — 그룹캠페인 접기", () => {
  const groupScalars = { name: "[가온] 비타민 외 2건", isDepositReceived: false, isPayoutCompleted: false };
  const member = (id: string, over: Partial<IntegrityCampaign> = {}): IntegrityCampaign =>
    campaign({ id, groupId: "g1", group: groupScalars, ...over });

  it("그룹 멤버 3건의 실매출 미입력은 그룹명 이슈 1건(멤버 3건 병기)으로 접힌다", () => {
    const issues = computeDataIntegrityIssues(
      [
        member("m1", { actualSales: null }),
        member("m2", { actualSales: null }),
        member("m3", { actualSales: null }),
        campaign({ id: "solo", actualSales: null }), // 미그룹은 개별 유지
      ],
      NOW
    );
    expect(issues).toHaveLength(2);
    const groupIssue = issues.find((i) => i.campaignId === "m1");
    expect(groupIssue).toMatchObject({
      type: "MISSING_SALES",
      campaignName: "[가온] 비타민 외 2건",
      label: "종료됐으나 실매출 미입력(멤버 3건)",
    });
    expect(issues.find((i) => i.campaignId === "solo")).toMatchObject({
      label: "종료됐으나 실매출 미입력",
    });
  });

  it("정산 플래그는 그룹이 SoT — 멤버 플래그가 낡아도 그룹이 완납이면 이슈가 아니다", () => {
    const paidGroup = { ...groupScalars, isDepositReceived: true, isPayoutCompleted: true };
    const issues = computeDataIntegrityIssues(
      [
        member("m1", { status: "COMPLETED", isDepositReceived: false, isPayoutCompleted: false, group: paidGroup }),
        member("m2", { status: "COMPLETED", isDepositReceived: false, isPayoutCompleted: false, group: paidGroup }),
      ],
      NOW
    );
    expect(issues).toEqual([]);
  });

  it("그룹 플래그 미완이면 COMPLETED 멤버가 여럿이어도 SETTLEMENT_INCOMPLETE 1건", () => {
    const issues = computeDataIntegrityIssues(
      [
        member("m1", { status: "COMPLETED" }),
        member("m2", { status: "COMPLETED" }),
      ],
      NOW
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      type: "SETTLEMENT_INCOMPLETE",
      campaignId: "m1",
      campaignName: "[가온] 비타민 외 2건",
      // 라벨은 슬롯에서 파생한다 — 셀러몰 갈래는 [입금(셀러), 지급(공급사)]다.
      label: "정산완료 처리됐으나 셀러 입금·공급사 지급 미확인",
    });
  });

  it("그룹명이 없으면 첫 멤버 표기명 외 N-1건으로 합성한다", () => {
    const noName = { ...groupScalars, name: null };
    const issues = computeDataIntegrityIssues(
      [
        member("m1", { actualSales: -5, group: noName }),
        member("m2", { group: noName }),
      ],
      NOW
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      type: "NEGATIVE_SALES",
      campaignName: "보바 보조배터리 - 김본명 외 1건",
      label: "매출이 음수로 입력됨",
    });
  });
});

/**
 * SETTLEMENT_INCOMPLETE 의 요구 플래그 집합은 채널이 정한다(2026-08-25 2단계).
 * 종전 `!입금 || !지급` 은 자사몰에서 **정상 완료된 캠페인 전건**을 「입금 미확인」으로
 * 데이터 점검 카드에 상주시켰다(입금 플래그가 켜질 경로가 아예 없다).
 */
describe("computeDataIntegrityIssues — 자사몰 완료 판정", () => {
  const ownMall = (over: Partial<IntegrityCampaign>): IntegrityCampaign => ({
    id: "own-1",
    campaignName: "자사몰 캠페인",
    dealName: "비타민",
    sellerName: "본명",
    sellerAlias: "가온",
    endDate: new Date("2026-07-01T00:00:00.000Z"),
    actualSales: 1000,
    status: "COMPLETED",
    salesChannel: "OWN_MALL_NAVER",
    isDepositReceived: false,
    isPayoutCompleted: true,
    isSupplierPayoutCompleted: true,
    groupId: null,
    group: null,
    ...over,
  });

  it("두 지급이 끝났으면 입금 플래그가 false 여도 이슈가 아니다", () => {
    expect(computeDataIntegrityIssues([ownMall({})], NOW)).toEqual([]);
  });

  it("공급사 지급이 남아 있으면 그 칸을 상대와 함께 지목한다", () => {
    const issues = computeDataIntegrityIssues(
      [ownMall({ isSupplierPayoutCompleted: false })],
      NOW,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      type: "SETTLEMENT_INCOMPLETE",
      label: "정산완료 처리됐으나 공급사 지급 미확인",
    });
  });
});
