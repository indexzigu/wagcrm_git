import { describe, it, expect } from "vitest";
import {
  buildSearchQuery,
  buildQuantityToken,
  inferQuantityFromName,
  parseSearchKeywordFromSupplementaryInfo,
  parseModelNameFromSupplementaryInfo,
  extractOptionToken,
  resolveMonitorFields,
  buildMonitorWindowWhere,
  MONITOR_WINDOW_DAYS,
  type MonitorDealFields,
} from "../query-builder";

describe("buildSearchQuery", () => {
  it("옵션별로 수량 토큰이 다르게 파생된다 (버그②③ 복구 대상)", () => {
    const base = { searchKeyword: "종근당 락토핏 골드", brandName: "종근당", dealName: "락토핏 골드 4박스" };

    const opt1 = buildSearchQuery({ ...base, unitQuantity: 2, unit: "박스" });
    const opt2 = buildSearchQuery({ ...base, unitQuantity: 4, unit: "박스" });

    expect(opt1).toBe("종근당 락토핏 골드 2박스");
    expect(opt2).toBe("종근당 락토핏 골드 4박스");
    expect(opt1).not.toBe(opt2);
  });

  it("searchKeyword가 없으면 brandName+dealName으로 폴백한다", () => {
    const q = buildSearchQuery({ brandName: "종근당", dealName: "락토핏 골드", unitQuantity: 1, unit: "통" });
    expect(q).toBe("종근당 락토핏 골드 1통");
  });

  it("수량/단위가 전혀 없으면 core만 반환한다", () => {
    const q = buildSearchQuery({ searchKeyword: "종근당 락토핏 골드" });
    expect(q).toBe("종근당 락토핏 골드");
  });

  it("unitQuantity가 비어도 dealName에서 수량을 역추출한다", () => {
    const q = buildSearchQuery({ searchKeyword: "락토핏 골드", dealName: "락토핏 골드 4박스", unit: "박스" });
    expect(q).toBe("락토핏 골드 4박스");
  });

  it("모든 재료가 비면 dealName 원문으로 최종 폴백한다", () => {
    const q = buildSearchQuery({ dealName: "이름만 있는 딜" });
    expect(q).toBe("이름만 있는 딜");
  });
});

describe("buildSearchQuery — childDealName/parentDealName (C1-1)", () => {
  it("childDealName 미전달 시 기존 동작과 바이트 동일 (회귀 금지)", () => {
    const withoutChild = buildSearchQuery({
      searchKeyword: "종근당 락토핏 골드",
      brandName: "종근당",
      dealName: "락토핏 골드 4박스",
      unitQuantity: 4,
      unit: "박스",
    });
    expect(withoutChild).toBe("종근당 락토핏 골드 4박스");
  });

  it("자식 옵션명이 '부모딜 - 화이트' 형태면 core+옵션토큰(화이트)+수량토큰이 붙는다", () => {
    const q = buildSearchQuery({
      searchKeyword: "종근당 락토핏 골드",
      dealName: "부모딜 - 화이트",
      childDealName: "부모딜 - 화이트",
      parentDealName: "부모딜",
      unitQuantity: 2,
      unit: "박스",
    });
    expect(q).toBe("종근당 락토핏 골드 화이트 2박스");
  });

  it("괄호 주석과 수량 중복은 제거된다 ('고순도 오메가3 - 4박스 (4개월분)')", () => {
    // core는 searchKeyword(AI 추출, 수량 미포함)로 고정하고, childDealName/parentDealName은
    // 자식 자신의 원본 표시명 그대로 전달한다(실사용 패턴과 동일 — core 재료로 dealName을
    // 재사용하지 않음).
    const q = buildSearchQuery({
      searchKeyword: "고순도 오메가3",
      dealName: "고순도 오메가3",
      childDealName: "고순도 오메가3 - 4박스 (4개월분)",
      parentDealName: "고순도 오메가3",
      unitQuantity: 4,
      unit: "박스",
    });
    expect(q.match(/4박스/g)?.length).toBe(1);
    expect(q).not.toContain("(4개월분)");
    expect(q).toBe("고순도 오메가3 4박스");
  });

  it("비정형 자식명('1통', 부모 접두어 없음)은 core에 수량토큰만 1회 붙는다 (복구 대상)", () => {
    const q = buildSearchQuery({
      searchKeyword: "부모 코어 키워드",
      dealName: "1통",
      childDealName: "1통",
      parentDealName: "부모딜",
      unitQuantity: 1,
      unit: "통",
    });
    expect(q).toBe("부모 코어 키워드 1통");
  });
});

