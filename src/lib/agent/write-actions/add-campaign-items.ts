import type { Prisma } from "@prisma/client";
import {
  addCampaignItemsArgsSchema,
  campaignOptionNameKey,
  type AddCampaignItemsArgs,
  type CampaignItemRow,
} from "@/lib/agent-worker/contracts";
import { recordActivityCreate, recordActivityMemo } from "@/lib/activity-log";
import { CAMPAIGN_INVALIDATION_TAGS, CRM_CACHE_TAGS } from "@/lib/cache-tags";
import { plannedOptionDealName } from "@/lib/deal-display";
import { buildOptionSupplementaryInfo, computeSupplyPrice } from "@/utils/deal-panel-helpers";
import { applyRecordChanges, lockRecordRows, readRecordSnapshot } from "../record-update-entities";
// 봇(작업 실행기)이 기안을 만들 때 쓰는 실행자 이름 — 기안자가 스스로 승인·실행하는 길을 막는다.
import { AGENT_WORKER_ACTOR } from "@/lib/agent/agent-worker-proposal";
import { isAutomatedActor } from "./update-settlement-amount";
import type { WriteActionDefinition, WriteActionResult } from "./types";

export type { AddCampaignItemsArgs } from "@/lib/agent-worker/contracts";

/** 매출 합계 대조 허용 오차(원) — Decimal 을 number 로 옮겨 더할 때의 부동소수 찌꺼기만 흡수한다. */
const SUM_TOLERANCE = 0.005;

/** 품목 줄로 연결할 수 있는 딜 — 상위 판매 조건 자신 또는 그 하위품목. 줄 기본값에 필요한 칸만. */
type LinkableDeal = {
  id: string;
  sellingPrice: Prisma.Decimal;
  costPrice: Prisma.Decimal;
  totalCommissionRate: Prisma.Decimal | null;
};

type OptionDeal = LinkableDeal & { dealName: string; optionSortOrder: number };

type ResolvedItem = { kind: "link"; deal: LinkableDeal } | { kind: "create"; row: CampaignItemRow; name: string };

const toNumber = (value: Prisma.Decimal | number | null | undefined): number | null =>
  value == null ? null : Number(value);

/**
 * 판매캠페인 하나의 품목에 하위품목을 덧붙인다 — 사람이 승인했을 때만, 승인 라우트가 연 tx(기안 EXECUTED 전이와
 * 같은 트랜잭션) 안에서. 화면의 두 손 작업을 그대로 따른다:
 *  - 새 하위품목 = 판매 조건 화면의 「하위품목 추가」(`useDealOptions` → `POST /api/deals` → `dealService.createDeal`)
 *    와 같은 값: 이름은 화면과 같은 규칙(`plannedOptionDealName` — 단위 있는 판매 조건은 「이름 - 3개」·수량 필수,
 *    없으면 「이름 - 옵션 이름」), 부모의 거래처·브랜드·단위·마진 정책을 물려받고, 수수료율은 입력이 없으면 부모 값, 원가(공급가)는
 *    `computeSupplyPrice(판매가, 수수료율)`, 정렬 순서는 형제 최대값 + 1, 상태는 SOURCING.
 *    ⚠️ 정본 서비스 대신 tx.deal.create 를 직접 쓰는 이유: 서비스는 tx 를 받지 않고 커밋 전에 구글 드라이브 폴더를
 *    만든다(외부 IO). `create-deal.ts` 와 같은 선택이다.
 *  - 품목 줄 = 판매캠페인 품목 표의 「+ 옵션 품목 추가」(`campaign-deals-table.tsx` `handleAddOption`)와 같은 기본값:
 *    수량 0 · 실매출 0 · 수수료율 = 하위품목 수수료율 ?? 캠페인 총마진율 · 셀러마진율 = 캠페인 값 · 판매가 = 하위품목
 *    판매가 · 공급가 = `computeSupplyPrice(판매가, 수수료율)` ?? 하위품목 원가.
 *  - 저장 = 그 표의 「저장」과 같은 본체(`applyCampaignPatch`, `applyRecordChanges` 경유)를 같은 tx 로. 품목 합계·
 *    품목 수·재무 파생·정산 기준액 자격 검사가 화면 저장과 같다. 기존 줄은 **읽은 값 그대로** 다시 보낸다(고치지 않음).
 *
 * 가드 순서:
 *  ① 사람 승인만 — 시스템 실행자(`SYSTEM_*`)와 봇 실행자(`AGENT_WORKER`)는 DB 를 읽기 전에 거부한다.
 *  ② 잠금 — 캠페인(묶음이면 그룹 락 → 묶음 행 → 멤버 행)을 `update_record` 와 같은 순서로 잠근다.
 *  ③ 판매 조건 대조 — 캠페인의 지금 판매 조건이 기안 때 본 `mainDealId` 와 다르면 실패(다른 상품 밑에 붙게 된다).
 *  ④ 매출 합계 대조 — 캠페인 실매출·주문수량이 지금 품목 합계와 다르면 실패. 품목 저장은 실매출·수량을 품목 합으로
 *     다시 쓰므로(`campaignService.updateCampaign`), 어긋난 캠페인에 줄을 덧붙이면 수량 0 줄인데도 매출이 바뀐다.
 *     화면 저장은 이 경우에도 그냥 덮어쓰지만, 기안은 승인자가 그 변화를 볼 수 없어 막는다(화면에서 확인 후 저장).
 *  ⑤ 줄 판정 — 연결 줄은 상위 판매 조건 자신이거나 그 하위품목이어야 한다. 새 줄은 같은 이름(`campaignOptionNameKey` —
 *     판매 조건 이름 접두를 맞춘 비교 키)의 하위품목이
 *     이미 있으면 새로 만들지 않고 그것을 연결한다(그 사이 화면에서 만든 경우). 이미 품목에 있는 줄은 건너뛴다.
 *  ⑥ 반영 — 새 하위품목 생성 → 품목 목록(기존 그대로 + 새 줄) 저장. 추가할 줄이 없으면 아무것도 쓰지 않는다.
 *
 * 📝 기안 메모가 있으면 캠페인 이력에 메모로 남긴다(`update_record` 와 같은 방식).
 */
