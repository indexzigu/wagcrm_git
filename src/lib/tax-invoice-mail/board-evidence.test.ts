import { describe, it, expect } from "vitest";
import {
  indexReceiptScan,
  reconstructGroupMembers,
  resolveRowEvidence,
  type ReceiptScanApiResponse,
  type BoardRowForEvidence,
} from "./board-evidence";
import type { ReceiptVerdict } from "./receipt-match";

/** 값은 전부 가짜다(P0 — public 레포). */
function verdict(overrides: Partial<ReceiptVerdict> = {}): ReceiptVerdict {
  return {
    status: "VERIFIED",
    confidence: "ATTACHMENT",
    matchedKey: "camp1:SUPPLIER_GOODS",
    candidateKeys: ["camp1:SUPPLIER_GOODS"],
    reasons: [],
    observed: {
      issueId: "1".repeat(24),
      writtenDate: "2026-07-15",
      counterpartBusinessNumber: "4445566666",
      totalAmount: 7_000_000,
      expectedTotalAmount: 7_000_000,
      amountDelta: 0,
    },
    ...overrides,
  };
}

function scan(overrides: Partial<ReceiptScanApiResponse> = {}): ReceiptScanApiResponse {
  return {
    scan: { box: "세금계산서", headerScanned: 0, candidates: 0, truncated: 0, sinceDays: 90 },
    summary: {
      verified: 0,
      needsReview: 0,
      notOurs: 0,
      issuedByUs: 0,
      expectedTotal: 0,
      unseenExpected: 0,
      passwordProtected: 0,
      attachmentCensus: {},
    },
    results: [],
    unseenExpected: [],
    ...overrides,
  };
}

function mailEntry(uid: number, v: ReceiptVerdict) {
  return { mail: { uid, subject: "s", fromAddress: "f", receivedAt: "r", hasAttachmentEvidence: true }, verdict: v };
}

function unseenItem(key: string, campaignId: string, slot: "SUPPLIER_GOODS" | "SELLER_COMMISSION" = "SUPPLIER_GOODS") {
  return {
    key,
    campaignId,
    campaignLabel: "캠페인",
    channel: "OWN_MALL",
    slot,
    counterpartLabel: "공급사",
    expectedTotalAmount: 1,
    amountBasis: "물품비",
    trackingField: "supplierInvoiceIssuedAt" as const,
    alreadyMarkedAt: null,
  };
}

/** 미그룹 단일 캠페인 행. */
function soloRow(
  campaignId: string,
  sourceField: BoardRowForEvidence["sourceField"] = "supplierInvoiceIssuedAt",
): BoardRowForEvidence {
  return { campaignId, campaignIds: [campaignId], groupId: null, sourceField, direction: "RECEIVE" };
}

/** 정산 그룹 행 — 대표(anchor)는 항상 첫 번째 id. */
function groupRow(
  campaignIds: string[],
  sourceField: BoardRowForEvidence["sourceField"] = "supplierInvoiceIssuedAt",
  groupId = "group1",
): BoardRowForEvidence {
  return { campaignId: campaignIds[0], campaignIds, groupId, sourceField, direction: "RECEIVE" };
}

