import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { loadDealSellerCandidates } from "@/lib/deal-seller-candidates-query";
import {
  RECAMPAIGN_REQUEST_TYPE,
  buildProposalDedupeKey,
  readProposalDedupeKey,
} from "@/lib/recampaign-proposal";

// GET /api/deals/[id]/seller-candidates — 이 딜에 제안할 셀러 후보(D2①, 읽기 전용).
//
// 집계·판정은 `deal-seller-candidates-query.ts` → `deal-seller-matching.ts` SSOT 에 있다.
// 이 라우트가 더하는 것은 인증 게이트와 **'이미 기안됨' 표시**뿐이다.

type Context = { params: Promise<{ id: string }> };

const OPEN_STATUSES = ["DRAFT", "PENDING_APPROVAL"];

export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const prisma = getPrisma();
  const now = new Date();

  const { deal, candidates } = await loadDealSellerCandidates(prisma, id, now);
  if (!deal) {
    return NextResponse.json({ error: "딜을 찾을 수 없습니다" }, { status: 404 });
  }

  // 열린 기안의 dedup 키 집합 — 버튼을 '기안됨'으로 바꾸는 근거.
  // ⚠️ 셀러 단위가 아니라 **키 단위**다. 같은 셀러라도 다른 딜·다른 사유면 따로 기안된다.
  const openProposals = await prisma.actionProposal.findMany({
    where: {
      requestType: RECAMPAIGN_REQUEST_TYPE,
      status: { in: OPEN_STATUSES },
      targetEntityType: "SELLER",
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
        buildProposalDedupeKey({ sellerId: c.sellerId, reason: c.reason, dealId: deal.id }),
      ),
    })),
  });
}
