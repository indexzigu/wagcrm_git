/**
 * 정산 메일 ↔ 품목 줄 옵션 대조(순수) — 판정표 칸마다 · 메일 합산(재발송 1회 · 같은 달 다른 내용 = 충돌) ·
 * 남의 메일 버리기 · 출력 화이트리스트 · 첫 줄 길이(최악 포함) · 「…외 N개」.
 */
import { describe, expect, it } from "vitest";
import {
  formatReconFirstLine,
  formatSettlementReconciliation,
  judgeOption,
  MAX_RECON_FIRST_LINE_CHARS,
  MAX_RECON_OPTION_NAME_CHARS,
  reconcileSettlement,
  settlementReconciliationDataSchema,
  type ReconCatalog,
  type ReconMail,
  type ReconScanFacts,
} from "./settlement-reconcile";
import { MAX_RESULT_SUMMARY_CHARS } from "@/lib/agent-worker/contracts";

const MAIN = { id: "deal-main", name: "샘플크림" };
const catalog: ReconCatalog = {
  mainDeals: [MAIN],
  optionDeals: [
    { id: "deal-3", parentDealId: MAIN.id, name: "샘플크림 - 구성: 3박스" },
    { id: "deal-6", parentDealId: MAIN.id, name: "샘플크림 - 구성: 6박스" },
    { id: "deal-9", parentDealId: MAIN.id, name: "샘플크림 - 구성: 9박스" },
    { id: "deal-12", parentDealId: MAIN.id, name: "샘플크림 - 구성: 12박스" },
    { id: "deal-a", parentDealId: MAIN.id, name: "구성: A 1박스" },
    { id: "deal-b", parentDealId: MAIN.id, name: "구성: B 1박스" },
  ],
  lines: [
    { id: "line-3", dealId: "deal-3", quantity: 4 },
    { id: "line-6", dealId: "deal-6", quantity: 2 },
    { id: "line-9", dealId: "deal-9", quantity: 5 },
    { id: "line-a", dealId: "deal-a", quantity: 1 },
    { id: "line-b", dealId: "deal-b", quantity: 2 },
    { id: "line-other", dealId: "deal-x", quantity: 7 },
  ],
  mappings: [
    { optionName: "구성: 3박스", campaignDealId: "line-3" },
    { optionName: "구성:  6박스 ", campaignDealId: "line-6" },
    // 9박스: 매핑이 있는데 이 캠페인 줄이 아닌 곳(지난 회차 줄)을 가리킨다.
    { optionName: "구성: 9박스", campaignDealId: "line-of-previous-round" },
    // 15박스: 매핑은 있고 하위품목·줄이 없다.
    { optionName: "구성: 15박스", campaignDealId: null },
    { optionName: "구성: A 1박스", campaignDealId: "line-a" },
    { optionName: "구성: B 1박스", campaignDealId: "line-b" },
  ],
};

const NO_SCAN: ReconScanFacts = { truncated: 0, unreadable: 0, ambiguous: 0, overlappingRounds: 0, timedOut: false };

function mail(_label: string, yearMonth: string, rows: ReconMail["rows"]): ReconMail {
  return { yearMonth, receivedDate: `${yearMonth}-28`, source: rows ? "XLS" : "NONE", rows };
}

