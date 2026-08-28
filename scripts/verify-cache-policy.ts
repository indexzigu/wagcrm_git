import { readFileSync } from "node:fs";
import { CRM_CACHE_LIFE, CRM_CACHE_SURFACES, CRM_DYNAMIC_SURFACES } from "../src/lib/cache-policy";
import {
  ASSET_INVALIDATION_TAGS,
  CAMPAIGN_INVALIDATION_TAGS,
  CHANNEL_FEE_INVALIDATION_TAGS,
  CRM_CACHE_TAGS,
  MASTER_DATA_INVALIDATION_TAGS,
  ORDER_SYNC_INVALIDATION_TAGS,
  OUTREACH_INVALIDATION_TAGS,
  REVENUE_GOAL_INVALIDATION_TAGS,
  SELLER_METRICS_INVALIDATION_TAGS,
  type CrmCacheTag,
} from "../src/lib/cache-tags";

type MutationGroup = {
  name: string;
  tags: readonly CrmCacheTag[];
  writers: readonly {
    path: string;
    expectedSource: readonly string[];
  }[];
};

const mutationGroups: readonly MutationGroup[] = [
  {
    name: "campaigns",
    tags: CAMPAIGN_INVALIDATION_TAGS,
    writers: [
      {
        path: "src/app/api/campaigns/route.ts",
        expectedSource: ["revalidateCampaignCaches()"],
      },
      {
        path: "src/app/api/campaigns/[id]/route.ts",
        expectedSource: ["revalidateCampaignCaches()"],
      },
      {
        path: "src/app/api/campaigns/[id]/actual-sales/route.ts",
        expectedSource: ["revalidateCampaignCaches()"],
      },
      {
        // 정산 워크스페이스 입금/지급 토글 — 정산 플래그 + 자동 상태 전이(COMPLETED)를
        // 쓰므로 홈·/settlement 캐시 표면을 즉시 깬다(#149 후속 리뷰에서 발견된 누락).
        path: "src/app/api/campaigns/[id]/settlement-status/route.ts",
        expectedSource: ["revalidateCampaignCaches()"],
      },
      {
        // 크론 라이터(2026-07-10 이벤트 기반 전환): 정산 원장 수집 + 마감 캠페인 결산 갱신
        path: "src/app/api/cron/naver-settlement-sync/route.ts",
        expectedSource: ["revalidateCampaignCaches()"],
      },
      {
        // 어시스턴트 레인 라이터 — `confirm_settlement` WRITE 액션(승인 버튼 경로와
        // 자동승인 경로가 공유한다). 무효화 **집행**은 write-action-effects.ts 지만
        // **어느 태그 묶음이냐**는 판정은 여기 effects 명세에 있으므로 이 파일을 건다.
        // 종전엔 이 레인이 DB 만 쓰고 무효화를 하지 않아 "승인했는데 화면은 그대로"가 났다.
        path: "src/lib/agent/write-executor.ts",
        expectedSource: ["revalidate: CAMPAIGN_INVALIDATION_TAGS"],
      },
    ],
  },
  {
    name: "masterData",
    tags: MASTER_DATA_INVALIDATION_TAGS,
    writers: [
      {
        path: "src/app/api/partners/route.ts",
        expectedSource: ["revalidateMasterDataCaches()"],
      },
      {
        path: "src/app/api/partners/[id]/route.ts",
        expectedSource: ["revalidateMasterDataCaches()"],
      },
      {
        path: "src/app/api/partners/[id]/business-info/route.ts",
        expectedSource: ["revalidateMasterDataCaches()"],
      },
      {
        path: "src/app/api/sellers/route.ts",
        expectedSource: ["revalidateMasterDataCaches()"],
      },
      {
        path: "src/app/api/sellers/[id]/route.ts",
        expectedSource: ["revalidateMasterDataCaches()"],
      },
      {
        path: "src/app/api/deals/route.ts",
        expectedSource: ["revalidateMasterDataCaches()"],
      },
      {
        path: "src/app/api/deals/[id]/route.ts",
        expectedSource: ["revalidateMasterDataCaches()"],
      },
      {
        // 어시스턴트 레인 라이터 — `change_deal_status` WRITE 액션. 위 campaigns 그룹과
        // 같은 이유로 태그 판정이 있는 파일(effects 명세)을 건다.
        path: "src/lib/agent/write-executor.ts",
        expectedSource: ["revalidate: MASTER_DATA_INVALIDATION_TAGS"],
      },
    ],
  },
  {
    name: "assets",
    tags: ASSET_INVALIDATION_TAGS,
    writers: [
      {
        path: "src/app/api/assets/route.ts",
        expectedSource: ["revalidateCrmTags(ASSET_INVALIDATION_TAGS)"],
      },
      {
        path: "src/app/api/assets/[id]/route.ts",
        expectedSource: ["revalidateCrmTags(ASSET_INVALIDATION_TAGS)"],
      },
      {
        // 크론 라이터(2026-07-10): 레퍼런스 링크 썸네일/캡션 보강 스윕
        path: "src/app/api/cron/enrich-references/route.ts",
        expectedSource: ["revalidateCrmTags(ASSET_INVALIDATION_TAGS)"],
      },
    ],
  },
  {
    // 2026-07-10 이벤트 기반 전환 — 주문 스냅샷 동기화가 포털 재구매/이력 캐시와
    // 파이프라인·정산 표면을 즉시 깬다(과거엔 hot 60s TTL이 이 역할을 대신했다).
    name: "orderSync",
    tags: ORDER_SYNC_INVALIDATION_TAGS,
    writers: [
      {
        path: "src/app/api/cron/naver-order-sync/route.ts",
        expectedSource: ["revalidateCrmTags(ORDER_SYNC_INVALIDATION_TAGS)"],
      },
    ],
  },
  {
    // 셀러 지표 수집(팔로워·ER·미디어 재호스팅) → 셀러 목록/상세·대시보드 모멘텀
    name: "sellerMetrics",
    tags: SELLER_METRICS_INVALIDATION_TAGS,
    writers: [
      {
        path: "src/app/api/cron/collect-instagram/route.ts",
        expectedSource: ["revalidateCrmTags(SELLER_METRICS_INVALIDATION_TAGS)"],
      },
      {
        path: "src/app/api/cron/collect-youtube/route.ts",
        expectedSource: ["revalidateCrmTags(SELLER_METRICS_INVALIDATION_TAGS)"],
      },
      {
        path: "src/app/api/cron/rehost-seller-media/route.ts",
        expectedSource: ["revalidateCrmTags(SELLER_METRICS_INVALIDATION_TAGS)"],
      },
    ],
  },
  {
    name: "outreach",
    tags: OUTREACH_INVALIDATION_TAGS,
    writers: [
      {
        path: "src/app/api/outreach/route.ts",
        expectedSource: ["revalidateCrmTags(OUTREACH_INVALIDATION_TAGS)"],
      },
      {
        path: "src/app/api/outreach/[id]/route.ts",
        expectedSource: ["revalidateCrmTags(OUTREACH_INVALIDATION_TAGS)"],
      },
    ],
  },
  {
    name: "channelFees",
    tags: CHANNEL_FEE_INVALIDATION_TAGS,
    writers: [
      {
        path: "src/app/api/settings/channel-fees/route.ts",
        expectedSource: ["revalidateCrmTags(CHANNEL_FEE_INVALIDATION_TAGS)"],
      },
    ],
  },
  {
    name: "revenueGoals",
    tags: REVENUE_GOAL_INVALIDATION_TAGS,
    writers: [
      {
        path: "src/app/api/settings/revenue-goals/route.ts",
        expectedSource: ["revalidateCrmTags(REVENUE_GOAL_INVALIDATION_TAGS)"],
      },
    ],
  },
] as const;

