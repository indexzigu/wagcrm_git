/**
 * 가격표 검수 승인 → Deal 반영 실행기 (Phase 3 청사진 §2, 결정 6).
 *
 * 검수표에서 "승인"을 누르면 서버가 한 요청 안에서 ActionProposal을
 * DRAFT → PENDING_APPROVAL → APPROVED → EXECUTED로 순차 전이시킨다
 * (actionProposalRepository.transition 사용 — canTransition이 WRITE의 DRAFT→EXECUTED
 * 직행을 금지하므로 반드시 이 체인을 그대로 거쳐야 한다).
 *
 * 실행 자체(runApplyActions)는 Prisma.$transaction으로 감싸 부분반영을 금지한다. 이 $transaction은
 * EXECUTED 전이(ActionProposalRepository.transition)까지 함께 포함한다(M1) — 전이 실패도
 * Deal 쓰기 롤백으로 이어져야 "전체 롤백"이 항상 사실이 되기 때문이다.
 * dealService.updateDeal/createDeal은 내부적으로 자체 getPrisma() 호출을 사용해 인터랙티브
 * 트랜잭션의 tx 클라이언트와 별개의 커넥션이 되므로 원자성이 깨진다 — 이 실행기는 Phase 3
 * 전용 최소 함수로 tx.deal.update/create를 직접 호출한다(payload 형태는 Phase 5 호환:
 * {service:"dealService", method:"updateDeal"|"createDeal", args:[...]}).
 *
 * Deal.supplyPrice는 Float(청사진 R-E) — PriceSheetRow.supplyPrice(Decimal)에서 옮길 때
 * Number()로 변환한다.
 */
import { getPrisma } from "@/lib/prisma";
import { ActionProposalRepository } from "@/repositories/actionProposalRepository";
import type { Prisma } from "@prisma/client";
import {
  computeDealGroups,
  decimalToNumber,
  rateToDealPercent,
  type ApplyRowInput,
  type BundlePolicy,
  type DealCreatePayload,
  type DealGroupOverride,
} from "./grouping";

// 그룹핑 규칙의 SSOT는 ./grouping.ts다(검수 화면 "딜 반영 미리보기"와 공유).
// 기존 소비처(테스트 포함) 호환을 위해 여기서 재수출한다.
export {
  computeDealGroups,
  extractPackQuantity,
  extractOptionBase,
  extractBrandName,
  matchPartnerByBrand,
  parseOptionName,
  rateToDealPercent,
  BUNDLE_GROUP_KEY,
  type ApplyRowInput,
  type DealCreatePayload,
  type DealGroupOverride,
  type PartnerOption,
  type BundlePolicy,
  type BundleTarget,
} from "./grouping";

export type ApplyRowAction =
  | {
      service: "dealService";
      method: "updateDeal";
      args: [dealId: string, data: DealUpdatePayload];
    }
  | {
      service: "dealService";
      method: "createDeal";
      args: [data: DealCreatePayload];
    }
  | {
      // 같은 제품명을 가진 신규 행이 2개 이상이면 상위딜(MAIN) 1개 + 하위품목딜(OPTION) N개로
      // 묶어 생성한다. parentDealId는 부모가 트랜잭션 안에서 생성된 뒤에야 알 수 있으므로
      // 액션 payload에는 담지 않고 runApplyActions가 실행 시점에 주입한다(옵션 순서 = optionSortOrder).
      service: "dealService";
      method: "createDealGroup";
      args: [group: DealGroupPayload];
    }
  | {
      // 이미 존재하는 상위딜 아래에 하위품목딜(OPTION) N개를 붙인다. optionSortOrder는
      // 부모의 현재 최대값 다음부터 이어붙이므로 payload에는 상대 순서만 담고
      // runApplyActions가 실행 시점에 오프셋을 더한다.
      service: "dealService";
      method: "attachDealOptions";
      args: [payload: AttachDealOptionsPayload];
    };

export type DealGroupPayload = {
  parent: DealCreatePayload;
  options: DealCreatePayload[];
};

export type AttachDealOptionsPayload = {
  parentDealId: string;
  options: DealCreatePayload[];
};

export type DealUpdatePayload = {
  dealName?: string;
  sellingPrice?: number;
  costPrice?: number;
  supplyPrice?: number | null;
  listPrice?: number | null;
  floorPrice?: number | null;
  totalCommissionRate?: number | null;
  discountRate?: number | null;
};

