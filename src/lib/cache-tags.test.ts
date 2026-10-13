import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidateTagMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidateTag: (...args: unknown[]) => revalidateTagMock(...args),
  revalidatePath: vi.fn(),
}));

import {
  CRM_CACHE_TAGS,
  IMMEDIATE_EXPIRY_TAGS,
  ORDER_SYNC_INVALIDATION_TAGS,
  revalidateCampaignCaches,
  revalidateCrmTags,
} from "./cache-tags";

// 정산 태그는 즉시 만료한다. "max"(stale-while-revalidate)는 무효화 뒤 첫 요청에 옛 값을
// 내주고, 정산 패널은 그 캐시 행을 편집 기준선으로 쓴다(실사고 2026-10-13, cache-tags.ts 주석).

function profileFor(tag: string) {
  const call = revalidateTagMock.mock.calls.find(([calledTag]) => calledTag === tag);
  expect(call, `${tag} 가 무효화되지 않았다`).toBeDefined();
  return call![1];
}

beforeEach(() => revalidateTagMock.mockReset());

describe("revalidateCrmTags — 무효화 방식", () => {
  it("캠페인 쓰기: 정산 태그는 즉시 만료, 요약 태그는 종전대로 max", () => {
    revalidateCampaignCaches();
    expect(profileFor(CRM_CACHE_TAGS.settlement)).toEqual({ expire: 0 });
    expect(profileFor(CRM_CACHE_TAGS.dashboard)).toBe("max");
  });

  it("주문 동기화 크론 등 다른 쓰기 경로도 같은 규칙을 탄다(태그가 방식을 정한다)", () => {
    revalidateCrmTags(ORDER_SYNC_INVALIDATION_TAGS);
    expect(profileFor(CRM_CACHE_TAGS.settlement)).toEqual({ expire: 0 });
    expect(profileFor(CRM_CACHE_TAGS.pipeline)).toBe("max");
  });

  it("즉시 만료 집합에는 정산 태그가 있어야 한다 — 비우면 사고가 돌아온다", () => {
    expect(IMMEDIATE_EXPIRY_TAGS.has(CRM_CACHE_TAGS.settlement)).toBe(true);
  });
});
