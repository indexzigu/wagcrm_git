/**
 * 데모 모드 안전 불변식: DEMO_MODE=1(인증 우회 배포)에서는 sqlite 목업만 허용되고
 * postgres(실DB) 연결은 기동 자체가 거부돼야 한다 — 미들웨어 인증 우회와 실DB가
 * 결합되는 최악 조합을 코드 레벨에서 차단하는 계약이다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function importFresh() {
  vi.resetModules();
  return import("./prisma-client");
}

describe("prisma-client 데모 모드 가드", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("DEMO_MODE=1 + postgres URL → 기동 거부(throw)", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    vi.stubEnv("DATABASE_URL", "postgresql://demo:demo@db.example.internal:5432/app");

    const { createPrismaClient } = await importFresh();
    expect(() => createPrismaClient()).toThrow(/실DB 연결을 금지/);
  });

  it("DEMO_MODE=1이면 URL이 없어도 sqlite로 판정된다(isSqliteDatabaseUrl)", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    vi.stubEnv("DATABASE_URL", "");

    const { isSqliteDatabaseUrl } = await importFresh();
    expect(isSqliteDatabaseUrl()).toBe(true);
  });

  it("DEMO_MODE 미설정 + postgres URL → 기존 postgres 판정 유지", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://demo:demo@db.example.internal:5432/app");

    const { isSqliteDatabaseUrl } = await importFresh();
    expect(isSqliteDatabaseUrl()).toBe(false);
  });
});
