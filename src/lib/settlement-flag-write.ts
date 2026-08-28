/**
 * 정산 완료 플래그 3종의 **CG-1 SoT 읽기·쓰기 SSOT**.
 *
 * `isDepositReceived` · `isPayoutCompleted` · `isSupplierPayoutCompleted` 와 짝 타임스탬프는
 * **그룹 소속이면 `CampaignGroup` 스칼라가 정본**이고 멤버 행 값은 낡을 수 있다(CG-1).
 * 그래서 이 세 플래그를 만지는 코드는 **읽을 때도 쓸 때도** 어느 행이 정본인지 먼저 골라야
 * 하는데, 그 선택이 호출부마다 손으로 재구현되면 한쪽만 그룹을 인지하는 상태가 된다.
 *
 * 🪤 **실제로 그렇게 갈렸다.** 오너의 버튼 경로(`PATCH /api/campaigns/[id]/settlement-status`)는
 * 그룹 스칼라에 썼는데, 어시스턴트 경로(`write-executor.handleConfirmSettlement`)는
 * `salesCampaign.updateMany` **하나만** 돌려서 그룹 소속 캠페인을 확정하면 **멤버 행만 true 가
 * 되고 그룹 스칼라는 false 로 남았다.** 화면·지연 판정·정산 목록은 전부 그룹 스칼라를 읽으므로
 * (`buildOverdueSettlementItems` · `desktop-dashboard` · `campaign-group-row`)
 * 「확정했는데 화면은 그대로」가 되고, 반대로 `computeAutoStatus` 는 멤버 플래그로 status 를
 * 전진시켜 status 와 플래그가 어긋난 행이 남는다. 같은 부류의 선례가 `buildOverdueSettlementItems`
 * 의 #196(멤버 플래그로 지연을 판정해 이미 입금된 그룹이 멤버 수만큼 지연으로 뜬 결함)이다.
 *
 * ⛔ **이 세 플래그를 쓰는 새 경로는 `tx.campaignGroup` / `tx.salesCampaign` 을 직접 부르지 말고
 * `writeSettlementFlags` 를 통과시킨다.** 계약은 `settlement-flag-write.contract.test.ts` 가
 * 소스 스캔으로 강제한다.
 *
 * ℹ️ **예외 하나 — `campaignService.updateCampaign`(캠페인 PATCH).** 그 경로는 같은 규칙을
 * 이미 지키지만(`groupSharedEventUpdates` → 그룹 / `!isGrouped` 일 때만 멤버) 플래그를
 * 계산서일·예정일·반품기간과 **한 statement 로 묶어** 쓴다. 그 묶음을 쪼개 이 함수를 태우면
 * 그룹 쓰기가 두 번으로 갈라져 원자성만 잃고 얻는 게 없다 — 계약 테스트의 허용 목록에
 * 사유와 함께 등재돼 있다.
 *
 * ⚠️ **status 는 이 규칙의 대상이 아니다.** `SalesCampaign.status` 는 그룹 스칼라가 없는
 * **멤버 고유 값**이라 그룹 소속이어도 멤버 행에 쓴다(정본 라우트가 하던 그대로).
 */
import type { CampaignGroup, Prisma, SalesCampaign } from "@prisma/client";
import type { SettlementCompletionFlags } from "./settlement-status";

/**
 * 완료 플래그 + 짝 타임스탬프 묶음. 그룹·멤버 어느 행에도 같은 이름으로 존재하므로
 * 두 모델의 입력 타입 교집합으로 받는다 — 한쪽에만 있는 필드를 실으면 컴파일이 막는다.
 */
export type SettlementScalarUpdates = Prisma.CampaignGroupUpdateManyMutationInput &
  Prisma.SalesCampaignUpdateManyMutationInput;

/**
 * 지금 이 캠페인의 정산 플래그 **정본 값**을 고른다 — 그룹이 있으면 그룹 스칼라, 없으면 멤버 행.
 *
 * ⛔ 호출부에서 `group?.isDepositReceived ?? campaign.isDepositReceived` 를 세 번 쓰지 말 것:
 * 세 플래그 중 하나만 빠뜨리면 그 레그의 전진 검증·상태 라벨이 낡은 멤버 값을 본다.
 */
export function resolveSettlementFlagSnapshot(
  campaign: SettlementCompletionFlags,
  group: SettlementCompletionFlags | null,
): SettlementCompletionFlags {
  const owner = group ?? campaign;
  return {
    isDepositReceived: owner.isDepositReceived,
    isPayoutCompleted: owner.isPayoutCompleted,
    isSupplierPayoutCompleted: owner.isSupplierPayoutCompleted,
  };
}

