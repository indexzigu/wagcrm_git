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
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
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

  it("리터럴 수집기는 JSX 텍스트와 문자열을 모두 본다(양성 프로브)", () => {
    // dialog.tsx 는 sr-only 「닫기」 JSX 텍스트와 className 문자열을 함께 가진다.
    const lits = stringLiterals("src/components/ui/dialog.tsx");
    expect(lits).toContain("닫기");
    expect(lits.some((l) => l.includes("sr-only"))).toBe(true);
  });
});
