import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import {
  collectInstagramFollowers,
  type InstagramCollectorConfig,
} from "@/lib/collectors/instagram-collector";
import { collectInstagramEngagement } from "@/lib/collectors/instagram-engagement-collector";
import { applyDbInstagramToken } from "@/lib/instagram-token";
import { declareTotalFailure } from "@/lib/cron-outcome";
import { SELLER_METRICS_INVALIDATION_TAGS, revalidateCrmTags } from "@/lib/cache-tags";
import { verifyCronAuth } from "@/lib/cron-auth";

// 감시 셀러 수 × Graph 1콜 + 간격을 소비하므로 명시 확장 (analyze 라우트와 동일 관례).
// 단 Hobby 플랜은 실행을 ~60s로 클램프하므로, 아래 ENGAGEMENT_BUDGET_MS로 지표 수집을
// 그 안쪽에 바운딩해 우선 완주시키고 2단계(프로필 보강)에 여유를 남긴다.
export const maxDuration = 300;
// Hobby ~60s 상한 아래 예산. 지표(ER·프로필)를 여기 안에서 완주시키고 나머지는 2단계·다음 주기로.
const ENGAGEMENT_BUDGET_MS = 45_000;

async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  try {
    const host = request.headers.get("host") || "localhost:3000";
    const protocol = host.includes("localhost") ? "http" : "https";
    const baseUrl = `${protocol}://${host}`;

    // F5: DB에 갱신된 토큰이 있으면 env를 덮어써 아래 config·하위 수집기가 최신 토큰 사용
    const tokenSource = await applyDbInstagramToken();

    const config: InstagramCollectorConfig = {
      appId: process.env.INSTAGRAM_APP_ID!,
      appSecret: process.env.INSTAGRAM_APP_SECRET!,
      accessToken: process.env.INSTAGRAM_ACCESS_TOKEN!,
      igBusinessAccountId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID!,
      baseUrl,
    };

    // 1단계: ER 적립 + 프로필 전체 갱신 (§11-3) — Tier0 BD 무료 1콜/셀러가
    //   팔로워·게시물수·bio·프로필사진·외부링크·ER을 한 번에 적립한다. "먼저" 돌려
    //   같은 BD 응답으로 2단계(경량 프로필 수집)의 중복 조회를 없앤다(오늘자 스냅샷을
    //   남기므로 2단계의 idempotency 게이트가 그 셀러를 자동 스킵).
    //   예산은 Hobby 함수 상한(~60s, maxDuration=300이 클램프됨) 아래로 잡아 우선 지표를
    //   완주시키고 2단계에 여유를 남긴다(enrich-references와 같은 접근). 잔여 셀러는
    //   deadlineReached로 이월되며, 크론이 **매일** 발화하므로 다음 날 같은 cutoff가
    //   그대로 이어받는다(2026-07-30 주간→매일 전환 전에는 이 이월이 일주일 지연이었다).
    const engagement = await collectInstagramEngagement({
      deadlineMs: startedAt + ENGAGEMENT_BUDGET_MS,
    });
    if (engagement.deadlineReached) {
      console.warn("[collect-instagram] ER 수집 데드라인 도달 — 잔여 셀러는 다음 주기로 이월");
    }

    // 2단계: 잔여 프로필 수집 — BD가 실패한 개인계정 등 1단계 미커버 셀러만 공개 스크래퍼로
    //   보강한다(1단계가 오늘자 스냅샷을 남긴 셀러는 idempotency 게이트로 스킵되어 재조회 없음).
    const result = await collectInstagramFollowers(config);

    // 이벤트 기반 무효화(2026-07-10): 팔로워·ER 갱신을 셀러 목록/상세·대시보드 모멘텀에 즉시 반영.
    revalidateCrmTags(SELLER_METRICS_INVALIDATION_TAGS);

    // ⚠️ HTTP 200 이어도 시도한 셀러가 전원 실패했으면 **실패로 선언**한다 — 선언이 없으면
    // `withSystemTaskStatus` 가 SUCCESS 로 기록한다(`CronOutcomeBody` 계약).
    // **두 단계를 합쳐 잰다** — 한 단계가 죽어도 다른 단계가 셀러를 갱신했으면 그 실행은
    // 헛돌지 않았다. 멱등 게이트로 건너뛴 셀러(`skippedCount`)와 데드라인 이월분은 시도가
    // 아니므로 넣지 않는다(넣으면 정상 이월이 매일 빨강이 된다).
    // ⚠️ 2단계의 시도는 `monitoredCount - skippedCount` 이지 `successCount + failedCount` 가
    // 아니다 — 모드 미설정처럼 **단계가 통째로 막히면 두 카운터가 모두 0**이고, 종전에는
    // 건너뛴 셀러까지 `successCount` 로 세서 실제 수집이 전량 실패한 날에도 그 값이 양수였다.
    // 어느 쪽이든 그 값으로 재면 이 선언이 발화하지 못한다.
    // 두 단계 모두 같은 식으로 잰다: 시도 = 감시 대상 - 멱등 스킵 - (1단계는) 데드라인 이월분.
    // ⚠️ 1단계도 `collectedCount + failedCount` 로 재면 안 된다 — Tier0 미설정으로 단계가
    // 막히면 둘 다 0인데, 직전까지 수집이 정상이었으면 2단계는 최근 스냅샷 때문에 **전원
    // 스킵**된다. 그러면 합산 시도가 0이 되어 **ER 수집이 죽은 채로 SUCCESS** 가 된다.
    // ⚠️ 반대로 데드라인 이월분은 손도 안 댄 것이라 시도에서 뺀다 — 넣으면 느린 날이 빨강이 된다.
    const attempted =
      (engagement.monitoredCount - engagement.skippedCount - engagement.deferredCount) +
      (result.monitoredCount - result.skippedCount);
    const succeeded = engagement.collectedCount + result.successCount;

    return NextResponse.json({
      ...result,
      engagement,
      tokenSource,
      ...declareTotalFailure({ attempted, succeeded, unit: "명", what: "인스타 수집" }),
    });
  } catch (error) {
    console.error("[collect-instagram] Unexpected error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export const GET = withSystemTaskStatus("collect-instagram", handler);
