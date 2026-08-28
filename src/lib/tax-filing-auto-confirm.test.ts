import { describe, expect, it } from "vitest";
import { buildAutoConfirmedEntries, type AutoConfirmLogRow } from "./tax-filing-auto-confirm";

function log(overrides: Partial<AutoConfirmLogRow> = {}): AutoConfirmLogRow {
  return {
    entityId: "camp-a",
    type: "TAX_INVOICE_AUTO_CONFIRM",
    fieldName: "supplierInvoiceIssuedAt",
    newValue: "2026-07-31",
    content: "메일 자동 확정 — 공급사/셀러몰 계산서 발행일을 2026-07-31로 기록했습니다(계산서 1장 · 승인번호 X).",
    createdAt: new Date("2026-08-06T01:00:00.000Z"),
    ...overrides,
  };
}

const labels = new Map([
  ["camp-a", "딜A - 셀러A"],
  ["camp-b", "딜B - 셀러A"],
]);

describe("buildAutoConfirmedEntries", () => {
  it("그룹 확정이 멤버 수만큼 뜨지 않는다 — 같은 op 는 한 줄로 접고 캠페인 라벨을 모은다", () => {
    const entries = buildAutoConfirmedEntries(
      [log({ entityId: "camp-a" }), log({ entityId: "camp-b" })],
      labels,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].campaignLabels).toEqual(["딜A - 셀러A", "딜B - 셀러A"]);
  });

  it("필드가 다르면 다른 확정이다 — 접지 않는다", () => {
    const entries = buildAutoConfirmedEntries(
      [log(), log({ fieldName: "sellerInvoiceIssuedAt", content: "셀러 계산서 문장" })],
      labels,
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.sourceField).sort()).toEqual([
      "sellerInvoiceIssuedAt",
      "supplierInvoiceIssuedAt",
    ]);
  });

  it("같은 필드라도 승인번호(=content)가 다르면 다른 계산서다 — 접지 않는다", () => {
    const entries = buildAutoConfirmedEntries(
      [log({ content: "…승인번호 X)." }), log({ entityId: "camp-b", content: "…승인번호 Y)." })],
      labels,
    );

    expect(entries).toHaveLength(2);
  });

  it("이 달 목록에 없는 캠페인도 개수에서 빼지 않는다 — 기계가 건드린 범위를 축소해 보고하지 않는다", () => {
    const entries = buildAutoConfirmedEntries([log({ entityId: "camp-a" }), log({ entityId: "camp-z" })], labels);

    expect(entries[0].campaignLabels).toHaveLength(2);
    expect(entries[0].campaignLabels[1]).toBe("이 달 목록 밖 캠페인");
  });

  it("알 수 없는 fieldName 은 라벨을 지어내지 않고 버린다", () => {
    expect(buildAutoConfirmedEntries([log({ fieldName: "accountingCompletedAt" })], labels)).toEqual([]);
    expect(buildAutoConfirmedEntries([log({ fieldName: null })], labels)).toEqual([]);
  });

  it("확정 시각은 그 op 의 가장 이른 로그이고, 목록은 최신순이다", () => {
    const entries = buildAutoConfirmedEntries(
      [
        log({ entityId: "camp-a", createdAt: new Date("2026-08-06T01:00:02.000Z") }),
        log({ entityId: "camp-b", createdAt: new Date("2026-08-06T01:00:00.000Z") }),
        log({
          entityId: "camp-a",
          content: "다른 확정",
          createdAt: new Date("2026-08-07T01:00:00.000Z"),
        }),
      ],
      labels,
    );

    expect(entries).toHaveLength(2);
    expect(entries[0].detail).toBe("다른 확정");
    expect(entries[1].confirmedAt).toBe("2026-08-06T01:00:00.000Z");
  });

  it("허용오차 흡수 확정은 type 으로만 가른다 — 문장을 파싱하지 않는다", () => {
    const entries = buildAutoConfirmedEntries(
      [
        log({ type: "TAX_INVOICE_AUTO_CONFIRM_TOLERATED", content: "…허용오차 흡수 건" }),
        log({ entityId: "camp-b", content: "…완전 일치 건" }),
      ],
      labels,
    );

    const tolerated = entries.filter((e) => e.tolerated);
    expect(tolerated).toHaveLength(1);
    expect(tolerated[0].detail).toBe("…허용오차 흡수 건");
    // 문장에 「허용오차」가 들어 있어도 type 이 완전 일치면 흡수로 세지 않는다 — 문구
    // 파싱으로 되돌아가면 이 단언이 깨진다.
    const exact = buildAutoConfirmedEntries([log({ content: "허용오차 라는 낱말이 든 완전 일치 문장" })], labels);
    expect(exact[0].tolerated).toBe(false);
  });

  it("흡수 확정과 완전 일치 확정은 같은 줄로 접히지 않는다", () => {
    const entries = buildAutoConfirmedEntries(
      [log(), log({ entityId: "camp-b", type: "TAX_INVOICE_AUTO_CONFIRM_TOLERATED" })],
      labels,
    );

    expect(entries).toHaveLength(2);
  });

  it("작성일자가 비어 있어도 줄을 버리지 않는다 — 기계가 손댄 사실 자체가 이 화면의 값어치다", () => {
    const entries = buildAutoConfirmedEntries([log({ newValue: null })], labels);

    expect(entries).toHaveLength(1);
    expect(entries[0].writtenDate).toBeNull();
  });
});