describe("extractOptionToken (C1-1)", () => {
  it("부모 접두어 제거 후 옵션명만 남긴다", () => {
    expect(extractOptionToken("부모딜 - 화이트", "부모딜", "")).toBe("화이트");
  });

  it("구분자(대시/엔대시/공백)를 모두 strip한다", () => {
    expect(extractOptionToken("부모딜 – 블랙", "부모딜", "")).toBe("블랙");
    expect(extractOptionToken("부모딜 블랙", "부모딜", "")).toBe("블랙");
  });

  it("괄호 주석을 제거한다 (수량 토큰이 없을 때는 잔여 텍스트가 그대로 남는다)", () => {
    expect(extractOptionToken("고순도 오메가3 - 화이트 (4개월분)", "고순도 오메가3", "")).toBe("화이트");
  });

  it("qtyToken과 동일한 숫자+단위 중복은 옵션토큰에서 제거된다 (buildSearchQuery가 별도로 재부착)", () => {
    // 잔여 텍스트가 qtyToken 자체("4박스")뿐이면 옵션토큰에서는 제거되어 빈 문자열이 된다.
    // 최종 쿼리에서는 buildSearchQuery의 token이 별도로 붙어 "4박스"가 정확히 1회만 나타난다.
    const result = extractOptionToken("고순도 오메가3 - 4박스 (4개월분)", "고순도 오메가3", "4박스");
    expect(result).toBe("");
  });

  it("부모 접두어가 없는 비정형 이름은 전체에 정리만 적용한다 (qtyToken과 동일하면 제거된다)", () => {
    expect(extractOptionToken("1통", "부모딜", "1통")).toBe("");
  });

  it("부모 접두어가 없고 괄호 주석이 있는 비정형 이름도 정리한다 (qtyToken 제거 후 빈 문자열)", () => {
    expect(extractOptionToken("2박스 (2개월분)", "부모딜", "2박스")).toBe("");
  });

  it("[Critical 2 회귀] 부분 접두어 오매치('레몬즙'.startsWith('레몬'))는 접두어로 인정하지 않고, 쓰레기 파편을 주입하지 않는다", () => {
    // 리뷰어 재현 케이스: "레몬즙 - 12박스".startsWith("레몬")은 true이지만 "레몬"은 진짜
    // 단어 경계 접두어가 아니다(다음 문자가 "즙"이라 공백/-/–/( 중 아무것도 아님). 기존
    // 버그는 이를 접두어로 오인해 "즙 -" 같은 쓰레기 파편을 쿼리에 주입했다.
    const result = extractOptionToken("레몬즙 - 12박스", "레몬", "12박스");
    expect(result).not.toContain("즙 -");
    expect(result).not.toMatch(/^즙/);
    expect(result).toBe("레몬즙");
  });
});

describe("buildQuantityToken", () => {
  it("수량+단위 조합", () => {
    expect(buildQuantityToken(3, "개")).toBe("3개");
  });
  it("단위만 있으면 단위만", () => {
    expect(buildQuantityToken(null, "박스")).toBe("박스");
  });
  it("둘 다 없으면 빈 문자열", () => {
    expect(buildQuantityToken(null, null)).toBe("");
  });
});

