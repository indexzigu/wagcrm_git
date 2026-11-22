import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  GRAPH_API_BASE_URL,
  GRAPH_API_VERSION,
  GRAPH_VERSION_EXPIRY,
  graphEndpointLabel,
  graphUrl,
} from "@/lib/instagram-graph-version";

// Graph API 버전 리터럴은 instagram-graph-version.ts 한 곳에만 둔다(만료 버전 v19.0 하드코딩 재발 방지).
// 주석은 AST 에서 노드가 아니므로 문자열·템플릿 리터럴만 본다.
const SRC_ROOT = path.resolve(__dirname, "../..");
const CONSTANT_MODULE = path.join(SRC_ROOT, "lib", "instagram-graph-version.ts");

const GRAPH_HOST = /graph\.(?:facebook|instagram)\.com/;
const BARE_VERSION = /^v\d+\.\d+$/;
const VERSIONED_PATH = /(?:^|[\s/])\/v\d+\.\d+(?:\/|$|\?)/;

export function findGraphVersionLiterals(source: string, fileName = "probe.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: string[] = [];
  // 호스트 규칙: Graph 호스트 리터럴은 상수 모듈에만 둔다(버전을 변수로 끼워 넣는 우회도 막는다).
  const check = (text: string, whole: boolean) => {
    if (GRAPH_HOST.test(text) || VERSIONED_PATH.test(text) || (whole && BARE_VERSION.test(text))) hits.push(text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node.text, true);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) check(node.text, false);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("Graph API 버전 단일 출처 계약", () => {
  it("상수 모듈 밖의 src 파일에는 버전 박힌 Graph 주소·경로 리터럴이 없다", () => {
    const files = listSourceFiles(SRC_ROOT).filter((f) => f !== CONSTANT_MODULE);
    expect(files.length).toBeGreaterThan(100); // 스캔 대상이 비면 초록이 무의미하다
    const offenders = files
      .map((f) => ({ f: path.relative(SRC_ROOT, f), hits: findGraphVersionLiterals(readFileSync(f, "utf8"), f) }))
      .filter((o) => o.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  it("프로브: 위반 리터럴(문자열·템플릿)은 잡힌다", () => {
    expect(findGraphVersionLiterals('const u = "https://graph.facebook.com/v19.0/x";')).toHaveLength(1);
    expect(findGraphVersionLiterals("const u = `https://graph.facebook.com/v23.0/${id}?a=1`;")).toHaveLength(1);
    expect(findGraphVersionLiterals("const l = `GET /v21.0/${id}/business_discovery`;")).toHaveLength(1);
    expect(findGraphVersionLiterals('const l = "/v20.0/me";')).toHaveLength(1);
  });

  it("프로브: 버전을 변수로 끼운 템플릿·타 호스트·맨 버전 문자열도 잡힌다", () => {
    expect(
      findGraphVersionLiterals('const V = "v19.0"; const u = `https://graph.facebook.com/${V}/x`;').length,
    ).toBeGreaterThanOrEqual(1);
    expect(findGraphVersionLiterals('const u = "https://graph.instagram.com/v21.0/x";').length).toBeGreaterThanOrEqual(1);
    expect(findGraphVersionLiterals('const V = "v19.0";')).toHaveLength(1);
  });

  it("프로브: 주석 속 버전은 잡지 않는다", () => {
    const src = [
      "// https://graph.facebook.com/v19.0/x 는 만료됐다",
      "/* GET /v19.0/abc/business_discovery */",
      "const ok = 1;",
    ].join("\n");
    expect(findGraphVersionLiterals(src)).toEqual([]);
  });

  it("프로브: 버전과 무관한 경로·숫자는 잡지 않는다", () => {
    expect(findGraphVersionLiterals('const p = "/api/v2/items"; const v = "1.2.3";')).toEqual([]);
  });

  it("현재 버전은 만료표에 있고 헬퍼가 그 버전으로 주소를 만든다", () => {
    expect(Object.keys(GRAPH_VERSION_EXPIRY)).toContain(GRAPH_API_VERSION);
    expect(GRAPH_API_BASE_URL).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}`);
    expect(graphUrl("/123?fields=a")).toBe(`${GRAPH_API_BASE_URL}/123?fields=a`);
    expect(graphUrl("123")).toBe(`${GRAPH_API_BASE_URL}/123`);
    expect(graphEndpointLabel("/123/business_discovery")).toBe(`GET /${GRAPH_API_VERSION}/123/business_discovery`);
  });
});