describe("judgeOption — 판정표 칸마다", () => {
  it.each([
    ["매핑 → 이 캠페인 줄, 수량 같음", "구성: 3박스", 4, { status: "MATCH", crmQty: 4 }],
    ["매핑 → 이 캠페인 줄, 메일 적음", "구성: 3박스", 3, { status: "MAIL_LESS", crmQty: 4 }],
    ["매핑 → 이 캠페인 줄, 메일 많음", "구성: 3박스", 5, { status: "MAIL_MORE", crmQty: 4 }],
    ["매핑 키는 공백·NFC 를 접는다", "구성: 6박스".normalize("NFD"), 2, { status: "MATCH", crmQty: 2 }],
    ["매핑이 다른 줄, 하위품목 줄은 있음", "구성: 9박스", 5, { status: "MAPPING_WRONG_LINE", crmQty: 5 }],
    ["매핑만 있고 줄 없음", "구성: 15박스", 1, { status: "LINE_MISSING", crmQty: null }],
    ["매핑 없음, 하위품목 줄은 있음", "구성: 12박스", 1, { status: "LINE_MISSING", crmQty: null }],
    ["매핑 없음, 하위품목 없음", "구성: 99박스", 1, { status: "OPTION_UNKNOWN", crmQty: null }],
  ] as const)("%s", (_label, option, qty, expected) => {
    expect(judgeOption(option, qty, catalog)).toEqual(expected);
  });

  it("매핑 없음 + 하위품목 줄 있음 = MAPPING_MISSING", () => {
    const withLine: ReconCatalog = { ...catalog, lines: [...catalog.lines, { id: "line-12", dealId: "deal-12", quantity: 3 }] };
    expect(judgeOption("구성: 12박스", 3, withLine)).toEqual({ status: "MAPPING_MISSING", crmQty: 3 });
  });

  it("같은 키 매핑이 여러 줄이면 이 캠페인 줄에 연결된 서로 다른 줄의 합", () => {
    const dup: ReconCatalog = {
      ...catalog,
      mappings: [
        ...catalog.mappings,
        { optionName: "구성: 3박스", campaignDealId: "line-3" },
        { optionName: "구성: 3박스", campaignDealId: "line-other" },
        { optionName: "구성: 3박스", campaignDealId: "line-elsewhere" },
      ],
    };
    expect(judgeOption("구성: 3박스", 11, dup)).toEqual({ status: "MATCH", crmQty: 11 });
  });

  it("가격이 같은 두 옵션을 옵션명으로만 가른다", () => {
    expect(judgeOption("구성: A 1박스", 1, catalog)).toEqual({ status: "MATCH", crmQty: 1 });
    expect(judgeOption("구성: B 1박스", 1, catalog)).toEqual({ status: "MAIL_LESS", crmQty: 2 });
  });
});

