import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import {
  diagnoseOffer,
  MANUAL_ROW_IDS,
  type ManualAnswer,
  type ManualRowId,
  type PriceVerdict,
} from "@/lib/offer/offer-diagnostic";
import { RUN_STATUSES } from "@/lib/recampaign-timing";
import { auditLaunchReadiness } from "@/lib/offer/launch-readiness";
import { checkText } from "@/lib/claims/claim-gate";
import {
  loadDealClaimContext,
  toGateClaims,
} from "@/lib/claims/deal-claim-context";
import {
  getDaysUntilStart,
  needsChannelAssignment,
  needsOrderRegistration,
} from "@/lib/campaign-setup";
import type { SalesChannel } from "@/lib/crm-types";
import { toKstDateStr } from "@/lib/campaign-row";

// Route segment config "dynamic"은 cacheComponents와 비호환이라 선언하지 않는다.

type Context = { params: Promise<{ id: string }> };

const KNOWN_PRICE_VERDICTS: readonly string[] = [
  "OK",
  "TIE",
  "VIOLATED",
  "NO_DATA",
];

/**
 * 공구 오픈 준비 감사 (C2 M4) — 읽기 전용.
 *
 * 캠페인 1건에 대해 **흩어진 자동 판정을 모아** SHIP/FIX/BLOCK 을 낸다.
 * 새 정보를 요구하지 않는다 — 표현 게이트(C1)·오퍼 진단(C2)·주문관리 등록은
 * 모두 이미 기록되는 것들이다(오너가 체크리스트 배지를 기각한 이유를 피한다).
 *
 * ⛔ 오픈을 막지 않는다. 판정을 돌려주는 것까지가 이 라우트의 일이다.
 */
