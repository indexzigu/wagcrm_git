import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Vercel Ignored Build Step 의 종료코드 계약을 고정한다.
 *
 * Vercel 규약: exit 1 = 빌드 진행 / exit 0 = 빌드 취소.
 * 이 방향이 뒤집히면 프로덕션이 "성공(초록)" 처럼 보이면서 조용히 배포를
 * 멈춘다(2026-07-22 #68~#72 실사고). 그래서 인라인 명령이 아니라 스크립트로
 * 옮기고, 여기서 4가지 분기를 전부 못 박는다.
 */

const SCRIPT = path.resolve(__dirname, "..", "vercel-ignore-build.sh");

const BUILD = 1;
const SKIP = 0;

function run(args: string[], env: Record<string, string | undefined>) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    env: { ...process.env, VERCEL_GIT_COMMIT_REF: undefined, ...env },
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("vercel-ignore-build.sh", () => {
  it("자기 레인 브랜치면 빌드한다(exit 1)", () => {
    // 운영 레인 = release (2026-07-24 승격 레인 전환)
    expect(run(["release"], { VERCEL_GIT_COMMIT_REF: "release" }).status).toBe(BUILD);
    expect(run(["demo"], { VERCEL_GIT_COMMIT_REF: "demo" }).status).toBe(BUILD);
  });

  it("다른 레인 브랜치면 스킵한다(exit 0)", () => {
    // 운영 프로젝트는 demo 브랜치 푸시로 프리뷰를 만들지 않는다.
    expect(run(["release"], { VERCEL_GIT_COMMIT_REF: "demo" }).status).toBe(SKIP);
    // 운영 프로젝트는 main 통합 머지로 빌드되지 않는다(승격 배칭의 핵심).
    expect(run(["release"], { VERCEL_GIT_COMMIT_REF: "main" }).status).toBe(SKIP);
    // 데모 프로젝트는 main/release 로 덩달아 빌드되지 않는다.
    expect(run(["demo"], { VERCEL_GIT_COMMIT_REF: "main" }).status).toBe(SKIP);
    expect(run(["demo"], { VERCEL_GIT_COMMIT_REF: "release" }).status).toBe(SKIP);
    expect(run(["release"], { VERCEL_GIT_COMMIT_REF: "claude/foo" }).status).toBe(SKIP);
  });

  it("브랜치 정보가 없으면 빌드 쪽으로 넘어진다(조용한 미배포 금지)", () => {
    expect(run(["release"], {}).status).toBe(BUILD);
    expect(run(["release"], { VERCEL_GIT_COMMIT_REF: "" }).status).toBe(BUILD);
  });

  it("인자를 빠뜨려도 빌드 쪽으로 넘어진다", () => {
    expect(run([], { VERCEL_GIT_COMMIT_REF: "main" }).status).toBe(BUILD);
  });

  it("판정 근거를 로그로 남긴다(취소 원인 추적용)", () => {
    const skipped = run(["release"], { VERCEL_GIT_COMMIT_REF: "demo" });
    expect(skipped.output).toContain("demo");
    expect(skipped.output).toContain("스킵");
  });
});
