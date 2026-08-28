/**
 * WRITE 액션 **커밋 이후** 후속 처리 집행기 — 캐시 무효화 + 구글 캘린더 재동기화.
 *
 * ## 왜 별도 모듈인가
 *
 * `write-executor.ts` 는 트랜잭션 **안**에서 돌기 때문에 여기 있는 일을 할 수 없다:
 * 롤백되는 실행이 캐시를 깨고 캘린더를 갱신하면 반쪽 반영이 남는다. 그래서 실행기는
 * **명세(`WriteActionEffectSpec`)만 선언**하고, 집행은 커밋 뒤 라우트가 이 함수로 한다
 * (「외부 IO 는 라우트의 `after()` 가 소유한다」 — `docs/agents/codebase-map.md`).
 *
 * 호출부가 둘(`POST /api/action-proposals/[id]/approve` · `POST /api/assistant` 자동승인)
 * 이라 집행 로직을 각 라우트에 손으로 복제하지 않는다 — 이 결함 자체가 정본 경로의
 * 후속 처리를 복제하다 절반을 빠뜨려서 생겼다.
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
