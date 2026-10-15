/**
 * WRITE 액션 커밋 후속 처리(캐시 무효화 + 캘린더 재동기화) 계약.
 *
 * 이 파일이 고정하는 불변식은 하나다 — **어시스턴트 경로의 쓰기가 정본 버튼 경로와
 * 같은 후속 처리를 받는다.** 종전에는 DB 쓰기만 복제되고 무효화·캘린더가 빠져 있어
 * "승인했는데 화면은 그대로"가 났다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidateCrmTagsMock = vi.fn();
const syncCampaignToCalendarMock = vi.fn();
const afterMock = vi.fn();
const autoMapOrderCampaignMock = vi.fn();
const fetchAndSyncCampaignsMock = vi.fn();

vi.mock("@/lib/cache-tags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-tags")>();
  return { ...actual, revalidateCrmTags: (...args: unknown[]) => revalidateCrmTagsMock(...args) };
});

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (cb: () => unknown) => afterMock(cb) };
});

vi.mock("@/lib/google-calendar-sync", () => ({
  syncCampaignToCalendar: (...args: unknown[]) => syncCampaignToCalendarMock(...args),
}));

vi.mock("@/lib/order-converter/mapping-service", () => ({
  autoMapOrderCampaign: (...args: unknown[]) => autoMapOrderCampaignMock(...args),
}));

vi.mock("@/app/order-converter/api/campaigns/campaigns-handler", () => ({
  fetchAndSyncCampaigns: (...args: unknown[]) => fetchAndSyncCampaignsMock(...args),
}));

const { applyWriteActionEffects } = await import("../write-action-effects");
const { WRITE_ACTIONS, resolveWriteActionEffects } = await import("../write-executor");
const { CAMPAIGN_INVALIDATION_TAGS, MASTER_DATA_INVALIDATION_TAGS } = await import("@/lib/cache-tags");

function result(refType: string, refId: string) {
  return { refType, refId, summary: "테스트 실행 결과" };
}

describe("applyWriteActionEffects", () => {
  beforeEach(() => {
    revalidateCrmTagsMock.mockReset();
    syncCampaignToCalendarMock.mockReset();
    afterMock.mockReset();
    autoMapOrderCampaignMock.mockReset();
    fetchAndSyncCampaignsMock.mockReset();
    autoMapOrderCampaignMock.mockResolvedValue(undefined);
    fetchAndSyncCampaignsMock.mockResolvedValue(undefined);
    syncCampaignToCalendarMock.mockResolvedValue({ ok: true });
    afterMock.mockImplementation((cb: () => unknown) => cb());
  });

  it("confirm_settlement: 정본 토글 경로와 같은 짝(캠페인 태그 무효화 + 캘린더 재동기화)을 수행한다", async () => {
    applyWriteActionEffects("confirm_settlement", result("CAMPAIGN", "campaign-1"));

    expect(revalidateCrmTagsMock).toHaveBeenCalledTimes(1);
    expect(revalidateCrmTagsMock).toHaveBeenCalledWith(CAMPAIGN_INVALIDATION_TAGS);
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(syncCampaignToCalendarMock).toHaveBeenCalledWith("campaign-1");
  });

  it("change_deal_status: 정본 딜 PATCH 경로와 같은 마스터데이터 태그를 무효화하고 캘린더는 건드리지 않는다", () => {
    applyWriteActionEffects("change_deal_status", result("DEAL", "deal-1"));

    expect(revalidateCrmTagsMock).toHaveBeenCalledWith(MASTER_DATA_INVALIDATION_TAGS);
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("add_entity_memo: 무효화 대상이 없다 — ActivityLog 를 읽는 캐시 표면이 없으므로 태그를 깨지 않는다", () => {
    applyWriteActionEffects("add_entity_memo", result("DEAL", "deal-1"));

    expect(revalidateCrmTagsMock).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("WRITE_ACTIONS 전 항목이 후속 처리 명세를 갖는다 (신규 액션 추가 시 누락 방지)", () => {
    for (const action of Object.keys(WRITE_ACTIONS)) {
      expect(() => resolveWriteActionEffects(action, result("CAMPAIGN", "campaign-1"))).not.toThrow();
    }
  });

  it("커밋 뒤에 도는 처리이므로 어떤 실패도 호출부로 던지지 않는다 (쓰기를 실패로 오분류시키지 않기 위함)", () => {
    revalidateCrmTagsMock.mockImplementation(() => {
      throw new Error("revalidate 폭발");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => applyWriteActionEffects("change_deal_status", result("DEAL", "deal-1"))).not.toThrow();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("미등록 action 이 들어와도 던지지 않고 로그만 남긴다", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => applyWriteActionEffects("nope", result("DEAL", "deal-1"))).not.toThrow();
    expect(consoleSpy).toHaveBeenCalled();
    expect(revalidateCrmTagsMock).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("캘린더 동기화 실패는 로그로만 남고 예외로 새지 않는다 (정본 경로와 동일한 fire-and-forget)", async () => {
    syncCampaignToCalendarMock.mockRejectedValue(new Error("calendar down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const pending: unknown[] = [];
    afterMock.mockImplementation((cb: () => unknown) => pending.push(cb()));
    applyWriteActionEffects("confirm_settlement", result("CAMPAIGN", "campaign-1"));
    await Promise.all(pending);

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

/**
 * 상품 매핑 등록(`upsert_product_mappings`) — 화면 저장(캠페인 PUT 라우트)과 같은 후속 처리.
 * 화면은 커밋 뒤 `autoMapOrderCampaign(id).then(() => fetchAndSyncCampaigns(false)).catch(로그)` 를
 * fire-and-forget 으로 부르고 캐시 태그는 하나도 깨지 않는다.
 */
