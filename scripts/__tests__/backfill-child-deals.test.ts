import { describe, it, expect } from "vitest";
import {
  inferUnitFromName,
  isStandardChildName,
  planBackfillForChild,
  summarizeBackfillPlans,
  type ChildDealForBackfill,
} from "../backfill-child-deals";

function baseChild(overrides: Partial<ChildDealForBackfill> = {}): ChildDealForBackfill {
  return {
    id: "child-1",
    dealName: "부모딜 - 화이트",
    brandName: null,
    unit: null,
    unitQuantity: null,
    parentDealName: "부모딜",
    parentBrandName: "브랜드",
    parentUnit: "박스",
    ...overrides,
  };
}

describe("inferUnitFromName (C2-2)", () => {
  it("일반 단위 목록(박스|통|개|세트|팩|병|포|캔|스틱) 중 숫자 선행 패턴을 찾는다", () => {
    expect(inferUnitFromName("레몬즙 - 12박스")).toBe("박스");
    expect(inferUnitFromName("2통")).toBe("통");
    expect(inferUnitFromName("3세트 구성")).toBe("세트");
  });

  it("숫자가 선행하지 않으면 단위로 인정하지 않는다", () => {
    expect(inferUnitFromName("박스 없는 이름")).toBeNull();
  });

  it("이름이 없으면 null", () => {
    expect(inferUnitFromName(null)).toBeNull();
    expect(inferUnitFromName(undefined)).toBeNull();
  });
});

describe("isStandardChildName (C2-2)", () => {
  it("부모 접두어로 시작하면 정형이다", () => {
    expect(isStandardChildName("부모딜 - 화이트", "부모딜")).toBe(true);
  });

  it("부모 접두어로 시작하지 않으면 비정형이다", () => {
    expect(isStandardChildName("1통", "부모딜")).toBe(false);
  });

  it("parentDealName이 없으면 비정형으로 취급한다", () => {
    expect(isStandardChildName("아무 이름", null)).toBe(false);
  });

  it("[Critical 2 회귀] 부분 접두어 오매치('레몬즙'.startsWith('레몬'))는 정형으로 오판하지 않는다", () => {
    // 리뷰어 재현 케이스: "레몬즙 - 12박스".startsWith("레몬")은 true이지만 진짜 단어 경계
    // 접두어가 아니므로(다음 문자가 "즙") 비정형(false)으로 판정해야 한다. 이 결함 때문에
    // 기존 로직은 이 행을 백필 리포트의 비정형 목록에서 누락시켰다.
    expect(isStandardChildName("레몬즙 - 12박스", "레몬")).toBe(false);
  });
});

describe("planBackfillForChild (C2-2)", () => {
  it("brandName null → 부모 brandName으로 채운다", () => {
    const plan = planBackfillForChild(baseChild());
    expect(plan.fields.brandName).toBe("브랜드");
  });

  it("brandName이 이미 있으면 채우지 않는다", () => {
    const plan = planBackfillForChild(baseChild({ brandName: "자식전용브랜드" }));
    expect(plan.fields.brandName).toBeUndefined();
  });

  it("unit null → 부모 unit으로 채운다", () => {
    const plan = planBackfillForChild(baseChild());
    expect(plan.fields.unit).toBe("박스");
  });

  it("부모 unit도 없으면 이름에서 일반 단위를 추정한다", () => {
    const plan = planBackfillForChild(
      baseChild({ parentUnit: null, dealName: "레몬즙 - 12박스", parentDealName: "레몬즙" })
    );
    expect(plan.fields.unit).toBe("박스");
  });

  it("unitQuantity null → resolvedUnit 기준으로 이름에서 역추출한다", () => {
    const plan = planBackfillForChild(
      baseChild({ dealName: "부모딜 - 4박스", parentUnit: "박스" })
    );
    expect(plan.fields.unitQuantity).toBe(4);
  });

  it("이미 값이 있는 필드는 건드리지 않는다", () => {
    const plan = planBackfillForChild(
      baseChild({ brandName: "기존값", unit: "개", unitQuantity: 99 })
    );
    expect(plan.fields).toEqual({});
  });

  it("비정형 이름('1통', 부모 접두어 없음)은 isStandardName=false로 표시된다 (dealName 자체는 변경 안 함)", () => {
    const plan = planBackfillForChild(
      baseChild({ dealName: "1통", parentDealName: "부모딜", parentUnit: null, unit: null })
    );
    expect(plan.isStandardName).toBe(false);
    // dealName은 그대로이며, unit/unitQuantity는 이름 자체에서 여전히 추정 가능하면 채워질 수
    // 있다(청사진: "변경하지 않는다"는 dealName 문자열 자체를 의미 — 필드 채움은 별도 허용).
    expect(plan.dealName).toBe("1통");
  });
});

describe("summarizeBackfillPlans (C2-2)", () => {
  it("대상 수 / 필드별 채움 수 / 비정형 목록을 집계한다", () => {
    const children: ChildDealForBackfill[] = [
      baseChild({ id: "c1", dealName: "부모딜 - 화이트" }),
      baseChild({ id: "c2", dealName: "부모딜 - 블랙", brandName: "이미있음" }),
      baseChild({ id: "c3", dealName: "1통", parentDealName: "부모딜" }),
    ];

    const summary = summarizeBackfillPlans(children);
    expect(summary.targetCount).toBe(3);
    expect(summary.filledCounts.brandName).toBe(2); // c1, c3
    expect(summary.nonStandardNames).toEqual([{ id: "c3", dealName: "1통" }]);
  });
});
