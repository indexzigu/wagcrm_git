import { describe, it, expect } from "vitest";
import { ORDER_RULES_PREVIEW_SAMPLES } from "../preview-orders";
import { ORDER_EXCEL_GUARDS } from "../excel-rules";

// 검수 미리보기 샘플은 "흔한 주문만으로는 안 드러나는 오매핑"을 화면에 노출하기 위한
// 의도적 엣지 모음(preview-orders.ts 설계 주석). 누군가 무심코 엣지를 지우면 검수 UI가
// 무력해지므로, 핵심 엣지 성질을 회귀 가드로 고정한다.

describe("preview-orders — 검수 미리보기 엣지 샘플 (회귀 가드)", () => {
  const byId = new Map(ORDER_RULES_PREVIEW_SAMPLES.map((s) => [s.id, s]));

  it("설계상 필수 엣지 3종(gift·contact2·mapping-fail)이 모두 존재한다", () => {
    expect(byId.has("gift")).toBe(true);
    expect(byId.has("contact2")).toBe(true);
    expect(byId.has("mapping-fail")).toBe(true);
  });

  it("선물 주문은 구매자 ≠ 수취인 — 연락처 계열 오매핑을 드러내는 핵심 엣지", () => {
    const gift = byId.get("gift")!.order;
    expect(gift.구매자명).not.toBe(gift.수취인명);
    expect(gift.구매자연락처).not.toBe(gift.수취인연락처1);
  });

  it("보조 연락처 샘플은 수취인연락처2를 포함한다", () => {
    expect(byId.get("contact2")!.order.수취인연락처2).toBeTruthy();
  });

  it("매핑 실패 샘플은 productCodeMapped 가드를 통과 못 하고, 정상 주문은 통과한다", () => {
    // 이 엣지가 있어야 조건부 기입(상품코드 매핑 우선) 오작동이 미리보기에 보인다.
    expect(ORDER_EXCEL_GUARDS.productCodeMapped(byId.get("mapping-fail")!.order)).toBe(false);
    expect(ORDER_EXCEL_GUARDS.productCodeMapped(byId.get("gift")!.order)).toBe(true);
  });
});