export type SettlementFlagWriteParams = {
  /** 대상 캠페인(사전 조회분). 그룹 소속이어도 status 는 이 행에 쓴다. */
  campaign: SalesCampaign;
  /** 소속 그룹(사전 조회분). null 이면 미그룹 — 플래그가 멤버 행으로 간다. */
  group: CampaignGroup | null;
  /** 완료 플래그 + 타임스탬프. 비어 있으면 플래그 쓰기를 건너뛴다. */
  settlementUpdates: SettlementScalarUpdates;
  /** 멤버 행 전용 필드(status 등). 그룹 여부와 무관하게 `SalesCampaign` 에 쓴다. */
  campaignUpdates: Prisma.SalesCampaignUpdateManyMutationInput;
  /**
   * 낙관적 선행조건 — **정본 행**(그룹이면 그룹, 아니면 멤버)의 사전 플래그 값.
   * 전진 전용 경로가 "사전 조회 이후 남이 이미 확정했다"를 원자적으로 걸러내는 장치다.
   * 생략하면 조건 없이 쓴다(양방향 토글이 정상인 버튼 경로).
   */
  expect?: Partial<SettlementCompletionFlags>;
};

export type SettlementFlagWriteResult =
  | { ok: true; campaign: SalesCampaign; group: CampaignGroup | null }
  /**
   * 쓰기 대상이 사라졌거나(그룹 탈퇴·삭제) 선행조건이 어긋났다(동시 확정).
   * 호출부가 409/재시도 안내로 번역한다 — 이 함수는 예외를 던지지 않는다.
   */
  | { ok: false };

/**
 * 정산 플래그를 **정본 행에** 쓰고, 멤버 전용 필드는 멤버 행에 쓴다.
 *
 * 🪤 **그룹 쓰기의 `where` 에 멤버십 조건이 붙어 있는 것은 방어가 아니라 계약이다** —
 * 사전 조회와 이 쓰기 사이에 대상 캠페인이 그룹을 떠났다면 우리는 **남의 그룹**을 확정하게
 * 된다. `count !== 1` 이면 그 상태이므로 쓰지 않고 실패로 돌려준다.
 *
 * ⚠️ **두 행이 갈리므로 반드시 호출부의 트랜잭션 안에서 부른다**(`tx` 주입). 그룹 플래그만
 * 커밋되고 멤버 status 가 빠지면 위 #196 과 같은 어긋난 행이 그대로 남는다.
 *
 * ℹ️ 쓰기를 `update` 가 아니라 `updateMany` + 재조회로 통일한 이유: `expect` 선행조건을
 * 양쪽 행에 같은 모양으로 실을 수 있고, "못 썼다"가 예외(P2025)가 아니라 `count` 라는
 * 같은 신호로 나온다. 재조회는 같은 트랜잭션 안의 PK 조회 1회다.
 */
export async function writeSettlementFlags(
  tx: Prisma.TransactionClient,
  params: SettlementFlagWriteParams,
): Promise<SettlementFlagWriteResult> {
  const { campaign, group, settlementUpdates, campaignUpdates, expect } = params;
  const precondition = expect ?? {};
  const hasSettlementUpdates = Object.keys(settlementUpdates).length > 0;

  let nextGroup = group;
  if (group && hasSettlementUpdates) {
    const { count } = await tx.campaignGroup.updateMany({
      where: { id: group.id, members: { some: { id: campaign.id } }, ...precondition },
      data: settlementUpdates,
    });
    if (count !== 1) return { ok: false };
    const reread = await tx.campaignGroup.findUnique({ where: { id: group.id } });
    if (!reread) return { ok: false };
    nextGroup = reread;
  }

  // 그룹이면 멤버 행에는 멤버 전용 필드만 간다(CG-1: 플래그를 양쪽에 쓰면 값이 갈라진다).
  const campaignData: Prisma.SalesCampaignUpdateManyMutationInput = group
    ? { ...campaignUpdates }
    : { ...settlementUpdates, ...campaignUpdates };

  let nextCampaign = campaign;
  if (Object.keys(campaignData).length > 0) {
    const { count } = await tx.salesCampaign.updateMany({
      // 선행조건은 **플래그가 사는 행에만** 건다 — 그룹 소속이면 멤버 행의 플래그는
      // 이미 낡았을 수 있어, 여기에 걸면 정상 확정이 조용히 거부된다.
      where: { id: campaign.id, ...(group ? {} : precondition) },
      data: campaignData,
    });
    if (count !== 1) return { ok: false };
    const reread = await tx.salesCampaign.findUnique({ where: { id: campaign.id } });
    if (!reread) return { ok: false };
    nextCampaign = reread;
  }

  return { ok: true, campaign: nextCampaign, group: nextGroup };
}
