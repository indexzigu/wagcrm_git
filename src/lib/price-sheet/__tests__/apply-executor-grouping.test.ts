import { describe, expect, it } from "vitest";
import {
  buildApplyActions,
  extractPackQuantity,
  extractOptionBase,
  parseOptionName,
} from "../apply-executor";

type RowInput = Parameters<typeof buildApplyActions>[0][number];

function newRow(overrides: Partial<RowInput> = {}): RowInput {
  return {
    id: "row",
    mappingStatus: "NEW_DEAL",
    mappedDealId: null,
    productName: "비비랩 CLA 팻버닝 다이어트",
    optionName: "애사비 젤리 2팩",
    sellingPrice: 18000,
    supplyPrice: 10800,
    listPrice: 30800,
    floorPrice: null,
    commissionRate: 0.4,
    discountRate: 0.42,
    ...overrides,
  };
}

describe("extractPackQuantity — 옵션명 수량 파싱", () => {
  it("문자열 뒤쪽 '2팩'을 2로 파싱한다", () => {
    expect(extractPackQuantity("애사비 탱글 포켓 젤리 2팩")).toBe(2);
  });
  it("'1통' → 1 (기본 단위 감지)", () => {
    expect(extractPackQuantity("프로틴 1통")).toBe(1);
  });
  it("'포켓'의 '포'는 앞에 숫자가 없어 매칭되지 않는다", () => {
    expect(extractPackQuantity("포켓 젤리")).toBeNull();
  });
  it("단위가 없으면 null", () => {
    expect(extractPackQuantity("그냥 상품명")).toBeNull();
    expect(extractPackQuantity(null)).toBeNull();
  });
});

describe("extractOptionBase — 구성 베이스 추출(수량·단위 제거)", () => {
  it("뒤쪽 수량+단위를 떼어 제품 정체성만 남긴다", () => {
    expect(extractOptionBase("저분자콜라겐S 3통")).toBe("저분자콜라겐S");
    expect(extractOptionBase("애사비 젤리 2팩")).toBe("애사비 젤리");
    expect(extractOptionBase("오메가3 9박스")).toBe("오메가3");
  });
  it("수량+단위만 있으면 null(베이스 없음)", () => {
    expect(extractOptionBase("2팩")).toBeNull();
    expect(extractOptionBase(null)).toBeNull();
  });
  it("수량만 다른 옵션들은 같은 베이스를 공유한다", () => {
    expect(extractOptionBase("저분자콜라겐S 3통")).toBe(extractOptionBase("저분자콜라겐S 9통"));
  });
});

