/**
 * 정산 메일 대조 창구 본체(`getSettlementReconciliation`) — 캠페인 읽기·메일 스캔을 주입해 합성 메일만 쓴다
 * (실메일함·운영 DB 에 닿지 않는다). 고정하는 것:
 *  ① 결과·실패 어디에도 발주서 시트의 가짜 구매자 정보가 없다(예외 경로 포함)
 *  ② 다른 거래처·다른 셀러 정산서는 빼고, 다른 셀러 이름도 걸린 메일은 「모호」로 센다(일부만 확인)
 *  ③ 피벗 양식 변경 → SHEET_LAYOUT_CHANGED · 전부 못 엶 → ATTACHMENT_UNREADABLE · 일부만 못 엶 → 일부만 확인
 *  ④ 후보 메일이 하나도 없음 → STATEMENT_NOT_FOUND · 옵션이 하나도 안 맞아 전부 버림 → 실패가 아니라 결과(partial)
 *     · 메일 설정 없음/읽기 실패 → 고정 코드
 *  ⑥ 셀러 이름이 본문(프로모션명)에만 있는 정산서도 읽는다 — 헤더의 이름은 순서만 정한다
 *  ⑤ `loadReconUnit` 은 그룹 멤버·같은 셀러 다른 회차·다른 셀러 이름을 가른다
 */
import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import type { ParsedSettlementStatement } from "@/lib/tax-invoice-mail/brand-statement";
import type { StatementAttachmentMail, StatementAttachmentScanResult } from "@/lib/tax-invoice-mail/brand-statement-scan";
import {
  getSettlementReconciliation,
  headerPriority,
  loadReconUnit,
  reconSellerLabelsOf,
  type ReconUnit,
} from "../settlement-reconciliation";

const FAKE_PII = ["테스트구매자", "010-0000-0000", "가상시 가상로 1"] as const;

function expectNoPii(value: unknown) {
  const text = JSON.stringify(value);
  for (const pii of FAKE_PII) expect(text).not.toContain(pii);
}

function attachment(pivot: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pivot), "피벗");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["주문번호", "구매자", "연락처", "주소"],
      ["2026100100000001", FAKE_PII[0], FAKE_PII[1], FAKE_PII[2]],
    ]),
    "발주서",
  );
  return XLSX.write(wb, { bookType: "biff8", type: "buffer" }) as Buffer;
}

const GOOD_PIVOT: unknown[][] = [
  ["옵션명", "합계 : 수량"],
  ["구성: 3박스", 4],
  ["구성: 6박스", 2],
  ["총합계", 6],
];

function statement(
  subject: string,
  counterparty = "브랜드A",
  yearMonth = "2026-10",
  promotionLabel: string | null = null,
): ParsedSettlementStatement {
  return {
    format: "CLOSING_TABLE",
    promotionLabel,
    counterpartyLabel: counterparty,
    subject,
    invoices: [
      { direction: "RECEIVE", issuerLabel: counterparty, writtenDate: `${yearMonth}-28`, yearMonth, totalAmount: 1000, dueDate: null },
    ],
  };
}

let uid = 0;
function mail(overrides: Partial<StatementAttachmentMail> = {}): StatementAttachmentMail {
  uid += 1;
  return {
    uid,
    messageKey: String(uid).padStart(32, "0"),
    receivedAt: new Date("2026-11-05T01:00:00.000Z"),
    statement: statement("[브랜드A] 10월 가나다님 정산서"),
    spreadsheets: [attachment(GOOD_PIVOT)],
    oversized: 0,
    ...overrides,
  };
}

const UNIT: ReconUnit = {
  campaignId: "sc-1",
  sellerLabels: ["가나다"],
  counterpartLabel: "브랜드A",
  periodStart: new Date("2026-10-01T00:00:00.000Z"),
  periodEnd: new Date("2026-10-07T00:00:00.000Z"),
  otherSellerLabels: [["라마바"]],
  overlappingRounds: 0,
  catalog: {
    mainDeals: [{ id: "deal-main", name: "영양제" }],
    optionDeals: [
      { id: "deal-3", parentDealId: "deal-main", name: "구성: 3박스" },
      { id: "deal-6", parentDealId: "deal-main", name: "구성: 6박스" },
    ],
    lines: [
      { id: "line-3", dealId: "deal-3", quantity: 4 },
      { id: "line-6", dealId: "deal-6", quantity: 2 },
    ],
    mappings: [
      { optionName: "구성: 3박스", campaignDealId: "line-3" },
      { optionName: "구성: 6박스", campaignDealId: "line-6" },
    ],
  },
};

