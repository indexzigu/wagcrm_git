import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  MAX_OPTION_DEALS,
  mainDealInputSchema,
  newPartnerInputSchema,
  opaqueIdSchema,
  optionDealInputSchema,
} from "@/lib/agent-worker/contracts";
import { recordActivityCreate } from "@/lib/activity-log";
import { MASTER_DATA_INVALIDATION_TAGS } from "@/lib/cache-tags";
import { assertEntityExists, type WriteActionDefinition, type WriteActionResult } from "./types";
import { createPartnerRow } from "./create-partner";

/**
 * `create_deal` 의 args = 계약(`@/lib/agent-worker/contracts`)의 같은 변형에서
 * `action` 칸만 뺀 모양. **칸의 모양은 계약이 export 한 조각을 그대로 부른다** — 승인 시점
 * 재검증(파일 머리 ②)이 기안 시점보다 느슨하면 그 틈이 우회로다. ⚠️ 봉투(키 이름·개수·「둘 중
 * 하나」)만 한 벌 더 있다(계약 변형은 익명 객체라 `action` 만 뗄 손잡이가 없다) — 갈리면
 * `__tests__/write-executor.test.ts` 의 계약 대조가 잡는다.
 */
const createDealArgsSchema = z
  .object({
    partnerId: opaqueIdSchema.optional(),
    partner: newPartnerInputSchema.optional(),
    mainDeal: mainDealInputSchema,
    optionDeals: z.array(optionDealInputSchema).max(MAX_OPTION_DEALS).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // 계약과 같은 「둘 중 정확히 하나」. 거래처 없는 딜은 어느 화면에도 안 걸리고, 둘 다 오면
    // 어느 쪽을 믿을지 실행기가 고르게 된다 — 그 선택은 계약이 이미 금지했다.
    if (Boolean(value.partnerId) === Boolean(value.partner)) {
      context.addIssue({
        code: "custom",
        path: ["partnerId"],
        message:
          "거래처를 정확히 하나로 지정해야 한다: 이미 등록된 거래처는 partnerId, " +
          "새로 만들 거래처는 partner.",
      });
    }
  });

export type CreateDealArgs = z.infer<typeof createDealArgsSchema>;

/**
 * 정책 없는 딜의 `baseMarginPolicy` — 정본(`src/services/dealService.ts:342`)이 넣는 값과
 * **같은 글자**다. 컬럼이 필수라 비울 수 없고, 다르면 마진 화면이 두 경로에서 갈린다.
 */
const DEFAULT_BASE_MARGIN_POLICY = '{"byChannel":{}}';

type OptionDealArgs = z.infer<typeof optionDealInputSchema>;
type MainDealArgs = z.infer<typeof mainDealInputSchema>;

/** 옵션 딜이 부모에게서 물려받는 값 묶음(정본 C2-1 상속 대상 + 거래처 연결). */
type ParentDealContext = {
  readonly id: string;
  readonly brandName: string | null;
  readonly unit: string | null;
  readonly partnerId: string;
  readonly partnerCompanyName: string;
};

/** 딜이 붙을 거래처 확정: 등록된 거래처면 존재 검증(§0-6), 동봉돼 오면 **같은 tx 안에서** 생성. */
async function resolveDealPartner(
  args: CreateDealArgs,
  actor: string,
  tx: Prisma.TransactionClient
): Promise<{ id: string; name: string }> {
  if (args.partnerId) {
    await assertEntityExists("PARTNER", args.partnerId, tx);
    const partner = await tx.partner.findUnique({
      where: { id: args.partnerId },
      select: { id: true, name: true },
    });
    if (!partner) {
      // assertEntityExists가 이미 확인했으므로 도달 불가하지만 타입 좁히기 및 방어적 코딩용
      // (handleChangeDealStatus와 같은 패턴).
      throw new Error(`대상 거래처(${args.partnerId})를 찾을 수 없습니다. 이미 삭제되었거나 잘못된 대상입니다.`);
    }
    return partner;
  }

  if (!args.partner) {
    // argsSchema의 「둘 중 정확히 하나」가 이미 막는다. 스키마가 느슨해져도 거래처 없는 딜이
    // 서지 않도록 실행기에서도 닫는다.
    throw new Error(
      "딜을 만들 거래처가 지정되지 않았습니다 (partnerId 또는 partner 중 하나가 필요합니다)."
    );
  }

  // 계약의 `partner` 는 담당자를 품지 않는다(중첩 깊이 상한) — 담당자는 create_partner 소관.
  return createPartnerRow(args.partner, [], actor, tx);
}

