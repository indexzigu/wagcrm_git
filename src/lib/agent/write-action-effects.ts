/**
 * WRITE 액션 **커밋 이후** 후속 처리 집행기 — 캐시 무효화 + 구글 캘린더 재동기화 + 주문캠페인 판매 딜
 * 자동 연결(`autoMapOrderCampaign`, 명세가 `autoMapOrderCampaignId` 를 줄 때만 · 지금은 새 줄을 만든 상품
 * 매핑 기안뿐). 자동 연결은 캠페인 편집 화면 저장과 같은 전체 재채점이라 기존 줄의 연결도 바꿀 수 있다.
 *
 * ## 왜 별도 모듈인가
 *
 * `write-executor.ts` 는 트랜잭션 **안**에서 돌기 때문에 여기 있는 일을 할 수 없다:
 * 롤백되는 실행이 캐시를 깨고 캘린더를 갱신하면 반쪽 반영이 남는다. 그래서 실행기는
 * **명세(`WriteActionEffectSpec`)만 선언**하고, 집행은 커밋 뒤 라우트가 이 함수로 한다
 * (「외부 IO 는 라우트의 `after()` 가 소유한다」 — `docs/agents/codebase-map.md`).
 *
 * 집행 로직을 호출부에 손으로 복제하지 않는다 — 이 결함 자체가 정본 경로의 후속 처리를
 * 복제하다 절반을 빠뜨려서 생겼다(종전 호출부는 둘이었다: 승인 라우트와 은퇴한 채팅
 * 자동승인 경로).
 *
 * ## 왜 던지지 않는가
 *
 * 이 함수가 도는 시점에 **DB 쓰기는 이미 커밋됐다.** 여기서 던지면 호출부의 실패
 * 분류 로직이 그 쓰기를 「실행 실패」로 오분류해 기안을 FAILED 로 되돌리고, 운영자는
 * 이미 반영된 정산을 재시도하게 된다. 그래서 실패는 예외가 아니라 `console.error`
 * 로 보고한다(삼키는 것이 아니라 보고 채널을 바꾸는 것 — 정본 토글 경로의 캘린더
 * 훅도 같은 fire-and-forget 이다).
 */
import { after } from "next/server";
import { revalidateCrmTags } from "@/lib/cache-tags";
import { syncCampaignToCalendar } from "@/lib/google-calendar-sync";
import { resolveWriteActionEffects, type WriteActionResult } from "./write-executor";

export function applyWriteActionEffects(action: string, result: WriteActionResult): void {
  try {
    const spec = resolveWriteActionEffects(action, result);

    // 무효화는 응답 전에 동기로 — 정본 경로(`revalidateCampaignCaches()`)와 같은 시점이다.
    if (spec.revalidate.length > 0) {
      revalidateCrmTags(spec.revalidate);
    }

    // 주문캠페인 매핑 저장 뒤 판매 딜 자동 연결 — 화면 저장(캠페인 PUT 라우트)과 같은 호출·같은
    // fire-and-forget·같은 로그다. 실패해도 이미 커밋된 쓰기를 실패로 만들지 않는다.
    // ⚠️ 두 모듈은 **동적 import** 다 — `order-converter/prisma` 가 import 시점에 `getPrisma()` 를
    // 실행하므로 정적으로 걸면 이 집행기를 import 하는 모든 곳(승인 라우트·크론·테스트)이 이 액션과
    // 무관하게 Prisma 클라이언트를 즉시 만든다. 이 액션이 실제로 돌 때만 로드한다.
    const orderCampaignId = spec.autoMapOrderCampaignId;
    if (orderCampaignId) {
      Promise.all([
        import("@/lib/order-converter/mapping-service"),
        import("@/app/order-converter/api/campaigns/campaigns-handler"),
      ])
        .then(([{ autoMapOrderCampaign }, { fetchAndSyncCampaigns }]) =>
          autoMapOrderCampaign(orderCampaignId).then(() => fetchAndSyncCampaigns(false))
        )
        .catch(e => console.error("Auto-mapping or sync failed:", e));
    }

    // 캘린더는 외부 IO 라 `after()` 로 응답 밖으로 뺀다. 실패해도 쓰기를 막지 않는다.
    const campaignId = spec.calendarCampaignId;
    if (campaignId) {
      after(async () => {
        try {
          const syncResult = await syncCampaignToCalendar(campaignId);
          if (!syncResult.ok && !syncResult.skipped) {
            console.error(
              `[calendar-sync] 캠페인 ${campaignId} ${action} 후속 동기화 실패:`,
              syncResult
            );
          }
        } catch (calendarError) {
          console.error(`[calendar-sync] 캠페인 ${campaignId} ${action} 후속 훅 실패:`, calendarError);
        }
      });
    }
  } catch (err) {
    console.error(
      `[write-action-effects] ${action} 후속 처리 실패 (쓰기는 이미 커밋됨 — 재시도 대상 아님):`,
      err
    );
  }
}
