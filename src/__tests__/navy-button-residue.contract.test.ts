import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringValues } from "./string-values";

// [애플UI] 남색 버튼 정리(오너 지시 2026-10-22 「남색 버튼 청록 주 버튼과 맞춰줘」).
// 진한 남색 채움(slate-800/900/950)은 청록 주 버튼(`bg-primary`)과 「이게 주요 동작」 자리를 다퉜다.
//   실행 버튼            → 청록 채움(`<Button>` 기본 변형과 같은 bg-primary / text-primary-foreground)
//   선택된 필터·단계 표시 → 청록 옅은 바탕 + 청록 글자(bg-primary/10 text-primary) — 한 화면의 청록 채움은
//                          누를 동작 하나로 남긴다(설정 메뉴·모바일 탭바 선택 표시와 같은 말).
// 아래 ALLOWED 는 버튼이 아닌 어두운 표면(툴팁·디버그 로그·진행 막대·외부 공개 페이지)이다 — 정확한 개수로 묶는다.
// 판정은 코드의 문자열 값(TS 구문 트리)에서 하고, `dark:` 변형과 `/NN` 알파 틴트는 남색 채움이 아니라 제외한다.

const SRC = path.join(process.cwd(), "src");

/** 클래스 토큰 하나가 진한 남색 채움인가 — 어떤 변형 접두(hover:·md:·data-[…]:·!)든 잡고, dark: 와 알파(/NN)는 제외. */
const NAVY_FILL = /^(?!(?:.*:)?dark:)(?:[\w\-[\]=&*!]+:)*!?bg-slate-(?:800|900|950)$/;

function navyFills(values: string[]): string[] {
  return values.flatMap((v) => v.split(/\s+/).filter((t) => NAVY_FILL.test(t)));
}

const ALLOWED: Record<string, { count: number; reason: string }> = {
  "app/coupang-partners/page.tsx": { count: 2, reason: "외부 공개 페이지(WAGPICK) — 단계 번호 원·어두운 안내 구역, CRM 버튼 아님" },
  "components/crm/step-metric-card.tsx": { count: 1, reason: "툴팁 바탕" },
  "components/crm/schedule-gap-briefing-card.tsx": { count: 1, reason: "툴팁 바탕(slate-950)" },
  "components/crm/partners-panel.tsx": { count: 1, reason: "툴팁 바탕" },
  "components/crm/campaign-side-panel.tsx": { count: 1, reason: "툴팁 바탕" },
  "components/crm/inline-edit-field.tsx": { count: 1, reason: "툴팁 바탕" },
  "components/crm/shipping/modals/CampaignEditModal.tsx": { count: 1, reason: "개발용 디버그 로그 블록 바탕" },
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(p);
    return /\.(tsx|ts)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("스캐너 프로브 — 고장 나면 아래 「0건」이 거짓말이 된다", () => {
  it("양성: 문자열·템플릿·조건식 속 남색 채움과 hover 변형을 잡는다", () => {
    const src = [
      'const a = <button className="bg-slate-900 text-white hover:bg-slate-800" />;',
      "const b = `x ${on ? 'bg-slate-950 text-white' : ''}`;",
      "const c = on ? 'disabled:hover:bg-slate-800' : '';",
      'const d = "md:bg-slate-900 data-[state=on]:bg-slate-950 !bg-slate-800";',
    ].join("\n");
    expect(navyFills(stringValues(src))).toEqual([
      "bg-slate-900",
      "hover:bg-slate-800",
      "bg-slate-950",
      "disabled:hover:bg-slate-800",
      "md:bg-slate-900",
      "data-[state=on]:bg-slate-950",
      "!bg-slate-800",
    ]);
  });

  it("음성: 주석·dark: 변형·알파 틴트·다른 셰이드·청록은 잡지 않는다", () => {
    const src = [
      "// 종전 bg-slate-900 버튼",
      'const a = <div className="dark:bg-slate-900/40 dark:hover:bg-slate-800 md:dark:bg-slate-900 bg-slate-900/10 bg-slate-700 bg-primary hover:bg-primary/90" />;',
    ].join("\n");
    expect(navyFills(stringValues(src))).toEqual([]);
  });
});

describe("진한 남색 채움은 허용 목록(버튼 아닌 어두운 표면)에만 정확한 개수로 남는다", () => {
  const files = walk(SRC);

  it("스캔 대상이 실제로 읽힌다(빈 목록이면 하네스 고장)", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("허용 목록 밖 재유입 0 · 허용 항목 개수 일치", () => {
    const found: Record<string, number> = {};
    for (const abs of files) {
      const rel = path.relative(SRC, abs).split(path.sep).join("/");
      const raw = readFileSync(abs, "utf8");
      // 구문 트리 파싱은 전수로 돌리면 병렬 부하에서 5초를 넘는다 — 셰이드 숫자나 \u 이스케이프가 있는 파일만 판다.
      if (!/(?:800|900|950)/.test(raw) && !raw.includes("\\u")) continue;
      const n = navyFills(stringValues(raw, rel)).length;
      if (n > 0) found[rel] = n;
    }
    for (const [rel, { reason }] of Object.entries(ALLOWED)) {
      expect(reason.length, `${rel} 사유가 비었다`).toBeGreaterThan(0);
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([k, v]) => [k, v.count])));
  }, 30_000);
});

describe("바뀐 자리 고정 — 실행 버튼은 청록 채움, 선택 표시는 청록 옅은 바탕", () => {
  const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

  it("실행 버튼 3곳", () => {
    expect(read("components/crm/order-dashboard.tsx")).toContain("bg-primary hover:bg-primary/90 text-primary-foreground");
    expect(read("components/crm/story-collect-button.tsx")).toContain("bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground");
    // 오류 화면은 공용 <Button> 기본 변형을 덮어쓰지 않는다.
    expect(read("app/error.tsx")).toContain('className="rounded-lg h-9 px-4 text-xs"');
  });

  it("선택 토글 — 옅은 청록 + 굵기 차이(색만으로 구분하지 않는다, WCAG 1.4.1)", () => {
    for (const rel of [
      "components/crm/story-inbox-grid.tsx",
      "components/crm/deals-panel.tsx",
      "components/crm/segment-toggle.tsx",
      "components/crm/claim-list.tsx",
      "components/crm/stage-filter-bar.tsx",
      "app/outreach/page.tsx",
    ]) {
      const src = read(rel);
      expect(src, rel).toContain("bg-primary/10 font-bold text-primary");
      expect(src, `${rel} 미선택 쪽 굵기`).toContain("font-medium text-slate-500");
    }
  });

  it("발송처리 안 N 표시는 청록 버튼 위 흰 칩(녹색 칩은 청록에 1.34:1 로 녹는다)", () => {
    expect(read("components/crm/order-dashboard.tsx")).toContain('"bg-card text-status-success text-[9px]');
  });
});