describe("resolveRowEvidence — 단일(미그룹) 캠페인 행", () => {
  it("ISSUE 행은 엔진이 다루지 않으므로 null", () => {
    const byKey = indexReceiptScan(scan());
    const row: BoardRowForEvidence = {
      campaignId: "camp1",
      campaignIds: ["camp1"],
      groupId: null,
      sourceField: "supplierInvoiceIssuedAt",
      direction: "ISSUE",
    };
    expect(resolveRowEvidence(row, byKey)).toBeNull();
  });

  it("매칭된 VERIFIED 건은 승인번호·작성일자·금액을 그대로 실어 낸다", () => {
    const byKey = indexReceiptScan(scan({ results: [mailEntry(1, verdict())] }));
    const result = resolveRowEvidence(soloRow("camp1"), byKey);
    expect(result).toEqual({
      kind: "verified",
      detail: { issueId: "1".repeat(24), writtenDate: "2026-07-15", totalAmount: 7_000_000 },
      memberCount: 1,
    });
  });

  it("NEEDS_REVIEW 건은 사유 메시지를 한국어 그대로 넘긴다(확인 필요 한 마디가 아니다)", () => {
    const mismatched = verdict({
      status: "NEEDS_REVIEW",
      reasons: [{ code: "AMOUNT_MISMATCH", message: "금액이 다릅니다. 계산서 5,000,000원 vs 정산 7,000,000원." }],
    });
    const byKey = indexReceiptScan(scan({ results: [mailEntry(1, mismatched)] }));
    const result = resolveRowEvidence(soloRow("camp1"), byKey);
    expect(result).toEqual({
      kind: "needs_review",
      reasons: ["금액이 다릅니다. 계산서 5,000,000원 vs 정산 7,000,000원."],
      memberCount: 1,
    });
  });

  it("unseenExpected 에만 있는 건은 미수취(unseen)로 표시한다", () => {
    const byKey = indexReceiptScan(scan({ unseenExpected: [unseenItem("camp1:SUPPLIER_GOODS", "camp1")] }));
    const result = resolveRowEvidence(soloRow("camp1"), byKey);
    expect(result).toEqual({ kind: "unseen", memberCount: 1 });
  });

  /**
   * ⛔ 「대조 불가」를 「미수취」로 합치지 않는다 — 상대 사업자번호가 없으면 계산서가 와
   * 있어도 영원히 매칭되지 않으므로, 미수취로 세는 순간 화면이 「안 왔다」고 단정한다.
   * 처방도 다르다(독촉 vs 사업자번호 등록).
   */
  it("상대 사업자번호가 없는 기대 건은 미수취가 아니라 대조 불가다", () => {
    const byKey = indexReceiptScan(
      scan({
        unseenExpected: [
          { ...unseenItem("camp1:SUPPLIER_GOODS", "camp1"), counterpartBusinessNumberMissing: true },
        ],
      }),
    );
    expect(resolveRowEvidence(soloRow("camp1"), byKey)).toEqual({ kind: "unmatchable", memberCount: 1 });
  });

  /** 음성 대조군 — 플래그가 없거나 false 면 종전대로 미수취다(전부 대조 불가로 뭉개지 않는다). */
  it("플래그가 없으면 종전대로 미수취로 남는다", () => {
    const byKey = indexReceiptScan(
      scan({
        unseenExpected: [
          { ...unseenItem("camp1:SUPPLIER_GOODS", "camp1"), counterpartBusinessNumberMissing: false },
        ],
      }),
    );
    expect(resolveRowEvidence(soloRow("camp1"), byKey)).toEqual({ kind: "unseen", memberCount: 1 });
  });

  it("스캔의 expected 목록에 애초에 없는 캠페인은 no_data — 미확인도 미수취도 아니다", () => {
    const byKey = indexReceiptScan(scan());
    const result = resolveRowEvidence(soloRow("camp-outside-window"), byKey);
    expect(result).toEqual({ kind: "no_data" });
  });
});

