// 광고 반응(adResponseScore) 계약 — **개수가 아니라 수익성 글 반응 유지율**을 판정한다.
//
// 왜 계약으로 고정하나: 종전 구현은 `m.ads.adCount`(협찬 게시물 **개수**)를 셌고, 그 사실을
// 고정하는 테스트가 **하나도 없었다**(기존 reviewMapping.test 는 행 순서만 봤다). 그래서
// 항목이 묻는 것과 재는 것이 어긋난 채로 오래 굴러갔고, 합산이 눌려 운영자가 판정을 손으로
// 되돌리는 패턴까지 만들었다. 같은 드리프트가 재발하지 않도록 의미·경계·미입력 처리를
// 전부 여기서 고정한다.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFieldSuggestions,
  LEVELS,
  AD_RESPONSE_HOLD_RETENTION,
  AD_RESPONSE_KEEP_RETENTION,
  AD_RESPONSE_DROP_RETENTION,
  type ReviewCurrentFields,
} from "../reviewMapping";
import { computeSubScores, normalizeMetrics } from "../scores";
import { computeSellerMetrics } from "../metrics";
import { matchLevelIndex, scorePrefix } from "@/components/crm/step-metric-card";

const EMPTY_CURRENT: ReviewCurrentFields = {
  activityFrequency: null,
  adResponseScore: null,
  commentResponseScore: null,
  collaborationScore: null,
  category: null,
  fitLevel: null,
};

/** 광고반응 판정에 필요한 부분만 채운 metrics (나머지는 정규화 기본값) */
function metricsWith(monetized: { count: number; monetizedEr: number | null; dailyEr: number | null }) {
  return normalizeMetrics({
    monetized: {
      monetizedCount: monetized.count,
      monetizedEr: monetized.monetizedEr,
      dailyEr: monetized.dailyEr,
      monetizedRetention:
        monetized.monetizedEr !== null && monetized.dailyEr !== null && monetized.dailyEr > 0
          ? monetized.monetizedEr / monetized.dailyEr
          : null,
    },
    dataSufficiency: { postCount: 30 },
  });
}

function adRow(metrics: ReturnType<typeof normalizeMetrics> | undefined) {
  const rows = buildFieldSuggestions(EMPTY_CURRENT, metrics, {
    ...computeSubScores(metrics),
    composite: null,
  });
  const row = rows.find((r) => r.field === "adResponseScore");
  expect(row).toBeDefined();
  return row!;
}

/** 유지율을 주면 그 판정 레벨을 돌려준다 (일상 ER 을 1로 고정) */
function levelForRetention(retention: number) {
  return adRow(metricsWith({ count: 5, monetizedEr: retention, dailyEr: 1 })).suggested;
}

describe("광고 반응 — 컷은 유지율이다", () => {
  it("컷 상수는 1.0 / 0.7 / 0.4", () => {
    expect(AD_RESPONSE_HOLD_RETENTION).toBe(1.0);
    expect(AD_RESPONSE_KEEP_RETENTION).toBe(0.7);
    expect(AD_RESPONSE_DROP_RETENTION).toBe(0.4);
  });

  it.each([
    [1.62, "3.유지·상승"],
    [1.0, "3.유지·상승"],
    [0.99, "2.대체유지"],
    [0.7, "2.대체유지"],
    [0.69, "1.하락"],
    [0.4, "1.하락"],
    [0.39, "0.반응없음"],
    [0.02, "0.반응없음"],
  ])("유지율 %s → %s", (retention, expected) => {
    expect(levelForRetention(retention as number)).toBe(expected);
  });

  it("제안 사유에 유지율 퍼센트가 실린다 (운영자가 근거를 볼 수 있어야 한다)", () => {
    expect(adRow(metricsWith({ count: 7, monetizedEr: 0.8, dailyEr: 1 })).reason).toContain("80%");
  });
});

describe("광고 반응 — ⛔ 개수를 세지 않는다 (구 결함 재발 방지)", () => {
  it("수익성 글이 많아도 반응이 죽으면 낮은 점수", () => {
    expect(adRow(metricsWith({ count: 50, monetizedEr: 0.1, dailyEr: 1 })).suggested).toBe("0.반응없음");
  });

  it("수익성 글이 1건뿐이어도 반응이 유지되면 최고점", () => {
    expect(adRow(metricsWith({ count: 1, monetizedEr: 1.2, dailyEr: 1 })).suggested).toBe("3.유지·상승");
  });

  it("판정이 adCount 에 반응하지 않는다 — 소스에 adCount 참조가 없다", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/seller-analysis/reviewMapping.ts"), "utf8");
    const fn = src.slice(src.indexOf("function suggestAdResponse"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).not.toContain("adCount");
    expect(body).toContain("monetizedRetention");
  });

  it("선택지 문구가 개수 어휘로 되돌아가지 않았다", () => {
    for (const level of LEVELS.adResponseScore) {
      expect(level).not.toMatch(/개(미만|이상)/);
    }
  });
});

