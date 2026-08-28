// 월별 지출 집계 계약 — 오너가 이 수치로 "무료 크레딧 넘었나"를 판단하므로
// 월 경계(KST)·계정별 분해·결손 표면화가 틀리면 판단이 통째로 틀어진다.
import { describe, expect, it } from "vitest";
import {
  formatMonthlyReport,
  kstMonthKey,
  kstMonthStartUtc,
  parseUsageMetadata,
  summarizeCommentUsageByMonth,
  type CommentUsageLogRow,
} from "../apify-comment-usage-report";

function meta(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    targetPosts: 10,
    receivedComments: 150,
    postsWithComments: 9,
    filledPosts: 9,
    unattributedPosts: 0,
    durationMs: 10_000,
    estimatedCostUsd: 0.345,
    costPerThousandUsd: 2.3,
    tokenFingerprint: "aaa111",
    ...over,
  });
}

function row(over: Partial<CommentUsageLogRow> = {}): CommentUsageLogRow {
  return {
    calledAt: new Date("2026-07-10T03:00:00Z"),
    success: true,
    statusCode: 200,
    errorMessage: null,
    metadata: meta(),
    ...over,
  };
}

describe("kstMonthKey — 월 경계는 KST 달력", () => {
  it("UTC로는 앞 달이지만 KST로 새 달인 시각을 새 달로 넣는다", () => {
    // 2026-06-30T20:00Z = KST 2026-07-01 05:00
    expect(kstMonthKey(new Date("2026-06-30T20:00:00Z"))).toBe("2026-07");
  });

  it("KST 기준 월말 직전은 그대로 그 달", () => {
    // 2026-06-30T14:00Z = KST 2026-06-30 23:00
    expect(kstMonthKey(new Date("2026-06-30T14:00:00Z"))).toBe("2026-06");
  });

  it("월을 2자리로 채운다", () => {
    expect(kstMonthKey(new Date("2026-01-15T00:00:00Z"))).toBe("2026-01");
  });
});

describe("kstMonthStartUtc — 조회 창", () => {
  it("0개월 전이면 이번 달 1일 KST 00:00(=전날 15:00Z)", () => {
    expect(kstMonthStartUtc(new Date("2026-07-23T10:00:00Z"), 0).toISOString()).toBe(
      "2026-06-30T15:00:00.000Z",
    );
  });

  it("연을 넘어가도 정상 역산", () => {
    expect(kstMonthKey(kstMonthStartUtc(new Date("2026-01-10T00:00:00Z"), 2))).toBe("2025-11");
  });
});

describe("parseUsageMetadata", () => {
  it("정상 JSON을 숫자로 뽑는다", () => {
    expect(parseUsageMetadata(meta())).toMatchObject({ receivedComments: 150, estimatedCostUsd: 0.345 });
  });

  it("null·깨진 JSON·배열은 null(호출부가 malformed로 센다)", () => {
    expect(parseUsageMetadata(null)).toBeNull();
    expect(parseUsageMetadata("{not json")).toBeNull();
    expect(parseUsageMetadata("[1,2]")).toBeNull();
  });

  it("estimatedCostUsd가 없으면 수신 수로 유도한다(구 행 호환)", () => {
    const parsed = parseUsageMetadata(JSON.stringify({ receivedComments: 1000 }));
    expect(parsed?.estimatedCostUsd).toBeCloseTo(2.3, 4);
  });

  it("숫자가 아닌 필드는 0으로 떨어진다", () => {
    expect(parseUsageMetadata(JSON.stringify({ targetPosts: "열" }))?.targetPosts).toBe(0);
  });
});

