/**
 * 계약: **캠페인 목록을 만드는 두 경로가 모두 부가 항목을 싣는다.**
 *
 * 정산 화면은 목록 페이로드만으로 거래처 정산 총액을 계산한다(상세를 다시 조회하지 않는다).
 * 한쪽만 include 하면 **첫 화면(서버 렌더)과 새로고침 후(목록 API)의 금액이 달라진다** —
 * 타입이 `settlementItems?` 라 컴파일러가 못 잡고, 빠진 쪽은 조용히 빈 배열이 되어
 * 화면에는 그럴듯한 숫자가 그대로 뜬다. 실제로 이 상태로 있었다(2026-08-28 발견).
 *
 * 판정은 **AST** 로 한다 — 문자열 grep 은 이 파일 위의 설명 주석이나 코드 주석만으로도
 * 통과해버린다(이 레포가 소스 스캔 계약에서 이미 밟은 함정).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** 등재된 경로 = 캠페인 목록 페이로드를 만드는 곳 전부. 새 경로가 생기면 여기 추가한다. */
const CAMPAIGN_LIST_SOURCES = [
  "src/lib/dashboard-data.ts",
  "src/services/campaignService.ts",
] as const;

function countPropertyAssignments(filePath: string, propertyName: string): number {
  const absolute = resolve(process.cwd(), filePath);
  const source = ts.createSourceFile(
    absolute,
    readFileSync(absolute, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  let found = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === propertyName
    ) {
      found += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("캠페인 목록 페이로드 — 부가 항목 include", () => {
  it.each(CAMPAIGN_LIST_SOURCES)("%s 가 settlementItems 를 include 한다", (filePath) => {
    expect(countPropertyAssignments(filePath, "settlementItems")).toBeGreaterThan(0);
  });

  // 음성 대조군 — 스캐너가 실제로 코드를 보는지 확인한다. 이게 없으면 판정 함수가
  // 고장나 항상 0 을 세도(또는 항상 통과해도) 초록이 된다.
  it.each(CAMPAIGN_LIST_SOURCES)("%s 에 없는 이름은 0 으로 센다", (filePath) => {
    expect(countPropertyAssignments(filePath, "settlementItemsThatDoNotExist")).toBe(0);
  });
});