// 그룹 행(campaignIds 여러 건) — 엔진이 그룹당 한 장으로 합쳤을 수도, 상대 불일치로
// 캠페인별로 후퇴했을 수도 있다(스펙 「✅ 정산 그룹의 계산서 장수 — 확정」절 이후).
// 대표(anchor=campaignId) 자신의 키 문자열은 두 경우 다 똑같은 모양이라, "대표 외
// 멤버의 키가 실재하는가"로 어느 쪽인지 판별한다 — 이 describe 블록의 각 하위 블록이
// 그 두 경로를 각각 고정한다.
describe("resolveRowEvidence — 엔진이 그룹을 1건으로 합친 경우(대표 외 키가 없음)", () => {
  it("대표 키가 VERIFIED 면 그룹 전체가 확인됨 — 실제 계산서 1장의 값을 그대로 보여준다", () => {
    // 대표(campA)만 매칭되고 나머지 멤버(campB, campC)의 키는 이 스캔 결과에 전혀
    // 없다(no_data) — 엔진이 그룹 전체를 campA 키 하나로 합쳤다는 뜻이다.
    const byKey = indexReceiptScan(scan({ results: [mailEntry(1, verdict({ matchedKey: "campA:SUPPLIER_GOODS" }))] }));
    const result = resolveRowEvidence(groupRow(["campA", "campB", "campC"]), byKey);
    expect(result).toEqual({
      kind: "verified",
      detail: { issueId: "1".repeat(24), writtenDate: "2026-07-15", totalAmount: 7_000_000 },
      memberCount: 3,
    });
  });

  it("대표 키가 NEEDS_REVIEW 면 그 사유를 그대로 보여준다", () => {
    const mismatched = verdict({
      status: "NEEDS_REVIEW",
      matchedKey: "campA:SUPPLIER_GOODS",
      reasons: [{ code: "AMOUNT_MISMATCH", message: "금액이 다릅니다. 계산서 1원 vs 정산 2원." }],
    });
    const byKey = indexReceiptScan(scan({ results: [mailEntry(1, mismatched)] }));
    const result = resolveRowEvidence(groupRow(["campA", "campB"]), byKey);
    expect(result).toEqual({ kind: "needs_review", reasons: ["금액이 다릅니다. 계산서 1원 vs 정산 2원."], memberCount: 2 });
  });

  it("대표 키가 unseenExpected 뿐이면 그룹 전체가 미수취다", () => {
    const byKey = indexReceiptScan(scan({ unseenExpected: [unseenItem("campA:SUPPLIER_GOODS", "campA")] }));
    const result = resolveRowEvidence(groupRow(["campA", "campB"]), byKey);
    expect(result).toEqual({ kind: "unseen", memberCount: 2 });
  });

  it("대표 키도 이 스캔의 대상에 없으면 no_data", () => {
    const byKey = indexReceiptScan(scan());
    const result = resolveRowEvidence(groupRow(["campA", "campB"]), byKey);
    expect(result).toEqual({ kind: "no_data" });
  });
});

describe("resolveRowEvidence — 상대 불일치로 캠페인별 후퇴(대표 외 멤버도 키가 실재함)", () => {
  it("멤버 전원이 VERIFIED 일 때만 확인됨 — 이때는 detail 을 특정할 수 없어 비운다(실제 계산서가 멤버마다 별도)", () => {
    const v1 = verdict({ matchedKey: "campA:SUPPLIER_GOODS" });
    const v2 = verdict({ matchedKey: "campB:SUPPLIER_GOODS", observed: { ...verdict().observed, issueId: "2".repeat(24) } });
    const byKey = indexReceiptScan(scan({ results: [mailEntry(1, v1), mailEntry(2, v2)] }));
    const result = resolveRowEvidence(groupRow(["campA", "campB"]), byKey);
    expect(result).toEqual({ kind: "verified", detail: null, memberCount: 2 });
  });

  it("일부만 VERIFIED 면 partial — 확인됨으로 읽지 않는다(부분 일치를 전체 확인으로 둔갑시키지 않는다)", () => {
    const v1 = verdict({ matchedKey: "campA:SUPPLIER_GOODS" });
    const byKey = indexReceiptScan(
      scan({
        results: [mailEntry(1, v1)],
        unseenExpected: [unseenItem("campB:SUPPLIER_GOODS", "campB")],
      }),
    );
    const result = resolveRowEvidence(groupRow(["campA", "campB"]), byKey);
    expect(result).toEqual({ kind: "partial", verifiedCount: 1, memberCount: 2 });
  });

  it("VERIFIED 0건이고 NEEDS_REVIEW 가 하나 이상이면 사유를 중복 제거해 합친다", () => {
    const mismatchMsg = "금액이 다릅니다. 계산서 1원 vs 정산 2원.";
    const v1 = verdict({ status: "NEEDS_REVIEW", matchedKey: "campA:SUPPLIER_GOODS", reasons: [{ code: "AMOUNT_MISMATCH", message: mismatchMsg }] });
    const v2 = verdict({ status: "NEEDS_REVIEW", matchedKey: "campB:SUPPLIER_GOODS", reasons: [{ code: "AMOUNT_MISMATCH", message: mismatchMsg }] });
    const byKey = indexReceiptScan(scan({ results: [mailEntry(1, v1), mailEntry(2, v2)] }));
    const result = resolveRowEvidence(groupRow(["campA", "campB"]), byKey);
    expect(result).toEqual({ kind: "needs_review", reasons: [mismatchMsg], memberCount: 2 });
  });

  it("전원 unseen이면 unseen", () => {
    const byKey = indexReceiptScan(
      scan({
        unseenExpected: [unseenItem("campA:SUPPLIER_GOODS", "campA"), unseenItem("campB:SUPPLIER_GOODS", "campB")],
      }),
    );
    const result = resolveRowEvidence(groupRow(["campA", "campB"]), byKey);
    expect(result).toEqual({ kind: "unseen", memberCount: 2 });
  });
});