function okScan(mails: StatementAttachmentMail[], extra: Partial<Extract<StatementAttachmentScanResult, { ok: true }>> = {}) {
  return vi.fn(async () => ({ ok: true as const, candidates: mails.length, truncated: 0, timedOut: false, mails, ...extra }));
}

function deps(scan: ReturnType<typeof okScan> | ReturnType<typeof vi.fn>, unit: ReconUnit | null = UNIT) {
  return { loadUnit: vi.fn(async () => unit), scan: scan as never };
}

describe("getSettlementReconciliation", () => {
  it("이 캠페인 메일 한 통 → 옵션 전부 일치, 결과에 가짜 구매자 정보 없음", async () => {
    const scan = okScan([mail()]);
    const result = await getSettlementReconciliation("sc-1", deps(scan));
    if (!result.ok) throw new Error(`expected ok: ${result.code}`);
    expect(result.data.partial).toBe(false);
    expect(result.data.mailsRead).toBe(1);
    expect(result.data.counts).toMatchObject({ options: 2, MATCH: 2 });
    expectNoPii(result);
  });

  it("스캔 조건 — 기간 시작 −3일 ~ 종료 +61일, 6통, 2MB, 헤더의 이름은 거름이 아니라 순서(셀러 2 · 거래처 1)", async () => {
    const scan = okScan([mail()]);
    await getSettlementReconciliation("sc-1", deps(scan));
    type Priority = (header: { subject: string; from: string }) => number;
    const options = (scan.mock.calls[0] as unknown as [Record<string, unknown> & { priority: Priority }])[0];
    expect(options.since).toEqual(new Date("2026-09-28T00:00:00.000Z"));
    expect(options.before).toEqual(new Date("2026-12-07T00:00:00.000Z"));
    expect(options.maxMessages).toBe(6);
    expect(options.maxAttachmentBytes).toBe(2 * 1024 * 1024);
    expect("subjectFilter" in options).toBe(false);
    expect(options.priority({ subject: "[브랜드A] 10월 가나다님 정산서", from: "x@example.com" })).toBe(3);
    expect(options.priority({ subject: "10월 마감정산서", from: "브랜드A 정산팀 <x@example.com>" })).toBe(1);
    expect(options.priority({ subject: "10월 라마바님 정산서", from: "x@example.com" })).toBe(0);
    expect(headerPriority({ subject: "가나다님 정산서", from: "" }, UNIT)).toBe(2);
  });

  it("셀러 이름이 본문(프로모션명)에만 있고 제목엔 브랜드·월·마감정산서뿐인 메일도 읽는다", async () => {
    const bodyOnly = mail({ statement: statement("[브랜드A] 26년 10월 마감정산서", "브랜드A", "2026-10", "26년 10월 가나다 공구") });
    const result = await getSettlementReconciliation("sc-1", deps(okScan([bodyOnly])));
    if (!result.ok) throw new Error(`expected ok: ${result.code}`);
    expect(result.data.mailsRead).toBe(1);
    expect(result.data.counts).toMatchObject({ options: 2, MATCH: 2 });
  });

  it("옵션이 하나도 안 맞아 전부 버리면 실패가 아니라 결과 — mails=0 · partial=1 · 버림 사유", async () => {
    const foreign = attachment([["옵션명", "합계 : 수량"], ["다른 상품 1개", 3], ["총합계", 3]]);
    const result = await getSettlementReconciliation("sc-1", deps(okScan([mail({ spreadsheets: [foreign] })])));
    if (!result.ok) throw new Error(`expected ok: ${result.code}`);
    expect(result.data).toMatchObject({ mailsRead: 0, dropped: 1, partial: true });
  });

  it("CFB 만 같은 다른 문서(.doc 류)만 붙은 메일은 「표 없음」이다(못 읽음 아님)", async () => {
    const result = await getSettlementReconciliation("sc-1", deps(okScan([mail({ spreadsheets: [], oversized: 0 })])));
    if (!result.ok) throw new Error(`expected ok: ${result.code}`);
    expect(result.data).toMatchObject({ withoutSheet: 1, unreadable: 0, partial: true });
  });

  it("다른 거래처·다른 셀러 정산서는 빼고, 다른 셀러 이름도 걸리면 「모호」로 세어 일부만 확인", async () => {
    const scan = okScan([
      mail(),
      mail({ statement: statement("[브랜드B] 가나다님 정산서", "브랜드B") }),
      mail({ statement: statement("[브랜드A] 가나다님·라마바님 정산서") }),
    ]);
    const result = await getSettlementReconciliation("sc-1", deps(scan));
    if (!result.ok) throw new Error(`expected ok: ${result.code}`);
    expect(result.data.mailsRead).toBe(1);
    expect(result.data.ambiguous).toBe(1);
    expect(result.data.partial).toBe(true);
  });

  it("피벗 양식이 바뀌었으면 SHEET_LAYOUT_CHANGED(짐작으로 읽지 않는다)", async () => {
    const broken = attachment([["옵션명", "합계 : 수량"], ["구성: 3박스", 1.5], ["총합계", 1.5]]);
    const result = await getSettlementReconciliation("sc-1", deps(okScan([mail({ spreadsheets: [broken] })])));
    expect(result).toMatchObject({ ok: false, code: "SHEET_LAYOUT_CHANGED" });
    expectNoPii(result);
  });

  it("모든 메일 첨부를 못 열면 ATTACHMENT_UNREADABLE, 일부만이면 일부만 확인", async () => {
    const garbage = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from(FAKE_PII[0])]);
    const all = await getSettlementReconciliation("sc-1", deps(okScan([mail({ spreadsheets: [garbage] }), mail({ spreadsheets: [], oversized: 1 })])));
    expect(all).toMatchObject({ ok: false, code: "ATTACHMENT_UNREADABLE" });
    expectNoPii(all);

    const some = await getSettlementReconciliation("sc-1", deps(okScan([mail(), mail({ spreadsheets: [garbage] })])));
    if (!some.ok) throw new Error(`expected ok: ${some.code}`);
    expect(some.data.unreadable).toBe(1);
    expect(some.data.partial).toBe(true);
    expectNoPii(some);
  });

  it("후보가 없으면 STATEMENT_NOT_FOUND, 캠페인이 없으면 CAMPAIGN_NOT_FOUND", async () => {
    expect(await getSettlementReconciliation("sc-1", deps(okScan([])))).toMatchObject({ ok: false, code: "STATEMENT_NOT_FOUND" });
    expect(await getSettlementReconciliation("sc-x", deps(okScan([]), null))).toMatchObject({ ok: false, code: "CAMPAIGN_NOT_FOUND" });
  });

  it("셀러 이름이나 거래처 이름이 비면 메일을 읽지 않고 STATEMENT_NOT_FOUND", async () => {
    const scan = okScan([mail()]);
    const result = await getSettlementReconciliation("sc-1", deps(scan, { ...UNIT, counterpartLabel: "" }));
    expect(result).toMatchObject({ ok: false, code: "STATEMENT_NOT_FOUND" });
    expect(scan).not.toHaveBeenCalled();
  });

  it("메일 설정 없음·읽기 실패는 고정 코드", async () => {
    const notConfigured = vi.fn(async () => ({ ok: false as const, code: "MAIL_NOT_CONFIGURED" as const }));
    expect(await getSettlementReconciliation("sc-1", deps(notConfigured))).toMatchObject({ ok: false, code: "MAIL_NOT_CONFIGURED" });
    const failed = vi.fn(async () => ({ ok: false as const, code: "MAIL_FETCH_FAILED" as const }));
    expect(await getSettlementReconciliation("sc-1", deps(failed))).toMatchObject({ ok: false, code: "MAIL_FETCH_FAILED" });
  });

  it("시간 예산을 넘겨 본문을 못 받았으면 실패 대신 일부만 확인", async () => {
    const result = await getSettlementReconciliation("sc-1", deps(okScan([], { candidates: 2, timedOut: true })));
    if (!result.ok) throw new Error(`expected ok: ${result.code}`);
    expect(result.data.timedOut).toBe(true);
    expect(result.data.partial).toBe(true);
  });

  it("어디서 던져도(오류 문구에 구매자 정보가 섞여도) 고정 문구 RECONCILE_FAILED", async () => {
    const throwing = vi.fn(async () => {
      throw new Error(`boom ${FAKE_PII.join(" ")}`);
    });
    const fromScan = await getSettlementReconciliation("sc-1", deps(throwing));
    expect(fromScan).toEqual({ ok: false, code: "RECONCILE_FAILED", message: "정산 대조 중 오류가 났습니다." });
    const fromLoad = await getSettlementReconciliation("sc-1", {
      loadUnit: vi.fn(async () => {
        throw new Error(FAKE_PII[1]);
      }),
      scan: okScan([]) as never,
    });
    expect(fromLoad).toMatchObject({ ok: false, code: "RECONCILE_FAILED" });
    expectNoPii(fromLoad);
  });
});

