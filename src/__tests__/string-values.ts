import ts from "typescript";

/** 코드의 문자열 값만 모은다(주석·JSX 본문 글자 제외). */
export function stringValues(source: string, fileName = "x.tsx"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
