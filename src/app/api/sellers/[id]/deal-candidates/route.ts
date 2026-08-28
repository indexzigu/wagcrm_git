import { NextResponse } from "next/server";
import type { DealStatus } from "@prisma/client";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { RUN_STATUSES } from "@/lib/recampaign-timing";
import {
  buildPairRunSignals,
  rankDealCandidatesForSeller,
  type PairRunRow,
} from "@/lib/deal-seller-matching";
import {
  RECAMPAIGN_REQUEST_TYPE,
  buildProposalDedupeKey,
  readProposalDedupeKey,
} from "@/lib/recampaign-proposal";

// GET /api/sellers/[id]/deal-candidates — 이 셀러에게 제안할 딜 후보(D2②, 읽기 전용).
//
// 후보 풀에서 옵션 딜(`parentDealId != null`)은 뺀다 — 본품에 딸린 변형이라 제안 단위가
// 아니다(C2 오퍼 진단의 "본품 단위로 성립한다"와 같은 규약).
//
// 🪤 **딜 상태 라벨을 영문 이름으로 짐작하지 말 것** — `ARCHIVED` 는 "완료"이고
// `DROPPED` 는 "보류"다(`dealStatusLabels`). 그래서 풀이 두 겹이다:
//   · 신규 제안 = 살아 있는 딜(`LIVE_DEAL_STATUSES`)
//   · 재진행    = 이 셀러가 전에 돌린 딜이면 **완료된 딜도 포함**(D3 의 주 모집단이다)
// 보류(`DROPPED`)만 양쪽에서 제외한다.

type Context = { params: Promise<{ id: string }> };

const OPEN_STATUSES = ["DRAFT", "PENDING_APPROVAL"];

/** 파이프라인에 살아 있어 **새로 제안할 수 있는** 딜 상태. */
const LIVE_DEAL_STATUSES: DealStatus[] = [
  "SOURCING",
  "NEGOTIATING",
  "CONFIRMED",
  "SAMPLE_TESTING",
];
/** 후보 풀에 아예 올리지 않는 상태 — 오너가 의도적으로 세워둔 딜. */
const EXCLUDED_DEAL_STATUSES: DealStatus[] = ["DROPPED"];

export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const prisma = getPrisma();
  const now = new Date();

  const seller = await prisma.seller.findUnique({ where: { id }, select: { id: true } });
  if (!seller) {
    return NextResponse.json({ error: "셀러를 찾을 수 없습니다" }, { status: 404 });
  }

  const [runRows, candidatePool, allDeals, linkedTasks] = await Promise.all([
    prisma.salesCampaign.groupBy({
      by: ["sellerId", "dealId", "groupId"],
      // 이 셀러분만 — 딜 쪽 라우트와 달리 스코프를 좁힐 수 있다(P7 egress).
      where: { sellerId: id, status: { in: [...RUN_STATUSES] }, startDate: { lte: now } },
      _count: { _all: true },
      _max: { startDate: true },
      _sum: { actualSales: true },
    }),
    prisma.deal.findMany({
      where: { status: { notIn: EXCLUDED_DEAL_STATUSES }, parentDealId: null },
      select: {
        id: true,
        dealName: true,
        brandName: true,
        partnerId: true,
        status: true,
        createdAt: true,
      },
    }),
    // 과거 진행 딜의 거래처는 후보 풀(진행 가능 딜) 밖에도 있으므로 전 딜의 거래처가 필요하다.
    prisma.deal.findMany({ select: { id: true, partnerId: true } }),
    // 이미 아웃리치가 있는 조합은 후보가 아니다 — 딜→셀러 방향의 제외와 같은 모수다.
    prisma.salesTask.findMany({ where: { sellerId: id }, select: { dealId: true } }),
  ]);

  const rows: PairRunRow[] = runRows.map((r) => ({
    sellerId: r.sellerId,
    dealId: r.dealId,
    groupId: r.groupId,
    rowCount: r._count._all,
    lastStartAt: r._max.startDate,
    // 전 행 미입력이면 Prisma 가 null 을 준다 — **0 으로 바꾸지 않는다**.
    salesSum: r._sum.actualSales == null ? null : Number(r._sum.actualSales),
  }));

  const candidates = rankDealCandidatesForSeller({
    sellerId: id,
    deals: candidatePool.map((d) => ({
      dealId: d.id,
      dealName: d.dealName,
      brandName: d.brandName,
      partnerId: d.partnerId,
      isLive: LIVE_DEAL_STATUSES.includes(d.status),
      createdAt: d.createdAt.toISOString(),
    })),
    pairs: buildPairRunSignals(rows, new Map(allDeals.map((d) => [d.id, d.partnerId])), now),
    excludeDealIds: linkedTasks.map((t) => t.dealId),
    now,
  });

  // 열린 기안의 dedup 키 집합 — 버튼을 '기안됨'으로 바꾸는 근거.
  // ⚠️ 셀러 단위가 아니라 **키 단위**다. 이 셀러에 다른 딜·다른 사유의 기안이 열려 있어도
  // 이 딜 제안은 막지 않는다(과차단 방지가 2단계의 목적이다).
  const openProposals = await prisma.actionProposal.findMany({
    where: {
      requestType: RECAMPAIGN_REQUEST_TYPE,
      targetEntityType: "SELLER",
      targetEntityId: id,
      status: { in: OPEN_STATUSES },
    },
    select: { targetEntityId: true, structuredResult: true },
  });
  const openKeys = new Set(
    openProposals.map(readProposalDedupeKey).filter((k): k is string => k !== null),
  );

  return NextResponse.json({
    candidates: candidates.map((c) => ({
      ...c,
      proposed: openKeys.has(
        buildProposalDedupeKey({ sellerId: id, reason: c.reason, dealId: c.dealId }),
      ),
    })),
  });
}
