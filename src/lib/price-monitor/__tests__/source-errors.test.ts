import { describe, it, expect } from "vitest";
import { summarizeSourceFailures, type MarketSourceStates } from "../source-errors";

const healthySources: MarketSourceStates = {
  naver: { status: "ok", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 3 },
  coupang: { status: "empty", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
  kakao: { status: "ok", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 2 },
};

describe("summarizeSourceFailures — 최저가 소스 결손 고지", () => {
  it("아직 아무 딜도 조회하지 않았으면 null(빈 배너 방지)", () => {
    expect(summarizeSourceFailures([undefined, undefined])).toBeNull();
    expect(summarizeSourceFailures([])).toBeNull();
  });

  it("3소스 전부 정상 또는 결과 없음이면 null — 정상 상태에 경고가 상주하지 않는다", () => {
    expect(summarizeSourceFailures([{ errors: { naver: null, coupang: null, kakao: null }, sources: healthySources }])).toBeNull();
  });

  it("⚠️ 계약: legacy 결과는 포함 소스를 추정하지 않고 unknown으로 둔다", () => {
    const summary = summarizeSourceFailures([{ naver: null, coupang: null, kakao: null }]);

    expect(summary).toMatchObject({ unknown: true, failed: [], includedLabels: [] });
  });

  it("쿠팡만 실패하면 빠진 소스와 '무엇만 보고 계산했는지'를 함께 돌려준다", () => {
    const summary = summarizeSourceFailures([
      {
        errors: { naver: null, coupang: "Coupang status 401", kakao: null },
        sources: {
          ...healthySources,
          coupang: { status: "error", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
        },
      },
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
      Array.from({ length: 17 }, () => ({
        errors: { naver: null, coupang: "Coupang status 401", kakao: null },
        sources: {
          ...healthySources,
          coupang: { status: "error", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
        },
      })),
    );

    expect(summary!.failed).toHaveLength(1);
    expect(summary!.failed[0].reason).toBe("Coupang status 401");
  });

  it("딜마다 다른 소스가 실패하면 합집합으로 모은다", () => {
    const summary = summarizeSourceFailures([
      {
        errors: { naver: null, coupang: "Coupang status 401", kakao: null },
        sources: {
          ...healthySources,
          coupang: { status: "error", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
        },
      },
      {
        errors: { naver: "NAVER_SEARCH_CLIENT_ID/SECRET 미설정", coupang: null, kakao: null },
        sources: {
          ...healthySources,
          naver: { status: "error", checkedAt: "2026-11-13T04:01:00.000Z", itemCount: 0 },
        },
      },
    ]);

    expect(summary!.failed.map((f) => f.channel)).toEqual(["naver", "coupang"]);
    expect(summary!.includedLabels).toEqual(["카카오 선물하기"]);
  });

  it("전 소스 실패면 includedLabels 가 비어 '근거 없음'을 말할 수 있다", () => {
    const summary = summarizeSourceFailures([
      {
        errors: { naver: "요청 실패 (HTTP 500)", coupang: "요청 실패 (HTTP 500)", kakao: "요청 실패 (HTTP 500)" },
        sources: {
          naver: { status: "error", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
          coupang: { status: "error", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
          kakao: { status: "error", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
        },
      },
    ]);

    expect(summary!.failed).toHaveLength(3);
    expect(summary!.includedLabels).toEqual([]);
  });

  it("빈 문자열·공백 사유는 실패로 치지 않는다", () => {
    expect(summarizeSourceFailures([{ errors: { naver: "", coupang: "   ", kakao: null }, sources: healthySources }])).toBeNull();
  });

  it("disabled 소스는 포함 소스로 표시하지 않고 상태를 보존한다", () => {
    const summary = summarizeSourceFailures([
      {
        errors: { naver: null, coupang: null, kakao: null },
        sources: {
          ...healthySources,
          coupang: { status: "disabled", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
        },
      },
    ]);

    expect(summary).toMatchObject({ includedLabels: ["네이버", "카카오 선물하기"] });
    expect(summary?.disabled).toEqual([{ channel: "coupang", label: "쿠팡" }]);
  });

  it("legacy와 새 상태가 섞이면 소스 상태 미확인을 유지하고 포함 소스를 추정하지 않는다", () => {
    const summary = summarizeSourceFailures([
      { errors: { naver: null, coupang: null, kakao: null } },
      { errors: { naver: null, coupang: null, kakao: null }, sources: healthySources },
    ]);

    expect(summary).toMatchObject({ unknown: true, includedLabels: [] });
  });

  it("한 대상에서 실패한 채널은 다른 대상의 성공 상태가 있어도 포함 소스가 되지 않는다", () => {
    const summary = summarizeSourceFailures([
      {
        errors: { naver: "네이버 조회 실패", coupang: null, kakao: null },
        sources: {
          ...healthySources,
          naver: { status: "error", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
        },
      },
      { errors: { naver: null, coupang: null, kakao: null }, sources: healthySources },
    ]);

    expect(summary?.failed.map((failure) => failure.channel)).toEqual(["naver"]);
    expect(summary?.includedLabels).toEqual(["쿠팡", "카카오 선물하기"]);
  });
});