async function handleAddCampaignItems(
  args: AddCampaignItemsArgs,
  actor: string,
  tx: Prisma.TransactionClient,
): Promise<WriteActionResult> {
  // ①
  if (isAutomatedActor(actor) || actor === AGENT_WORKER_ACTOR) {
    throw new Error(`품목 추가 불가: 이 기안은 사람이 결재함에서 승인해야 반영됩니다(실행자 ${actor}).`);
  }

  // ②
  const snapshot = await readRecordSnapshot(tx, "CAMPAIGN", args.campaignId);
  if (!snapshot) {
    throw new Error(`캠페인(${args.campaignId})을 찾을 수 없습니다. 이미 삭제되었거나 잘못된 대상입니다.`);
  }
  if (!(await lockRecordRows(tx, "CAMPAIGN", args.campaignId, snapshot))) {
    throw new Error("캠페인이 승인 중에 바뀌었습니다. 다시 조회해 올려 주세요.");
  }

  const campaign = await tx.salesCampaign.findUnique({
    where: { id: args.campaignId },
    select: {
      id: true,
      dealId: true,
      actualSales: true,
      quantity: true,
      totalMarginRate: true,
      sellerMarginRate: true,
      campaignDeals: {
        select: {
          dealId: true,
          quantity: true,
          actualSales: true,
          feeRate: true,
          sellerMarginRate: true,
          costPrice: true,
          sellingPrice: true,
        },
      },
    },
  });
  if (!campaign) {
    throw new Error(`캠페인(${args.campaignId})을 찾을 수 없습니다.`);
  }

  // ③
  if (campaign.dealId !== args.mainDealId) {
    throw new Error("캠페인의 판매 조건이 기안 때와 다릅니다. 다시 조회해 올려 주세요.");
  }

  // ④ 품목이 하나도 없는 캠페인은 화면 저장이 실매출·수량을 0 으로 쓰므로 같은 대조에 걸린다(합계 0 ≠ 지금 값).
  const existingSales = campaign.campaignDeals.reduce((sum, row) => sum + Number(row.actualSales), 0);
  const existingQuantity = campaign.campaignDeals.reduce((sum, row) => sum + row.quantity, 0);
  const campaignSales = toNumber(campaign.actualSales) ?? 0;
  const campaignQuantity = campaign.quantity ?? 0;
  if (Math.abs(existingSales - campaignSales) > SUM_TOLERANCE || existingQuantity !== campaignQuantity) {
    throw new Error(
      `캠페인 실매출·주문수량(${campaignSales.toLocaleString("ko-KR")}원 · ${campaignQuantity}개)이 지금 품목 합계` +
        `(${existingSales.toLocaleString("ko-KR")}원 · ${existingQuantity}개)와 달라, 품목을 덧붙이면 매출이 바뀝니다. ` +
        "캠페인 화면의 매출 상세내역에서 직접 추가해 주세요.",
    );
  }

  const mainDeal = await tx.deal.findUnique({
    where: { id: campaign.dealId },
    select: {
      id: true,
      dealName: true,
      dealType: true,
      partnerId: true,
      partnerCompanyName: true,
      brandName: true,
      unit: true,
      totalCommissionRate: true,
      baseMarginPolicy: true,
      sellingPrice: true,
      costPrice: true,
    },
  });
  if (!mainDeal) {
    throw new Error(`캠페인의 판매 조건(${campaign.dealId})을 찾을 수 없습니다.`);
  }
  if (mainDeal.dealType === "OPTION") {
    // 가격표 반영 경로와 같은 규칙 — 하위품목 밑에 다시 하위품목을 붙이지 않는다(`apply-executor.ts`).
    throw new Error("이 캠페인의 판매 조건이 하위품목이라 그 밑에 하위품목을 만들 수 없습니다. 화면에서 처리해 주세요.");
  }

  const options = await tx.deal.findMany({
    where: { parentDealId: mainDeal.id, dealType: "OPTION" },
    select: {
      id: true,
      dealName: true,
      sellingPrice: true,
      costPrice: true,
      totalCommissionRate: true,
      optionSortOrder: true,
    },
    orderBy: [{ optionSortOrder: "asc" }, { createdAt: "asc" }],
  });

  // ⑤
  const inCampaign = new Set(campaign.campaignDeals.map((row) => row.dealId));
  const optionsById = new Map(options.map((option) => [option.id, option]));
  // 같은 이름(비교 키)의 하위품목이 둘 이상이면 이름으로 고를 수 없다 — 그래서 목록으로 모은다.
  const optionsByName = new Map<string, OptionDeal[]>();
  for (const option of options) {
    const key = campaignOptionNameKey(mainDeal.dealName, option.dealName);
    optionsByName.set(key, [...(optionsByName.get(key) ?? []), option]);
  }

  const resolved: ResolvedItem[] = [];
  // 기안 안 새 줄끼리 저장 이름이 겹치면 같은 이름 하위품목이 둘 생긴다 — 막는다(기안 시점 확인과 같은 규칙).
  const plannedInProposal = new Set<string>();
  let skipped = 0;
  for (const row of args.items) {
    if (row.dealId) {
      const deal = row.dealId === mainDeal.id ? mainDeal : optionsById.get(row.dealId);
      if (!deal) {
        throw new Error(`연결할 하위품목(${row.dealId})이 이 캠페인의 판매 조건 「${mainDeal.dealName}」 밑에 없습니다.`);
      }
      if (inCampaign.has(deal.id)) {
        skipped += 1;
        continue;
      }
      resolved.push({ kind: "link", deal });
      inCampaign.add(deal.id);
      continue;
    }
    const plannedName = plannedOptionDealName(mainDeal, row);
    if (plannedName === null) {
      throw new Error(
        `판매 조건 「${mainDeal.dealName}」에 단위(${mainDeal.unit})가 있어 새 하위품목에는 단위 수량이 필요합니다(화면과 같은 규칙).`,
      );
    }
    const key = campaignOptionNameKey(mainDeal.dealName, plannedName);
    if (plannedInProposal.has(key)) {
      throw new Error(`새 하위품목 두 줄이 같은 이름(「${plannedName}」)으로 저장됩니다. 한 줄로 합쳐 다시 올려 주세요.`);
    }
    plannedInProposal.add(key);
    const sameName = optionsByName.get(key) ?? [];
    if (sameName.length > 0) {
      const [existing] = sameName;
      if (sameName.length > 1) {
        throw new Error(`「${key}」 이름의 하위품목이 둘 이상이라 어느 것을 연결할지 정할 수 없습니다. dealId 로 지정해 주세요.`);
      }
      if (inCampaign.has(existing.id)) {
        skipped += 1;
        continue;
      }
      resolved.push({ kind: "link", deal: existing });
      inCampaign.add(existing.id);
      continue;
    }
    resolved.push({ kind: "create", row, name: plannedName });
  }

  if (resolved.length === 0) {
    return {
      refType: "CAMPAIGN",
      refId: campaign.id,
      summary: `캠페인 품목 추가 없음: 기안의 ${skipped}건이 모두 이미 품목에 있습니다.`,
      createdCount: 0,
    };
  }

  // ⑥ 새 하위품목 생성 — 정렬 순서는 형제 최대값 다음부터(`dealService.createDeal` 의 needsSiblingLookup 과 같다).
  let nextSortOrder = options.reduce((max, option) => Math.max(max, option.optionSortOrder), -1) + 1;
  const mainCommission = toNumber(mainDeal.totalCommissionRate);
  const newRows: Array<{ dealId: string; sellingPrice: number; commission: number | null; costPrice: number }> = [];
  let createdDeals = 0;
  for (const item of resolved) {
    if (item.kind === "link") {
      const commission = toNumber(item.deal.totalCommissionRate);
      newRows.push({
        dealId: item.deal.id,
        sellingPrice: Number(item.deal.sellingPrice),
        commission,
        costPrice: Number(item.deal.costPrice),
      });
      continue;
    }
    const { row, name } = item;
    const sellingPrice = row.sellingPrice ?? 0;
    const commission = row.totalCommissionRate ?? mainCommission;
    const costPrice = computeSupplyPrice(sellingPrice, commission) ?? 0;
    const created = await tx.deal.create({
      data: {
        dealName: name,
        brandName: mainDeal.brandName,
        partnerId: mainDeal.partnerId,
        partnerCompanyName: mainDeal.partnerCompanyName,
        costPrice,
        sellingPrice,
        totalCommissionRate: commission,
        unit: mainDeal.unit,
        unitQuantity: row.unitQuantity ?? null,
        // 화면 「하위품목 추가」와 같은 저장 모양(`buildOptionSupplementaryInfo` — 모델명이 없으면 글 그대로).
        supplementaryInfo: buildOptionSupplementaryInfo(row.supplementaryInfo ?? "", ""),
        dealType: "OPTION",
        parentDealId: mainDeal.id,
        optionSortOrder: nextSortOrder,
        baseMarginPolicy: mainDeal.baseMarginPolicy,
        status: "SOURCING",
      },
      select: { id: true },
    });
    nextSortOrder += 1;
    createdDeals += 1;
    await recordActivityCreate("DEAL", created.id, actor, tx);
    newRows.push({ dealId: created.id, sellingPrice, commission, costPrice });
  }

  const campaignMarginRate = toNumber(campaign.totalMarginRate);
  const campaignSellerMarginRate = toNumber(campaign.sellerMarginRate);
  const campaignDeals = [
    ...campaign.campaignDeals.map((row) => ({
      dealId: row.dealId,
      quantity: row.quantity,
      actualSales: Number(row.actualSales),
      feeRate: toNumber(row.feeRate),
      sellerMarginRate: toNumber(row.sellerMarginRate),
      costPrice: toNumber(row.costPrice),
      sellingPrice: toNumber(row.sellingPrice),
    })),
    ...newRows.map((row) => {
      const feeRate = row.commission ?? campaignMarginRate;
      return {
        dealId: row.dealId,
        quantity: 0,
        actualSales: 0,
        feeRate,
        sellerMarginRate: campaignSellerMarginRate,
        sellingPrice: row.sellingPrice,
        costPrice: computeSupplyPrice(row.sellingPrice, feeRate) ?? row.costPrice,
      };
    }),
  ];

  await applyRecordChanges(tx, "CAMPAIGN", campaign.id, { campaignDeals }, actor);

  if (args.memo) {
    await recordActivityMemo("CAMPAIGN", campaign.id, `품목 추가 기안 메모: ${args.memo}`, actor, tx);
  }

  return {
    refType: "CAMPAIGN",
    refId: campaign.id,
    summary:
      `캠페인 품목 추가: ${newRows.length}건(새 하위품목 ${createdDeals}건 · 기존 하위품목 연결 ${newRows.length - createdDeals}건)` +
      (skipped > 0 ? ` · 이미 있어 건너뜀 ${skipped}건` : ""),
    createdCount: newRows.length,
  };
}

export const addCampaignItemsAction: WriteActionDefinition<AddCampaignItemsArgs> = {
  argsSchema: addCampaignItemsArgsSchema,
  handler: handleAddCampaignItems,
  // 화면 저장(캠페인 PATCH 라우트)의 `revalidateCampaignCaches()` 와 같은 캠페인 태그 + 새 하위품목이 판매 조건 목록에
  // 보이도록 deals 태그(`POST /api/deals` 가 비우는 master-data 묶음 중 판매 조건 몫). 캘린더는 품목이 일정 칸이
  // 아니라 다시 맞추지 않는다(PATCH 라우트도 일정 칸이 바뀔 때만 맞춘다).
  effects: () => ({
    revalidate: [...CAMPAIGN_INVALIDATION_TAGS, CRM_CACHE_TAGS.deals],
    calendarCampaignId: null,
  }),
};
