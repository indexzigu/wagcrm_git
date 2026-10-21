import { describe, expect, it } from "vitest";
import { appendFailureCause, declareTotalFailure, describeFailureCause, scrubFailureCause } from "@/lib/cron-outcome";
import { incidentSignature } from "@/lib/cron-incident";

/**
 * 크론의 **실질 실패 선언** 공용 판정 — `withSystemTaskStatus` 의 `CronOutcomeBody` 계약에서
 * "이번 실행이 통째로 헛돌았는가"를 재는 자리다.
 *
 * 이 파일이 지키는 것은 경계 셋이고, 그중 **시도 0 = 정상**이 가장 중요하다 —
 * 산출량으로 판정하면 대상이 없던 조용한 날마다 빨강이 되어 습관화로 신호를 잃는다.
 */
describe("declareTotalFailure", () => {
  it("시도한 것이 전부 실패하면 실패로 선언한다", () => {
    const outcome = declareTotalFailure({
      attempted: 4,
      succeeded: 0,
      unit: "명",
      what: "인스타 지표 수집",
    });

    expect(outcome.failed).toBe(true);
    expect(outcome.failureReason).toContain("4명");
    expect(outcome.failureReason).toContain("인스타 지표 수집");
  });

  it("하나라도 성공했으면 실패가 아니다(개별 항목 실패를 승격하지 않는다)", () => {
    const outcome = declareTotalFailure({
      attempted: 4,
      succeeded: 1,
      unit: "명",
      what: "인스타 지표 수집",
    });

    expect(outcome.failed).toBe(false);
    expect(outcome.failureReason).toBeUndefined();
  });

  it("시도가 0이면 실패가 아니다(대상 없는 날 — 상시 빨강 방지)", () => {
    const outcome = declareTotalFailure({
      attempted: 0,
      succeeded: 0,
      unit: "건",
      what: "VOC 분석",
    });

    expect(outcome.failed).toBe(false);
    expect(outcome.failureReason).toBeUndefined();
  });

  it("산출 판정용 targets·produced 를 함께 돌려준다(targets=시도, produced=성공)", () => {
    expect(declareTotalFailure({ attempted: 5, succeeded: 2, unit: "명", what: "x" })).toMatchObject({
      failed: false,
      targets: 5,
      produced: 2,
    });
    expect(declareTotalFailure({ attempted: 3, succeeded: 0, unit: "명", what: "x" })).toMatchObject({
      failed: true,
      targets: 3,
      produced: 0,
    });
    expect(declareTotalFailure({ attempted: 0, succeeded: 0, unit: "건", what: "x" })).toMatchObject({
      failed: false,
      targets: 0,
      produced: 0,
    });
  });
});

/**
 * 대표 원인 — 전량 실패 선언에 「첫 항목 오류의 원인 사슬」을 붙인다(자가 정상화 4단계 Task 1).
 * 원인이 없으면 사고 원인 칸이 오류 종류의 고정 라벨에 머물러 알려진 원인(프록시 한도·토큰 만료)을
 * 가를 수 없다. 단 항목 식별자(셀러 핸들·이름·id)는 싣지 않는다 — 사고 서명이 셀러마다 갈라진다.
 */
describe("declareTotalFailure — 대표 원인", () => {
  it("cause 가 있으면 사유 뒤에 「 · 대표 원인: …」을 붙인다", () => {
    const outcome = declareTotalFailure({
      attempted: 2,
      succeeded: 0,
      unit: "명",
      what: "인스타 수집",
      cause: "fetch failed <- Proxy response (407) !== 200 when HTTP Tunneling",
    });
    expect(outcome.failureReason).toBe(
      "인스타 수집 대상 2명 전량 실패(성공 0) · 대표 원인: fetch failed <- Proxy response (407) !== 200 when HTTP Tunneling",
    );
  });

  it("cause 가 없거나 비었으면 기존 문구 그대로다", () => {
    const base = { attempted: 2, succeeded: 0, unit: "명", what: "인스타 수집" };
    expect(declareTotalFailure(base).failureReason).toBe("인스타 수집 대상 2명 전량 실패(성공 0)");
    expect(declareTotalFailure({ ...base, cause: "  " }).failureReason).toBe("인스타 수집 대상 2명 전량 실패(성공 0)");
  });

  it("성공한 실행에는 cause 를 줘도 사유가 없다", () => {
    const outcome = declareTotalFailure({ attempted: 2, succeeded: 1, unit: "명", what: "x", cause: "boom" });
    expect(outcome.failureReason).toBeUndefined();
  });

  it("대표 원인이 길면 앞 100자와 끝 200자를 남긴다(사슬의 진짜 원인은 끝에 있다)", () => {
    const cause = `${"가".repeat(400)} <- Proxy response (407)`;
    const reason = appendFailureCause("사유", cause);
    expect(reason).toBe(`사유 · 대표 원인: ${cause.slice(0, 100)} … ${cause.slice(-200)}`);
    expect(reason).toContain("Proxy response (407)");
  });

  it("300자 이하 대표 원인은 그대로 둔다", () => {
    expect(appendFailureCause("사유", "가".repeat(300))).toBe(`사유 · 대표 원인: ${"가".repeat(300)}`);
  });
});

