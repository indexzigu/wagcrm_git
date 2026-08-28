import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// naverOrderSnapshotRepository.test.ts와 동일 관례: serializeJsonField는
// isSqliteDatabaseUrl()(DATABASE_URL)에 따라 분기하므로 매 테스트마다 모듈을 재로딩한다.
async function loadRepository() {
  vi.resetModules();
  return await import("../priceMonitorSnapshotRepository");
}

describe("priceMonitorSnapshotRepository 직렬화 왕복", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  const sampleRawResults = [
    { mall: "테스트몰", price: 10000, totalPrice: 10000, matchScore: 90, excludeReason: undefined },
    { mall: "제외몰", price: 5000, totalPrice: 5000, matchScore: 10, excludeReason: "MATCH_TOO_LOW" },
  ];

  it("SQLite(file: DATABASE_URL)에서는 JSON 문자열로 직렬화하고 parseRawResults로 원복된다", async () => {
    process.env.DATABASE_URL = "file:./dev.db";
    const { serializeJsonField, priceMonitorSnapshotRepository } = await loadRepository();

    const serialized = serializeJsonField(sampleRawResults);
    expect(typeof serialized).toBe("string");

    const roundTripped = priceMonitorSnapshotRepository.parseRawResults({ rawResults: serialized });
    expect(roundTripped).toEqual(sampleRawResults);
  });

  it("Postgres(DATABASE_URL)에서는 객체를 그대로 유지한다", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    const { serializeJsonField, priceMonitorSnapshotRepository } = await loadRepository();

    const serialized = serializeJsonField(sampleRawResults);
    expect(serialized).toBe(sampleRawResults);

    const roundTripped = priceMonitorSnapshotRepository.parseRawResults({ rawResults: serialized });
    expect(roundTripped).toEqual(sampleRawResults);
  });

  it("evidence가 null이면 parseEvidence도 null을 반환한다", async () => {
    process.env.DATABASE_URL = "file:./dev.db";
    const { priceMonitorSnapshotRepository } = await loadRepository();
    expect(priceMonitorSnapshotRepository.parseEvidence({ evidence: null })).toBeNull();
  });
});
