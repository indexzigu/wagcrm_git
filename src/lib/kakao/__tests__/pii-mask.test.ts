import { describe, expect, it } from "vitest";
import { maskPii } from "../pii-mask";

// 합성 데이터만 사용 — 실 archive 원문은 절대 사용하지 않는다.

describe("maskPii — 결정적 정규식 마스킹", () => {
  it("휴대전화번호(하이픈 포함)를 마스킹한다", () => {
    const result = maskPii("연락처는 010-1234-5678 입니다.");
    expect(result.masked).toBe(true);
    expect(result.text).toBe("연락처는 [PHONE_MASKED] 입니다.");
  });

  it("휴대전화번호(하이픈 없음)를 마스킹한다", () => {
    const result = maskPii("01012345678로 연락주세요");
    expect(result.masked).toBe(true);
    expect(result.text).toContain("[PHONE_MASKED]");
  });

  it("지역번호 유선전화를 마스킹한다", () => {
    const result = maskPii("사무실 번호는 02-1234-5678 입니다.");
    expect(result.masked).toBe(true);
    expect(result.text).toContain("[PHONE_MASKED]");
  });

  it("계좌번호(하이픈 3분할)를 마스킹한다", () => {
    const result = maskPii("입금 계좌: 123-456-789012 국민은행");
    expect(result.masked).toBe(true);
    expect(result.text).toContain("[ACCOUNT_MASKED]");
    expect(result.text).toContain("국민은행");
  });

  it("주민등록번호를 마스킹한다", () => {
    const result = maskPii("주민번호 900101-1234567 확인 부탁드려요.");
    expect(result.masked).toBe(true);
    expect(result.text).toBe("주민번호 [RRN_MASKED] 확인 부탁드려요.");
  });

  it("이메일을 마스킹한다", () => {
    const result = maskPii("메일은 test.user@example.co.kr 로 보내주세요.");
    expect(result.masked).toBe(true);
    expect(result.text).toBe("메일은 [EMAIL_MASKED] 로 보내주세요.");
  });

  it("여러 PII가 섞여 있으면 전부 마스킹하고 업무 맥락 텍스트는 보존한다", () => {
    const result = maskPii(
      "김철수 010-1111-2222 test@abc.com 정산 계좌 123-45-6789012로 입금 부탁드립니다."
    );
    expect(result.masked).toBe(true);
    expect(result.text).toContain("김철수");
    expect(result.text).toContain("정산");
    expect(result.text).toContain("입금 부탁드립니다");
    expect(result.text).not.toMatch(/\d{3}-\d{4}-\d{4}/);
    expect(result.text).not.toMatch(/@/);
  });

  it("PII가 없으면 masked=false이고 원문을 그대로 반환한다", () => {
    const result = maskPii("내일 회의 3시에 진행하겠습니다.");
    expect(result.masked).toBe(false);
    expect(result.text).toBe("내일 회의 3시에 진행하겠습니다.");
  });

  it("빈 문자열은 안전하게 처리한다", () => {
    const result = maskPii("");
    expect(result.masked).toBe(false);
    expect(result.text).toBe("");
  });

  it("동일 입력에 대해 항상 동일한 결과를 반환한다(결정성)", () => {
    const input = "연락처 010-9999-8888, 메일 a@b.com";
    const r1 = maskPii(input);
    const r2 = maskPii(input);
    expect(r1).toEqual(r2);
  });
});

describe("maskPii — 리뷰 유출 케이스 보강(M1)", () => {
  it("주민등록번호(하이픈 없음)를 마스킹한다", () => {
    const result = maskPii("주민번호 9001011234567 입니다.");
    expect(result.masked).toBe(true);
    expect(result.text).toContain("[RRN_MASKED]");
    expect(result.text).not.toContain("9001011234567");
  });

  it("계좌 키워드 근접 시 하이픈 없는 14자리 숫자열을 마스킹한다", () => {
    const result = maskPii("농협 계좌 11023456789012 로 입금 부탁드립니다.");
    expect(result.masked).toBe(true);
    expect(result.text).toContain("[ACCOUNT_MASKED]");
    expect(result.text).not.toContain("11023456789012");
  });

  it("국제형 휴대전화(공백 구분, +82 10 1234 5678)를 마스킹한다", () => {
    const result = maskPii("연락처는 +82 10 1234 5678 입니다.");
    expect(result.masked).toBe(true);
    expect(result.text).toContain("[PHONE_MASKED]");
    expect(result.text).not.toMatch(/\d{2,4}\s\d{4}/);
  });

  it("국제형 휴대전화(구분자 없음, +821012345678)를 마스킹한다", () => {
    const result = maskPii("연락처는 +821012345678 입니다.");
    expect(result.masked).toBe(true);
    expect(result.text).toContain("[PHONE_MASKED]");
    expect(result.text).not.toContain("+821012345678");
  });

  it("국제형 휴대전화(하이픈 구분, +82-10-1234-5678)를 마스킹한다", () => {
    const result = maskPii("연락처는 +82-10-1234-5678 입니다.");
    expect(result.masked).toBe(true);
    expect(result.text).toContain("[PHONE_MASKED]");
    expect(result.text).not.toContain("+82-10-1234-5678");
  });

  it("오탐 가드: 키워드 없는 일반 14자리 숫자는 마스킹하지 않는다", () => {
    const result = maskPii("주문번호 11023456789012 확인해주세요.");
    expect(result.masked).toBe(false);
    expect(result.text).toBe("주문번호 11023456789012 확인해주세요.");
  });

  it("오탐 가드: 날짜/시각 표현은 마스킹하지 않는다", () => {
    const result = maskPii("2026년 07월 04일 오후 3시에 뵙겠습니다.");
    expect(result.masked).toBe(false);
    expect(result.text).toBe("2026년 07월 04일 오후 3시에 뵙겠습니다.");
  });
});