describe("parseSearchKeywordFromSupplementaryInfo (버그② 복구)", () => {
  it("JSON supplementaryInfo에서 searchKeyword를 파싱한다", () => {
    const raw = JSON.stringify({ searchKeyword: "종근당 락토핏 골드", referenceUrl: "https://example.com" });
    expect(parseSearchKeywordFromSupplementaryInfo(raw)).toBe("종근당 락토핏 골드");
  });

  it("searchKeyword가 빈 문자열이면 null", () => {
    const raw = JSON.stringify({ searchKeyword: "  " });
    expect(parseSearchKeywordFromSupplementaryInfo(raw)).toBeNull();
  });

  it("레거시 자유 텍스트(JSON이 아님)는 null로 취급해 폴백 경로를 타게 한다", () => {
    expect(parseSearchKeywordFromSupplementaryInfo("1개월분")).toBeNull();
  });

  it("null/undefined/빈 문자열은 null", () => {
    expect(parseSearchKeywordFromSupplementaryInfo(null)).toBeNull();
    expect(parseSearchKeywordFromSupplementaryInfo(undefined)).toBeNull();
    expect(parseSearchKeywordFromSupplementaryInfo("")).toBeNull();
  });
});

describe("parseModelNameFromSupplementaryInfo (P1-5)", () => {
  it("JSON supplementaryInfo에서 modelName을 파싱한다", () => {
    const raw = JSON.stringify({ searchKeyword: "휴브론 3 in 1 무선고데기", modelName: "PB-10000X" });
    expect(parseModelNameFromSupplementaryInfo(raw)).toBe("PB-10000X");
  });

  it("modelName이 빈 문자열이면 null", () => {
    const raw = JSON.stringify({ modelName: "  " });
    expect(parseModelNameFromSupplementaryInfo(raw)).toBeNull();
  });

  it("레거시 자유 텍스트(JSON이 아님)는 null로 취급한다", () => {
    expect(parseModelNameFromSupplementaryInfo("1개월분")).toBeNull();
  });

  it("null/undefined/빈 문자열은 null", () => {
    expect(parseModelNameFromSupplementaryInfo(null)).toBeNull();
    expect(parseModelNameFromSupplementaryInfo(undefined)).toBeNull();
    expect(parseModelNameFromSupplementaryInfo("")).toBeNull();
  });

  it("modelName 필드 자체가 없으면(기존 데이터) null", () => {
    const raw = JSON.stringify({ searchKeyword: "종근당 락토핏 골드" });
    expect(parseModelNameFromSupplementaryInfo(raw)).toBeNull();
  });
});

describe("inferQuantityFromName", () => {
  it("이름에서 숫자+단위 패턴을 추출한다", () => {
    expect(inferQuantityFromName("락토핏 4박스 특가", "박스")).toBe(4);
  });
  it("패턴이 없으면 null", () => {
    expect(inferQuantityFromName("락토핏 특가", "박스")).toBeNull();
  });
  it("정규식 특수문자가 섞인 단위도 안전하게 처리한다", () => {
    expect(() => inferQuantityFromName("상품 3(개)", "(개)")).not.toThrow();
  });
});

