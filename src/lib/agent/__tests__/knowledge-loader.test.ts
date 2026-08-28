import { describe, expect, it, beforeEach } from "vitest";
import { buildDateContext, buildSystemPrompt, clearKnowledgeCache, getLoadOrder, KNOWLEDGE_ROOT } from "../knowledge-loader";

describe("knowledge-loader", () => {
  beforeEach(() => {
    clearKnowledgeCache();
  });

  it("KNOWLEDGE_ROOT는 .knowledge(OKF)가 아닌 knowledge/ 디렉터리를 가리킨다 (R5)", () => {
    expect(KNOWLEDGE_ROOT.endsWith("/knowledge")).toBe(true);
    expect(KNOWLEDGE_ROOT.endsWith("/.knowledge")).toBe(false);
  });

  it("index.json의 loadOrder를 그대로 반환한다", async () => {
    const loadOrder = await getLoadOrder();
    expect(loadOrder).toEqual([
      "entities/relationships.md",
      "entities/glossary.md",
      "rules/settlement.rules.json",
      "rules/approval.rules.json",
      "rules/forbidden_expressions.md",
    ]);
  });

  it("buildSystemPrompt는 loadOrder 순서대로 각 파일 내용을 결합한다", async () => {
    const prompt = await buildSystemPrompt();

    const relIdx = prompt.indexOf("entities/relationships.md");
    const glossaryIdx = prompt.indexOf("entities/glossary.md");
    const settlementIdx = prompt.indexOf("rules/settlement.rules.json");
    const approvalIdx = prompt.indexOf("rules/approval.rules.json");
    const forbiddenIdx = prompt.indexOf("rules/forbidden_expressions.md");

    expect(relIdx).toBeGreaterThan(-1);
    expect(glossaryIdx).toBeGreaterThan(relIdx);
    expect(settlementIdx).toBeGreaterThan(glossaryIdx);
    expect(approvalIdx).toBeGreaterThan(settlementIdx);
    expect(forbiddenIdx).toBeGreaterThan(approvalIdx);
  });

  it("buildSystemPrompt는 각 지식 파일의 실제 내용을 포함한다", async () => {
    const prompt = await buildSystemPrompt();
    // settlement.rules.json의 핵심 규칙 id가 프롬프트 텍스트 안에 존재해야 한다.
    expect(prompt).toContain("settlement-status-disclosure");
    // forbidden_expressions.md의 금지 표현 예시가 포함되어야 한다.
    expect(prompt).toContain("정산 확정 단정 금지");
  });

  it("buildSystemPrompt는 .knowledge/(OKF) 경로의 어떤 파일도 참조하지 않는다 (R5 회귀 방지)", async () => {
    const prompt = await buildSystemPrompt();
    // .knowledge/index.md 등 사람용 문서 특유의 마커가 섞여 들어오면 안 된다.
    expect(prompt).not.toMatch(/\.knowledge\//);
  });

  it("모듈 캐시가 동작한다 (forceReload 없이 재호출 시 동일 참조)", async () => {
    const first = await buildSystemPrompt();
    const second = await buildSystemPrompt();
    expect(first).toBe(second);
  });

  it("시스템 프롬프트 프리앰블에 3중 방어 핵심 규칙(예정/확정/지급완료 분리)이 포함된다", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).toMatch(/예정.*확정.*지급완료|pending.*confirmed.*paid/);
  });

  describe("buildDateContext — 상대 날짜 환산 기준 (실사용 되묻기 버그 수정)", () => {
    it("KST 기준 오늘/이번 달/지난달을 환산한다", () => {
      const ctx = buildDateContext(new Date("2026-07-06T03:00:00Z")); // KST 2026-07-06 12:00
      expect(ctx).toContain("2026-07-06");
      expect(ctx).toContain('"이번 달"=2026-07');
      expect(ctx).toContain('"지난달"=2026-06');
      expect(ctx).toContain("되묻지 마십시오");
    });

    it("KST 월 경계: UTC로는 전월이어도 KST 기준 월을 쓴다", () => {
      const ctx = buildDateContext(new Date("2026-06-30T16:00:00Z")); // KST 2026-07-01 01:00
      expect(ctx).toContain("2026-07-01");
      expect(ctx).toContain('"이번 달"=2026-07');
    });

    it("1월이면 지난달은 전년 12월", () => {
      const ctx = buildDateContext(new Date("2026-01-15T03:00:00Z"));
      expect(ctx).toContain('"지난달"=2025-12');
    });

    it("buildSystemPrompt는 캐시 히트/미스 모두 현재 날짜 블록을 포함한다", async () => {
      const first = await buildSystemPrompt(); // 캐시 미스
      const second = await buildSystemPrompt(); // 캐시 히트
      expect(first).toContain("## 현재 날짜");
      expect(second).toContain("## 현재 날짜");
    });
  });
});
