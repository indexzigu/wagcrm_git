import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * 공용 프리미티브 접근성 계약 (2026-09-24 interfaces 점검 묶음 B).
 *
 * 프리미티브 한 줄이 소비 파일 수십 곳에 그대로 번지므로 여기서 막는다.
 * 1. 메뉴·셀렉트 항목의 키보드 강조가 `bg-accent`(#F8FAFC on #FFFFFF = 1.05:1) 하나뿐이면
 *    ↑↓ 이동이 화면에 안 보인다 → `ui/command.tsx` 와 같은 좌측 프라이머리 바를 캐리어로 둔다.
 * 2. destructive 변형 글자 `text-destructive` 는 자기 /10 틴트 위에서 4.13:1 → `text-status-urgent-text`.
 * 3. 한국어 문서(lang="ko")에 영어 접근 이름(「Close」)을 두지 않는다.
 * 4. 카운트 배지 9px 는 P8 타입 사다리 밖이다(하한 10px).
 *
 * 주석의 설명 문구에 속지 않도록 **문자열 리터럴만** AST 로 읽어 판정한다.
 */

function stringLiterals(relPath: string): string[] {
  const source = readFileSync(join(process.cwd(), relPath), "utf8");
  const file = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push(node.text);
    }
    if (ts.isJsxText(node) && node.text.trim()) out.push(node.text.trim());
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

const joined = (relPath: string) => stringLiterals(relPath).join("\n");

describe("공용 프리미티브 접근성 계약", () => {
  it.each(["src/components/ui/dropdown-menu.tsx", "src/components/ui/select.tsx"])(
    "%s — 항목 키보드 강조가 배경색 하나에 기대지 않는다",
    (path) => {
      const s = joined(path);
      expect(s).not.toContain("focus:bg-accent");
      expect(s).toContain("focus:border-primary");
    },
  );

  it.each(["src/components/ui/button.tsx", "src/components/ui/badge.tsx"])(
    "%s — destructive 글자는 틴트 위 대비를 만족하는 토큰을 쓴다",
    (path) => {
      const s = joined(path);
      expect(s).toContain("bg-destructive/10 text-status-urgent-text");
      expect(s).not.toMatch(/bg-destructive\/10 text-destructive\b/);
    },
  );

  it.each(["src/components/ui/dialog.tsx", "src/components/ui/sheet.tsx", "src/components/ui/sidebar.tsx"])(
    "%s — 접근 이름·보이는 버튼이 영어가 아니다",
    (path) => {
      const lits = stringLiterals(path);
      expect(lits).not.toContain("Close");
      expect(lits).not.toContain("Toggle Sidebar");
    },
  );

  it("카운트 배지는 10px 하한을 지킨다", () => {
    expect(joined("src/components/ui/badge.tsx")).not.toContain("text-[9px]");
  });

  // 5. 회색 트레이·칩(`bg-muted`) 위 글자 하한 = `text-slate-600`. `text-muted-foreground` 는 그 위
  //    4.34:1 로 미달이고, 알파로 흐린 글자(`text-foreground/60`)는 표면이 조금만 바뀌어도 미달한다.
  //    대비는 globals.css 의 실제 값에서 매번 다시 계산한다(색 리터럴을 고정하는 계약이 아니다).
  describe("회색 표면(bg-muted) 위 3차 글자", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const rootVar = (name: string) => {
      const m = css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
      if (!m) throw new Error(`globals.css 에서 --${name} 을 못 찾았다`);
      return m[1];
    };
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    // Tailwind v4 slate-600 = oklch(44.6% 0.043 257.281) → sRGB #45556C(환산값).
    const SLATE_600 = "#45556C";

    it("대비 근거 — muted-foreground 는 bg-muted 위 미달, slate-600 은 통과", () => {
      const muted = rootVar("muted");
      expect(ratio(rootVar("muted-foreground"), muted)).toBeLessThan(4.5);
      expect(ratio(SLATE_600, muted)).toBeGreaterThanOrEqual(4.5);
    });

    it("tabs — 기본 트레이(bg-muted)의 비활성 탭 글자는 slate-600 이고 알파로 흐리지 않는다", () => {
      const s = joined("src/components/ui/tabs.tsx");
      expect(s).toContain("bg-muted");
      expect(s).not.toMatch(/(^|\s)text-muted-foreground(\s|$)/m);
      expect(s).not.toMatch(/(^|\s)text-foreground\/\d+/m);
      expect(s).toMatch(/(^|\s)text-slate-600(\s|$)/m);
      // 활성 탭 구분은 유지된다
      expect(s).toContain("data-active:text-foreground");
    });

    it("badge — hover 로 bg-muted 가 깔리는 변형은 글자를 muted-foreground 로 내리지 않는다", () => {
      const s = joined("src/components/ui/badge.tsx");
      expect(s).not.toContain("hover:text-muted-foreground");
      expect(s).toContain("hover:bg-muted hover:text-slate-600");
    });
  });

  it("리터럴 수집기는 JSX 텍스트와 문자열을 모두 본다(양성 프로브)", () => {
    // dialog.tsx 는 sr-only 「닫기」 JSX 텍스트와 className 문자열을 함께 가진다.
    const lits = stringLiterals("src/components/ui/dialog.tsx");
    expect(lits).toContain("닫기");
    expect(lits.some((l) => l.includes("sr-only"))).toBe(true);
  });
});