describe("buildApplyActions — 상위딜/하위품목딜 그룹핑", () => {
  it("같은 제품명 3행(2/6/12팩) → 상위딜 1 + 하위 3개의 createDealGroup 1건", () => {
    const rows = [
      newRow({ id: "r1", optionName: "애사비 젤리 2팩", sellingPrice: 18000 }),
      newRow({ id: "r2", optionName: "애사비 젤리 6팩", sellingPrice: 49300 }),
      newRow({ id: "r3", optionName: "애사비 젤리 12팩", sellingPrice: 78800 }),
    ];
    const actions = buildApplyActions(rows, "partner-1");
    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action.method).toBe("createDealGroup");
    if (action.method !== "createDealGroup") throw new Error("unreachable");
    const { parent, options } = action.args[0];
    // 브랜드(첫 토큰)는 brandName 필드가 전담 — 딜명에서는 뗀다(딜 패널 관례).
    expect(parent.dealName).toBe("CLA 팻버닝 다이어트");
    expect(parent.dealType).toBe("MAIN");
    // 상위딜 unit = 옵션 공통 단위(딜 패널 "새 옵션 등록" 폼의 단위 설정).
    expect(parent.unit).toBe("팩");
    expect(options).toHaveLength(3);
    expect(options.every((o) => o.dealType === "OPTION")).toBe(true);
    // 옵션 순서는 optionSortOrder로 보존
    expect(options.map((o) => o.optionSortOrder)).toEqual([0, 1, 2]);
    // 옵션 dealName은 딜 패널 옵션 관례("상위딜명 - N단위") — 제품명 중복 표기 금지.
    expect(options[0].dealName).toBe("CLA 팻버닝 다이어트 - 2팩");
    // 구조 필드도 딜 패널 옵션과 동일하게 채운다.
    expect(options[0].unitQuantity).toBe(2);
    expect(options[0].unit).toBe("팩");
    expect(options.map((o) => o.unitQuantity)).toEqual([2, 6, 12]);
  });

  it("'단위 1' 기본 옵션이 없으면(최소 2팩) 상위딜은 빈 컨테이너(0원)", () => {
    const rows = [
      newRow({ id: "r1", optionName: "2팩", sellingPrice: 18000, supplyPrice: 10800 }),
      newRow({ id: "r2", optionName: "6팩", sellingPrice: 49300, supplyPrice: 29580 }),
    ];
    const [action] = buildApplyActions(rows, null);
    if (action.method !== "createDealGroup") throw new Error("expected group");
    expect(action.args[0].parent.sellingPrice).toBe(0);
    expect(action.args[0].parent.costPrice).toBe(0);
    expect(action.args[0].parent.supplyPrice).toBeNull();
  });

  it("'1팩' 기본 옵션이 있으면 상위딜 가격을 그 값으로 상속한다", () => {
    const rows = [
      newRow({ id: "r0", optionName: "1팩", sellingPrice: 9900, supplyPrice: 6000 }),
      newRow({ id: "r1", optionName: "2팩", sellingPrice: 18000, supplyPrice: 10800 }),
    ];
    const [action] = buildApplyActions(rows, null);
    if (action.method !== "createDealGroup") throw new Error("expected group");
    expect(action.args[0].parent.sellingPrice).toBe(9900);
    expect(action.args[0].parent.supplyPrice).toBe(6000);
    // 기본 옵션도 여전히 옵션 목록에 포함된다(2개)
    expect(action.args[0].options).toHaveLength(2);
  });

  it("제품명이 단 하나뿐인 그룹(옵션 1개)은 평평한 단일 상위딜(createDeal)로 생성", () => {
    const actions = buildApplyActions([newRow({ id: "solo" })], "partner-1");
    expect(actions).toHaveLength(1);
    expect(actions[0].method).toBe("createDeal");
  });

  it("서로 다른 제품명은 각각 별개의 그룹으로 나뉜다", () => {
    const rows = [
      newRow({ id: "a1", productName: "제품A", optionName: "2팩" }),
      newRow({ id: "a2", productName: "제품A", optionName: "6팩" }),
      newRow({ id: "b1", productName: "제품B", optionName: "2팩" }),
      newRow({ id: "b2", productName: "제품B", optionName: "6팩" }),
    ];
    const groups = buildApplyActions(rows, null).filter((a) => a.method === "createDealGroup");
    expect(groups).toHaveLength(2);
  });

  it("좌측 제품명이 같아도 구성 베이스가 다르면 별개 딜로 갈린다(콜라겐 vs 애사비젤리)", () => {
    // 실제 가격표 오입력 케이스: 두 섹션 모두 productName이 "비비랩 CLA 팻버닝 다이어트"지만
    // 구성(저분자콜라겐S vs 애사비 젤리)이 달라 서로 다른 제품 → 서로 다른 딜이어야 한다.
    const rows = [
      newRow({ id: "c1", optionName: "저분자콜라겐S 3통", sellingPrice: 26000 }),
      newRow({ id: "c2", optionName: "저분자콜라겐S 6통", sellingPrice: 49000 }),
      newRow({ id: "c3", optionName: "저분자콜라겐S 9통", sellingPrice: 67500 }),
      newRow({ id: "j1", optionName: "애사비 젤리 2팩", sellingPrice: 18000 }),
      newRow({ id: "j2", optionName: "애사비 젤리 6팩", sellingPrice: 49300 }),
      newRow({ id: "j3", optionName: "애사비 젤리 12팩", sellingPrice: 78800 }),
    ];
    const groups = buildApplyActions(rows, null).filter((a) => a.method === "createDealGroup");
    expect(groups).toHaveLength(2);
    // 동명이인 방지: 같은 제품명이 두 베이스로 갈렸으므로 상위딜명에 구성 베이스가 붙는다.
    const parentNames = groups
      .map((g) => (g.method === "createDealGroup" ? g.args[0].parent.dealName : ""))
      .sort();
    expect(parentNames).toEqual([
      "CLA 팻버닝 다이어트 - 애사비 젤리",
      "CLA 팻버닝 다이어트 - 저분자콜라겐S",
    ]);
    // 각 딜은 옵션 3개(수량만 다른)로 묶인다.
    for (const g of groups) {
      if (g.method === "createDealGroup") expect(g.args[0].options).toHaveLength(3);
    }
  });

  it("구성 베이스가 유일하면 상위딜명에 베이스를 붙이지 않는다(제품명 그대로)", () => {
    const rows = [
      newRow({ id: "u1", productName: "비비랩 프로바이오틱스 더블유", optionName: "여성 질 유산균 2통", sellingPrice: 29200 }),
      newRow({ id: "u2", productName: "비비랩 프로바이오틱스 더블유", optionName: "여성 질 유산균 4통", sellingPrice: 55000 }),
    ];
    const [action] = buildApplyActions(rows, null);
    if (action.method !== "createDealGroup") throw new Error("expected group");
    expect(action.args[0].parent.dealName).toBe("프로바이오틱스 더블유");
  });

  it("MAPPED 행은 그룹핑 대상이 아니라 개별 updateDeal로 유지된다", () => {
    const rows = [
      { ...newRow({ id: "m1" }), mappingStatus: "MAPPED", mappedDealId: "deal-1" },
      newRow({ id: "n1", productName: "신규제품", optionName: "2팩" }),
      newRow({ id: "n2", productName: "신규제품", optionName: "6팩" }),
    ];
    const actions = buildApplyActions(rows, null);
    expect(actions.filter((a) => a.method === "updateDeal")).toHaveLength(1);
    expect(actions.filter((a) => a.method === "createDealGroup")).toHaveLength(1);
  });
});

