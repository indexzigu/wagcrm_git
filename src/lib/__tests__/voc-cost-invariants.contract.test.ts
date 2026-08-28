import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * VOC 비용 불변식 계약(REVIEW_QNA_COLLECTION_PLAN.md §6-1) — 위반이 곧 버그.
 *
 * I1. 읽기 경로는 LLM 무호출: voc-store·/voc 라우트가 gemini 계열 모듈(직접) 또는
 *     voc-insight(간접 — LLM을 끌고 옴)를 import하면 화면 조회가 토큰을 태우게 된다.
 * I2. 분석 진입점 통제: 크론은 analyzeDirtyDeals(dirty 선별)만 부른다. voc-insight의
 *     analyze* export는 허용 목록(단일 딜 엔진 포함) 밖으로 늘어나면 안 된다 —
 *     "전 딜 순회" 함수가 생기는 순간 dirty-gate가 우회된다.
 *
 * 주의(앵커 함정 메모리): 파일이 비었거나 경로가 틀리면 "금지 문자열 없음"이 공허 통과한다
 * — 각 파일에 존재해야 하는 앵커를 먼저 단언한다(음성 대조군).
 */

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf-8");

const READ_PATH_FILES = [
  { path: "src/lib/order-converter/voc-store.ts", anchor: "VocReviewCorpus" },
  { path: "src/app/api/deals/[id]/voc/route.ts", anchor: "loadDealVocView" },
];

// 직접(LLM 클라이언트) + 간접(voc-insight·gemini-client 등 LLM을 끌고 오는 모듈) 금지 토큰.
// 코드리뷰 지적 반영: 특정 심볼 나열이 아니라 계열 전체(gemini/genai, 대소문자 무시)를 막는다 —
// gemini-client의 다른 export를 import해도 모듈 경로에 "gemini"가 있어 걸린다.
const FORBIDDEN_IN_READ_PATH: { token: string | RegExp; why: string }[] = [
  { token: "voc-insight", why: "voc-insight import는 LLM 의존을 통째로 끌고 온다" },
  { token: /gemini/i, why: "gemini 계열 모듈(@/lib/agent/gemini-client 등) 참조" },
  { token: /genai/i, why: "@google/genai SDK 참조" },
  { token: "generativelanguage", why: "Gemini REST 엔드포인트 직접 호출" },
];

describe("I1 — 읽기 경로 LLM 무호출", () => {
  for (const f of READ_PATH_FILES) {
    it(`${f.path}: 스냅샷·집계만 읽는다(LLM 모듈 import 금지)`, () => {
      const src = read(f.path);
      expect(src).toContain(f.anchor); // 앵커 — 빈 파일/경로 오류의 공허 통과 방지
      for (const { token, why } of FORBIDDEN_IN_READ_PATH) {
        const hit = typeof token === "string" ? src.includes(token) : token.test(src);
        expect(hit, `${f.path} 가 ${String(token)} 에 걸림 — ${why}(I1 위반)`).toBe(false);
      }
    });
  }
});

describe("I2 — 분석 진입점 통제(dirty-gate 우회 차단)", () => {
  it("analyze-voc 크론은 analyzeDirtyDeals만 import한다", () => {
    const src = read("src/app/api/cron/analyze-voc/route.ts");
    expect(src).toContain("withSystemTaskStatus"); // 앵커
    const importMatch = src.match(/import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/order-converter\/voc-insight["']/);
    expect(importMatch, "크론이 voc-insight를 named import로 쓰지 않음").toBeTruthy();
    const names = importMatch![1].split(",").map((s) => s.trim()).filter(Boolean);
    expect(names).toEqual(["analyzeDirtyDeals"]);
  });

  it("voc-insight의 analyze* export는 허용 목록뿐(전 딜 순회 함수 신설 금지)", () => {
    const src = read("src/lib/order-converter/voc-insight.ts");
    expect(src).toContain("VOC_DIRTY_NEW_THRESHOLD"); // 앵커
    // 코드리뷰 지적 반영: function 선언·화살표(const)·re-export 세 형태 전부 스캔.
    const exported = [
      ...Array.from(src.matchAll(/export\s+(?:async\s+)?function\s+(analyze\w*)/g)).map((m) => m[1]),
      ...Array.from(src.matchAll(/export\s+const\s+(analyze\w*)/g)).map((m) => m[1]),
      ...Array.from(src.matchAll(/export\s*\{([^}]*)\}/g)).flatMap((m) =>
        Array.from(m[1].matchAll(/\b(analyze\w*)\b/g)).map((x) => x[1]),
      ),
    ];
    expect(exported.length).toBeGreaterThan(0); // 스캐너 자체가 공허하지 않음(음성 대조군)
    expect(Array.from(new Set(exported)).sort()).toEqual(["analyzeDirtyDeals", "analyzeVocForDeal"].sort());
  });

  it("analyzeDirtyDeals는 상한 슬라이스 + 실행 데드라인(60s clamp 배압)을 유지한다", () => {
    const src = read("src/lib/order-converter/voc-insight.ts");
    expect(src).toContain(".slice(0, VOC_MAX_DEALS_PER_RUN)");
    expect(src).toContain("VOC_RUN_BUDGET_MS"); // 코드리뷰 HIGH — 데드라인 가드 존재
  });
});