describe("resolveRowEvidence — 알려진 불일치 가드(2026-08-04): groupId 있고 campaignIds 1건인 셀러 의무", () => {
  it("board 가 공급사 불일치로 캠페인별 행으로 되돌린 셀러 의무는, 엔진이 그 키를 그룹 전체 합산으로 갖고 있을 수 있어 no_data 로 남긴다", () => {
    // campA 는 원래 어느 그룹(groupId="group1")의 멤버였는데, 그 그룹의 공급사가 갈려
    // board 는 캠페인별 행으로 되돌렸다(campaignIds=[campA] 하나뿐). 그런데 엔진은
    // 스펙대로 셀러 의무를 항상 합산하므로, byKey 에는 "campA:SELLER_COMMISSION" 이
    // 실제로는 그룹 전체(campA+campB+...)의 합산값으로 VERIFIED 매칭돼 있을 수 있다 —
    // 이 캠페인 1건 몫이 아니다. 그래서 아무리 byKey 에 VERIFIED 가 있어도 no_data.
    const byKey = indexReceiptScan(
      scan({ results: [mailEntry(1, verdict({ matchedKey: "campA:SELLER_COMMISSION" }))] }),
    );
    const row: BoardRowForEvidence = {
      campaignId: "campA",
      campaignIds: ["campA"],
      groupId: "group1",
      sourceField: "sellerInvoiceIssuedAt",
      direction: "RECEIVE",
    };
    expect(resolveRowEvidence(row, byKey)).toEqual({ kind: "no_data" });
  });

  it("같은 조건이라도 공급사 의무(supplierInvoiceIssuedAt)는 가드 대상이 아니다 — board·엔진 둘 다 캠페인별로 후퇴하는 축이라 안전하다", () => {
    const byKey = indexReceiptScan(
      scan({ results: [mailEntry(1, verdict({ matchedKey: "campA:SUPPLIER_GOODS" }))] }),
    );
    const row: BoardRowForEvidence = {
      campaignId: "campA",
      campaignIds: ["campA"],
      groupId: "group1",
      sourceField: "supplierInvoiceIssuedAt",
      direction: "RECEIVE",
    };
    expect(resolveRowEvidence(row, byKey)).toEqual({
      kind: "verified",
      detail: { issueId: "1".repeat(24), writtenDate: "2026-07-15", totalAmount: 7_000_000 },
      memberCount: 1,
    });
  });

  it("groupId 가 null(진짜 미그룹)이면 가드가 걸리지 않는다", () => {
    const byKey = indexReceiptScan(
      scan({ results: [mailEntry(1, verdict({ matchedKey: "campA:SELLER_COMMISSION" }))] }),
    );
    const result = resolveRowEvidence(soloRow("campA", "sellerInvoiceIssuedAt"), byKey);
    expect(result?.kind).toBe("verified");
  });

  it("groupMembers 로 형제(campB)의 키가 이 스캔에도 실재함을 확인하면 — 채널 불일치 후퇴다, 이 캠페인 자신의 키를 신뢰한다(2026-08-04 회귀 정정)", () => {
    // campA·campB 는 같은 그룹(group1)이었는데 채널이 갈려 board·엔진 둘 다 두 슬롯을
    // 캠페인별로 후퇴시켰다 — 그래서 campB 도 자기만의 SELLER_COMMISSION 키를 갖는다
    // (미수취든 매칭이든 흔적이 있다). 이 경우 campA 의 키는 그룹 합산이 아니라 진짜
    // campA 하나만의 값이므로, 가드가 무조건 no_data 로 덮으면 안 된다.
    const byKey = indexReceiptScan(
      scan({
        results: [mailEntry(1, verdict({ matchedKey: "campA:SELLER_COMMISSION" }))],
        unseenExpected: [unseenItem("campB:SELLER_COMMISSION", "campB", "SELLER_COMMISSION")],
      }),
    );
    const groupMembers = new Map([["group1", new Set(["campA", "campB"])]]);
    const row: BoardRowForEvidence = {
      campaignId: "campA",
      campaignIds: ["campA"],
      groupId: "group1",
      sourceField: "sellerInvoiceIssuedAt",
      direction: "RECEIVE",
    };
    expect(resolveRowEvidence(row, byKey, groupMembers)).toEqual({
      kind: "verified",
      detail: { issueId: "1".repeat(24), writtenDate: "2026-07-15", totalAmount: 7_000_000 },
      memberCount: 1,
    });
  });

  it("groupMembers 로 찾은 형제(campB)가 전원 no_data 면 — 공급사 불일치로 셀러가 여전히 그룹 합산째로 남아 있는 상태다, no_data 를 유지한다", () => {
    const byKey = indexReceiptScan(
      scan({ results: [mailEntry(1, verdict({ matchedKey: "campA:SELLER_COMMISSION" }))] }),
    );
    const groupMembers = new Map([["group1", new Set(["campA", "campB"])]]);
    const row: BoardRowForEvidence = {
      campaignId: "campA",
      campaignIds: ["campA"],
      groupId: "group1",
      sourceField: "sellerInvoiceIssuedAt",
      direction: "RECEIVE",
    };
    expect(resolveRowEvidence(row, byKey, groupMembers)).toEqual({ kind: "no_data" });
  });

  it("groupMembers 에 이 groupId 자체가 없으면(재구성 실패) 보수적으로 no_data", () => {
    const byKey = indexReceiptScan(
      scan({ results: [mailEntry(1, verdict({ matchedKey: "campA:SELLER_COMMISSION" }))] }),
    );
    const row: BoardRowForEvidence = {
      campaignId: "campA",
      campaignIds: ["campA"],
      groupId: "group-not-in-map",
      sourceField: "sellerInvoiceIssuedAt",
      direction: "RECEIVE",
    };
    expect(resolveRowEvidence(row, byKey, new Map())).toEqual({ kind: "no_data" });
  });
});