describe("parseOptionName — 옵션명 → 구조 필드(수량·단위·보조정보)", () => {
  it("'파이토 샐러드샷 2박스 (1개월분)' → base/수량/단위/보조정보 분해", () => {
    expect(parseOptionName("파이토 샐러드샷 2박스 (1개월분)")).toEqual({
      base: "파이토 샐러드샷",
      quantity: 2,
      unit: "박스",
      supplementary: "1개월분",
    });
  });
  it("괄호 없는 '애사비 젤리 6팩'은 보조정보 null", () => {
    expect(parseOptionName("애사비 젤리 6팩")).toEqual({
      base: "애사비 젤리",
      quantity: 6,
      unit: "팩",
      supplementary: null,
    });
  });
  it("수량이 끝에 없으면 base는 자르지 않고 수량만 참고값으로 취한다", () => {
    const parsed = parseOptionName("2팩 세트상품");
    expect(parsed.base).toBe("2팩 세트상품");
    expect(parsed.quantity).toBe(2);
  });
  it("수량이 괄호 안에만 있는 '제품명 (2박스)'도 구성 수량으로 인식한다(보조정보 아님)", () => {
    // 회귀 가드: 괄호를 무조건 보조정보로 삼키면 수량 유실 → 상위딜 빈 컨테이너(0원) +
    // 딜명 중복 표기 폴백 재발(code-reviewer HIGH 적발 케이스).
    expect(parseOptionName("파이토 샐러드샷 (2박스)")).toEqual({
      base: "파이토 샐러드샷",
      quantity: 2,
      unit: "박스",
      supplementary: null,
    });
    // "단위 1" 판정도 이 형태를 인식해야 상위딜 가격 상속이 동작한다.
    expect(parseOptionName("제품 (1개)").quantity).toBe(1);
  });
  it("괄호 밖 끝 수량이 정본 — 괄호 안 수량 후보는 보조정보로 강등된다", () => {
    expect(parseOptionName("베이스 2박스 (1개)")).toEqual({
      base: "베이스",
      quantity: 2,
      unit: "박스",
      supplementary: "1개",
    });
  });
});

describe("딜 패널 옵션 관례 정합 — 딜명·구조 필드", () => {
  it("옵션에 보조정보가 있으면 딜명은 '상위딜명 - N단위 (보조정보)'로 조합된다", () => {
    const rows = [
      newRow({ id: "s1", productName: "브랜드명 파이토 샐러드샷", optionName: "파이토 샐러드샷 2박스 (1개월분)", sellingPrice: 55000 }),
      newRow({ id: "s2", productName: "브랜드명 파이토 샐러드샷", optionName: "파이토 샐러드샷 4박스 (2개월분)", sellingPrice: 96000 }),
    ];
    const [action] = buildApplyActions(rows, null);
    if (action.method !== "createDealGroup") throw new Error("expected group");
    const { parent, options } = action.args[0];
    expect(parent.dealName).toBe("파이토 샐러드샷");
    expect(options[0].dealName).toBe("파이토 샐러드샷 - 2박스 (1개월분)");
    expect(options[0].supplementaryInfo).toBe("1개월분");
    expect(options[1].dealName).toBe("파이토 샐러드샷 - 4박스 (2개월분)");
  });

  it("2토큰 제품명('애사비 젤리')은 브랜드를 딜명에서 떼지 않는다(보수 규칙)", () => {
    const rows = [
      newRow({ id: "t1", productName: "애사비 젤리", optionName: "애사비 젤리 2팩" }),
      newRow({ id: "t2", productName: "애사비 젤리", optionName: "애사비 젤리 6팩" }),
    ];
    const [action] = buildApplyActions(rows, null);
    if (action.method !== "createDealGroup") throw new Error("expected group");
    expect(action.args[0].parent.dealName).toBe("애사비 젤리");
    expect(action.args[0].options?.[0].dealName).toBe("애사비 젤리 - 2팩");
  });
});
