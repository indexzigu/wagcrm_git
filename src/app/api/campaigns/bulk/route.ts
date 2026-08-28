import { NextResponse } from "next/server";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { parseBaseMarginPolicy } from "@/lib/base-margin-policy";
import { recalculateCampaignRounds } from "@/services/campaignRounds";

const bulkCampaignSchema = z.object({
  dealId: z.string().min(1, "dealId is required"),
  sellerIds: z.array(z.string().min(1)).min(1, "At least one seller is required"),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  salesChannel: z.string().optional(),
});

function generateTrackingLink(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 12; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `https://track.wag.kr/${code}`;
}

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = bulkCampaignSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { dealId, sellerIds, startDate, endDate, salesChannel } = parsed.data;

  // Fetch the deal to get baseMarginPolicy
  const deal = await getPrisma().deal.findUnique({
    where: { id: dealId },
    select: {
      id: true,
      baseMarginPolicy: true,
    },
  });

  if (!deal) {
    return NextResponse.json(
      { error: "해당 딜을 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  // Parse baseMarginPolicy to get default margin rates
  const policy = parseBaseMarginPolicy(deal.baseMarginPolicy);
  const firstChannel = Object.values(policy.byChannel)[0];
  const totalMarginRate = firstChannel?.totalMarginRate ?? 0;
  const sellerMarginRate = firstChannel?.sellerMarginRate ?? 0;

  const netMarginRate = totalMarginRate - sellerMarginRate;
  const resolvedSalesChannel = salesChannel || "OWN_MALL";
  const resolvedStartDate = startDate ? new Date(startDate) : new Date();
  const resolvedEndDate = endDate
    ? new Date(endDate)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // default: 30 days from now

  const created: unknown[] = [];
  const failed: { sellerId: string; error: string }[] = [];

  // Create campaigns for each seller, handling partial failures
  for (const sellerId of sellerIds) {
    try {
      // 생성과 차수/이름 재계산을 한 트랜잭션으로 묶어, 이름 없는 캠페인이
      // 중간 상태로 남지 않게 한다 (정식 경로 campaignService.createCampaign과 동일 규칙).
      const campaign = await getPrisma().$transaction(async (tx) => {
        const inserted = await tx.salesCampaign.create({
          data: {
            dealId,
            sellerId,
            startDate: resolvedStartDate,
            endDate: resolvedEndDate,
            salesChannel: resolvedSalesChannel,
            totalMarginRate,
            sellerMarginRate,
            netMarginRate,
            status: "PROPOSAL",
            generatedTrackingLink: generateTrackingLink(),
            baseNaverLink: "",
          },
        });

        await recalculateCampaignRounds(dealId, sellerId, tx);

        return (
          (await tx.salesCampaign.findUnique({ where: { id: inserted.id } })) ??
          inserted
        );
      });

      created.push(campaign);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      failed.push({ sellerId, error: message });
    }
  }

  return NextResponse.json({ created, failed }, { status: 207 });
}

// ⛔ PATCH 는 2026-08-27 에 제거됐다 — 되살리지 말 것.
//
// 이 라우트에는 `campaignIds` 여러 건의 `isDepositReceived`/`isPayoutCompleted`
// 와 짝 타임스탬프·`status` 를 `salesCampaign.updateMany` 로 한 번에 쓰는 PATCH
// 핸들러가 있었다. 저장소 이관(2026-07-16) 이후 한 번도 수정되지 않은 채
// **앱 안 호출부 0건**으로 남아 있었고, 그 사이 정산 쪽에 들어온 규약을 하나도
// 받지 못했다:
//   ① 완료 플래그의 SoT 는 그룹 소속이면 **그룹 스칼라**다(CG-1). 이 핸들러는
//      그룹을 조회조차 하지 않아, 조합 캠페인을 포함해 호출하면 멤버 행만 true 가
//      되고 그룹 스칼라는 false 로 남는다. 읽기 표면은 전부
//      `group?.isX ?? campaign.isX` 이므로(`campaign-row.ts` · `desktop-dashboard.ts`
//      · `mobile-settlement-data.ts` · `agenda-settlements.ts` …) 화면·지연 판정·
//      정산 목록이 옛 값을 계속 보여준다 — `buildOverdueSettlementItems` 가 밟은
//      #196 과 같은 부류다.
//   ② 세 번째 플래그 `isSupplierPayoutCompleted` 를 모른다.
//   ③ `computeAutoStatus`(상태 자동전이) · 변경 이력(`recordActivityChange`) ·
//      화면 캐시 갱신(`revalidateCampaignCaches`) · 캘린더 재동기화가 전부 없다.
//   ④ `status` 를 임의 문자열로 받는다(유효값 검사 없음).
//
// **정산 플래그를 바꾸는 정본 경로는 `PATCH /api/campaigns/[id]/settlement-status`
// 하나다** — 그룹 소속이면 그룹 스칼라에 쓰므로 멤버 한 건을 체크하면 조합 전체에
// 적용된다. 오너 확정(2026-08-27): 일괄 처리용 화면·버튼·스크립트를 따로 두지 않고
// 이 전파로 해결한다. 그러니 나중에 일괄 처리가 필요해져도 이 자리에 updateMany 를
// 되살리지 말고, 그 라우트를 캠페인마다 태우거나 그룹 인지 쓰기 SSOT 에 위임할 것.
//
// 회귀 가드는 `__tests__/route.test.ts` 의 「제거된 표면」 계약이다.