/** PriceSheetRow 하나를 payload 액션으로 변환한다(순수 함수, 테스트 가능). */
export function buildApplyActionForRow(
  row: ApplyRowInput,
  partnerId: string | null
): ApplyRowAction | null {
  const sellingPrice = decimalToNumber(row.sellingPrice);
  const supplyPrice = decimalToNumber(row.supplyPrice);
  const listPrice = decimalToNumber(row.listPrice);
  const floorPrice = decimalToNumber(row.floorPrice);
  // 비율만 단위 변환이 필요하다 — 가격표는 0~1 소수, 딜은 퍼센트 수치(rateToDealPercent 참조).
  // 금액 필드는 두 저장소가 같은 단위라 그대로 옮긴다.
  const commissionRate = rateToDealPercent(row.commissionRate);
  const discountRate = rateToDealPercent(row.discountRate);

  if (row.mappingStatus === "MAPPED" && row.mappedDealId) {
    const data: DealUpdatePayload = {};
    if (sellingPrice !== null) data.sellingPrice = sellingPrice;
    if (supplyPrice !== null) data.supplyPrice = supplyPrice;
    if (listPrice !== null) data.listPrice = listPrice;
    if (floorPrice !== null) data.floorPrice = floorPrice;
    if (commissionRate !== null) data.totalCommissionRate = commissionRate;
    if (discountRate !== null) data.discountRate = discountRate;
    return { service: "dealService", method: "updateDeal", args: [row.mappedDealId, data] };
  }

  if (row.mappingStatus === "NEW_DEAL") {
    if (!row.productName || sellingPrice === null) return null; // 필수값 없으면 생성 스킵(검수 단계에서 걸러졌어야 함)
    return {
      service: "dealService",
      method: "createDeal",
      args: [
        {
          dealName: row.productName,
          partnerId,
          costPrice: supplyPrice ?? 0,
          sellingPrice,
          supplyPrice,
          listPrice,
          floorPrice,
          totalCommissionRate: commissionRate,
          discountRate,
        },
      ],
    };
  }

  return null; // UNMAPPED/SUGGESTED(미확정)는 반영 대상 아님
}

/**
 * 반영 대상 행 전체를 액션 목록으로 변환한다.
 * - MAPPED 행: 기존 딜 갱신(updateDeal) — 행마다 독립.
 * - NEW_DEAL 행: computeDealGroups(./grouping.ts — 검수 화면 '딜 반영 미리보기'와 공유하는
 *   SSOT)가 (제품명 + 구성 베이스)로 묶은 결과를 액션으로 변환한다. 그룹 크기 1이면 단일
 *   createDeal, 2 이상이면 상위딜(MAIN)+하위품목딜(OPTION)의 createDealGroup.
 */
export function buildApplyActions(
  rows: ApplyRowInput[],
  partnerId: string | null,
  groupOverrides?: Record<string, DealGroupOverride>,
  bundle?: BundlePolicy
): ApplyRowAction[] {
  const actions: ApplyRowAction[] = [];

  // MAPPED(및 기타) 행: 기존 per-row 규약 그대로.
  for (const row of rows) {
    if (row.mappingStatus !== "NEW_DEAL") {
      const action = buildApplyActionForRow(row, partnerId);
      if (action) actions.push(action);
    }
  }

  const { groups } = computeDealGroups(rows, partnerId, groupOverrides, bundle);
  for (const group of groups) {
    if (group.attachToDealId) {
      actions.push({
        service: "dealService",
        method: "attachDealOptions",
        args: [{ parentDealId: group.attachToDealId, options: group.options ?? [] }],
      });
    } else if (group.options === null) {
      actions.push({ service: "dealService", method: "createDeal", args: [group.parent] });
    } else {
      actions.push({
        service: "dealService",
        method: "createDealGroup",
        args: [{ parent: group.parent, options: group.options }],
      });
    }
  }

  return actions;
}

export class ApplyExecutorError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ApplyExecutorError";
  }
}

/**
 * Deal 쓰기(tx.deal.update/create) 자체를 수행한다. 호출부가 이미 열어둔 인터랙티브
 * 트랜잭션(tx)을 받아 그 안에서 실행한다 — EXECUTED 전이와 원자성을 묶기 위해
 * $transaction을 여기서 새로 열지 않는다(M1: applyPriceSheet가 이 함수와
 * ActionProposalRepository.transition(EXECUTED)를 하나의 $transaction으로 감싼다).
 */
