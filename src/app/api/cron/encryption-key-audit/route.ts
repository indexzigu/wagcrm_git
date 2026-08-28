import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { getPrisma } from "@/lib/prisma";
import { runEncryptionKeyAudit } from "@/lib/encryption-audit";
import { verifyCronAuth } from "@/lib/cron-auth";

// 주민등록번호 암호화 키 정합 감사 크론 (매일 17:30 UTC = 02:30 KST).
//
// 이 크론이 존재하는 이유는 **이 실패가 무증상**이기 때문이다(2026-08-13 실사고).
// 대량 조회 경로의 `decryptOrNull()` 은 복호화 실패를 `console.warn` 으로 남기고 빈칸을
// 돌려준다 — 그 설계는 유지해야 하지만(한 행이 프리렌더를 죽이면 피해가 원인보다 크다),
// 대가로 "키가 데이터와 어긋난 상태"가 화면에서 미입력과 구분되지 않는다. 실제로 그
// 상태를 며칠간 아무도 몰랐고 빌드 로그를 우연히 읽다가 발견했다.
//
// ⚠️ **실행 위치가 이 감사의 핵심이다.** 검사해야 하는 것은 "앱이 지금 쓰는
// `ENCRYPTION_KEY` × 앱이 지금 붙은 DB" 쌍이다. 개발 머신의 스크립트나 CI 는 그 쌍을
// 볼 수 없다(preflight 는 2026-08-13 부로 일회용 Postgres 로 빌드한다 — 프로덕션
// 데이터가 아예 없다). 그래서 배포된 프로세스 안에서 도는 크론이다.
//
// 부수효과 0 — `Seller` 읽기뿐이고 외부 호출·쓰기가 없다. 실패해도 되돌릴 게 없다.

async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const prisma = getPrisma();
  const result = await runEncryptionKeyAudit({
    countSellers: () => prisma.seller.count(),
    listStoredValues: async () => {
      const rows = await prisma.seller.findMany({
        where: { residentNumber: { not: null } },
        select: { id: true, residentNumber: true },
      });
      return rows.map((row) => ({ id: row.id, value: row.residentNumber }));
    },
  });

  // ⚠️ HTTP 200 이어도 어긋났으면 **실패로 선언**한다(`failed: true`) — 그래야 시스템
  // 레이더가 빨강이 된다. 200 을 그냥 돌려주면 "매일 도는데 아무도 안 보는 초록"이 되어
  // 이 크론을 만든 의미가 사라진다(withSystemTaskStatus 의 CronOutcomeBody 계약).
  if (result.status === "degraded") {
    // 값·키는 남기지 않는다(P0) — 개수와 셀러 id 뿐이다.
    console.error("[encryption-key-audit] 키 정합 이상:", result.summary);
    return NextResponse.json({
      ...result,
      failed: true,
      failureReason:
        `주민등록번호가 현재 ENCRYPTION_KEY 로 열리지 않는다. ${result.summary}. ` +
        "구 키를 회수할 수 있으면 P6 「암호화 키 교체 런북」대로 ENCRYPTION_KEY_PREVIOUS 등록 → 재암호화, 아니면 해당 셀러의 값을 다시 입력해야 한다.",
    });
  }

  if (result.status === "broken") {
    console.error("[encryption-key-audit] 감사 불능:", result.reason);
    return NextResponse.json({
      ...result,
      failed: true,
      failureReason: `감사기가 판정하지 못한다. ${result.reason}`,
    });
  }

  // skipped(sqlite·데모)·empty(검사 대상 0건)는 실패가 아니다 — 사유는 본문에 남는다.
  return NextResponse.json(result);
}

export const GET = withSystemTaskStatus("encryption-key-audit", handler);