describe("reconcileSettlement — 메일 합산", () => {
  const sept = [
    { label: "구성: 3박스", qty: 2 },
    { label: "구성: 6박스", qty: 1 },
  ];
  const oct = [{ label: "구성: 3박스", qty: 2 }];

  it("달마다 더하고, 재발송(같은 내용)은 한 번만 센다", () => {
    const data = reconcileSettlement({
      campaignId: "sc-1",
      mails: [mail("a", "2026-09", sept), mail("b", "2026-09", [...sept].reverse()), mail("c", "2026-10", oct)],
      catalog,
      scan: NO_SCAN,
    });
    expect(data.partial).toBe(false);
    expect(data.mailsRead).toBe(2);
    expect(data.lastMailMonth).toBe("2026-10");
    expect(data.options).toEqual([
      { optionName: "구성: 6박스", status: "MAIL_LESS", mailQty: 1, crmQty: 2 },
      { optionName: "구성: 3박스", status: "MATCH", mailQty: 4, crmQty: 4 },
    ]);
    expect(settlementReconciliationDataSchema.safeParse(data).success).toBe(true);
  });

  it("같은 달 내용이 다르면 충돌 — 그 달은 합산하지 않고 partial", () => {
    const data = reconcileSettlement({
      campaignId: "sc-1",
      mails: [mail("a", "2026-09", sept), mail("b", "2026-09", [{ label: "구성: 3박스", qty: 9 }]), mail("c", "2026-10", oct)],
      catalog,
      scan: NO_SCAN,
    });
    expect(data.conflictMonths).toEqual(["2026-09"]);
    expect(data.partial).toBe(true);
    expect(data.options).toEqual([{ optionName: "구성: 3박스", status: "MAIL_LESS", mailQty: 2, crmQty: 4 }]);
  });

  it("이 캠페인 옵션과 하나도 안 맞는 메일은 버리되(헛경보 없음) 보이게 버린다 — 버림 칸 · 사유 · partial", () => {
    const data = reconcileSettlement({
      campaignId: "sc-1",
      mails: [mail("a", "2026-09", sept), mail("z", "2026-09", [{ label: "다른 브랜드 옵션", qty: 50 }])],
      catalog,
      scan: NO_SCAN,
    });
    expect(data.dropped).toBe(1);
    expect(data.partial).toBe(true);
    expect(data.conflictMonths).toEqual([]);
    expect(data.counts.OPTION_UNKNOWN).toBe(0);
    const text = formatSettlementReconciliation(data);
    expect(text.split("\n")[0]).toMatch(/ 버림=1$/);
    expect(text).toContain("옵션이 하나도 안 맞아 뺀 메일 1통");
  });

  it("전부 버려도 결과다 — mails=0 · partial=1 · 버림=N", () => {
    const data = reconcileSettlement({
      campaignId: "sc-1",
      mails: [mail("z", "2026-09", [{ label: "다른 브랜드 옵션", qty: 50 }]), mail("y", "2026-10", [{ label: "또 다른 옵션", qty: 1 }])],
      catalog,
      scan: NO_SCAN,
    });
    expect(data).toMatchObject({ mailsRead: 0, dropped: 2, partial: true, mails: [] });
    expect(formatReconFirstLine(data)).toMatch(/ partial=1 mails=0 .* 버림=2$/);
  });

  it("그룹 캠페인 — 같은 하위품목 줄이 멤버마다 있으면 CRM 수량은 그 줄들의 합", () => {
    const grouped: ReconCatalog = {
      ...catalog,
      lines: [...catalog.lines, { id: "line-6-member2", dealId: "deal-6", quantity: 5 }],
      mappings: catalog.mappings.filter((mapping) => mapping.campaignDealId !== "line-6"),
    };
    const data = reconcileSettlement({
      campaignId: "sc-1",
      mails: [mail("a", "2026-09", [{ label: "구성: 6박스", qty: 7 }])],
      catalog: grouped,
      scan: NO_SCAN,
    });
    expect(data.options).toEqual([{ optionName: "구성: 6박스", status: "MAPPING_MISSING", mailQty: 7, crmQty: 7 }]);
  });

  it("표가 없는 메일·스캔 불완전은 partial 이고, partial 은 MAIL_MORE 를 지우지 않는다(첫 줄에서 함께 읽는다)", () => {
    const data = reconcileSettlement({
      campaignId: "sc-1",
      mails: [mail("a", "2026-09", [{ label: "구성: 3박스", qty: 9 }]), mail("n", "2026-10", null)],
      catalog,
      scan: { ...NO_SCAN, overlappingRounds: 1 },
    });
    expect(data.partial).toBe(true);
    expect(data.withoutSheet).toBe(1);
    expect(data.counts.MAIL_MORE).toBe(1);
    const text = formatSettlementReconciliation(data);
    expect(text).toContain("메일 많음도 확정 아님");
    // 사람용 옵션 줄도 미확정으로 쓴다 — 첫 줄 칸(메일많음=1)은 그대로.
    expect(text).toContain("옵션「구성: 3박스」 메일 9 · CRM 4 · 메일 많음(미확정: 일부만 확인)");
    expect(text).not.toContain("브랜드가 CRM 보다 많이 셈");
    expect(text.split("\n")[0]).toContain(" 메일많음=1 ");
  });

  it("partial=0 이면 메일많음은 확정 문구다", () => {
    const data = reconcileSettlement({ campaignId: "sc-1", mails: [mail("a", "2026-09", [{ label: "구성: 3박스", qty: 9 }])], catalog, scan: NO_SCAN });
    expect(data.partial).toBe(false);
    const text = formatSettlementReconciliation(data);
    expect(text).toContain("옵션「구성: 3박스」 메일 9 · CRM 4 · 메일 많음(브랜드가 CRM 보다 많이 셈)");
    expect(text).not.toContain("미확정");
  });

  it("상태 칸은 서로 겹치지 않는다 — 합 = 옵션 수", () => {
    const rows = ["구성: 3박스", "구성: 6박스", "구성: 9박스", "구성: 15박스", "구성: 12박스", "구성: 99박스"].map((label) => ({ label, qty: 1 }));
    const data = reconcileSettlement({ campaignId: "sc-1", mails: [mail("a", "2026-09", rows)], catalog, scan: NO_SCAN });
    const { options, ...byStatus } = data.counts;
    expect(Object.values(byStatus).reduce((a, b) => a + b, 0)).toBe(options);
    expect(options).toBe(6);
  });
});