describe("reconstructGroupMembers", () => {
  it("groupId 별로 등장한 campaignIds 를 모두 모은다 — 슬롯·direction 과 무관하게", () => {
    const rows: BoardRowForEvidence[] = [
      { campaignId: "campA", campaignIds: ["campA"], groupId: "group1", sourceField: "sellerInvoiceIssuedAt", direction: "RECEIVE" },
      { campaignId: "campB", campaignIds: ["campB"], groupId: "group1", sourceField: "supplierInvoiceIssuedAt", direction: "ISSUE" },
      { campaignId: "camp-solo", campaignIds: ["camp-solo"], groupId: null, sourceField: "sellerInvoiceIssuedAt", direction: "RECEIVE" },
    ];
    const result = reconstructGroupMembers(rows);
    expect(result.get("group1")).toEqual(new Set(["campA", "campB"]));
    expect(result.has("null")).toBe(false);
    expect(result.size).toBe(1);
  });
});

describe("indexReceiptScan — VERIFIED 우선 병합", () => {
  it("같은 키에 NEEDS_REVIEW 와 VERIFIED 가 둘 다 매칭되면(중복 발행 등) VERIFIED 를 지우지 않는다", () => {
    const key = "camp1:SELLER_COMMISSION";
    const ok = verdict({ matchedKey: key });
    const bad = verdict({ status: "NEEDS_REVIEW", matchedKey: key, reasons: [{ code: "DUPLICATE_ISSUE", message: "중복" }] });
    const byKeyOkFirst = indexReceiptScan(scan({ results: [mailEntry(1, ok), mailEntry(2, bad)] }));
    const row = soloRow("camp1", "sellerInvoiceIssuedAt");
    expect(resolveRowEvidence(row, byKeyOkFirst)?.kind).toBe("verified");

    const byKeyBadFirst = indexReceiptScan(scan({ results: [mailEntry(2, bad), mailEntry(1, ok)] }));
    expect(resolveRowEvidence(row, byKeyBadFirst)?.kind).toBe("verified");
  });
});

