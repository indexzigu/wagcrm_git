import { describe, expect, it } from "vitest";
import { buildPurchaseOrderMailDefaults, kstYymmdd } from "../purchase-order-mail-defaults";

/**
 * 데스크톱 `openEmailModal` 에 인라인으로 있던 문구를 옮긴 것이라 **문자열이 종전과 같아야** 한다.
 * 날짜는 KST 기준 — UTC 16:00 는 KST 다음날 01:00 이라 날짜가 하루 넘어간다(경계 고정).
 */
describe("buildPurchaseOrderMailDefaults", () => {
  const now = new Date("2026-07-08T16:00:00Z"); // KST 2026-07-09 01:00

  it("KST yyMMdd 를 쓴다(UTC 날짜와 다를 때 KST 가 이긴다)", () => {
    expect(kstYymmdd(now)).toBe("260709");
  });

  it("제목·본문이 종전 데스크톱 문구와 글자 단위로 같다", () => {
    const d = buildPurchaseOrderMailDefaults("하늘맘", now);
    expect(d.subject).toBe("[와이그라운드] 하늘맘 260709 발주서 보내드립니다.");
    expect(d.message).toBe(`안녕하세요,
금일 하늘맘 발주서를 첨부하여 전달드립니다.
확인후 회신 부탁드립니다.
감사합니다.`);
  });

  it("셀러명은 손대지 않는다(빈 문자열도 그대로 — 종전 동작 보존)", () => {
    expect(buildPurchaseOrderMailDefaults("", now).subject).toBe("[와이그라운드]  260709 발주서 보내드립니다.");
  });
});