describe("resolveMonitorFields (C1-3 — cron 부모 join 해소)", () => {
  const child: MonitorDealFields = {
    dealName: "부모딜 - 화이트",
    brandName: null,
    unit: null,
    unitQuantity: null,
    supplementaryInfo: null,
  };
  const parent: MonitorDealFields = {
    dealName: "부모딜",
    brandName: "브랜드",
    unit: "박스",
    unitQuantity: null,
    supplementaryInfo: JSON.stringify({ searchKeyword: "브랜드 부모딜" }),
  };

  it("parentDeal이 없으면(단독/부모 딜) 자기 자신 필드만 사용하고 child/parentDealName은 null이다", () => {
    const resolved = resolveMonitorFields(parent, null);
    expect(resolved).toEqual({
      dealName: "부모딜",
      coreDealName: "부모딜",
      brandName: "브랜드",
      unit: "박스",
      unitQuantity: null,
      searchKeyword: "브랜드 부모딜",
      modelName: null,
      childDealName: null,
      parentDealName: null,
    });
  });

  it("자식 딜의 brandName/unit이 null이면 부모 값으로 폴백한다", () => {
    const resolved = resolveMonitorFields(child, parent);
    expect(resolved.brandName).toBe("브랜드");
    expect(resolved.unit).toBe("박스");
  });

  it("자식 딜의 searchKeyword가 없으면 부모 supplementaryInfo에서 파싱한다", () => {
    const resolved = resolveMonitorFields(child, parent);
    expect(resolved.searchKeyword).toBe("브랜드 부모딜");
  });

  it("자식 딜이면 buildSearchQuery에 넘길 childDealName/parentDealName을 채운다", () => {
    const resolved = resolveMonitorFields(child, parent);
    expect(resolved.childDealName).toBe("부모딜 - 화이트");
    expect(resolved.parentDealName).toBe("부모딜");
  });

  it("자식 딜이면 coreDealName은 부모의 dealName이다 (청사진 §C1-1: core는 brand+부모dealName)", () => {
    const resolved = resolveMonitorFields(child, parent);
    expect(resolved.coreDealName).toBe("부모딜");
    expect(resolved.dealName).toBe("부모딜 - 화이트"); // dealName 자체는 자식 자신의 표시명 유지
  });

  it("자식 자신에 값이 있으면 부모보다 우선한다(자식 ?? 부모)", () => {
    const childWithOwnValues: MonitorDealFields = {
      ...child,
      brandName: "자식전용브랜드",
      unit: "개",
      supplementaryInfo: JSON.stringify({ searchKeyword: "자식전용키워드" }),
    };
    const resolved = resolveMonitorFields(childWithOwnValues, parent);
    expect(resolved.brandName).toBe("자식전용브랜드");
    expect(resolved.unit).toBe("개");
    expect(resolved.searchKeyword).toBe("자식전용키워드");
  });

  it("최종 buildSearchQuery에 넘기면 부모브랜드 복구 + 비정형 자식명도 core로 복구된다 ('1통')", () => {
    // 자식 자신의 unit도 "통"으로 채워져 있는(정상 케이스) 비정형 이름 — 부모 unit이 null이라
    // 충돌이 없는 케이스.
    const parentWithoutUnit: MonitorDealFields = { ...parent, unit: null };
    const nonStandardChild: MonitorDealFields = {
      dealName: "1통",
      brandName: null,
      unit: "통",
      unitQuantity: 1,
      supplementaryInfo: null,
    };
    const resolved = resolveMonitorFields(nonStandardChild, parentWithoutUnit);
    const query = buildSearchQuery({
      searchKeyword: resolved.searchKeyword,
      brandName: resolved.brandName,
      dealName: resolved.coreDealName,
      unitQuantity: resolved.unitQuantity,
      unit: resolved.unit,
      childDealName: resolved.childDealName,
      parentDealName: resolved.parentDealName,
    });
    expect(query).toBe("브랜드 부모딜 1통");
  });

  it("[Critical 1 회귀] 비정형 자식 '1통'(unit/unitQuantity null) + 부모 unit '박스' 충돌 시 쓰레기 토큰이 생기지 않는다", () => {
    // 리뷰어 재현 케이스: 자식 자신은 unit/unitQuantity가 전혀 없고(진짜 프로덕션 상태),
    // 부모에서 unit="박스"를 상속받는다. 이름 "1통"에는 qty를 추론할 unit("박스")이 없으므로
    // resolvedQty는 null로 남고, 기존 버그는 buildQuantityToken(null, "박스")이 bare-unit
    // "박스"를 반환해 "브랜드 1통 1통 박스" 같은 이중/쓰레기 토큰을 만들었다.
    // childDealName 경로에서는 qty 추론 실패 시 bare-unit을 붙이지 않아야 한다. core 폴백
    // 재료는 실제 cron 라우팅과 동일하게 coreDealName(부모 dealName)을 사용한다.
    const resolved = resolveMonitorFields(
      { dealName: "1통", brandName: null, unit: null, unitQuantity: null, supplementaryInfo: null },
      { dealName: "부모딜", brandName: "브랜드", unit: "박스", unitQuantity: null, supplementaryInfo: null },
    );
    expect(resolved.unit).toBe("박스");
    expect(resolved.unitQuantity).toBeNull();
    expect(resolved.coreDealName).toBe("부모딜");

    const query = buildSearchQuery({
      searchKeyword: resolved.searchKeyword,
      brandName: resolved.brandName,
      dealName: resolved.coreDealName,
      unitQuantity: resolved.unitQuantity,
      unit: resolved.unit,
      childDealName: resolved.childDealName,
      parentDealName: resolved.parentDealName,
    });
    expect(query).toBe("브랜드 부모딜 1통");
    expect(query.match(/1통/g)?.length).toBe(1);
    expect(query).not.toContain("박스");
  });

  it("[P3-2] 자식 딜의 modelName이 없으면 부모 supplementaryInfo에서 파싱한다", () => {
    const parentWithModel: MonitorDealFields = {
      ...parent,
      supplementaryInfo: JSON.stringify({ searchKeyword: "브랜드 부모딜", modelName: "PB-10000X" }),
    };
    const resolved = resolveMonitorFields(child, parentWithModel);
    expect(resolved.modelName).toBe("PB-10000X");
  });

  it("[P3-2] 자식 딜 자신에 modelName이 있으면 부모보다 우선한다(자식 ?? 부모)", () => {
    const childWithModel: MonitorDealFields = {
      ...child,
      supplementaryInfo: JSON.stringify({ searchKeyword: "자식 키워드", modelName: "AX58-CHILD" }),
    };
    const parentWithModel: MonitorDealFields = {
      ...parent,
      supplementaryInfo: JSON.stringify({ searchKeyword: "브랜드 부모딜", modelName: "PB-10000X" }),
    };
    const resolved = resolveMonitorFields(childWithModel, parentWithModel);
    expect(resolved.modelName).toBe("AX58-CHILD");
  });

  it("[P3-2] 양쪽 다 modelName이 없으면 null이다 (기존 데이터 불변식)", () => {
    const resolved = resolveMonitorFields(child, parent);
    expect(resolved.modelName).toBeNull();
  });
});

