import { describe, expect, it } from "vitest";
import { brandPrefix, cleanCompanyName, suggestBrandAliases, type AliasSuggestionCandidate } from "../alias-suggestions";

const missing = (productName: string, matchScore = 65, mall = "몰"): AliasSuggestionCandidate => ({
  productName,
  mall,
  matchScore,
  excludeReason: "BRAND_MISMATCH",
});

describe("cleanCompanyName", () => {
  it("법인 표기를 걷어낸다", () => {
    expect(cleanCompanyName("(주)가나제약")).toBe("가나제약");
    expect(cleanCompanyName("주식회사 가나제약")).toBe("가나제약");
    expect(cleanCompanyName("㈜가")).toBeNull();
    expect(cleanCompanyName("재단법인 가나재단")).toBe("가나재단");
    expect(cleanCompanyName(null)).toBeNull();
  });
});

describe("brandPrefix", () => {
  it("여러 낱말 브랜드면 첫 낱말, 한 낱말이면 null", () => {
    expect(brandPrefix("하루랩 더블유")).toBe("하루랩");
    expect(brandPrefix("하루랩")).toBeNull();
    expect(brandPrefix("A 라인")).toBeNull();
  });
});

describe("suggestBrandAliases", () => {
  it("회사 이름만 적힌 같은 상품 후보가 있으면 회사 이름을 근거와 함께 제안한다", () => {
    const out = suggestBrandAliases({
      brandName: "하루랩",
      companyName: "(주)가나제약",
      aliases: [],
      candidates: [
        missing("[가나제약] 올리브 토마토샷 1박스", 45, "가나제약"),
        missing("다른회사 올리브 토마토샷", 85, "다른몰"),
      ],
    });
    expect(out).toEqual([
      { name: "가나제약", source: "COMPANY", evidence: ["[가나제약] 올리브 토마토샷 1박스"], evidenceCount: 1 },
    ]);
  });

  it("브랜드 이름이 쇼핑몰 표기보다 길면 첫 낱말을 제안한다", () => {
    const out = suggestBrandAliases({
      brandName: "하루랩 더블유",
      companyName: null,
      aliases: [],
      candidates: [missing("하루랩 데일리 밸런스 유산균 2통"), missing("하루랩 슬림 밸런스 유산균 2통")],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "하루랩", source: "BRAND_PREFIX", evidenceCount: 2 });
  });

  it("상품명 점수가 목록 하한(40) 미만인 후보는 근거로 쓰지 않는다", () => {
    const out = suggestBrandAliases({
      brandName: "하루랩",
      companyName: "가나제약",
      aliases: [],
      candidates: [missing("[가나제약] 전혀 다른 상품", 12)],
    });
    expect(out).toEqual([]);
  });

  it("「브랜드 없음」 때문에만 빠진 후보만 근거로 쓴다(유효·오너 「다른 상품」·제외 키워드 후보는 아니다)", () => {
    const out = suggestBrandAliases({
      brandName: "하루랩",
      companyName: "가나제약",
      aliases: [],
      candidates: [
        { productName: "가나제약 하루랩 토마토샷", matchScore: 80, excludeReason: null },
        { productName: "[가나제약] 다른 토마토샷", matchScore: 80, excludeReason: "OWNER_DIFFERENT" },
        { productName: "[가나제약] 토마토샷 중고", matchScore: 80, excludeReason: "EXCLUDE_KEYWORD" },
      ],
    });
    expect(out).toEqual([]);
  });

  it("이미 등록된 이름은 띄어쓰기가 달라도 다시 제안하지 않는다", () => {
    const out = suggestBrandAliases({
      brandName: "하루랩",
      companyName: "가나 제약",
      aliases: ["가나제약"],
      candidates: [missing("[가나제약] 토마토샷")],
    });
    expect(out).toEqual([]);
  });

  it("플랫폼 이름인 거래처는 제안하지 않는다(상품명의 「카카오전용특가」 같은 문구에 걸린다)", () => {
    const out = suggestBrandAliases({
      brandName: "하루랩",
      companyName: "카카오",
      aliases: [],
      candidates: [missing("카카오전용특가 다른회사 토마토샷")],
    });
    expect(out).toEqual([]);
  });

  it("플랫폼 이름으로 시작하는 거래처도 제안하지 않는다", () => {
    const out = suggestBrandAliases({
      brandName: "하루랩",
      companyName: "네이버파이낸셜",
      aliases: [],
      candidates: [missing("네이버파이낸셜 단독 토마토샷")],
    });
    expect(out).toEqual([]);
  });

  it("저장 API 상한을 넘는 제안은 내지 않는다(이름 40자 초과·이미 20개)", () => {
    const longName = "가".repeat(41);
    expect(
      suggestBrandAliases({ brandName: "하루랩", companyName: longName, aliases: [], candidates: [missing(`${longName} 토마토샷`)] }),
    ).toEqual([]);
    const full = Array.from({ length: 20 }, (_, i) => `이름${i}`);
    expect(
      suggestBrandAliases({ brandName: "하루랩", companyName: "가나제약", aliases: full, candidates: [missing("[가나제약] 토마토샷")] }),
    ).toEqual([]);
  });

  it("근거 상품명은 서로 다른 것만 최대 3개, 건수는 전체를 센다", () => {
    const out = suggestBrandAliases({
      brandName: "하루랩",
      companyName: "가나제약",
      aliases: [],
      candidates: ["A", "A", "B", "C", "D"].map((s) => missing(`[가나제약] 토마토샷 ${s}`)),
    });
    expect(out[0].evidence).toEqual(["[가나제약] 토마토샷 A", "[가나제약] 토마토샷 B", "[가나제약] 토마토샷 C"]);
    expect(out[0].evidenceCount).toBe(5);
  });

  it("판매처 이름에만 회사 이름이 있어도 근거가 된다", () => {
    const out = suggestBrandAliases({
      brandName: "하루랩",
      companyName: "가나제약",
      aliases: [],
      candidates: [missing("올리브 토마토샷 1박스", 50, "가나제약 공식몰")],
    });
    expect(out.map((s) => s.name)).toEqual(["가나제약"]);
  });
});
