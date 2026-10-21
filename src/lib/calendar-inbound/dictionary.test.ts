import { describe, expect, it } from "vitest";
import { loadInboundDictionary, type InboundDictionaryDb } from "./dictionary";

function fakeDb(): InboundDictionaryDb {
  return {
    seller: {
      findMany: async () => [
        { id: "s1", name: "샘플셀러", alias: "샘플" },
        { id: "s2", name: "  ", alias: "샘플셀러2" },
        { id: "s3", name: "같은이름", alias: "같은이름" },
      ],
    },
    deal: {
      findMany: async () => [
        {
          id: "d1",
          brandName: "테스트브랜드 / 가짜브랜드,",
          dealName: "테스트 딜",
          partner: { name: "테스트거래처" },
        },
        { id: "d2", brandName: null, dealName: "비활성 딜", partner: null },
      ],
    },
  };
}

describe("loadInboundDictionary", () => {
  it("셀러 alias·name 을 공백 제외·중복 제거로 모은다", async () => {
    const d = await loadInboundDictionary(fakeDb());
    expect(d.sellers).toEqual([
      { id: "s1", names: ["샘플", "샘플셀러"] },
      { id: "s2", names: ["샘플셀러2"] },
      { id: "s3", names: ["같은이름"] },
    ]);
  });

  it("브랜드를 / , 로 쪼개고 거래처명을 붙인다", async () => {
    const d = await loadInboundDictionary(fakeDb());
    expect(d.deals[0]).toEqual({
      id: "d1",
      brandNames: ["테스트브랜드", "가짜브랜드"],
      dealName: "테스트 딜",
      partnerName: "테스트거래처",
    });
    expect(d.deals[1]).toMatchObject({ brandNames: [], partnerName: null });
  });
});