describe("출력 — 화이트리스트 · 첫 줄 · 사람용 줄", () => {
  it("결과 칸 이름이 고정돼 있다(금액·주문번호·이름 칸 없음)", () => {
    const data = reconcileSettlement({ campaignId: "sc-1", mails: [mail("a", "2026-09", [{ label: "구성: 3박스", qty: 4 }])], catalog, scan: NO_SCAN });
    expect(Object.keys(data).sort()).toEqual([
      "ambiguous",
      "campaignId",
      "conflictMonths",
      "counts",
      "dropped",
      "kind",
      "lastMailMonth",
      "mails",
      "mailsRead",
      "options",
      "optionsOmitted",
      "overlappingRounds",
      "partial",
      "timedOut",
      "truncated",
      "unreadable",
      "version",
      "withoutSheet",
    ]);
    expect(Object.keys(data.options[0]).sort()).toEqual(["crmQty", "mailQty", "optionName", "status"]);
    expect(Object.keys(data.mails[0]).sort()).toEqual(["receivedDate", "source", "yearMonth"]);
    expect(settlementReconciliationDataSchema.safeParse({ ...data, amount: 1 }).success).toBe(false);
  });

  it("첫 줄 모양(hermes 사본 계약)", () => {
    const data = reconcileSettlement({ campaignId: "sc-1", mails: [mail("a", "2026-09", [{ label: "구성: 3박스", qty: 4 }])], catalog, scan: NO_SCAN });
    expect(formatReconFirstLine(data)).toBe(
      "recon campaign=sc-1 partial=0 mails=1 옵션=1 일치=1 메일적음=0 메일많음=0 줄누락=0 매핑누락=0 연결오류=0 미상=0 충돌=0 버림=0",
    );
  });

  it("최악(긴 id · 큰 숫자)에도 첫 줄은 200자 이하이고 숫자 칸은 줄이지 않는다", () => {
    const base = reconcileSettlement({ campaignId: "x".repeat(128), mails: [], catalog, scan: NO_SCAN });
    const worst = {
      ...base,
      partial: true,
      mailsRead: 999_999,
      dropped: 1_000_000,
      conflictMonths: Array.from({ length: 24 }, (_, i) => `2026-${String((i % 12) + 1).padStart(2, "0")}`),
      counts: {
        options: 999_999,
        MATCH: 999_999,
        MAIL_LESS: 999_999,
        MAIL_MORE: 999_999,
        LINE_MISSING: 999_999,
        MAPPING_MISSING: 999_999,
        MAPPING_WRONG_LINE: 999_999,
        OPTION_UNKNOWN: 999_999,
      },
    };
    const line = formatReconFirstLine(worst);
    expect(line.length).toBeLessThanOrEqual(MAX_RECON_FIRST_LINE_CHARS);
    expect(line).toMatch(/ partial=1 mails=999999 옵션=999999 .* 미상=999999 충돌=24 버림=1000000$/);
    expect(line).toMatch(/^recon campaign=x+… /);
    // 실제 id 길이(25자)는 줄이지 않는다(합성 id).
    const syntheticId = "camp_test_1".padEnd(25, "x");
    expect(formatReconFirstLine({ ...worst, campaignId: syntheticId })).toContain(`campaign=${syntheticId} `);
  });

  it("옵션이 40개를 넘으면 「…외 N개」로 밝히고, 긴 옵션명도 전체 글자 상한 안이다", () => {
    const longName = (i: number) => `구성: ${"가".repeat(90)}${i}`;
    const rows = Array.from({ length: 60 }, (_, i) => ({ label: longName(i), qty: 1 }));
    const data = reconcileSettlement({ campaignId: "sc-1", mails: [mail("a", "2026-09", rows)], catalog: { ...catalog, mappings: rows.map((row) => ({ optionName: row.label, campaignDealId: null })) }, scan: NO_SCAN });
    expect(data.options.every((option) => option.optionName.length <= MAX_RECON_OPTION_NAME_CHARS)).toBe(true);
    const text = formatSettlementReconciliation(data);
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_SUMMARY_CHARS);
    const shown = text.split("\n").filter((line) => line.startsWith("옵션「")).length;
    expect(shown).toBeLessThanOrEqual(40);
    expect(text).toContain(`…외 ${60 - shown}개`);

    const short = Array.from({ length: 45 }, (_, i) => ({ label: `옵션${i}`, qty: 1 }));
    const many = reconcileSettlement({ campaignId: "sc-1", mails: [mail("a", "2026-09", short)], catalog: { ...catalog, mappings: short.map((row) => ({ optionName: row.label, campaignDealId: null })) }, scan: NO_SCAN });
    const manyText = formatSettlementReconciliation(many);
    expect(manyText.split("\n").filter((line) => line.startsWith("옵션「"))).toHaveLength(40);
    expect(manyText).toContain("…외 5개");
  });
});