describe("summarizeCommentUsageByMonth", () => {
  it("KST 월별로 접고 최신 월을 먼저 준다", () => {
    const out = summarizeCommentUsageByMonth([
      row({ calledAt: new Date("2026-06-10T03:00:00Z") }),
      row({ calledAt: new Date("2026-07-10T03:00:00Z") }),
      row({ calledAt: new Date("2026-06-30T20:00:00Z") }), // KST 7월
    ]);
    expect(out.map((s) => s.month)).toEqual(["2026-07", "2026-06"]);
    expect(out[0].calls).toBe(2);
    expect(out[1].calls).toBe(1);
  });

  it("합계·실패율·평균 소요를 낸다", () => {
    const out = summarizeCommentUsageByMonth([
      row(),
      row(),
      row({ success: false, statusCode: 402, errorMessage: "hard limit exceeded", metadata: meta({ receivedComments: 0, filledPosts: 0, postsWithComments: 0, estimatedCostUsd: 0, durationMs: 2_000 }) }),
    ]);
    const july = out[0];
    expect(july.calls).toBe(3);
    expect(july.failures).toBe(1);
    expect(july.failureRate).toBeCloseTo(0.3333, 3);
    expect(july.receivedComments).toBe(300);
    expect(july.estimatedCostUsd).toBeCloseTo(0.69, 4);
    expect(july.avgDurationMs).toBe(7333);
    expect(july.topErrors).toEqual([{ reason: "hard limit exceeded", count: 1 }]);
  });

  it("실패 사유가 비어 있으면 상태코드로 대체한다(사유 유실 방지)", () => {
    const out = summarizeCommentUsageByMonth([row({ success: false, statusCode: 502, errorMessage: null })]);
    expect(out[0].topErrors).toEqual([{ reason: "HTTP 502", count: 1 }]);
  });

  it("토큰(계정)별로 쪼개고 계정당 크레딧으로 초과를 판정한다", () => {
    const out = summarizeCommentUsageByMonth(
      [
        row({ metadata: meta({ tokenFingerprint: "aaa111", estimatedCostUsd: 4 }) }),
        row({ metadata: meta({ tokenFingerprint: "aaa111", estimatedCostUsd: 2 }) }),
        row({ metadata: meta({ tokenFingerprint: "bbb222", estimatedCostUsd: 1 }) }),
      ],
      5,
    );
    const [a, b] = out[0].byToken;
    expect(a).toMatchObject({ tokenFingerprint: "aaa111", calls: 2, estimatedCostUsd: 6, overFreeCredit: true });
    expect(b).toMatchObject({ tokenFingerprint: "bbb222", calls: 1, estimatedCostUsd: 1, overFreeCredit: false });
  });

  it("풀 합계가 여유로워도 한 계정이 넘으면 잡힌다(합계만 보면 놓치는 경우)", () => {
    const out = summarizeCommentUsageByMonth(
      [
        row({ metadata: meta({ tokenFingerprint: "aaa111", estimatedCostUsd: 5.5 }) }),
        row({ metadata: meta({ tokenFingerprint: "bbb222", estimatedCostUsd: 0.1 }) }),
      ],
      5,
    );
    expect(out[0].estimatedCostUsd).toBeCloseTo(5.6, 4); // 계정 2개면 크레딧 총 $10 = 합계로는 여유
    expect(out[0].byToken.filter((t) => t.overFreeCredit)).toHaveLength(1);
  });

  it("metadata가 깨진 행은 호출 수에는 세되 결손을 표면화한다(P0)", () => {
    const out = summarizeCommentUsageByMonth([row(), row({ metadata: "{broken" })]);
    expect(out[0].calls).toBe(2);
    expect(out[0].malformedRows).toBe(1);
    expect(out[0].receivedComments).toBe(150); // 깨진 행 몫은 못 센다
  });

  it("빈 입력은 빈 배열", () => {
    expect(summarizeCommentUsageByMonth([])).toEqual([]);
  });
});

describe("formatMonthlyReport — 오너가 실제로 읽는 출력", () => {
  const overspent = summarizeCommentUsageByMonth(
    [
      row({ metadata: meta({ tokenFingerprint: "aaa111", estimatedCostUsd: 5.5, receivedComments: 2391 }) }),
      row({ metadata: meta({ tokenFingerprint: "bbb222", estimatedCostUsd: 0.1, receivedComments: 43 }) }),
    ],
    5,
  )[0];

  it("초과 계정이 있으면 그 줄과 판정 줄 양쪽에 표시한다", () => {
    const out = formatMonthlyReport(overspent, new Map([["aaa111", 1], ["bbb222", 2]]), 5);
    expect(out).toContain("#1 aaa111");
    expect(out).toContain("🔴 무료 크레딧 초과");
    expect(out).toContain("➜ 판정: 🔴 무료 크레딧 초과 계정 1개");
    expect(out).toContain("$5.60"); // 합계는 참고값으로 같이 노출
  });

  it("합계를 단일 계정 크레딧이 아니라 '계정 수 × 크레딧' 예산과 나란히 보여준다", () => {
    // 합계 $5.60 은 $5 를 넘지만 계정이 2개라 예산은 $10 — 합계만 보면 오판하는 지점
    const out = formatMonthlyReport(overspent, new Map([["aaa111", 1], ["bbb222", 2]]), 5);
    expect(out).toContain("관측 계정 2개 × $5.00 = $10.00");
  });

  it("초과가 없으면 초록 판정", () => {
    const clean = summarizeCommentUsageByMonth([row({ metadata: meta({ estimatedCostUsd: 0.35 }) })], 5)[0];
    expect(formatMonthlyReport(clean, new Map([["aaa111", 1]]), 5)).toContain("➜ 판정: 🟢 계정별 초과 없음");
  });

  it("풀은 아는데 지문이 없으면 '교체된 토큰'으로 드러낸다", () => {
    expect(formatMonthlyReport(overspent, new Map(), 5)).toContain("현 풀에 없음: 교체된 토큰");
  });

  it("풀 자체를 모르면(.env 미로드) 교체 여부를 단정하지 않는다", () => {
    // null(풀 미상)과 빈 Map(풀은 아는데 매칭 없음)을 구분하지 않으면
    // env 를 안 읽고 돌린 실행에서 모든 계정이 '교체됨'으로 오표기된다.
    const out = formatMonthlyReport(overspent, null, 5);
    expect(out).not.toContain("교체된 토큰");
    expect(out).toContain("지문 aaa111");
  });

  it("실패 사유·결손 행을 출력에 싣는다", () => {
    const broken = summarizeCommentUsageByMonth([
      row({ success: false, statusCode: 402, errorMessage: "hard limit exceeded" }),
      row({ metadata: "{broken" }),
    ])[0];
    const out = formatMonthlyReport(broken);
    expect(out).toContain("1× hard limit exceeded");
    expect(out).toContain("metadata 파싱 실패 1행");
  });

  it("출력 어디에도 토큰 원문 형태가 없다(지문 6자만)", () => {
    const out = formatMonthlyReport(overspent, new Map([["aaa111", 1]]), 5);
    expect(out).not.toMatch(/apify_api_[A-Za-z0-9_]+/);
    expect(out).not.toContain("token=");
  });
});