/** DealCreatePayload → Prisma create data. parentDealId는 부모 연결(connect)로 표현한다. */
function toDealCreateData(data: DealCreatePayload): Prisma.DealCreateInput {
  return {
    dealName: data.dealName,
    brandName: data.brandName ?? null,
    ...(data.partnerId ? { partner: { connect: { id: data.partnerId } } } : {}),
    ...(data.parentDealId ? { parentDeal: { connect: { id: data.parentDealId } } } : {}),
    costPrice: data.costPrice,
    sellingPrice: data.sellingPrice,
    supplyPrice: data.supplyPrice ?? null,
    listPrice: data.listPrice ?? null,
    floorPrice: data.floorPrice ?? null,
    totalCommissionRate: data.totalCommissionRate ?? null,
    discountRate: data.discountRate ?? null,
    dealType: data.dealType ?? "MAIN",
    optionSortOrder: data.optionSortOrder ?? 0,
    unit: data.unit ?? null,
    unitQuantity: data.unitQuantity ?? null,
    supplementaryInfo: data.supplementaryInfo ?? null,
    baseMarginPolicy: '{"byChannel":{}}',
    status: "SOURCING",
  };
}

async function createDealWithLog(
  tx: Prisma.TransactionClient,
  data: DealCreatePayload,
  actor: string
): Promise<string> {
  const created = await tx.deal.create({ data: toDealCreateData(data) });
  await tx.activityLog.create({
    data: { entityType: "DEAL", entityId: created.id, type: "CREATE", actor },
  });
  return created.id;
}

async function runApplyActions(
  tx: Prisma.TransactionClient,
  actions: ApplyRowAction[],
  actor: string
) {
  const results: Array<{ dealId: string; action: "UPDATE" | "CREATE" }> = [];

  for (const action of actions) {
    if (action.method === "updateDeal") {
      const [dealId, data] = action.args;
      const updated = await tx.deal.update({
        where: { id: dealId },
        data: data as Prisma.DealUpdateInput,
      });
      await tx.activityLog.create({
        data: {
          entityType: "DEAL",
          entityId: updated.id,
          type: "CHANGE",
          fieldName: "가격표 반영",
          newValue: JSON.stringify(data),
          actor,
        },
      });
      results.push({ dealId: updated.id, action: "UPDATE" });
    } else if (action.method === "createDeal") {
      const [data] = action.args;
      const dealId = await createDealWithLog(tx, data, actor);
      results.push({ dealId, action: "CREATE" });
    } else if (action.method === "attachDealOptions") {
      // 기존 상위딜에 하위품목을 이어붙인다. 정렬 순서는 부모의 현재 최대값 다음부터 —
      // 0부터 다시 매기면 기존 옵션과 섞여 딜 패널의 표시 순서가 뒤집힌다.
      const [{ parentDealId, options }] = action.args;
      const parent = await tx.deal.findUnique({
        where: { id: parentDealId },
        select: { parentDealId: true },
      });
      if (!parent) {
        throw new ApplyExecutorError(`상위딜을 찾을 수 없습니다 (${parentDealId})`);
      }
      if (parent.parentDealId) {
        // 2단 중첩은 오퍼 진단·발주 준비도의 부모 치환(parentDealId ?? id)을 조용히 망가뜨린다.
        throw new ApplyExecutorError("하위품목딜에는 다시 하위품목을 붙일 수 없습니다");
      }
      const maxOrder = await tx.deal.aggregate({
        where: { parentDealId },
        _max: { optionSortOrder: true },
      });
      const offset = (maxOrder._max.optionSortOrder ?? -1) + 1;
      for (const [index, option] of options.entries()) {
        const optionId = await createDealWithLog(
          tx,
          { ...option, parentDealId, optionSortOrder: offset + index },
          actor
        );
        results.push({ dealId: optionId, action: "CREATE" });
      }
    } else {
      // createDealGroup: 상위딜(MAIN)을 먼저 만들고, 그 id를 각 하위품목딜(OPTION)의
      // parentDealId로 주입해 순차 생성한다 — 부모 id가 이 트랜잭션 안에서만 확정되기 때문.
      const [{ parent, options }] = action.args;
      const parentId = await createDealWithLog(tx, parent, actor);
      results.push({ dealId: parentId, action: "CREATE" });
      for (const option of options) {
        const optionId = await createDealWithLog(tx, { ...option, parentDealId: parentId }, actor);
        results.push({ dealId: optionId, action: "CREATE" });
      }
    }
  }

  return results;
}

