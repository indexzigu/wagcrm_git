// 스토리 수집 **수동 폴백** 러너 — `capture-stories.command` 더블클릭으로 돈다.
//
// ⛔ **정규 실행 경로가 아니다(2026-08-19 레인 통합).** 지금 매일 발화하는 것은 셀프호스트
// crontab 의 `capture-stories`(KST 00:00 → `/api/cron/capture-stories`)이고, 수동 1회는 홈
// 화면 시스템 레이더의 「지금 실행」 버튼이다. 이 파일은 **앱이 떠 있지 않을 때**만 쓴다.
//
// 왜 한때 이것이 정규 경로였나(2026-08-04~08-19): 익명 뷰어의 프로필 API 가 Vercel 클라이언트에
// **CAPTCHA 를 요구했다**(실측 `status=422 CAPTCHA_REQUIRED`). 같은 코드·같은 헤드리스 브라우저가
// 주거용 IP 에서는 통과하므로 판별 변수는 IP 평판이었고, 캡차 우회는 쓰지 않으므로(collect-reviews
// 종결과 같은 선) 서버 크론을 내리고 오너 맥의 launchd 러너를 세웠다. **그 전제는 2026-08-13
// 셀프호스팅 컷오버로 소멸했다** — 앱 자체가 그 맥에서 도니 크론 경로도 주거용 IP 를 탄다.
// 레인을 되돌리기 전에 `src/lib/cron-jobs.ts` 의 lane 주석(별도 env 가 부른 6일 무음 실패)을 읽을 것.
//
// ⚠️ **상태 기록이 이 러너의 절반이다.** 종전 러너는 captureActiveCampaignStories 만 부르고
// withSystemTaskStatus 를 거치지 않아 레이더에 아무것도 남기지 않았다 — 서버에서 막 고친 무음
// 실패를 실행 위치만 바꿔 되사는 구조였다. 판정은 크론 라우트와 **같은 SSOT**
// (declareStoryCaptureOutcome)를 쓴다.
//
// 사전조건: .env 에 DATABASE_URL + Supabase(SUPABASE_URL/SERVICE_ROLE_KEY) — 저장·리호스팅용.
//   set -a; . .env; set +a; npx tsx scripts/capture-stories-local.ts
import { getPrisma } from "../src/lib/prisma";
import { captureActiveCampaignStories, declareStoryCaptureOutcome } from "../src/lib/story-capture";
import { recordSystemTaskRun } from "../src/lib/system-task-status";

const JOB_KEY = "capture-stories";

async function main() {
  const prisma = getPrisma();
  console.log("[스토리 수집] 시작 — 로컬 브라우저(집 IP)로 수집창 셀러 스토리 수집…");

  // 시작 마커 — 맥이 잠들거나 프로세스가 죽어 완주하지 못해도 RUNNING 행이 남아,
  // "아예 안 돌았음"(시각이 낡음)과 "돌다가 죽음"(RUNNING 고착)을 구분할 수 있다.
  await recordSystemTaskRun(JOB_KEY, "RUNNING", undefined);

  let result;
  try {
    result = await captureActiveCampaignStories(prisma);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordSystemTaskRun(JOB_KEY, "ERROR", message);
    throw error;
  }

  const outcome = declareStoryCaptureOutcome(result);
  await recordSystemTaskRun(
    JOB_KEY,
    outcome.failed ? "ERROR" : "SUCCESS",
    outcome.failed ? (outcome.failureReason ?? null) : null,
    // 응답 본문과 같은 페이로드를 남긴다 — 서버 레인과 이력 형태를 맞춰야
    // "어느 레인이 남긴 행인가"와 무관하게 같은 눈으로 읽을 수 있다.
    { ok: true, ...result, ...outcome, lane: "local" },
  );

  console.log("\n[스토리 수집] 완료");
  console.log(`  대상 셀러: ${result.activeSellers}명 (${result.handles.join(", ") || "-"})`);
  console.log(
    `  본 스토리: ${result.storiesSeen}건 · 신규 저장: ${result.storiesNew}건 · 썸네일: ${result.thumbnailsRehosted}건`,
  );
  if (result.errors.length) {
    console.log(`  경고 ${result.errors.length}건:`);
    for (const e of result.errors) console.log(`    - ${e}`);
  }
  if (outcome.failed) {
    // 전량 실패는 종료코드로도 드러낸다 — launchd 로그·래퍼가 성공으로 읽지 않게.
    console.error(`\n[스토리 수집] 실질 실패: ${outcome.failureReason}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nCRM /admin/stories 분류함에서 확인하세요.");
}

main().catch((e) => {
  console.error("[스토리 수집] 실패:", e);
  process.exit(1);
});
