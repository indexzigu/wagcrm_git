import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 셀러 포털 막다른 화면 계약 (2026-09-24 interfaces 점검 묶음 C).
 *
 * 포털 구간에 자기 not-found·error 가 없으면 Next 기본 영어 404 와 루트 app/error.tsx
 * (운영자용 — CRM 홈 링크·「디버그용」 오류 식별자)가 외부 셀러에게 그대로 보인다.
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const SEGMENTS = ["src/app/[slug]", "src/app/p/[token]"];

describe("셀러 포털 막다른 화면 계약", () => {
  it.each(SEGMENTS)("%s — 전용 not-found·error 가 포털 화면을 쓴다", (seg) => {
    expect(existsSync(join(ROOT, seg, "not-found.tsx"))).toBe(true);
    expect(existsSync(join(ROOT, seg, "error.tsx"))).toBe(true);
    expect(read(`${seg}/not-found.tsx`)).toMatch(/<PortalNotFound\s*\/>/);
    expect(read(`${seg}/error.tsx`)).toMatch(/<PortalErrorScreen\b/);
  });

  it("셀러용 화면은 CRM 링크·오류 원문·식별자를 렌더하지 않는다", () => {
    for (const p of ["src/components/portal/portal-status-screen.tsx", "src/components/portal/portal-error-screen.tsx"]) {
      const code = read(p).replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/href=/);
      expect(code).not.toMatch(/error\.(message|digest)/);
    }
  });
});
