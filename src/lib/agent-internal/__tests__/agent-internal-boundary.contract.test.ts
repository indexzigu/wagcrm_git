/**
 * 봇 내부 창구 경계 계약(보안 리뷰 2026-10-16) — 소스 스캔.
 *  B1 「사람 승인만」 가드를 통과하는 즉시 저장 실행자(`AGENT_MAPPING_APPLY`)로 승인하는 코드는
 *     `agent-internal/apply-product-mappings.ts` 하나뿐이다. 다른 곳이 이 실행자로 `approveProposal` 을 부르면
 *     사람 승인 없는 매핑 쓰기가 네이버 옵션 대조 없이 열린다.
 *  B2 그 실행자 글자(따옴표 리터럴)는 `actors.ts` 한 곳에만 있다 — 사본이 생기면 B1 스캔을 우회한다.
 *  B3 앱은 루프백에만 바인드한다(`infra/selfhost/run-app.sh` HOSTNAME=127.0.0.1) — 창구의 터널 헤더·Host 검사는
 *     바깥 요청이 터널로만 들어온다는 전제 위에 서 있다.
 * 각 스캔은 양성 대조(잡혀야 할 것이 잡히는지)를 함께 본다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const SRC = join(root, "src");
const APPLY_MODULE = ["src", "lib", "agent-internal", "apply-product-mappings.ts"].join(sep);
const ACTORS_MODULE = ["src", "lib", "agent-internal", "actors.ts"].join(sep);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(full, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** 줄·블록 주석을 걷어낸다 — 설명문이 금지 글자를 인용해 자기 자신을 잡지 않게. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const FILES = walk(SRC).map((file) => ({ rel: relative(root, file), code: stripComments(readFileSync(file, "utf8")) }));

describe("봇 내부 창구 경계", () => {
  it("스캔이 살아 있다(양성 대조)", () => {
    expect(FILES.length).toBeGreaterThan(300);
    const apply = FILES.find((file) => file.rel === APPLY_MODULE);
    expect(apply?.code).toMatch(/approve\(prepared\.proposalId,\s*AGENT_MAPPING_APPLY_ACTOR/);
    expect(FILES.find((file) => file.rel === ACTORS_MODULE)?.code).toContain('"AGENT_MAPPING_APPLY"');
  });

  it("B1 즉시 저장 실행자로 승인하는 파일은 저장 모듈 하나뿐이다", () => {
    const offenders = FILES.filter(
      (file) => /AGENT_MAPPING_APPLY_ACTOR/.test(file.code) && /approveProposal\b/.test(file.code),
    ).map((file) => file.rel);
    expect(offenders).toEqual([APPLY_MODULE]);
  });

  it("B2 실행자 글자는 actors.ts 에만 있다", () => {
    const offenders = FILES.filter((file) => /["'`]AGENT_MAPPING_APPLY["'`]/.test(file.code)).map((file) => file.rel);
    expect(offenders).toEqual([ACTORS_MODULE]);
  });

  it("B3 앱은 루프백에만 바인드한다", () => {
    const runApp = readFileSync(join(root, "infra", "selfhost", "run-app.sh"), "utf8");
    expect(runApp).toMatch(/^export [^\n]*\bHOSTNAME=127\.0\.0\.1\b/m);
  });
});
