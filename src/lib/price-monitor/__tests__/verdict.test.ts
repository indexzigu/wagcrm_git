import { describe, it, expect } from "vitest";
import { computeVerdict, TIE_BAND } from "../verdict";

describe("computeVerdict", () => {
  it("우리 가격 정보가 없으면 NO_DATA", () => {
    expect(computeVerdict({ ourPrice: null, minValidPrice: 10000 })).toBe("NO_DATA");
    expect(computeVerdict({ ourPrice: 0, minValidPrice: 10000 })).toBe("NO_DATA");
  });

  it("시장 유효 최저가가 없으면 NO_DATA", () => {
    expect(computeVerdict({ ourPrice: 10000, minValidPrice: null })).toBe("NO_DATA");
  });

  it(`±${TIE_BAND * 100}% 이내면 TIE`, () => {
    expect(computeVerdict({ ourPrice: 10000, minValidPrice: 10050 })).toBe("TIE"); // 0.5% 차이
    expect(computeVerdict({ ourPrice: 10100, minValidPrice: 10000 })).toBe("TIE"); // 1% 차이
  });

  it("우리가 시장보다 싸거나 같으면(TIE 밖) OK", () => {
    expect(computeVerdict({ ourPrice: 9000, minValidPrice: 10000 })).toBe("OK");
  });

  it("시장에 확실히 더 싼 유효 후보가 있으면 VIOLATED", () => {
    expect(computeVerdict({ ourPrice: 12000, minValidPrice: 10000 })).toBe("VIOLATED");
  });
});
