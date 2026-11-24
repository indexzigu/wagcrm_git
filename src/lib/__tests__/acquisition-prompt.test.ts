import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { needsAcquisitionPrompt } from "@/lib/acquisition-prompt";
import { toPortalCampaign } from "@/lib/seller-portal";

describe("needsAcquisitionPrompt", () => {
  it("묻는다: null·undefined·빈 문자열", () => {
    expect(needsAcquisitionPrompt({ acquisitionChannel: null })).toBe(true);
    expect(needsAcquisitionPrompt({ acquisitionChannel: undefined })).toBe(true);
    expect(needsAcquisitionPrompt({})).toBe(true);
    expect(needsAcquisitionPrompt({ acquisitionChannel: "" })).toBe(true);
  });

  it("값이 있으면 묻지 않는다", () => {
    expect(needsAcquisitionPrompt({ acquisitionChannel: "COLD" })).toBe(false);
  });
});

describe("진입점은 공유 술어를 가져온다 (사본 금지)", () => {
  const strip = (file: string) => {
    const source = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    return sf.statements
      .filter(ts.isImportDeclaration)
      .map((d) => ({
        from: (d.moduleSpecifier as ts.StringLiteral).text,
        names: d.importClause?.namedBindings && ts.isNamedImports(d.importClause.namedBindings)
          ? d.importClause.namedBindings.elements.map((e) => e.name.text)
          : [],
      }));
  };

  const countCalls = (source: string, file = "probe.tsx") => {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let calls = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "needsAcquisitionPrompt") calls += 1;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return calls;
  };

  it("호출 판정 반례: import 만 있고 부르지 않으면 0", () => {
    expect(countCalls('import { needsAcquisitionPrompt } from "@/lib/acquisition-prompt";\n// needsAcquisitionPrompt(x)\nconst y = 1;')).toBe(0);
    expect(countCalls("needsAcquisitionPrompt({ acquisitionChannel: null });")).toBe(1);
  });

  it.each(["src/components/crm/campaign-creation-sheet.tsx", "src/app/outreach/page.tsx"])(
    "%s",
    (file) => {
      const hit = strip(file).find((i) => i.from === "@/lib/acquisition-prompt");
      expect(hit?.names).toContain("needsAcquisitionPrompt");
      expect(countCalls(readFileSync(file, "utf8"), file)).toBeGreaterThan(0);
    },
  );
});

describe("셀러 포털 페이로드", () => {
  it("유입 경로·소개자 필드를 담지 않는다", () => {
    const payload = toPortalCampaign({
      id: "c1",
      name: "테스트캠페인A",
      acquisitionChannel: "COLD",
      referredById: "seller-x",
      salesCampaigns: [{ id: "s1", sellerId: "seller-a", acquisitionChannel: "COLD", referredById: "seller-x" }],
    });
    const json = JSON.stringify(payload);
    expect(json).not.toContain("acquisitionChannel");
    expect(json).not.toContain("referredById");
  });
});
