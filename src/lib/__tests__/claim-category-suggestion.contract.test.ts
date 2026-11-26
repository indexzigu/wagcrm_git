import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { BannedRuleInput } from "@/lib/claims/claim-gate";
import {
  countSkippedCategoryRules,
  suggestClaimCategory,
} from "@/lib/claims/suggest-claim-category";

/**
 * 카테고리 미지정 판매 조건의 규칙 공백 계약 — 제안은 순수·읽기 전용이고,
 * 판정 결과는 보지 않은 카테고리 규칙 수를 숨기지 않는다.
 */

const rule = (id: string, category: string | null): BannedRuleInput => ({
  id,
  phrase: id,
  pattern: null,
  category,
  severity: "WARN",
  legalBasis: "테스트",
});

describe("suggestClaimCategory", () => {
  it("카테고리별 낱말이 제안과 근거 낱말을 낸다", () => {
    expect(suggestClaimCategory("프리미엄 유산균 30포")).toEqual({
      category: "SUPPLEMENT",
      keyword: "유산균",
    });
    expect(suggestClaimCategory("수분 앰플 세트")).toEqual({
      category: "COSMETIC",
      keyword: "앰플",
    });
    expect(suggestClaimCategory("건강 간식 모음")).toEqual({
      category: "FOOD",
      keyword: "간식",
    });
  });

  it("두 카테고리 낱말이 함께 걸리면 제안하지 않는다", () => {
    expect(suggestClaimCategory("유산균 크림 세트")).toBeNull();
  });

  it("낱말이 없거나 입력이 비면 null", () => {
    expect(suggestClaimCategory("여름 특가 기획전")).toBeNull();
    expect(suggestClaimCategory(null, undefined, "")).toBeNull();
  });

  it("제안 모듈은 DB 쓰기·prisma 를 쓰지 않는다 (AST)", () => {
    const file = join(process.cwd(), "src/lib/claims/suggest-claim-category.ts");
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const offenders: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const spec = (node.moduleSpecifier as ts.StringLiteral).text;
        if (/prisma|supabase|^pg$/i.test(spec)) offenders.push(`import ${spec}`);
      }
      if (ts.isIdentifier(node) && /^(prisma|getPrisma|fetch)$/.test(node.text)) {
        offenders.push(node.text);
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        /^(create|update|upsert|delete|createMany|updateMany|deleteMany)$/.test(
          node.name.text,
        )
      ) {
        offenders.push(`.${node.name.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(offenders).toEqual([]);
  });
});

describe("미지정 카테고리의 건너뛴 규칙 수", () => {
  const rules = [
    rule("common", null),
    rule("c1", "COSMETIC"),
    rule("f1", "FOOD"),
    rule("s1", "SUPPLEMENT"),
  ];

  it("카테고리 null 이면 실제 넘어온 카테고리 규칙 수를 센다(0 이 아니다)", () => {
    expect(countSkippedCategoryRules(rules, null)).toBe(3);
  });

  it("카테고리가 있으면 0", () => {
    expect(countSkippedCategoryRules(rules, "FOOD")).toBe(0);
  });

  it("규칙 수에 따라 변한다(하드코딩 아님)", () => {
    expect(countSkippedCategoryRules(rules.slice(0, 2), null)).toBe(1);
    expect(countSkippedCategoryRules([], null)).toBe(0);
  });
});
