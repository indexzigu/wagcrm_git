import { describe, it, expect } from "vitest";
import { isIncompleteSource, toConfirmedSource, riskyFieldNote } from "../types";

// F4 Phase 2 §4단계 검수 UI의 확정 게이팅·위험필드 경고를 뒷받침하는 순수 로직.
// 이 함수들이 "확정 버튼 비활성(incomplete)"과 "구매자/수취인 오매핑 경고"를 결정한다.

describe("order-template/types — 순수 로직", () => {
  describe("isIncompleteSource — 미선택 필드 감지(확정 차단 근거)", () => {
    it("field 타입인데 field가 null이면 incomplete", () => {
      expect(isIncompleteSource({ type: "field", field: null })).toBe(true);
    });
    it("field가 지정되면 complete", () => {
      expect(isIncompleteSource({ type: "field", field: "구매자명" })).toBe(false);
    });
    it("template/const/empty는 incomplete가 아니다(의도적 값/공란)", () => {
      expect(isIncompleteSource({ type: "template", template: "{{sellerName}}" })).toBe(false);
      expect(isIncompleteSource({ type: "const", value: "고정값" })).toBe(false);
      expect(isIncompleteSource({ type: "empty" })).toBe(false);
    });
  });

  describe("toConfirmedSource — 확정 가능 소스로 좁히기", () => {
    it("incomplete(field=null)면 null을 반환해 확정을 막는다", () => {
      expect(toConfirmedSource({ type: "field", field: null })).toBeNull();
    });
    it("확정 가능한 소스는 그대로 반환한다", () => {
      expect(toConfirmedSource({ type: "field", field: "수취인명" })).toEqual({
        type: "field",
        field: "수취인명",
      });
      expect(toConfirmedSource({ type: "empty" })).toEqual({ type: "empty" });
      expect(toConfirmedSource({ type: "const", value: "와이그라운드" })).toEqual({
        type: "const",
        value: "와이그라운드",
      });
    });
  });

  describe("riskyFieldNote — 구매자/수취인 오매핑 경고", () => {
    it("구매자* 필드는 주문자 경고를 낸다", () => {
      expect(riskyFieldNote({ type: "field", field: "구매자명" })).toMatch(/주문자/);
      expect(riskyFieldNote({ type: "field", field: "구매자연락처" })).toMatch(/주문자/);
    });
    it("수취인* 필드는 수령인 경고를 낸다", () => {
      expect(riskyFieldNote({ type: "field", field: "수취인명" })).toMatch(/수령인/);
      expect(riskyFieldNote({ type: "field", field: "수취인연락처1" })).toMatch(/수령인/);
    });
    it("위험하지 않은 필드·미선택·비필드 소스는 경고 없음", () => {
      expect(riskyFieldNote({ type: "field", field: "상품코드" })).toBeNull();
      expect(riskyFieldNote({ type: "field", field: null })).toBeNull();
      expect(riskyFieldNote({ type: "template", template: "{{sellerName}}" })).toBeNull();
      expect(riskyFieldNote({ type: "empty" })).toBeNull();
    });
  });
});
