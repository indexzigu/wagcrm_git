import { describe, it, expect } from "vitest";
import {
  buildDealMatchMemoContent,
  buildDealMatchProposalInput,
  buildDealMatchProposalTitle,
  buildProposalDedupeKey,
  buildRecampaignMemoContent,
  buildRecampaignProposalInput,
  buildRecampaignProposalTitle,
  readProposalDedupeKey,
  RECAMPAIGN_REQUEST_TYPE,
  type DealMatchProposalInput,
} from "../recampaign-proposal";
import { RERUN_PRIORITY_SALES } from "../deal-seller-matching";
import type { RecampaignAlert } from "../recampaign-timing";

const dueAlert: RecampaignAlert = {
  sellerId: "seller-1",
  sellerName: "김본명",
  runCount: 3,
  medianIntervalDays: 31,
  lastStartDate: "2026-05-01T00:00:00.000Z",
  dueDate: "2026-06-01T00:00:00.000Z",
  daysUntilDue: -36,
  state: "DUE",
  availabilityNote: null,
};

describe("recampaign-proposal", () => {
  it("메모 본문에 케이던스·횟수·경과일을 담는다", () => {
    const content = buildRecampaignMemoContent(dueAlert);
    expect(content).toContain("3회");
    expect(content).toContain("31일");
    expect(content).toContain("36일 경과");
    expect(content).toContain("다음 딜 제안");
  });

  it("가용 일정이 있으면 본문에 포함한다", () => {
    const content = buildRecampaignMemoContent({ ...dueAlert, availabilityNote: "9월까지 휴가" });
    expect(content).toContain("가용 일정: 9월까지 휴가");
  });

  it("가용 일정이 없으면 관련 문구를 넣지 않는다", () => {
    expect(buildRecampaignMemoContent(dueAlert)).not.toContain("가용 일정");
  });

  it("제목에 셀러명과 경과를 담는다", () => {
    expect(buildRecampaignProposalTitle(dueAlert)).toBe("재캠페인 적기: 김본명 (36일 경과)");
  });

  it("UPCOMING 알림은 'N일 후' 표기", () => {
    const upcoming: RecampaignAlert = { ...dueAlert, daysUntilDue: 4, state: "UPCOMING" };
    expect(buildRecampaignProposalTitle(upcoming)).toBe("재캠페인 적기: 김본명 (4일 후)");
    expect(buildRecampaignMemoContent(upcoming)).toContain("4일 후 도래");
  });

  it("기안 입력은 WRITE·PENDING_APPROVAL·add_entity_memo 페이로드를 구성한다", () => {
    const input = buildRecampaignProposalInput(dueAlert);
    expect(input.requestType).toBe(RECAMPAIGN_REQUEST_TYPE);
    expect(input.kind).toBe("WRITE");
    expect(input.status).toBe("PENDING_APPROVAL");
    expect(input.createdBy).toBe("SYSTEM"); // self-approval 게이트 통과용
    expect(input.targetEntityType).toBe("SELLER");
    expect(input.targetEntityId).toBe("seller-1");
    expect(input.payload.action).toBe("add_entity_memo");
    expect(input.payload.args).toMatchObject({ entityType: "SELLER", entityId: "seller-1" });
    expect(input.payload.args.content).toBe(input.resultSummary);
    expect(input.structuredResult.cadenceDays).toBe(31);
    expect(input.structuredResult.runCount).toBe(3);
  });

  it("케이던스 기안은 사유를 CADENCE_DUE·딜 없음으로 남긴다 (dedup 키의 축)", () => {
    const input = buildRecampaignProposalInput(dueAlert);
    expect(input.structuredResult.reason).toBe("CADENCE_DUE");
    expect(input.structuredResult.dealId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 중복 제거 키 (멱등성 4종 세트 ②) — 2단계에서 셀러 단독 → 셀러+사유+딜 로 넓혔다
// ---------------------------------------------------------------------------

describe("buildProposalDedupeKey", () => {
  it("같은 셀러라도 딜이 다르면 다른 키다 — 과차단 방지가 이 확장의 목적이다", () => {
    const a = buildProposalDedupeKey({ sellerId: "s1", reason: "SAME_DEAL_RERUN", dealId: "d1" });
    const b = buildProposalDedupeKey({ sellerId: "s1", reason: "SAME_DEAL_RERUN", dealId: "d2" });
    expect(a).not.toBe(b);
  });

  it("같은 셀러·같은 딜이라도 사유가 다르면 다른 키다", () => {
    const a = buildProposalDedupeKey({ sellerId: "s1", reason: "SAME_DEAL_RERUN", dealId: "d1" });
    const b = buildProposalDedupeKey({ sellerId: "s1", reason: "SAME_PARTNER", dealId: "d1" });
    expect(a).not.toBe(b);
  });

  it("딜 없는 케이던스 기안과 딜 기안은 서로를 막지 않는다", () => {
    const cadence = buildProposalDedupeKey({ sellerId: "s1", reason: "CADENCE_DUE", dealId: null });
    const deal = buildProposalDedupeKey({ sellerId: "s1", reason: "CADENCE_DUE", dealId: "d1" });
    expect(cadence).not.toBe(deal);
  });

  it("셋이 모두 같으면 같은 키다 (진짜 중복은 계속 막는다)", () => {
    expect(buildProposalDedupeKey({ sellerId: "s1", reason: "SAME_PARTNER", dealId: "d1" })).toBe(
      buildProposalDedupeKey({ sellerId: "s1", reason: "SAME_PARTNER", dealId: "d1" }),
    );
  });
});

describe("readProposalDedupeKey — 저장된 행에서 키를 복원한다", () => {
  it("기록된 사유·딜을 그대로 읽는다", () => {
    expect(
      readProposalDedupeKey({
        targetEntityId: "s1",
        structuredResult: { reason: "SAME_DEAL_RERUN", dealId: "d1" },
      }),
    ).toBe(buildProposalDedupeKey({ sellerId: "s1", reason: "SAME_DEAL_RERUN", dealId: "d1" }));
  });

  // 🔴 이 폴백이 없으면 dedup 을 넓히려다 오히려 뚫린다 — 딜 축 도입 이전의 열린 기안은
  // structuredResult 에 reason 이 없어서, 사유 미상으로 흘리면 같은 셀러에 케이던스 기안이
  // 한 건 더 생긴다.
  it("사유가 없는 레거시 행은 케이던스 기안으로 본다", () => {
    expect(
      readProposalDedupeKey({ targetEntityId: "s1", structuredResult: { cadenceDays: 31 } }),
    ).toBe(buildProposalDedupeKey({ sellerId: "s1", reason: "CADENCE_DUE", dealId: null }));
  });

  it("structuredResult 가 통째로 없어도 같게 본다", () => {
    expect(readProposalDedupeKey({ targetEntityId: "s1", structuredResult: null })).toBe(
      buildProposalDedupeKey({ sellerId: "s1", reason: "CADENCE_DUE", dealId: null }),
    );
  });

  // 🔴 실측 사고 — `actionProposalRepository` 가 SQLite 에서는 Json 을 **문자열로** 저장한다
  // (Postgres 는 객체). raw Prisma 로 읽으면 그 문자열이 그대로 올라오므로, 객체만 처리하면
  // 로컬에서 dedup 이 조용히 뚫려 같은 조합의 기안이 계속 생긴다.
  it("문자열로 저장된 Json 도 같은 키로 읽는다 (SQLite 직렬화)", () => {
    const asObject = readProposalDedupeKey({
      targetEntityId: "s1",
      structuredResult: { reason: "SAME_DEAL_RERUN", dealId: "d1" },
    });
    const asString = readProposalDedupeKey({
      targetEntityId: "s1",
      structuredResult: JSON.stringify({ reason: "SAME_DEAL_RERUN", dealId: "d1" }),
    });
    expect(asString).toBe(asObject);
  });

  it("깨진 Json 문자열은 레거시 행으로 안전하게 떨어진다", () => {
    expect(readProposalDedupeKey({ targetEntityId: "s1", structuredResult: "{not json" })).toBe(
      buildProposalDedupeKey({ sellerId: "s1", reason: "CADENCE_DUE", dealId: null }),
    );
  });

  it("셀러가 없는 행은 이 계열이 아니라 null 이다", () => {
    expect(readProposalDedupeKey({ targetEntityId: null, structuredResult: {} })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 딜 스코프 기안 — "이 셀러에게 이 딜"
// ---------------------------------------------------------------------------

const dealMatch: DealMatchProposalInput = {
  sellerId: "seller-1",
  sellerName: "김본명",
  dealId: "deal-1",
  dealName: "딜 이름",
  reason: "SAME_DEAL_RERUN",
  priority: true,
  pairRunCount: 2,
  pairDaysSinceLastRun: 200,
  pairSalesTotal: RERUN_PRIORITY_SALES + 2_000_000,
};

describe("딜 스코프 기안", () => {
  it("제목에 셀러·딜·사유를 담는다", () => {
    expect(buildDealMatchProposalTitle(dealMatch)).toBe("제안 검토: 김본명 × 딜 이름 (재진행)");
  });

  it("본문에 조합 이력과 우선순위를 담는다", () => {
    const content = buildDealMatchMemoContent(dealMatch);
    expect(content).toContain("2회 진행");
    expect(content).toContain("200일 경과");
    expect(content).toContain("1,200만원");
    expect(content).toContain("적극 검토");
  });

  it("매출 미입력이면 금액 문장을 아예 만들지 않는다 — 0원은 실적 없음으로 오독된다", () => {
    const content = buildDealMatchMemoContent({
      ...dealMatch,
      pairSalesTotal: null,
      priority: false,
    });
    expect(content).not.toContain("만원");
    expect(content).not.toContain("적극 검토");
  });

  it("접점 없는 신규 후보는 이력 문장을 만들지 않는다", () => {
    const content = buildDealMatchMemoContent({
      ...dealMatch,
      reason: "NEW_MATCH",
      priority: false,
      pairRunCount: null,
      pairDaysSinceLastRun: null,
      pairSalesTotal: null,
    });
    expect(content).toContain("신규 후보");
    expect(content).not.toContain("경과");
  });

  it("기안 입력은 케이던스 기안과 같은 규약을 따르고 dedup 축을 남긴다", () => {
    const input = buildDealMatchProposalInput(dealMatch);
    expect(input.requestType).toBe(RECAMPAIGN_REQUEST_TYPE);
    expect(input.kind).toBe("WRITE");
    expect(input.status).toBe("PENDING_APPROVAL");
    expect(input.createdBy).toBe("SYSTEM");
    expect(input.targetEntityType).toBe("SELLER");
    expect(input.targetEntityId).toBe("seller-1");
    expect(input.payload.args.content).toBe(input.resultSummary);
    expect(input.structuredResult.reason).toBe("SAME_DEAL_RERUN");
    expect(input.structuredResult.dealId).toBe("deal-1");
  });
});
