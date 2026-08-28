import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";

// 다른 크론 라우트(enrich-references, collect-instagram 등)와 동일한 상한.
// 딜당 외부 3소스(네이버/쿠팡/카카오) 순차 조회 + 300ms 지연이라 기본값 의존 금지.
export const maxDuration = 300;
import { getPrisma } from "@/lib/prisma";
import {
  buildMonitorWindowWhere,
  buildSearchQuery,
  inferQuantityFromName,
  resolveMonitorFields,
} from "@/lib/price-monitor/query-builder";
import { evaluateMarketPrice, type EvaluatedCandidate } from "@/lib/price-monitor/pipeline";
import { priceMonitorSnapshotRepository } from "@/repositories/priceMonitorSnapshotRepository";
import { fetchAllMarketPrices } from "@/lib/price-monitor/market-fetch";
import { verifyCronAuth } from "@/lib/cron-auth";

// naver-order-sync/route.ts의 verifyCronAuth 패턴을 그대로 복제한다.
function todayDateKey(): string {
  // KST 기준 YYYY-MM-DD (naverOrderSnapshotRepository.markAllDirty의 toDateKey와 동형)
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

type MonitorTarget = {
  dealId: string;
  campaignId: string | null;
  /** 딜 자신의 dealName — 알림 제목 등 사람이 알아볼 이름에 사용(항상 자기 자신 표시명) */
  dealName: string;
  /** buildSearchQuery의 core 폴백 재료용 dealName(자식이면 부모 dealName, 청사진 §C1-1) */
  coreDealName: string;
  brandName: string | null;
  searchKeyword: string | null;
  /** AI가 추출한 모델명/모델코드(P3-2) — resolveMonitorFields가 자식??부모 순서로 해소한다. */
  modelName: string | null;
  unit: string | null;
  unitQuantity: number | null;
  sellingPrice: number;
  campaignShippingFee: number | null;
  campaignFreeShippingThreshold: number | null;
  /** 자식 딜(하위 옵션)이면 buildSearchQuery의 childDealName/parentDealName에 전달(C1-3) */
  childDealName: string | null;
  parentDealName: string | null;
};

/**
 * 판매기간 전후 MONITOR_WINDOW_DAYS일 이내인 캠페인에 연결된 CampaignDeal 중 monitorEnabled인
 * 딜을 모니터링 대상으로 조회한다(오너 확정 2026-07-13 — 시간창 규칙·근거는 query-builder.ts의
 * buildMonitorWindowWhere 주석 참조). 기존엔 status==="ACTIVE"(수동 칸반 상태)로 게이트했으나,
 * 실제 판매기간과 분리돼 판매 직전 세팅주·마감 후 주를 놓치고 상태 미전이 시 영구 수집되는
 * 문제가 있어 날짜 기반 시간창으로 대체했다.
 *
 * searchKeyword(AI 추출 키워드)가 supplementaryInfo JSON에 없어도 brandName+dealName 폴백으로
 * query-builder가 쿼리를 만들 수 있으므로, "searchKeyword 有"는 완화해 monitorEnabled만 필터한다
 * (청사진은 "searchKeyword 有"를 명시했으나, 폴백 경로가 있는 한 아예 스킵하면 신규 딜이 영원히
 * 모니터링되지 않는다 — 다만 청사진 의도를 존중해 searchKeyword 없는 딜은 evidence에 표시만 하고
 * 대상에서 제외하지는 않는다).
 *
 * C1-3: 자식 딜(parentDealId 있음)이면 부모 딜을 join해 searchKeyword/brandName/unit을
 * "자식 ?? 부모" 순서로 해소한다(resolveMonitorFields, 순수함수 — query-builder.ts).
 */
async function fetchMonitorTargets(): Promise<MonitorTarget[]> {
  const prisma = getPrisma();

  const campaignDeals = await prisma.campaignDeal.findMany({
    where: buildMonitorWindowWhere(new Date()),
    include: {
      campaign: { select: { id: true, shippingFee: true, freeShippingThreshold: true } },
      deal: {
        select: {
          id: true,
          dealName: true,
          brandName: true,
          unit: true,
          unitQuantity: true,
          sellingPrice: true,
          supplementaryInfo: true,
          monitorEnabled: true,
          parentDealId: true,
          parentDeal: {
            select: {
              dealName: true,
              brandName: true,
              supplementaryInfo: true,
              unit: true,
            },
          },
        },
      },
    },
  });

  return campaignDeals.map((cd) => {
    const resolved = resolveMonitorFields(
      {
        dealName: cd.deal.dealName,
        brandName: cd.deal.brandName,
        unit: cd.deal.unit,
        unitQuantity: cd.deal.unitQuantity,
        supplementaryInfo: cd.deal.supplementaryInfo,
      },
      cd.deal.parentDeal
        ? {
            dealName: cd.deal.parentDeal.dealName,
            brandName: cd.deal.parentDeal.brandName,
            unit: cd.deal.parentDeal.unit,
            unitQuantity: null,
            supplementaryInfo: cd.deal.parentDeal.supplementaryInfo,
          }
        : null,
    );
    const sellingPrice = Number(cd.sellingPrice ?? cd.deal.sellingPrice ?? 0);

    return {
      dealId: cd.deal.id,
      campaignId: cd.campaign.id,
      dealName: resolved.dealName,
      coreDealName: resolved.coreDealName,
      brandName: resolved.brandName,
      searchKeyword: resolved.searchKeyword,
      modelName: resolved.modelName,
      unit: resolved.unit,
      unitQuantity: resolved.unitQuantity,
      sellingPrice,
      campaignShippingFee: cd.campaign.shippingFee != null ? Number(cd.campaign.shippingFee) : null,
      campaignFreeShippingThreshold:
        cd.campaign.freeShippingThreshold != null ? Number(cd.campaign.freeShippingThreshold) : null,
      childDealName: resolved.childDealName,
      parentDealName: resolved.parentDealName,
    };
  });
}

function computeOurTotalPrice(target: MonitorTarget): number {
  const needsShipping =
    target.campaignShippingFee != null &&
    (!target.campaignFreeShippingThreshold || target.sellingPrice < target.campaignFreeShippingThreshold);
  return target.sellingPrice + (needsShipping ? target.campaignShippingFee! : 0);
}

async function processTarget(target: MonitorTarget, snapshotDate: string) {
  // expectedQuantity는 자식 자신의 실제 표시명(target.dealName)에서 역추출한다(수량은 자식
  // 이름 자체에 리터럴로 존재). query의 core 폴백 재료는 청사진 §C1-1 규칙대로 부모
  // dealName(target.coreDealName)을 사용한다 — 자식이 아니면 둘은 항상 동일하다.
  const expectedQuantity = target.unitQuantity ?? inferQuantityFromName(target.dealName, target.unit);
  const query = buildSearchQuery({
    searchKeyword: target.searchKeyword,
    brandName: target.brandName,
    dealName: target.coreDealName,
    unitQuantity: target.unitQuantity,
    unit: target.unit,
    childDealName: target.childDealName,
    parentDealName: target.parentDealName,
  });

  const ourTotalPrice = computeOurTotalPrice(target);

  const { allItems, errors } = await fetchAllMarketPrices(query);

  const result = evaluateMarketPrice({
    candidates: allItems,
    targetQuery: query,
    ourTotalPrice,
    expectedUnit: target.unit,
    expectedQuantity,
    modelName: target.modelName,
  });

  await priceMonitorSnapshotRepository.upsertDaily({
    dealId: target.dealId,
    campaignId: target.campaignId,
    snapshotDate,
    searchQuery: query,
    ourUnitPrice: result.ourUnitPrice,
    minValidPrice: result.minValidItem?.totalPrice ?? null,
    verdict: result.verdict,
    validCount: result.validCount,
    rawResults: result.allScored as EvaluatedCandidate[],
    evidence: { sourceErrors: errors, ourTotalPrice, hasSearchKeyword: !!target.searchKeyword },
  });

  // 위반 신호는 별도 알림을 만들지 않는다 — 홈 "최저가 방어" 카드가 이 스냅샷을
  // 직접 읽어 라이브 표시한다(알림센터 해체, 2026-07-24 오너 확정,
  // /api/price-monitoring/overview). 스냅샷 적재가 곧 신호 발행이다.

  return result.verdict;
}

async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const snapshotDate = todayDateKey();
  const summary = { total: 0, OK: 0, TIE: 0, VIOLATED: 0, REVIEW: 0, NO_DATA: 0, failed: 0 };

  try {
    const targets = await fetchMonitorTargets();
    summary.total = targets.length;

    // 순차 지연 배치 처리(Promise.allSettled) — 외부 소스에 대한 동시 과호출 방지.
    // naver-order-sync 등 기존 cron과 달리 이 작업은 외부 API(네이버/쿠팡/카카오 선물하기)를
    // 다수 호출하므로 각 딜 처리 사이에 짧은 지연을 둔다.
    const settled: PromiseSettledResult<string>[] = [];
    for (const target of targets) {
      const outcome = await Promise.allSettled([processTarget(target, snapshotDate)]);
      settled.push(outcome[0]);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    for (const s of settled) {
      if (s.status === "fulfilled") {
        summary[s.value as keyof typeof summary] =
          (summary[s.value as keyof typeof summary] as number) + 1;
      } else {
        summary.failed++;
        console.error("[cron/price-monitoring] target 처리 실패:", s.reason);
      }
    }

    return NextResponse.json({ success: true, snapshotDate, summary });
  } catch (error) {
    console.error("[cron/price-monitoring] Unexpected error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export const GET = withSystemTaskStatus("price-monitoring", handler);