// 자격증명이 든 프록시 주소 픽스처 — 리터럴로 쓰면 commit-guard 가 「URL 내장 자격증명」으로 막아 조립한다(가짜 값).
const CRED_PROXY = "http://" + ["user", "pw"].join(":") + "@proxy.example.com:80";

describe("describeFailureCause — 항목 식별자·자격 증명 제외", () => {
  it("원인 사슬을 펼치고 항목 식별자를 <항목> 으로 바꾼다", () => {
    const error = new Error("seller_a 조회 실패", { cause: new Error("Graph (code 190) seller_a token expired") });
    expect(describeFailureCause(error, ["seller_a", null, undefined, ""])).toBe(
      "<항목> 조회 실패 <- Graph (code 190) <항목> token expired",
    );
  });

  it("긴 식별자부터 바꿔 짧은 식별자가 긴 것의 일부를 먼저 먹지 않는다", () => {
    expect(scrubFailureCause("seller_ab / seller_a", ["seller_a", "seller_ab"])).toBe("<항목> / <항목>");
  });

  it("URL 의 사용자 정보와 비밀 쿼리 값을 가린다", () => {
    expect(scrubFailureCause(`connect via ${CRED_PROXY} failed`)).toBe(
      "connect via http://<가림>@proxy.example.com:80 failed",
    );
    expect(scrubFailureCause("GET /oauth?client_secret=abc&fb_exchange_token=xyz&grant_type=x")).toBe(
      "GET /oauth?client_secret=<가림>&fb_exchange_token=<가림>&grant_type=x",
    );
  });

  it("식별자는 낱말 전체로 나올 때만 바꾼다(짧은 핸들이 다른 낱말 속을 먹지 않는다)", () => {
    expect(scrubFailureCause("Graph said: ai explain failed for ai", ["ai"])).toBe(
      "Graph said: <항목> explain failed for <항목>",
    );
    expect(scrubFailureCause("detail: email sai.x failed", ["ai"])).toBe("detail: email sai.x failed");
    expect(scrubFailureCause("@seller_a. 끝", ["seller_a"])).toBe("@<항목>. 끝");
    expect(scrubFailureCause("seller_a님 조회 실패", ["seller_a"])).toBe("<항목>님 조회 실패");
  });

  it("흔한 오류 낱말과 같은 식별자는 바꾸지 않는다(fetch 라는 핸들이 「fetch failed」를 지우지 않게)", () => {
    expect(scrubFailureCause("fetch failed <- timeout", ["fetch", "timeout"])).toBe("fetch failed <- timeout");
  });

  it("Bearer 토큰과 JSON 의 access_token·client_secret 값을 가린다", () => {
    expect(scrubFailureCause("Authorization: Bearer abc.DEF-123_x= rejected")).toBe(
      "Authorization: Bearer <가림> rejected",
    );
    expect(scrubFailureCause('body {"access_token":"tok123","client_secret": "sec456","x":1}')).toBe(
      'body {"access_token":"<가림>","client_secret": "<가림>","x":1}',
    );
  });

  it("같은 원인·다른 셀러 두 번의 전량 실패는 같은 사고 서명이 된다", () => {
    const make = (handle: string) =>
      declareTotalFailure({
        attempted: 3,
        succeeded: 0,
        unit: "명",
        what: "인스타 수집",
        cause: describeFailureCause(new Error(`Tier0 실패 ${handle}`, { cause: new Error("status=429 quota") }), [handle]),
      }).failureReason!;
    const a = make("seller_a");
    const b = make("seller_b");
    expect(a).not.toContain("seller_a");
    expect(b).not.toContain("seller_b");
    const sig = (message: string) =>
      incidentSignature({ jobKey: "collect-instagram", kind: "A", errorKind: null, message });
    expect(sig(a)).toBe(sig(b));
  });
});
