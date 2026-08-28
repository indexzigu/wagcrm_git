import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";
import { computeRecampaignAlerts } from "@/lib/recampaign-timing";
import { loadDealSellerCandidates } from "@/lib/deal-seller-candidates-query";
import {
  buildDealMatchProposalInput,
  buildProposalDedupeKey,
  buildRecampaignProposalInput,
  readProposalDedupeKey,
  RECAMPAIGN_REQUEST_TYPE,
  type ProposalReason,
} from "@/lib/recampaign-proposal";
import { ActionProposalRepository } from "@/repositories/actionProposalRepository";
import type { Prisma } from "@prisma/client";

// POST /api/recampaign-proposals — 후보 하나를 승인 대기 기안으로 승격한다.
//
// 두 생산 경로가 이 라우트를 공유한다:
//   · `dealId` 없음 → 재캠페인 적기 카드(개인 케이던스). DUE 만 허용. 사유 `CADENCE_DUE`
//   · `dealId` 있음 → 딜↔셀러 양방향 검토(D2). 사유는 매칭 SSOT 가 정한다
//
// 🔴 **중복 제거 키는 `셀러id + 사유코드 + 딜id` 다**(멱등성 4종 세트 ②). 종전 키는
//    `셀러id` 단독이었고, 딜 차원이 들어온 뒤로는 **과차단**이다 — "이 셀러에 열린 기안이
//    있음" 하나로 서로 다른 딜 제안이 전부 막힌다. 키 정의는 `recampaign-proposal.ts` SSOT.
//
// 정밀도 가드(승인함 마비 방지)는 그대로다: 상태·후보 자격을 **서버가 재계산해 검증**하고
// (클라이언트가 보낸 값 불신) 같은 키의 열린 기안이 있으면 새로 만들지 않는다.

const OPEN_STATUSES = ["DRAFT", "PENDING_APPROVAL"];

function readStringField(body: unknown, key: string): string {
  if (!body || typeof body !== "object" || !(key in body)) return "";
  const value = (body as Record<string, unknown>)[key];
  return value == null ? "" : String(value);
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const sellerId = readStringField(body, "sellerId");
  const dealId = readStringField(body, "dealId");
  if (!sellerId) {
    return NextResponse.json({ error: "sellerId가 필요합니다." }, { status: 400 });
  }

  const prisma = getPrisma();
  const now = new Date();

  // 서버 권위 재계산 — 무엇을 기안할지와 **사유 코드**를 여기서 확정한다.
  // 사유는 dedup 키의 축이므로 클라이언트가 정하게 두면 키를 우회할 수 있다.
  let reason: ProposalReason;
  let buildInput: () => ReturnType<typeof buildRecampaignProposalInput> | ReturnType<typeof buildDealMatchProposalInput>;

  if (dealId) {
    const { deal, candidates } = await loadDealSellerCandidates(prisma, dealId, now);
    if (!deal) {
      return NextResponse.json({ error: "딜을 찾을 수 없습니다." }, { status: 404 });
    }
    const candidate = candidates.find((c) => c.sellerId === sellerId);
    if (!candidate) {
      return NextResponse.json(
        { error: "해당 셀러는 이 딜의 현재 제안 후보가 아닙니다." },
        { status: 409 },
      );
    }
    const dealRecord = await prisma.deal.findUnique({
      where: { id: dealId },
      select: { dealName: true },
    });
    reason = candidate.reason;
    buildInput = () =>
      buildDealMatchProposalInput({
        sellerId: candidate.sellerId,
        sellerName: candidate.name,
        dealId: deal.id,
        dealName: dealRecord?.dealName ?? "딜",
        reason: candidate.reason,
        priority: candidate.priority,
        pairRunCount: candidate.pairRunCount,
        pairDaysSinceLastRun:
          candidate.pairLastRunStartAt === null
            ? null
            : Math.floor((now.getTime() - Date.parse(candidate.pairLastRunStartAt)) / 86_400_000),
        pairSalesTotal: candidate.pairSalesTotal,
      });
  } else {
    const campaigns = await prisma.salesCampaign.findMany({
      select: {
        sellerId: true,
        startDate: true,
        endDate: true,
        status: true,
        seller: { select: { name: true, alias: true, availabilityNote: true } },
      },
    });
    const alerts = computeRecampaignAlerts(
      campaigns.map((c) => ({
        sellerId: c.sellerId,
        startDate: c.startDate,
        endDate: c.endDate,
        status: c.status,
        sellerName: c.seller.name,
        sellerAlias: c.seller.alias,
        availabilityNote: c.seller.availabilityNote,
      })),
      now,
    );
    const alert = alerts.find((a) => a.sellerId === sellerId);
    if (!alert) {
      return NextResponse.json(
        { error: "해당 셀러는 현재 재캠페인 적기 대상이 아닙니다." },
        { status: 409 },
      );
    }
    if (alert.state !== "DUE") {
      return NextResponse.json(
        { error: "적기 도래(DUE) 셀러만 기안할 수 있습니다 (임박 셀러는 아직)." },
        { status: 409 },
      );
    }
    reason = "CADENCE_DUE";
    buildInput = () => buildRecampaignProposalInput(alert);
  }

  // 중복 제거 — 같은 (셀러, 사유, 딜) 조합의 열린 기안이 이미 있으면 새로 만들지 않는다.
  // 상태 스코프가 있는 dedup 이라 DB 유니크 제약이 아니라 조회 후 키 비교다.
  const dedupeKey = buildProposalDedupeKey({ sellerId, reason, dealId: dealId || null });
  const openForSeller = await prisma.actionProposal.findMany({
    where: {
      requestType: RECAMPAIGN_REQUEST_TYPE,
      targetEntityType: "SELLER",
      targetEntityId: sellerId,
      status: { in: OPEN_STATUSES },
    },
    select: { id: true, targetEntityId: true, structuredResult: true },
  });
  const existing = openForSeller.find((row) => readProposalDedupeKey(row) === dedupeKey);
  if (existing) {
    return NextResponse.json(
      {
        skipped: true,
        reason: "같은 사유의 승인 대기 기안이 이미 있습니다.",
        proposalId: existing.id,
      },
      { status: 200 },
    );
  }

  const created = await ActionProposalRepository.create(
    buildInput() as unknown as Prisma.ActionProposalUncheckedCreateInput,
  );

  revalidateMasterDataCaches();

  return NextResponse.json(
    { created: true, proposalId: created.id, title: created.title },
    { status: 201 },
  );
}