describe("buildMonitorWindowWhere (수집 시간창 — 판매기간 ±N일)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date("2026-07-13T00:00:00.000Z");

  it("기본 window는 7일이다", () => {
    expect(MONITOR_WINDOW_DAYS).toBe(7);
  });

  it("monitorEnabled 딜 + DROPPED 제외를 항상 건다", () => {
    const where = buildMonitorWindowWhere(now);
    expect(where.deal).toEqual({ monitorEnabled: true });
    expect(where.campaign.status).toEqual({ not: "DROPPED" });
  });

  it("startDate ≤ now+N일 (판매 시작 N일 전부터 켜짐)", () => {
    const where = buildMonitorWindowWhere(now);
    expect(where.campaign.startDate).toEqual({
      lte: new Date(now.getTime() + 7 * DAY),
    });
  });

  it("endDate ≥ now−N일 (판매 종료 N일 후에 꺼짐)", () => {
    const where = buildMonitorWindowWhere(now);
    expect(where.campaign.endDate).toEqual({
      gte: new Date(now.getTime() - 7 * DAY),
    });
  });

  it("windowDays 인자로 창 폭을 바꿀 수 있다", () => {
    const where = buildMonitorWindowWhere(now, 3);
    expect(where.campaign.startDate).toEqual({ lte: new Date(now.getTime() + 3 * DAY) });
    expect(where.campaign.endDate).toEqual({ gte: new Date(now.getTime() - 3 * DAY) });
  });
});
