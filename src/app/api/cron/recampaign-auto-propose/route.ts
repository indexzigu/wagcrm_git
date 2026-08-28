import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { getPrisma } from "@/lib/prisma";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";
import { loadAutoProposableRerunPairs } from "@/lib/deal-seller-candidates-query";
import {
  buildDealMatchProposalInput,
  buildProposalDedupeKey,
  readProposalDedupeKey,
  RECAMPAIGN_REQUEST_TYPE,
} from "@/lib/recampaign-proposal";
import { buildProposalHistory, selectProposable } from "@/lib/proposal-idempotency";
import { ActionProposalRepository } from "@/repositories/actionProposalRepository";
import type { Prisma } from "@prisma/client";

// 재진행 적기 자동 기안 (F1 3단계) — 하루 한 번 훑어 **재진행 시점이 온 (셀러×딜) 조합**을
// 승인 대기 기안으로 올린다. 승인하면 셀러에 재접촉 결정이 메모로 남는다(내부 기록 —
// 셀러에게 나가는 것은 없다).
//
// ## 점검 주기와 행동 조건은 분리돼 있다 (멱등성 4종 세트의 전제)
//
// 매일 **점검**하되, 기안은 아래를 전부 만족할 때만 한다:
//   · 재진행 간격 도래 + 쌍 매출이 D3 문턱 이상 (`loadAutoProposableRerunPairs`)
//   · 같은 키의 열린 기안 없음 · 쿨다운 창 밖 (`selectProposable`)
// 둘을 뭉개면 창을 놓치거나 스팸이 된다.
//
// ## 멱등성 4종 세트
//   ① 마지막 실행 마커 → `withSystemTaskStatus` 가 `SystemTaskStatus` 에 기록
//   ② 중복 제거 키     → `buildProposalDedupeKey`(셀러+사유+딜)
//   ③ 쿨다운 창        → `PROPOSAL_COOLDOWN_DAYS`
//   ④ '이미 처리' 집합 → 이력 조회가 **상태를 가리지 않는다**(거부·승인·실행 전부 처리됨)

// 기안 생성은 건당 쓰기 1회라 상한 안쪽이면 짧다. 조회가 전 캠페인 groupBy 1회 + 소규모
// 3건이라 기본값(300)이면 충분하다 — 다른 크론과 같은 상한을 명시해 둔다.
export const maxDuration = 300;

/**
 * 한 회차 기안 상한.
 *
 * 실측상 1일차 대상은 한 자릿수이고 이후엔 새로 도래하는 것만 뜨므로 평시엔 걸리지 않는다.
 * 그럼에도 두는 이유는 **데이터 결함이 상시 폭주로 번지는 것**을 막기 위해서다(임포트로
 * 과거 캠페인이 대량 유입되는 등). ⚠️ 상한에 걸려 빠진 수는 응답에 남긴다 — 조용한 절단은
 * "전부 처리했다"로 읽힌다.
 */
const MAX_PROPOSALS_PER_RUN = 10;

const OPEN_OR_CLOSED_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "EXECUTED",
  "REJECTED",
  "FAILED",
];

async function handler(request: Request): Promise<Response> {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const prisma = getPrisma();
  const now = new Date();

  const candidates = await loadAutoProposableRerunPairs(prisma, now);
  if (candidates.length === 0) {
    return NextResponse.json({
      checked: 0,
      created: 0,
      skippedOpen: 0,
      skippedCooldown: 0,
      droppedByCap: 0,
    });
  }

  // ②③④ — 후보 셀러들의 기안 이력을 상태 구분 없이 가져와 키 단위로 접는다.
  // `updatedAt` 을 활동 시각으로 쓴다: 오래 전에 올라와 **어제 거부된** 기안을 생성 시각
  // 으로 재면 쿨다운이 이미 지나 하루 만에 다시 올라온다.
  const sellerIds = Array.from(new Set(candidates.map((c) => c.sellerId)));
  const historyRows = await prisma.actionProposal.findMany({
    where: {
      requestType: RECAMPAIGN_REQUEST_TYPE,
      targetEntityType: "SELLER",
      targetEntityId: { in: sellerIds },
      status: { in: OPEN_OR_CLOSED_STATUSES },
    },
    select: { targetEntityId: true, structuredResult: true, status: true, updatedAt: true },
  });
  const history = buildProposalHistory(
    historyRows.flatMap((row) => {
      const dedupeKey = readProposalDedupeKey(row);
      return dedupeKey === null
        ? []
        : [{ dedupeKey, status: row.status, lastActivityAt: row.updatedAt }];
    }),
  );

  const selection = selectProposable(
    candidates,
    (c) =>
      buildProposalDedupeKey({
        sellerId: c.sellerId,
        reason: "SAME_DEAL_RERUN",
        dealId: c.dealId,
      }),
    history,
    { now, cap: MAX_PROPOSALS_PER_RUN },
  );

  const createdIds: string[] = [];
  for (const candidate of selection.selected) {
    const input = buildDealMatchProposalInput({
      sellerId: candidate.sellerId,
      sellerName: candidate.sellerName,
      dealId: candidate.dealId,
      dealName: candidate.dealName,
      reason: "SAME_DEAL_RERUN",
      // 이 스윕은 D3 문턱을 이미 통과한 것만 담는다 — 전부 적극 검토 대상이다.
      priority: true,
      pairRunCount: candidate.pairRunCount,
      pairDaysSinceLastRun: candidate.pairDaysSinceLastRun,
      pairSalesTotal: candidate.pairSalesTotal,
    });
    const created = await ActionProposalRepository.create(
      input as unknown as Prisma.ActionProposalUncheckedCreateInput,
    );
    createdIds.push(created.id);
  }

  if (createdIds.length > 0) revalidateMasterDataCaches();

  return NextResponse.json({
    checked: candidates.length,
    created: createdIds.length,
    skippedOpen: selection.skippedOpen,
    skippedCooldown: selection.skippedCooldown,
    // 상한 절단을 조용히 넘기지 않는다.
    droppedByCap: selection.droppedByCap,
  });
}

// 래퍼가 **핸들러를 감싼 함수**를 돌려준다 — 핸들러 안에서 부르고 그 반환값을 응답으로
// 쓰면 라우트가 Response 대신 함수를 내보낸다(타입 검사가 잡는다).
// 래퍼는 시크릿이 일치하는 진짜 크론 호출만 상태에 기록한다(프리렌더·무단 접근 제외).
export const GET = withSystemTaskStatus("recampaign-auto-propose", handler);