function main() {
  const knownTags = new Set(Object.values(CRM_CACHE_TAGS));
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const group of mutationGroups) {
    for (const tag of group.tags) {
      if (!knownTags.has(tag)) {
        errors.push(`Unknown tag '${tag}' referenced by mutation group '${group.name}'.`);
      }
    }

    for (const writer of group.writers) {
      const source = readFileSync(writer.path, "utf8");
      const missingChecks = writer.expectedSource.filter((snippet) => !source.includes(snippet));

      if (missingChecks.length > 0) {
        errors.push(
          `Writer '${writer.path}' is missing expected cache invalidation source: ${missingChecks.join(", ")}`,
        );
      }
    }
  }

  const surfaces = CRM_CACHE_SURFACES.map((surface) => {
    const coveringGroups = mutationGroups
      .filter((group) => surface.tags.some((tag) => group.tags.includes(tag)))
      .map((group) => group.name);

    if (coveringGroups.length === 0) {
      errors.push(`Cached surface '${surface.path}' has no matching invalidation group.`);
    }

    return {
      id: surface.id,
      path: surface.path,
      cacheLife: {
        key: surface.cacheLife,
        ...CRM_CACHE_LIFE[surface.cacheLife],
      },
      tags: surface.tags,
      coveredBy: coveringGroups,
      notes: surface.notes,
    };
  });

  const uncachedSurfaceTags = new Set(
    CRM_DYNAMIC_SURFACES.flatMap((surface) => surface.tags),
  );

  const mutationOnlyTags = Object.values(CRM_CACHE_TAGS).filter((tag) => {
    return (
      !CRM_CACHE_SURFACES.some((surface) => surface.tags.includes(tag)) &&
      !uncachedSurfaceTags.has(tag)
    );
  });

  for (const tag of mutationOnlyTags) {
    warnings.push(
      `Tag '${tag}' is invalidated by writes but is not currently attached to a cached page surface.`,
    );
  }

  const result = {
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    cacheLives: CRM_CACHE_LIFE,
    surfaces,
    dynamicSurfaces: CRM_DYNAMIC_SURFACES,
    mutationGroups,
    warnings,
    errors,
  };

  console.log(JSON.stringify(result, null, 2));

  if (errors.length > 0) {
    process.exit(1);
  }
}

main();