/**
 * 오너 승인은 판정과 **같은 칸**에 든다.
 *
 * 승인은 수취일시를 실제로 기록하므로 계산서 열이 초록으로 바뀌는데, `verdict` 는 여전히
 * `NEEDS_REVIEW` 다. 이 병합이 없으면 같은 건에 대해 열은 초록이고 오버레이는 「확인 필요」라
 * 두 표면이 서로 다른 말을 한다.
 */
describe("indexReceiptScan — 오너 승인 반영", () => {
  const key = "camp1:SELLER_COMMISSION";
  const row = soloRow("camp1", "sellerInvoiceIssuedAt");

  function approved(matchedKeys: string[]) {
    return { decision: "APPROVED", matchedKeys, amountDelta: -11000, decidedAt: "2026-08-12T00:00:00.000Z" };
  }

  it("승인된 건은 판정이 NEEDS_REVIEW 여도 확인됨으로 읽는다", () => {
    const v = verdict({
      status: "NEEDS_REVIEW",
      matchedKey: key,
      reasons: [{ code: "AMOUNT_MISMATCH", message: "금액이 다릅니다." }],
    });
    const byKey = indexReceiptScan(
      scan({ results: [{ ...mailEntry(1, v), decision: approved([key]) }] }),
    );
    expect(resolveRowEvidence(row, byKey)?.kind).toBe("verified");
  });

  it("판정이 후보를 특정하지 못한 건도 승인 대상 key 로 귀속된다", () => {
    // matchedKey 는 null(모호·미매칭) — 승인이 귀속을 정한다.
    const v = verdict({
      status: "NEEDS_REVIEW",
      matchedKey: null,
      candidateKeys: [],
      reasons: [{ code: "NO_EXPECTED_MATCH", message: "대응 정산 건 없음" }],
    });
    const byKey = indexReceiptScan(
      scan({ results: [{ ...mailEntry(1, v), decision: approved([key]) }] }),
    );
    expect(resolveRowEvidence(row, byKey)?.kind).toBe("verified");
  });

  it("무관 처리는 확인됨으로 바꾸지 않는다", () => {
    const v = verdict({
      status: "NEEDS_REVIEW",
      matchedKey: key,
      reasons: [{ code: "AMOUNT_MISMATCH", message: "금액이 다릅니다." }],
    });
    const byKey = indexReceiptScan(
      scan({
        results: [
          {
            ...mailEntry(1, v),
            decision: { decision: "DISMISSED", matchedKeys: [], amountDelta: null, decidedAt: "2026-08-12T00:00:00.000Z" },
          },
        ],
      }),
    );
    expect(resolveRowEvidence(row, byKey)?.kind).toBe("needs_review");
  });
});