describe("applyWriteActionEffects — upsert_product_mappings 자동 연결", () => {
  // 새 줄을 만든 실행 결과 — 자동 연결은 새 줄이 있을 때만 돈다(createdCount 0 이면 건너뜀).
  const created = (refId: string, createdCount = 1) => ({ ...result("ORDER_CAMPAIGN", refId), createdCount });

  beforeEach(() => {
    revalidateCrmTagsMock.mockReset();
    syncCampaignToCalendarMock.mockReset();
    afterMock.mockReset();
    autoMapOrderCampaignMock.mockReset();
    fetchAndSyncCampaignsMock.mockReset();
    autoMapOrderCampaignMock.mockResolvedValue(undefined);
    fetchAndSyncCampaignsMock.mockResolvedValue(undefined);
  });

  // 집행은 동적 import 를 거치는 fire-and-forget 이라 마이크로태스크 몇 번으로는 끝나지 않는다.
  async function flush() {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it("주문캠페인 id 로 자동 매핑을 1회 부르고 이어서 동기화한다 (캐시 태그·캘린더는 건드리지 않는다)", async () => {
    applyWriteActionEffects("upsert_product_mappings", created("oc-1"));
    await flush();

    expect(autoMapOrderCampaignMock).toHaveBeenCalledTimes(1);
    expect(autoMapOrderCampaignMock).toHaveBeenCalledWith("oc-1");
    expect(fetchAndSyncCampaignsMock).toHaveBeenCalledTimes(1);
    expect(fetchAndSyncCampaignsMock).toHaveBeenCalledWith(false);
    expect(revalidateCrmTagsMock).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("새로 만든 줄이 없으면(고치기만 한 기안) 자동 매핑도 동기화도 부르지 않는다", async () => {
    applyWriteActionEffects("upsert_product_mappings", created("oc-1", 0));
    await flush();

    expect(autoMapOrderCampaignMock).not.toHaveBeenCalled();
    expect(fetchAndSyncCampaignsMock).not.toHaveBeenCalled();
  });

  it("다른 액션은 자동 매핑을 부르지 않는다 (선택 칸이라 기존 액션은 영향 없음)", async () => {
    applyWriteActionEffects("change_deal_status", result("DEAL", "deal-1"));
    applyWriteActionEffects("confirm_settlement", result("CAMPAIGN", "campaign-1"));
    await flush();

    expect(autoMapOrderCampaignMock).not.toHaveBeenCalled();
    expect(fetchAndSyncCampaignsMock).not.toHaveBeenCalled();
  });

  it("자동 매핑이 reject 해도 던지지 않고 에러를 1회 로그하며 동기화는 건너뛴다 (PUT 라우트와 동일)", async () => {
    autoMapOrderCampaignMock.mockRejectedValue(new Error("mapping down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      applyWriteActionEffects("upsert_product_mappings", created("oc-1"))
    ).not.toThrow();
    await flush();

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0][0]).toBe("Auto-mapping or sync failed:");
    expect(fetchAndSyncCampaignsMock).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("동기화가 reject 해도 던지지 않고 에러를 1회 로그한다", async () => {
    fetchAndSyncCampaignsMock.mockRejectedValue(new Error("sync down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      applyWriteActionEffects("upsert_product_mappings", created("oc-1"))
    ).not.toThrow();
    await flush();

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it("upsert_product_mappings 명세: 태그·캘린더 없음 + 결과 refId 로 자동 연결 대상 지정", () => {
    const spec = resolveWriteActionEffects("upsert_product_mappings", created("oc-9", 3));
    expect(spec.revalidate).toEqual([]);
    expect(spec.calendarCampaignId).toBeNull();
    expect(spec.autoMapOrderCampaignId).toBe("oc-9");
  });
});