/**
 * 검수 승인 1회 요청의 전체 흐름: ActionProposal 생성(DRAFT) → PENDING_APPROVAL → APPROVED
 * → 실행 → EXECUTED(성공) / FAILED(실패, errorMessage 기록). canTransition이 WRITE의
 * DRAFT→EXECUTED 직행을 막으므로 반드시 이 순서를 지킨다.
 */
export async function applyPriceSheet(input: {
  priceSheetId: string;
  partnerId: string | null;
  actor: string;
  // ApplyRowInput으로 통일해 그룹핑이 의존하는 optionName이 타입에서 빠지지 않게 한다
  // (인라인 타입이면 호출부가 select로 optionName을 누락해도 TS가 못 잡고 그룹핑이 조용히 퇴화).
  rows: ApplyRowInput[];
  /** 검수 화면이 확인·수정한 그룹별 브랜드·거래처(키 = groupKey). 미전달 시 기본값 규칙. */
  groupOverrides?: Record<string, DealGroupOverride>;
  /** 시트 단위 반영 방식(검수 화면 선택). 미전달 시 AUTO(현행 규칙). */
  bundle?: BundlePolicy;
}) {
  const { priceSheetId, partnerId, actor, rows, groupOverrides, bundle } = input;

  const actions = buildApplyActions(rows, partnerId, groupOverrides, bundle);

  if (actions.length === 0) {
    throw new ApplyExecutorError("반영할 매핑 확정 행이 없습니다 (MAPPED/NEW_DEAL 행 없음)");
  }

  const proposal = await ActionProposalRepository.create({
    requestType: "price_sheet_apply",
    kind: "WRITE",
    status: "DRAFT",
    title: `가격표 반영 (${priceSheetId})`,
    reviewRequired: true,
    targetEntityType: "PRICE_SHEET",
    targetEntityId: priceSheetId,
    payload: actions,
    createdBy: actor,
  });

  await ActionProposalRepository.transition(proposal.id, "PENDING_APPROVAL", {
    actor,
    note: "가격표 검수 승인과 동시에 자동 상신",
  });
  await ActionProposalRepository.transition(proposal.id, "APPROVED", {
    actor,
    note: "검수 승인 = 즉시 승인 처리",
  });

  // M1: Deal 쓰기(runApplyActions)와 EXECUTED 전이(ActionProposalRepository.transition)를
  // 하나의 $transaction으로 묶는다. 이전에는 Deal 커밋이 끝난 뒤 트랜잭션 밖에서 EXECUTED
  // 전이를 별도로 실행했기 때문에, 전이 자체가 실패하면(예: DB 순간 장애) Deal은 이미
  // 커밋됐는데도 "전체 롤백됨"이라는 거짓 note와 함께 FAILED로 기록되는 상태-DB 불일치가
  // 발생했다. 이제는 전이 실패 = Deal 쓰기까지 전부 롤백이 사실이 되므로 note도 그에 맞게
  // 정정한다.
  const prisma = getPrisma();
  try {
    const { results, executed } = await prisma.$transaction(async (tx) => {
      const results = await runApplyActions(tx, actions, actor);
      const executed = await ActionProposalRepository.transition(proposal.id, "EXECUTED", {
        actor,
        note: `${results.length}건 반영 완료`,
        data: {
          executedBy: actor,
          executedAt: new Date(),
          executionResult: { results },
        },
        tx,
      });
      return { results, executed };
    });
    return { proposal: executed, results };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 위 $transaction이 실패했으므로 Deal 쓰기와 EXECUTED 전이가 모두 롤백된 상태다.
    // 아래 FAILED 전이는 별도의(정상 동작하는) 트랜잭션으로, ActionProposal 자체를
    // APPROVED -> FAILED로 옮겨 재시도 가능하게 만드는 용도다.
    await ActionProposalRepository.transition(proposal.id, "FAILED", {
      actor,
      note: "실행 중 오류: Deal 반영 및 상태 전이 전체 롤백됨(부분반영 없음)",
      data: { errorMessage: message },
    });
    throw new ApplyExecutorError(`가격표 반영 실행 실패: ${message}`, err);
  }
}
