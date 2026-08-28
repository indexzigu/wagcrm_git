/**
 * 경로 B(이미지/pdf/pptx) 순수 함수 테스트 — LLM 호출 없이 응답 파싱/정규화만 검증.
 * igojin 슬라이드3 실측 값(99,000원/28,200원/30%)을 흉내낸 응답으로 정규화 검증.
 */
import { describe, expect, it } from "vitest";
import { parseRowResponse, normalizeRowsB, assertFileSizeLimit } from "../extract-path-b";
import { PriceSheetExtractError, MAX_FILE_SIZE_BYTES } from "../types";

describe("parseRowResponse", () => {
  it("유효한 JSON 응답을 파싱한다", () => {
    const text = JSON.stringify({
      rows: [
        {
          tableSegment: 0,
          productName: "코어 마운틴 클라이머 320P",
          sellingPrice: 99000,
          supplyPrice: 28200,
          commissionRate: 0.3,
        },
      ],
      policyText: "정산일: 마지막 주문일로부터 21일 이내",
    });
    const parsed = parseRowResponse(text);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].sellingPrice).toBe(99000);
  });

  it("코드펜스로 감싼 JSON도 파싱한다", () => {
    const text = "```json\n" + JSON.stringify({ rows: [], policyText: null }) + "\n```";
    const parsed = parseRowResponse(text);
    expect(parsed.rows).toEqual([]);
  });

  it("잘못된 JSON은 PriceSheetExtractError를 던진다", () => {
    expect(() => parseRowResponse("이건 JSON이 아닙니다")).toThrow(PriceSheetExtractError);
  });

  it("스키마 밖 타입(문자열 가격)은 거부한다 — 숫자만 허용", () => {
    const text = JSON.stringify({ rows: [{ productName: "A", sellingPrice: "구만구천원" }] });
    expect(() => parseRowResponse(text)).toThrow(PriceSheetExtractError);
  });
});

describe("normalizeRowsB", () => {
  it("여러 슬라이드(제품)를 tableSegment로 구분해 정규화한다", () => {
    const parsed = {
      rows: [
        { tableSegment: 0, productName: "코어 마운틴 클라이머", sellingPrice: 99000, supplyPrice: 28200, commissionRate: 0.3 },
        { tableSegment: 1, productName: "비타 마운틴 클라이머", sellingPrice: 149000, supplyPrice: 28400, commissionRate: 0.2 },
      ],
      policyText: "원천징수 3.3%",
    };
    const { rows, detectedTables } = normalizeRowsB(parsed);
    expect(detectedTables).toBe(2);
    expect(rows[0].sellingPrice).toBe(99000);
    expect(rows[1].sellingPrice).toBe(149000);
  });

  it("productName 없는 행은 missingRequiredField 플래그가 붙는다", () => {
    const parsed = { rows: [{ sellingPrice: 1000 }], policyText: null };
    const { rows } = normalizeRowsB(parsed);
    expect(rows[0].flags.missingRequiredField).toBe(true);
    expect(rows[0].flags.needsReview).toBe(true);
  });

  it("불확실 값(null)은 지어내지 않고 그대로 null 유지", () => {
    const parsed = { rows: [{ productName: "상품", sellingPrice: null, supplyPrice: null }], policyText: null };
    const { rows } = normalizeRowsB(parsed);
    expect(rows[0].sellingPrice).toBeNull();
    expect(rows[0].supplyPrice).toBeNull();
  });

  // M3: LLM이 프롬프트 지시("30% -> 0.3")를 어기고 "30" 그대로 반환하는 경우를 대비한
  // 정규화 회귀 테스트. `PriceSheetRow`의 관례가 0~1 소수이므로 여기서 0.3으로 맞춘다.
  //
  // ⚠️ 종전 주석은 *"이 값이 그대로 Deal.totalCommissionRate에 들어가면 3000%로 기록되는
  // 금전 사고"* 라고 적었으나 **전제가 틀렸다** — `Deal.totalCommissionRate`는 0~1이 아니라
  // 퍼센트 수치라(`computeSupplyPrice`가 /100 한다) 30은 30%로 맞았다. 실제 사고는 반대
  // 방향이었다: 이 정규화 자체는 옳지만 **딜로 넘기는 경계에서 되돌리지 않아** 50%가
  // 0.5%로 저장됐다(프로덕션 19건). 경계 변환은 `grouping.ts`의 `rateToDealPercent`이고
  // 계약은 `rate-unit.contract.test.ts`가 고정한다.
  it("M3: commissionRate=30(퍼센트 정수)은 0.3으로 정규화된다", () => {
    const parsed = { rows: [{ productName: "상품", commissionRate: 30 }], policyText: null };
    const { rows } = normalizeRowsB(parsed);
    expect(rows[0].commissionRate).toBe(0.3);
  });

  it("M3: discountRate=30(퍼센트 정수)도 0.3으로 정규화된다", () => {
    const parsed = { rows: [{ productName: "상품", discountRate: 30 }], policyText: null };
    const { rows } = normalizeRowsB(parsed);
    expect(rows[0].discountRate).toBe(0.3);
  });

  it("M3: commissionRate=0.3(이미 소수)은 그대로 유지된다(이중 정규화 금지)", () => {
    const parsed = { rows: [{ productName: "상품", commissionRate: 0.3 }], policyText: null };
    const { rows } = normalizeRowsB(parsed);
    expect(rows[0].commissionRate).toBe(0.3);
  });

  // M3: 정규화해도 1을 초과하는 진짜 이상값(예: 원본 150 -> 1.5)은 클램프하지 않고
  // needsReview 플래그로 사람에게 넘긴다.
  it("M3: commissionRate=150 정규화 후 1.5 — needsReview 플래그가 붙는다(클램프하지 않음)", () => {
    const parsed = { rows: [{ productName: "상품", commissionRate: 150 }], policyText: null };
    const { rows } = normalizeRowsB(parsed);
    expect(rows[0].commissionRate).toBeCloseTo(1.5, 5);
    expect(rows[0].flags.needsReview).toBe(true);
  });

  // M4: 수치 sanity — 음수/비상식적으로 큰 sellingPrice는 needsReview로 플래그.
  it("M4: sellingPrice가 음수면 needsReview 플래그가 붙는다", () => {
    const parsed = { rows: [{ productName: "상품", sellingPrice: -1000 }], policyText: null };
    const { rows } = normalizeRowsB(parsed);
    expect(rows[0].flags.needsReview).toBe(true);
  });

  it("M4: sellingPrice가 1억을 초과하면 needsReview 플래그가 붙는다", () => {
    const parsed = { rows: [{ productName: "상품", sellingPrice: 200_000_000 }], policyText: null };
    const { rows } = normalizeRowsB(parsed);
    expect(rows[0].flags.needsReview).toBe(true);
  });

  it("M4: 정상 범위 값은 needsReview 플래그가 붙지 않는다", () => {
    const parsed = { rows: [{ productName: "상품", sellingPrice: 30900, commissionRate: 0.3 }], policyText: null };
    const { rows } = normalizeRowsB(parsed);
    expect(rows[0].flags.needsReview).toBeUndefined();
  });
});

describe("assertFileSizeLimit (R-D: 20MB 초과 거부)", () => {
  it("20MB 이하는 통과", () => {
    expect(() => assertFileSizeLimit(MAX_FILE_SIZE_BYTES)).not.toThrow();
  });
  it("20MB 초과는 throw", () => {
    expect(() => assertFileSizeLimit(MAX_FILE_SIZE_BYTES + 1)).toThrow(PriceSheetExtractError);
  });
});
