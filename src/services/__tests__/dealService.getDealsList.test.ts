import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// T-234 — 딜 목록 API(`GET /api/deals` → dealService.getDealsList)의 select 가
// 딜 그리드가 그리는 열을 빠뜨려, SSR 캐시로 그린 첫 화면에는 보이다가 `useDeals` 재조회
// 순간 총수수료·정가·하한가 등이 빈 값으로 바뀌는 값 유실이 있었다(API Drift Detector
// 시험 2026-10-06 에서 발견). tsc 는 `mapDealResponse(deal: Record<string, unknown>)`
// 캐스트 뒤라 이 드리프트를 못 보므로, 여기서 두 쪽을 기계로 묶는다:
//   ① getDealsList 가 Prisma 에 넘기는 select 에 소비처가 읽는 키가 전부 있고
//   ② 그 키 목록은 손으로 적은 사본이 아니라 소비처 소스(`useDeals.ts`)에서 파생한다.

const findManyMock = vi.fn();

vi.mock("@/repositories/dealRepository", () => ({
  dealRepository: {
    findMany: (...args: unknown[]) => findManyMock(...args),
  },
}));

vi.mock("@/lib/activity-log", () => ({
  recordActivityCreate: vi.fn(),
  recordActivityChange: vi.fn(),
  recordActivityDelete: vi.fn(),
  FIELD_LABELS: {},
  getCompareValue: vi.fn(),
}));

vi.mock("@/lib/asset-storage", () => ({
  googleDriveProvider: { createFolderForEntity: vi.fn() },
}));

import { dealService } from "../dealService";

/** `mapDealResponse` 본문에서 `deal.<key>` 로 읽는 스칼라 키를 소스에서 뽑는다. */
function readConsumedDealKeys(): Set<string> {
  const src = readFileSync(resolve(__dirname, "../../hooks/useDeals.ts"), "utf-8");
  const start = src.indexOf("function mapDealResponse(");
  const end = src.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = src.slice(start, end);
  const keys = new Set<string>();
  for (const m of body.matchAll(/\bdeal\.([A-Za-z_]\w*)/g)) keys.add(m[1]);
  return keys;
}

describe("dealService.getDealsList — select 가 그리드 소비 키를 전부 싣는다 (T-234)", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    findManyMock.mockResolvedValue([]);
  });

  it("useDeals.mapDealResponse 가 읽는 모든 키가 select 에 있다", async () => {
    await dealService.getDealsList({});
    expect(findManyMock).toHaveBeenCalledTimes(1);
    const select = findManyMock.mock.calls[0][0].select as Record<string, unknown>;

    const consumed = readConsumedDealKeys();
    // 소스 파생 목록이 비어 있으면 파서가 고장난 것이지 "드리프트 0" 이 아니다(양성 대조).
    expect(consumed.has("totalCommissionRate")).toBe(true);
    expect(consumed.size).toBeGreaterThanOrEqual(15);

    const missing = [...consumed].filter((k) => !(k in select));
    expect(missing).toEqual([]);
  });

  it("실결함이던 6개 열이 명시적으로 select 된다 (회귀 고정)", async () => {
    await dealService.getDealsList({});
    const select = findManyMock.mock.calls[0][0].select as Record<string, boolean>;
    for (const k of [
      "listPrice",
      "floorPrice",
      "discountRate",
      "totalCommissionRate",
      "brokerageCommissionRate",
      "sourcingMemo",
    ]) {
      expect(select[k], k).toBe(true);
    }
  });
});
