import { describe, expect, it } from "vitest";
import { brandEmailsFor, toOrderBrandOptions } from "../order-brand-option";

const OPTIONS = toOrderBrandOptions([
  { slug: "sample-a", displayName: "샘플거래처A", toEmail: "a@example.com", ccEmail: "a-cc@example.com" },
  { slug: "sample-b", displayName: "샘플거래처B", toEmail: "b@example.com", ccEmail: null },
  { slug: "sample-c", displayName: "샘플거래처C" },
]);

describe("toOrderBrandOptions", () => {
  it("메일 칸을 버리지 않고 옮긴다(수정 창이 버려서 상속이 안 되던 자리)", () => {
    expect(OPTIONS[0]).toEqual({ slug: "sample-a", displayName: "샘플거래처A", toEmail: "a@example.com", ccEmail: "a-cc@example.com" });
    expect(OPTIONS[2]).toMatchObject({ toEmail: null, ccEmail: null });
  });

  it("배열이 아니거나 slug 없는 항목은 건너뛴다", () => {
    expect(toOrderBrandOptions(undefined)).toEqual([]);
    expect(toOrderBrandOptions([{ displayName: "이름만" }, null])).toEqual([]);
  });
});

describe("brandEmailsFor", () => {
  it("양식을 고르면 그 거래처의 수신·참조 메일을 돌려준다", () => {
    expect(brandEmailsFor(OPTIONS, "sample-a")).toEqual({ toEmail: "a@example.com", ccEmail: "a-cc@example.com" });
  });

  it("거래처에 없는 칸은 돌려주지 않는다(지금 입력값 유지)", () => {
    expect(brandEmailsFor(OPTIONS, "sample-b")).toEqual({ toEmail: "b@example.com" });
    expect(brandEmailsFor(OPTIONS, "sample-c")).toEqual({});
    expect(brandEmailsFor(OPTIONS, "")).toEqual({});
  });
});
