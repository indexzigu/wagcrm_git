import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { getPrisma } from "@/lib/prisma";
import { runDbExposureAudit } from "@/lib/db-exposure-audit";
import { verifyCronAuth } from "@/lib/cron-auth";

// Supabase Data API 노출 감사 크론 (매일 17:00 UTC = 02:00 KST).
//
// 이 크론이 존재하는 이유는 **레포 안의 가드가 볼 수 없는 것**을 보기 위해서다.
// `rls-coverage.contract.test.ts`(#193)는 마이그레이션 파일을 대조하므로 "우리가 켜기를
// 빠뜨렸나"는 막지만, 방어가 **DB 쪽에서** 벗겨지는 것은 레포에 흔적이 없다.
// `20260716130000_revoke_public_grants_from_anon` 이 경고한 무증상 되돌림(Supabase 플랫폼
// 업그레이드의 기본권한 재부여)이 정확히 그 경우다 — 되돌아가도 앱은 멀쩡히 돈다
// (Prisma 는 postgres 롤이라 그랜트·RLS 무관). 사람이 알아차릴 계기가 없으므로 기계가 본다.
//
// 부수효과 0 — 카탈로그 조회뿐이라 외부 호출·쓰기가 없다. 실패해도 되돌릴 게 없다.

async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runDbExposureAudit(getPrisma());

  // ⚠️ HTTP 200 이어도 드리프트면 **실패로 선언**한다(`failed: true`) — 그래야 시스템
  // 레이더가 빨강이 된다. 200 을 그냥 돌려주면 "매일 도는데 아무도 안 보는 초록"이 되어
  // 이 크론을 만든 의미가 사라진다(withSystemTaskStatus 의 CronOutcomeBody 계약).
  if (result.status === "drift") {
    console.error("[db-exposure-audit] 노출 방어 드리프트:", result.summary);
    return NextResponse.json({
      ...result,
      failed: true,
      failureReason: `Supabase 노출 방어가 벗겨졌다. ${result.summary}`,
    });
  }

  if (result.status === "broken") {
    console.error("[db-exposure-audit] 감사 불능:", result.reason);
    return NextResponse.json({
      ...result,
      failed: true,
      failureReason: `감사기가 대상을 보지 못한다. ${result.reason}`,
    });
  }

  // skipped(sqlite·비 Supabase)는 실패가 아니다 — 이 불변식이 존재하지 않는 환경이다.
  return NextResponse.json(result);
}

export const GET = withSystemTaskStatus("db-exposure-audit", handler);
