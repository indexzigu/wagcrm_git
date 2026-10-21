import { describe, expect, it } from "vitest";
import { sellerDisplayName } from "../seller-display-name";

describe("sellerDisplayName", () => {
  it("별칭이 있으면 별칭, 없거나 공백이면 이름", () => {
    expect(sellerDisplayName({ name: "샘플셀러", alias: "샘플" })).toBe("샘플");
    expect(sellerDisplayName({ name: "샘플셀러", alias: null })).toBe("샘플셀러");
    expect(sellerDisplayName({ name: "샘플셀러", alias: "   " })).toBe("샘플셀러");
    expect(sellerDisplayName({ name: "샘플셀러", alias: "" })).toBe("샘플셀러");
  });
});
