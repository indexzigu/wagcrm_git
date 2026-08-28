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
