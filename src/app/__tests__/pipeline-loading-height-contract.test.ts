import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #192 회귀 가드 — 캠페인 탭 로딩 화면의 높이 계약.
 *
 * `pipeline/loading.tsx` 가 `min-h-[60vh]` 였을 때, 로딩→본문 높이 급변으로 iOS
 * 스탠드얼론에서 하단 nav 가 위로 튀어 보였다(오너 실기기 보고). 본문
 * (`mobile-pipeline-view`)과 같은 `min-h-[calc(100dvh+1px)]` 가 정본이다.
 *
 * 플로팅 idle-reveal nav(2026-07-16)도 여전히 `position:fixed` 라 이 조건을 그대로
 * 상속한다 — 스켈레톤 등 로딩 화면을 다시 디자인할 때 높이만은 유지해야 한다.
 * jsdom 은 dvh·env() 를 모르므로 렌더 테스트로는 못 잡는다 — 소스 계약으로 고정.
 */

const LOADING_RAW = readFileSync(join(process.cwd(), "src/app/pipeline/loading.tsx"), "utf8");
// 주석 제거 — 파일 주석이 "60vh 였을 때"라는 경고문을 담고 있어, 원문 검사면 가드가
// 자기 경고에 걸려 오탐한다(layout-suspense-contract 와 같은 함정).
const LOADING = LOADING_RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("pipeline/loading.tsx 높이 계약 (#192)", () => {
  it("본문과 같은 min-h-[calc(100dvh+1px)] 를 쓴다", () => {
    expect(LOADING).toContain("min-h-[calc(100dvh+1px)]");
  });

  it("60vh 로 되돌아가지 않았다", () => {
    expect(LOADING).not.toContain("min-h-[60vh]");
  });
});
