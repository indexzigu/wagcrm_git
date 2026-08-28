import { describe, it, expect } from "vitest";
import { summarizeSourceFailures } from "../source-errors";

describe("summarizeSourceFailures — 최저가 소스 결손 고지", () => {
  it("아직 아무 딜도 조회하지 않았으면 null(빈 배너 방지)", () => {
    expect(summarizeSourceFailures([undefined, undefined])).toBeNull();
    expect(summarizeSourceFailures([])).toBeNull();
  });

  it("3소스 전부 정상이면 null — 정상 상태에 경고가 상주하지 않는다", () => {
    expect(summarizeSourceFailures([{ naver: null, coupang: null, kakao: null }])).toBeNull();
  });

  it("⚠️ 계약: 쿠팡 미도입 파킹(error: null)은 실패가 아니다", () => {
    // market-fetch.ts 가 키 미설정 시 의도적으로 error:null 로 침묵시키는 계약.
    // 이게 경고로 새면 "의도적 미설정"이 매번 장애처럼 보인다.
    expect(summarizeSourceFailures([{ naver: null, coupang: null, kakao: null }])).toBeNull();
  });

  it("쿠팡만 실패하면 빠진 소스와 '무엇만 보고 계산했는지'를 함께 돌려준다", () => {
    const summary = summarizeSourceFailures([
      { naver: null, coupang: "Coupang status 401", kakao: null },
    ]);

    expect(summary).not.toBeNull();
    expect(summary!.failed).toEqual([
      { channel: "coupang", label: "쿠팡", reason: "Coupang status 401" },
    ]);
    expect(summary!.includedLabels).toEqual(["네이버", "카카오 선물하기"]);
  });

  it("여러 딜에 같은 실패가 반복돼도 채널당 1건으로 접는다", () => {
    // 딜 17개를 조회하면 같은 401 이 17번 온다 — 그대로 나열하면 배너가 화면을 덮는다.
    const summary = summarizeSourceFailures(
      Array.from({ length: 17 }, () => ({ naver: null, coupang: "Coupang status 401", kakao: null })),
    );

    expect(summary!.failed).toHaveLength(1);
    expect(summary!.failed[0].reason).toBe("Coupang status 401");
  });

  it("딜마다 다른 소스가 실패하면 합집합으로 모은다", () => {
    const summary = summarizeSourceFailures([
      { naver: null, coupang: "Coupang status 401", kakao: null },
      { naver: "NAVER_SEARCH_CLIENT_ID/SECRET 미설정", coupang: null, kakao: null },
    ]);

    expect(summary!.failed.map((f) => f.channel)).toEqual(["naver", "coupang"]);
    expect(summary!.includedLabels).toEqual(["카카오 선물하기"]);
  });

  it("전 소스 실패면 includedLabels 가 비어 '근거 없음'을 말할 수 있다", () => {
    const summary = summarizeSourceFailures([
      { naver: "요청 실패 (HTTP 500)", coupang: "요청 실패 (HTTP 500)", kakao: "요청 실패 (HTTP 500)" },
    ]);

    expect(summary!.failed).toHaveLength(3);
    expect(summary!.includedLabels).toEqual([]);
  });

  it("빈 문자열·공백 사유는 실패로 치지 않는다", () => {
    expect(summarizeSourceFailures([{ naver: "", coupang: "   ", kakao: null }])).toBeNull();
  });
});