describe("loadReconUnit", () => {
  function fakeDb(options: { grouped: boolean }) {
    const base = { startDate: new Date("2026-10-01"), endDate: new Date("2026-10-07"), orderCampaignId: "oc-1" };
    const members = [
      { id: "sc-1", groupId: options.grouped ? "g-1" : null, dealId: "deal-main", ...base },
      { id: "sc-2", groupId: "g-1", dealId: "deal-main-2", ...base, endDate: new Date("2026-10-10"), orderCampaignId: "oc-2" },
    ];
    const neighbourFind = vi.fn(async () => [
      { id: "sc-9", groupId: null, sellerId: "seller-1", seller: { name: "가나다", alias: null } },
      { id: "sc-10", groupId: "g-2", sellerId: "seller-1", seller: { name: "가나다", alias: null } },
      { id: "sc-11", groupId: "g-2", sellerId: "seller-1", seller: { name: "가나다", alias: null } },
      { id: "sc-12", groupId: null, sellerId: "seller-2", seller: { name: "라마바", alias: "라마" } },
    ]);
    const memberFind = vi.fn(async () => members);
    const db = {
      salesCampaign: {
        findUnique: vi.fn(async () => ({
          ...members[0],
          sellerId: "seller-1",
          seller: { name: "가나다", alias: null },
          deal: { partnerId: "partner-1", partner: { name: " 브랜드A " } },
        })),
        findMany: vi.fn(async (args: { where: Record<string, unknown> }) => ("groupId" in args.where ? memberFind() : neighbourFind())),
      },
      campaignDeal: { findMany: vi.fn(async () => [{ id: "line-3", dealId: "deal-3", quantity: 4 }]) },
      deal: {
        findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
          "parentDealId" in args.where
            ? [
                { id: "deal-3", parentDealId: "deal-main", dealName: "구성: 3박스" },
                { id: "deal-x", parentDealId: null, dealName: "고아" },
              ]
            : [{ id: "deal-main", dealName: "영양제" }],
        ),
      },
      productMapping: { findMany: vi.fn(async () => [{ optionName: "구성: 3박스", campaignDealId: "line-3" }]) },
    };
    return db;
  }

  it("그룹이면 멤버 기간을 합치고, 같은 셀러 다른 회차는 그룹 단위로 세며, 다른 셀러 이름을 따로 모은다", async () => {
    const db = fakeDb({ grouped: true });
    const unit = await loadReconUnit(db as never, "sc-1");
    expect(unit).not.toBeNull();
    expect(unit!.periodEnd).toEqual(new Date("2026-10-10"));
    expect(unit!.counterpartLabel).toBe("브랜드A");
    expect(unit!.sellerLabels).toContain("가나다");
    expect(unit!.overlappingRounds).toBe(2);
    expect(unit!.otherSellerLabels).toHaveLength(1);
    expect(unit!.otherSellerLabels[0]).toContain("라마바");
    expect(unit!.catalog.optionDeals).toEqual([{ id: "deal-3", parentDealId: "deal-main", name: "구성: 3박스" }]);
    const neighbourArgs = db.salesCampaign.findMany.mock.calls.find(([args]) => !("groupId" in args.where))![0] as {
      where: { id: { notIn: string[] }; status: { notIn: string[] } };
    };
    expect(neighbourArgs.where.id.notIn).toEqual(["sc-1", "sc-2"]);
    expect(neighbourArgs.where.status.notIn).toEqual(["DROPPED", "PROPOSAL"]);
    const mappingArgs = db.productMapping.findMany.mock.calls[0] as unknown as [{ where: { campaignId: { in: string[] } } }];
    expect(mappingArgs[0].where.campaignId.in).toEqual(["oc-1", "oc-2"]);
  });

  it("캠페인이 없으면 null", async () => {
    const db = fakeDb({ grouped: false });
    db.salesCampaign.findUnique = vi.fn(async () => null) as never;
    expect(await loadReconUnit(db as never, "sc-x")).toBeNull();
  });

  it("별칭이 「활동명 본명」이어도 활동명(첫 낱말) 하나만 적힌 메일을 이 캠페인 것으로 읽는다 — 다른 셀러 이름도 같은 규칙", async () => {
    const db = fakeDb({ grouped: false });
    const base = { startDate: new Date("2026-10-01"), endDate: new Date("2026-10-07"), orderCampaignId: "oc-1" };
    db.salesCampaign.findUnique = vi.fn(async () => ({
      id: "sc-1",
      groupId: null,
      dealId: "deal-main",
      ...base,
      sellerId: "seller-1",
      seller: { name: "가나다 홍길동 | 영양제 • 건강습관", alias: "가나다 홍길동" },
      deal: { partnerId: "partner-1", partner: { name: "브랜드A" } },
    })) as never;
    db.salesCampaign.findMany = vi.fn(async () => [
      { id: "sc-12", groupId: null, sellerId: "seller-2", seller: { name: "라마바 김철수", alias: null } },
    ]) as never;
    const unit = await loadReconUnit(db as never, "sc-1");
    expect(unit!.sellerLabels).toEqual(expect.arrayContaining(["가나다 홍길동", "가나다"]));
    expect(unit!.otherSellerLabels[0]).toEqual(expect.arrayContaining(["라마바 김철수", "라마바"]));

    // 제목·프로모션명에 「가나다님」만 있는 정산서(GOOD_PIVOT) — 통째 이름만 보면 제외돼 STATEMENT_NOT_FOUND 가 된다.
    const result = await getSettlementReconciliation("sc-1", deps(okScan([mail()]), unit));
    if (!result.ok) throw new Error(`expected ok: ${result.code}`);
    expect(result.data.mailsRead).toBe(1);
    expect(result.data.counts.MATCH).toBeGreaterThanOrEqual(1);
    // 다른 셀러의 활동명만 적힌 메일은 이 캠페인 것이 아니다(첫 낱말이 걸려도 셀러가 다르면 제외).
    const other = await getSettlementReconciliation(
      "sc-1",
      deps(okScan([mail({ statement: statement("[브랜드A] 10월 라마바님 정산서") })]), unit),
    );
    expect(other).toMatchObject({ ok: false, code: "STATEMENT_NOT_FOUND" });
  });
});

