import { describe, it, expect } from "vitest";
import { planBackfill, formatPlanBreakdown, OLD_OWN_MALL_LABEL, NEW_OWN_MALL_LABEL, SELLER_MALL_ADDED } from "../backfill-settlement-checklist-labels";

describe("planBackfill — 멱등하고 좁게 잡는다", () => {
  it("옛 우리몰 라벨을 정확히 일치할 때만 고친다", () => {
    const plan = planBackfill(
      [{ id: "i1", campaignId: "c1", label: OLD_OWN_MALL_LABEL, status: "SETTLEMENT_IN_PROGRESS" }],
      [{ id: "c1", salesChannel: "OWN_MALL_NAVER" }],
    );
    expect(plan.labelUpdates).toEqual([{ id: "i1", from: OLD_OWN_MALL_LABEL, to: NEW_OWN_MALL_LABEL }]);
  });

  it("이미 신규 라벨이면 아무것도 하지 않는다 — 두 번 돌려도 같다", () => {
    const plan = planBackfill(
      [{ id: "i1", campaignId: "c1", label: NEW_OWN_MALL_LABEL, status: "SETTLEMENT_IN_PROGRESS" }],
      [{ id: "c1", salesChannel: "OWN_MALL_NAVER" }],
    );
    expect(plan.labelUpdates).toEqual([]);
  });

  it("부분 일치하는 다른 라벨은 건드리지 않는다", () => {
    const plan = planBackfill(
      [{ id: "i1", campaignId: "c1", label: "공급사 총 수수료 매출 세금계산서 발행", status: "SETTLEMENT_IN_PROGRESS" }],
      [{ id: "c1", salesChannel: "BRAND_MALL" }],
    );
    expect(plan.labelUpdates).toEqual([]);
  });

  it("셀러몰에 없는 항목만 채운다", () => {
    const plan = planBackfill(
      [{ id: "i1", campaignId: "c1", label: "대금 입금 일정 확정", status: "SETTLEMENT_IN_PROGRESS" }],
      [{ id: "c1", salesChannel: "SELLER_MALL" }],
    );
    expect(plan.itemInserts.map((i) => i.label).sort()).toEqual([...SELLER_MALL_ADDED].map((t) => t.label).sort());
  });

  it("체크리스트가 아예 없는 캠페인은 건드리지 않는다 — 템플릿이 만들게 둔다", () => {
    const plan = planBackfill([], [{ id: "c1", salesChannel: "SELLER_MALL" }]);
    expect(plan.itemInserts).toEqual([]);
  });

  it("셀러몰이 아닌 채널엔 항목을 넣지 않는다", () => {
    const plan = planBackfill(
      [{ id: "i1", campaignId: "c1", label: "대금 입/출금 일정 확정", status: "SETTLEMENT_IN_PROGRESS" }],
      [{ id: "c1", salesChannel: "BRAND_MALL" }],
    );
    expect(plan.itemInserts).toEqual([]);
  });
});

// 프로덕션 DB 쓰기의 **유일한** 사전 검토 수단이 예행 출력이다(P0 게이트). 총계 두 줄로는
// 오너가 `--apply` 를 승인할 근거를 만들 수 없으므로, 출력 형식 자체를 계약으로 고정한다.
describe("formatPlanBreakdown — 승인 근거가 되는 분해 출력", () => {
  const PLAN = planBackfill(
    [
      { id: "i1", campaignId: "c1", label: OLD_OWN_MALL_LABEL, status: "SETTLEMENT_IN_PROGRESS" },
      { id: "i2", campaignId: "c2", label: OLD_OWN_MALL_LABEL, status: "SETTLEMENT_IN_PROGRESS" },
      { id: "i3", campaignId: "c3", label: "대금 입금 일정 확정", status: "SETTLEMENT_IN_PROGRESS" },
    ],
    [
      { id: "c1", salesChannel: "OWN_MALL_NAVER" },
      { id: "c2", salesChannel: "OWN_MALL_NAVER" },
      { id: "c3", salesChannel: "SELLER_MALL" },
    ],
  );

  it("라벨 정정을 「무엇 → 무엇: N건」으로 분해한다", () => {
    const out = formatPlanBreakdown(PLAN).join("\n");
    expect(out).toContain("라벨 정정 2건");
    expect(out).toContain(`"${OLD_OWN_MALL_LABEL}" → "${NEW_OWN_MALL_LABEL}": 2건`);
  });

  it("항목 추가를 라벨별 건수로 분해하고 영향 캠페인 수도 밝힌다", () => {
    const out = formatPlanBreakdown(PLAN).join("\n");
    expect(out).toContain("항목 추가 2건 (캠페인 1개)");
    for (const template of SELLER_MALL_ADDED) {
      expect(out).toContain(`"${template.label}": 1건`);
    }
  });

  it("⛔ 캠페인 id 를 출력하지 않는다 — 오너가 이 출력을 그대로 붙여넣을 수 있다(P0, 이 레포는 PUBLIC)", () => {
    const out = formatPlanBreakdown(PLAN).join("\n");
    // 계획에 실제로 들어 있는 식별자들이 출력에 새지 않는지 본다.
    for (const id of ["c1", "c2", "c3", "i1", "i2", "i3"]) {
      expect(out).not.toContain(id);
    }
  });

  it("할 일이 없으면 「(없음)」이라고 말한다 — 빈 줄은 '출력이 잘렸나'로 읽힌다", () => {
    const out = formatPlanBreakdown({ labelUpdates: [], itemInserts: [] }).join("\n");
    expect(out).toContain("라벨 정정 0건");
    expect(out).toContain("항목 추가 0건 (캠페인 0개)");
    expect(out.match(/\(없음\)/g)).toHaveLength(2);
  });
});