/** 부모 딜(MAIN) 한 행의 생성 데이터. 값 규칙은 정본 `dealService.createDeal` 과 같다. */
function toMainDealCreateData(
  main: MainDealArgs,
  partner: { id: string; name: string }
): Prisma.DealUncheckedCreateInput {
  return {
    dealName: main.dealName,
    brandName: main.brandName ?? null,
    partnerId: partner.id,
    // 계약에 `partnerCompanyName` 칸이 없다 — 확정된 거래처 이름을 그대로 넣는다.
    partnerCompanyName: partner.name,
    costPrice: main.costPrice ?? 0,
    sellingPrice: main.sellingPrice ?? 0,
    supplyPrice: main.supplyPrice ?? null,
    listPrice: main.listPrice ?? null,
    shippingFee: main.shippingFee ?? null,
    unit: main.unit ?? null,
    unitQuantity: main.unitQuantity ?? null,
    sourcingMemo: main.sourcingMemo ?? null,
    dealType: "MAIN",
    baseMarginPolicy: DEFAULT_BASE_MARGIN_POLICY,
    status: "SOURCING",
  };
}

/**
 * 옵션 딜들을 방금 만든 부모 밑에 만든다. `optionSortOrder` 는 배열 순서대로 0,1,2… 인데,
 * 정본의 「형제 중 최대값+1」(`dealService.createDeal` 의 needsSiblingLookup)과 결과가 같다 —
 * 부모를 **이 트랜잭션에서 방금** 만들어 형제가 하나도 없기 때문이다. brandName·unit 은
 * 옵션에 값이 없으면 부모 값을 물려받는다(정본 C2-1) — 옵션 입력에는 brandName 칸 자체가 없다.
 */
async function createOptionDeals(
  options: readonly OptionDealArgs[],
  parent: ParentDealContext,
  actor: string,
  tx: Prisma.TransactionClient
): Promise<void> {
  for (const [index, option] of options.entries()) {
    const created = await tx.deal.create({
      data: {
        dealName: option.dealName,
        brandName: parent.brandName,
        partnerId: parent.partnerId,
        partnerCompanyName: parent.partnerCompanyName,
        // 옵션 입력에는 원가 칸이 없다 — 컬럼 기본값과 같은 0으로 둔다(가격표 반영 경로도 동일).
        costPrice: 0,
        sellingPrice: option.sellingPrice ?? 0,
        supplyPrice: option.supplyPrice ?? null,
        listPrice: option.listPrice ?? null,
        unit: option.unit ?? parent.unit,
        unitQuantity: option.unitQuantity ?? null,
        sourcingMemo: option.sourcingMemo ?? null,
        dealType: "OPTION",
        parentDealId: parent.id,
        optionSortOrder: index,
        baseMarginPolicy: DEFAULT_BASE_MARGIN_POLICY,
        status: "SOURCING",
      },
      select: { id: true },
    });

    await recordActivityCreate("DEAL", created.id, actor, tx);
  }
}

/**
 * 딜을 만든다(Phase 5 HITL WRITE 5종째). 거래처 확정 → 부모 딜(MAIN) → 옵션 딜(OPTION)이
 * 한 트랜잭션이다. 값 규칙은 정본 `dealService.createDeal` 을 따른다.
 */
async function handleCreateDeal(
  args: CreateDealArgs,
  actor: string,
  tx: Prisma.TransactionClient
): Promise<WriteActionResult> {
  const partner = await resolveDealPartner(args, actor, tx);
  const main = args.mainDeal;
  const options = args.optionDeals ?? [];

  const parentDeal = await tx.deal.create({
    data: toMainDealCreateData(main, partner),
    select: { id: true },
  });

  await recordActivityCreate("DEAL", parentDeal.id, actor, tx);

  await createOptionDeals(
    options,
    {
      id: parentDeal.id,
      brandName: main.brandName ?? null,
      unit: main.unit ?? null,
      partnerId: partner.id,
      partnerCompanyName: partner.name,
    },
    actor,
    tx
  );

  return {
    refType: "DEAL",
    refId: parentDeal.id,
    summary:
      `딜 "${main.dealName}" 등록 (거래처 ${partner.name}${args.partnerId ? "" : " 신규 등록"})` +
      (options.length > 0 ? `, 옵션 ${options.length}건` : ""),
  };
}

export const createDealAction: WriteActionDefinition<CreateDealArgs> = {
  argsSchema: createDealArgsSchema,
  handler: handleCreateDeal,
  // 정본 라우트 `POST /api/deals` 의 `revalidateMasterDataCaches()` 와 **같은 집합**
  // (거래처를 동봉해 만드는 경로가 필요로 하는 거래처 태그도 이미 이 집합에 있다).
  effects: () => ({ revalidate: MASTER_DATA_INVALIDATION_TAGS, calendarCampaignId: null }),
};
