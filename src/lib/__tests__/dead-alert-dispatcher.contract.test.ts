import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 알림 발송 주체는 메뉴바 앱(notify.sh)과 Cloudflare Worker 뿐이다 — 둘 다 Next 앱
 * 밖이다. 앱 안에 발송기를 두면 앱·맥이 죽는 바로 그 상황에서 함께 죽는다(2026-08-19
 * 사고의 자기참조). dispatcherService 는 호출부가 0곳인 채 설정 화면만 갖고 있어,
 * "살아 보이는 죽은 배선"으로 다음 사람을 유인하던 자리다.
 * 설계 정본: docs/private/specs/2026-08-19-external-alert-channel-design.md
 */
const ROOT = process.cwd();

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      out.push(...tsFiles(full));
    } else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

export function isTestFile(path: string): boolean {
  return path.includes("__tests__") || /\.(?:test|spec)\.[jt]sx?$/.test(path);
}

describe("죽은 알림 발송기 부재 계약", () => {
  const files = tsFiles(join(ROOT, "src"));

  it("스캐너가 파일을 찾는다(공허 통과 방지)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("dispatcher 모듈이 없다", () => {
    expect(existsSync(join(ROOT, "src", "lib", "dispatcher"))).toBe(false);
    expect(existsSync(join(ROOT, "src", "services", "dispatcherService.ts"))).toBe(false);
  });

  it("테스트 파일 제외 규칙이 폴더와 파일명 확장자 모두 인식한다", () => {
    expect(isTestFile("src/lib/__tests__/sample.ts")).toBe(true);
    expect(isTestFile("src/components/button.test.tsx")).toBe(true);
    expect(isTestFile("src/services/order.spec.ts")).toBe(true);
    expect(isTestFile("src/services/orderService.ts")).toBe(false);
    expect(isTestFile("src/lib/order-converter.ts")).toBe(false);
  });

  it("파일명 규칙으로 끝나는 테스트 파일은 검사에서 걸러지고 일반 소스는 남는다", () => {
    const mockPaths = [
      "src/components/sample.test.ts",
      "src/components/sample.spec.tsx",
      "src/services/sampleService.ts",
    ];
    const nonTestFiles = mockPaths.filter((p) => !isTestFile(p));
    expect(nonTestFiles).toEqual(["src/services/sampleService.ts"]);
  });

  it("앱 소스 어디서도 발송기를 참조하지 않는다", () => {
    const offenders = files.filter((f) => {
      if (isTestFile(f)) return false;
      const src = readFileSync(f, "utf8");
      return /dispatcherService|lib\/dispatcher|sendDiscordMessage|sendEmailAlert/.test(src);
    });
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("양성 프로브 — 스캐너가 실제로 잡는다", () => {
    expect(/dispatcherService|sendEmailAlert/.test('import { sendEmailAlert } from "x"')).toBe(true);
  });
});