describe("광고 반응 — 비교 불가는 '미입력'이지 0점이 아니다", () => {
  it("수익성 글 0건 → 제안 없음(null)", () => {
    const row = adRow(metricsWith({ count: 0, monetizedEr: null, dailyEr: 1 }));
    expect(row.suggested).toBeNull();
    expect(row.reason).toContain("수익성");
  });

  it("일상 글이 없어 비교 대상이 없으면 → 제안 없음(null)", () => {
    const row = adRow(metricsWith({ count: 8, monetizedEr: 0.5, dailyEr: null }));
    expect(row.suggested).toBeNull();
  });

  it("metrics 자체가 없어도 0점으로 떨어지지 않는다", () => {
    expect(adRow(undefined).suggested).toBeNull();
  });

  it("⚠️ 어떤 경우에도 '0.반응없음' 을 미평가의 뜻으로 쓰지 않는다", () => {
    for (const m of [
      metricsWith({ count: 0, monetizedEr: null, dailyEr: 1 }),
      metricsWith({ count: 3, monetizedEr: 0.5, dailyEr: null }),
    ]) {
      expect(adRow(m).suggested).not.toBe("0.반응없음");
    }
  });
});

describe("수익성 지표 산출 — 광고 ∪ 공구 합집합", () => {
  const post = (caption: string, likes: number, comments: number) => ({
    caption, likes, comments_count: comments, sample_comments: [],
    taken_at: new Date().toISOString(), media_type: "image" as const,
    video_view_count: null, is_sponsored: false,
  });
  // 팔로워 수는 ER 의 분모라 양쪽에서 약분된다 — 유지율 자체에는 영향이 없지만
  // 0 이면 groupEr 이 null 이라 판정 불가가 되므로 반드시 넣는다.
  const data = (posts: ReturnType<typeof post>[]) => ({
    seller_id: "s", profile: { follower_count: 10_000 }, raw_posts: posts, images: [],
  });

  it("협찬광고가 0건이어도 공구 글이 있으면 유지율이 산출된다", () => {
    // 이것이 광고 전용 축(adPerformanceRetention)으로는 커버되지 않던 구간이다.
    const m = computeSellerMetrics(data([
        post("오늘 마켓 오픈합니다 최저가 링크는 댓글에", 100, 10),
        post("일상 사진이에요", 200, 20)]));
    expect(m.ads.adCount).toBe(0);
    expect(m.ads.adPerformanceRetention).toBeNull(); // 광고 축은 판정 불가
    expect(m.monetized.monetizedCount).toBe(1); // 수익성 축은 잡는다
    expect(m.monetized.monetizedRetention).toBeCloseTo(0.5, 5);
  });

  it("광고이면서 공구인 글을 두 번 세지 않는다", () => {
    const m = computeSellerMetrics(data([
        post("#광고 마켓 오픈 최저가 링크는 댓글에", 100, 0),
        post("일상", 100, 0)]));
    expect(m.monetized.monetizedCount).toBe(1);
  });

  it("일상 글이 하나도 없으면 유지율은 null (0 이 아니다)", () => {
    const m = computeSellerMetrics(data([post("#광고 협찬 받았어요", 100, 0)]));
    expect(m.monetized.monetizedRetention).toBeNull();
  });
});

describe("라벨 개정이 기존 저장값을 죽이지 않는다", () => {
  it("구 저장값('1.5개미만')이 신 라벨의 같은 단계로 매칭된다", () => {
    // 정확 문자열 매칭이면 -1(화면 '미입력')인데 점수 합산은 접두사만 읽어 1점을 센다 —
    // 화면과 계산이 갈리는 그 조합을 막는 계약이다.
    expect(matchLevelIndex(LEVELS.adResponseScore, "1.5개미만")).toBe(1);
    expect(matchLevelIndex(LEVELS.adResponseScore, "3.10개이상")).toBe(3);
    expect(matchLevelIndex(LEVELS.adResponseScore, "0.없음")).toBe(0);
  });

  it("신 라벨은 그대로 매칭된다", () => {
    LEVELS.adResponseScore.forEach((level, i) => {
      expect(matchLevelIndex(LEVELS.adResponseScore, level)).toBe(i);
    });
  });

  it("미입력·파싱 불가는 -1 (미입력 표시)", () => {
    expect(matchLevelIndex(LEVELS.adResponseScore, "")).toBe(-1);
    expect(matchLevelIndex(LEVELS.adResponseScore, "언젠가")).toBe(-1);
    expect(scorePrefix(null)).toBeNull();
  });

  it("모든 레벨이 'N.라벨' 형태를 지킨다 — 접두사 매칭의 전제", () => {
    for (const levels of Object.values(LEVELS)) {
      levels.forEach((level, i) => expect(scorePrefix(level)).toBe(i));
    }
  });
});

describe("선택지 문구 SSOT — 사본을 다시 만들지 않는다", () => {
  it("셀러 상세가 LEVELS 를 import 하고 인라인 배열을 쓰지 않는다", () => {
    const src = readFileSync(join(process.cwd(), "src/components/crm/seller-detail-content.tsx"), "utf8");
    expect(src).toContain("LEVELS.adResponseScore");
    // 인라인 사본(구 형태)이 되살아나면 AI 제안 어휘와 화면 선택지가 갈린다
    expect(src).not.toContain('"0.비노출"');
    expect(src).not.toContain('"3.10개이상"');
  });
});