export async function GET(_request: Request, { params }: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await params;
  const prisma = getPrisma();

  const campaign = await prisma.salesCampaign.findUnique({
    where: { id },
    select: {
      id: true,
      startDate: true,
      salesChannel: true,
      orderCampaignId: true,
      deal: {
        select: {
          id: true,
          parentDealId: true,
          dealName: true,
        },
      },
    },
  });
  if (!campaign) {
    return NextResponse.json(
      { error: "캠페인을 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  // 오퍼는 본품 단위로 성립한다 — 옵션 딜이면 부모로 올려 본다(C2 규약).
  const dealId = campaign.deal.parentDealId ?? campaign.deal.id;

  /**
   * ⚠️ **이 라우트는 서로 다른 두 상속 규약이 만나는 유일한 지점이다.**
   *
   * | 축 | 딜 기준 | 규약 |
   * | --- | --- | --- |
   * | 오퍼·가격(C2) | 위 `dealId` = `parentDealId ?? id` | 부모 **치환** — 오퍼는 본품 단위로 성립 |
   * | 표현 게이트(C1) | 아래 `loadDealClaimContext(자기 id)` | **합집합** — 표현 제약은 누적 |
   *
   * 같은 캠페인에서 두 값이 갈리는 것이 **정상이다.** 하나로 통일하면 둘 중
   * 하나가 반드시 깨진다 — 합집합으로 통일하면 옵션 딜이 오퍼를 따로 성립시키고,
   * 부모 치환으로 통일하면 옵션 딜의 **자기 전용 금지 표현이 게이트에서 무시**된다
   * (후자는 content-guide 라우트에서 실제로 난 사고다 — PR #151).
   */
  const [
    deal,
    snapshot,
    approvedClaims,
    requiredDisclosures,
    offerAnswers,
    priorRunCount,
  ] = await Promise.all([
      prisma.deal.findUnique({
        where: { id: dealId },
        select: {
          listPrice: true,
          sellingPrice: true,
          shippingFee: true,
          freeShippingThreshold: true,
          supplementaryInfo: true,
          options: { select: { id: true } },
        },
      }),
      prisma.priceMonitorSnapshot.findFirst({
        where: { dealId },
        orderBy: { snapshotDate: "desc" },
        select: { verdict: true },
      }),
      prisma.dealClaim.findMany({
        where: { dealId, kind: "APPROVED_CLAIM", status: "APPROVED" },
        select: { evidenceType: true },
      }),
      prisma.dealClaim.findMany({
        where: { dealId, kind: "REQUIRED_DISCLOSURE", status: "APPROVED" },
        select: { id: true, text: true },
      }),
      prisma.dealOfferAnswer.findMany({
        where: { dealId },
        select: { rowId: true, verdict: true, note: true },
      }),
      /**
       * 앵콜 이력 — **지금 감사 중인 캠페인은 뺀다.** 이미 ACTIVE 로 열린 건을
       * 세면 자기 자신을 검증 근거로 쓰는 셈이 된다.
       */
      prisma.salesCampaign.count({
        where: {
          id: { not: campaign.id },
          deal: { OR: [{ id: dealId }, { parentDealId: dealId }] },
          status: { in: [...RUN_STATUSES] },
          startDate: { lte: new Date() },
        },
      }),
    ]);

  /**
   * 표현 게이트(C1)의 입력 — **검사할 본문이 있을 때만** 판정한다.
   *
   * 감사 시점에 존재하는 본문은 **셀러에게 보낸 자료**(`DealAssetDraft`)다.
   * 최신 1건을 본다 — 여러 번 보냈으면 마지막이 지금 유효한 문안이다.
   *
   * ⛔ **저장된 `gateVerdict` 를 재사용하지 않는다.** 두 가지 이유로 다른
   * 질문에 답한 값이다: ①그것은 **생성 시점** 판정이라 그 뒤 `BannedPhraseRule`
   * 이 추가되면 낡는다(감사는 "**지금** 열어도 되나"를 묻는다) ②감사가 요구하는
   * `missingDisclosures` 는 애초에 저장돼 있지 않은데, 고지 누락은 **BLOCK 축의
   * 나머지 절반**이다. 그래서 본문을 현재 규칙으로 다시 판정한다.
   *
   * ⛔ **본문은 상속하지 않는다** — 위 표의 합집합은 *제약*(금지 표현·고지)에
   * 적용되는 규약이고, 자료 본문은 그 딜을 위해 생성된 **산출물**이다. 옵션 딜에
   * 자료가 없다고 부모 자료를 검사하면 실제로 셀러에게 나가지 않은 문안을 근거로
   * 오픈을 막게 된다.
   */
  const [claimContext, activeRules, latestDraft, latestBrandDraft] = await Promise.all([
    loadDealClaimContext(campaign.deal.id),
    prisma.bannedPhraseRule.findMany({
      where: { active: true },
      select: {
        id: true,
        phrase: true,
        pattern: true,
        category: true,
        severity: true,
        legalBasis: true,
        note: true,
      },
    }),
    /**
     * ⚠️ **유형마다 최신 1건을 따로 잡는다** (2026-08-02, 가이드 2원화 → 게이트 범위 확대).
     *
     * 유형 필터 없이 `sentAt` 최신 1건만 보면, 브랜드용 자료를 나중에 보낸 순간
     * **감사 대상 문서가 조용히 갈아치워진다** — 셀러 문안은 검사되지 않은 채 게이트는
     * 초록이 된다. 두 유형이 생기기 전에는 존재할 수 없던 경로다.
     *
     * 오너 결정(2026-08-02): 브랜드용 자료도 **판정에 포함**한다. 그쪽도 소비자에게
     * 닿으므로 셀러용과 달리 볼 이유가 없고, "보여주기만 하는 경고"는 결국 무시된다.
     */
    prisma.dealAssetDraft.findFirst({
      where: { dealId: campaign.deal.id, kind: "CONTENT_GUIDE" },
      orderBy: { sentAt: "desc" },
      select: { body: true, sentAt: true },
    }),
    prisma.dealAssetDraft.findFirst({
      where: { dealId: campaign.deal.id, kind: "BRAND_CONTENT_GUIDE" },
      orderBy: { sentAt: "desc" },
      select: { body: true, sentAt: true },
    }),
  ]);

  // 같은 규칙·같은 클레임으로 유형마다 판정한다 — 사전이나 판정 함수는 건드리지
  // 않는다(공유 게이트의 의미를 유형별로 바꾸는 것은 별개 결정이다).
  const gateContext = {
    category: claimContext?.category ?? null,
    rules: activeRules,
    // 승인분만 — `loadDealClaimContext` 는 모든 status 를 준다(C1 M3).
    dealClaims: toGateClaims(claimContext?.claims ?? []),
  };
  const claimGate = latestDraft ? checkText(latestDraft.body, gateContext) : null;
  const brandClaimGate = latestBrandDraft
    ? checkText(latestBrandDraft.body, gateContext)
    : null;

  const manualAnswers: Partial<Record<ManualRowId, ManualAnswer>> = {};
  for (const answer of offerAnswers) {
    if ((MANUAL_ROW_IDS as readonly string[]).includes(answer.rowId)) {
      manualAnswers[answer.rowId as ManualRowId] = {
        verdict: answer.verdict,
        note: answer.note,
      };
    }
  }

  const offer = deal
    ? diagnoseOffer({
        listPrice: deal.listPrice ? Number(deal.listPrice) : null,
        sellingPrice: Number(deal.sellingPrice),
        priceVerdict:
          snapshot?.verdict && KNOWN_PRICE_VERDICTS.includes(snapshot.verdict)
            ? (snapshot.verdict as PriceVerdict)
            : null,
        shippingFee: deal.shippingFee ? Number(deal.shippingFee) : null,
        freeShippingThreshold: deal.freeShippingThreshold
          ? Number(deal.freeShippingThreshold)
          : null,
        optionCount: deal.options.length,
        supplementaryInfo: deal.supplementaryInfo,
        approvedClaimCount: approvedClaims.length,
        measuredClaimCount: approvedClaims.filter(
          (c) => c.evidenceType === "MEASURED",
        ).length,
        sellerFit: null,
        priorRunCount,
        manualAnswers,
      })
    : null;

  const audit = auditLaunchReadiness({
    /**
     * ✅ **표현 게이트가 감사에 들어왔다(C3 파이프라인 착지 후).** 위에서 셀러에게
     * 보낸 최신 자료 본문을 **현재 규칙으로** 판정한 결과다.
     *
     * 자료가 아직 없으면 여전히 `null` 이다 — 검사 대상이 없는데 빈 PASS 를
     * 넘기면 "게이트가 돌았다"는 오해만 만든다. 그 상태는 아래
     * `claimGateSource` 로 화면에 밝힌다(침묵하지 않는다).
     */
    claimGates: [
      ...(claimGate ? [{ label: "셀러용 자료", gate: claimGate }] : []),
      ...(brandClaimGate ? [{ label: "브랜드용 자료", gate: brandClaimGate }] : []),
    ],
    offer,
    // DB 는 채널을 문자열로 들고 있다 — 판정 함수는 미지의 값을 "등록 대상
    // 아님"으로 흘리므로(집합 검사) 캐스팅이 판정을 왜곡하지 않는다.
    needsChannelAssignment: needsChannelAssignment({
      salesChannel: campaign.salesChannel as SalesChannel,
    }),
    needsOrderRegistration: needsOrderRegistration({
      salesChannel: campaign.salesChannel as SalesChannel,
      isOrderRegistered: campaign.orderCampaignId !== null,
    }),
    // ⚠️ UTC 로 자르면 KST 에서 날짜가 하루 밀린다 — 남은 일수가 어긋나면
    // "오늘 오픈"을 "내일"로 읽는다. 레포 정본 변환을 쓴다.
    daysUntilStart: getDaysUntilStart({
      startDate: toKstDateStr(campaign.startDate) ?? "",
    }),
  });

  return NextResponse.json({
    ...audit,
    campaignId: campaign.id,
    dealName: campaign.deal.dealName,
    requiredDisclosureCount: requiredDisclosures.length,
    /**
     * 표현 축이 **왜** 비었는지를 화면이 말할 수 있게 한다 — 항목이 그냥 없으면
     * 운영자는 "통과했다"로 읽는다(미검사와 무결점은 화면에서 구분되지 않는다).
     * `#174` 가 근거 카드에서 세운 것과 같은 규약이다.
     */
    claimGateSource: latestDraft ? "ASSET_DRAFT" : "NO_ASSET_DRAFT",
    /** 검사한 자료를 셀러에게 보낸 시점(없으면 null). */
    claimGateCheckedAt: latestDraft?.sentAt ?? null,
    /**
     * 브랜드용 자료의 검사 여부 — 셀러용과 **따로** 밝힌다. 한 필드로 합치면
     * "둘 중 하나만 검사됨"이 "검사됨"으로 뭉개져 부재가 통과처럼 읽힌다.
     */
    brandClaimGateSource: latestBrandDraft ? "ASSET_DRAFT" : "NO_ASSET_DRAFT",
    brandClaimGateCheckedAt: latestBrandDraft?.sentAt ?? null,
  });
}