describe("reconSellerLabelsOf", () => {
  it("별칭·이름 그대로에 첫 낱말을 더한다(공백·| 앞) — 낱말이 하나면 그대로, 중복 없음", () => {
    expect(reconSellerLabelsOf({ name: "가나다 홍길동 | 영양제 • 건강습관", alias: "가나다 홍길동" })).toEqual([
      "가나다 홍길동",
      "가나다 홍길동 | 영양제 • 건강습관",
      "가나다",
    ]);
    expect(reconSellerLabelsOf({ name: "가나다", alias: null })).toEqual(["가나다"]);
    expect(reconSellerLabelsOf({ name: "가나다", alias: "가나다" })).toEqual(["가나다"]);
    expect(reconSellerLabelsOf(null)).toEqual([]);
  });

  it("실제 대조 함수(headerPriority)가 「가나다님」 제목을 이 셀러로 알아본다 · 한 글자 첫 낱말은 거른다", () => {
    const labels = reconSellerLabelsOf({ name: "가나다 홍길동 | 영양제", alias: "가나다 홍길동" });
    expect(headerPriority({ subject: "[브랜드A] 26년 10월 가나다님 마감정산서", from: "" }, { sellerLabels: labels, counterpartLabel: "" })).toBe(2);
    expect(headerPriority({ subject: "[브랜드A] 26년 10월 다른셀러님 마감정산서", from: "" }, { sellerLabels: labels, counterpartLabel: "" })).toBe(0);
    // 한글 한 글자 첫 낱말(「김 철수」→「김」)은 우연히 겹치므로 대조에 안 쓰인다(`statementMentionsUnit` 의 최소 길이).
    const short = reconSellerLabelsOf({ name: "김 철수", alias: null });
    expect(headerPriority({ subject: "[브랜드A] 김밥 정산서", from: "" }, { sellerLabels: short, counterpartLabel: "" })).toBe(0);
  });
});
