import { z } from "zod";
import {
  MAX_OPTION_DEALS,
  mainDealInputSchema,
  newPartnerInputSchema,
  opaqueIdSchema,
  optionDealInputSchema,
} from "@/lib/agent-worker/contracts";
import type { AgentTool, ToolResult, WriteIntent } from "./types";
import { missingParam, ok } from "./types";

/**
 * 칸의 모양은 계약(`@/lib/agent-worker/contracts`)이 export 한 조각을 그대로 부른다 —
 * 승인 시점 재검증(`write-executor.createDealArgsSchema`)이 같은 조각을 쓰므로,
 * 여기서 새로 적으면 두 검사가 조용히 갈린다.
 *
 * ⚠️ 「거래처는 둘 중 정확히 하나」는 스키마가 아니라 execute가 본다 — 스키마에서
 * 막으면 도구 호출이 형식 오류로 끝나지만, execute가 MISSING_PARAM으로 답하면
 * 에이전트 루프가 사용자에게 거래처를 되묻는다(types.ts의 MISSING_PARAM 계약).
 */
const inputSchema = z
  .object({
    partnerId: opaqueIdSchema
      .optional()
      .describe("이미 등록된 거래처의 ID. 새로 만들 거래처라면 이 칸 대신 partner를 채운다"),
    partner: newPartnerInputSchema
      .optional()
      .describe("딜과 함께 새로 만들 거래처. 이미 등록된 거래처라면 이 칸 대신 partnerId를 채운다"),
    mainDeal: mainDealInputSchema.describe("등록할 상품(딜) 한 건. dealName은 필수, 가격·단위는 선택"),
    optionDeals: z
      .array(optionDealInputSchema)
      .max(MAX_OPTION_DEALS)
      .optional()
      .describe(`이 상품의 옵션 줄 목록 (최대 ${MAX_OPTION_DEALS}건, 배열 순서가 곧 정렬 순서)`),
  })
  .strict();

export type CreateDealInput = z.infer<typeof inputSchema>;

export type CreateDealData = {
  writeIntent: WriteIntent;
};

type NewPartnerInput = z.infer<typeof newPartnerInputSchema>;

/**
 * 「둘 중 정확히 하나」를 판정하면서 승인 카드에 쓸 거래처 표현까지 함께 만든다.
 * 위반이면 null — 호출부가 되묻기(MISSING_PARAM)로 돌린다.
 */
function describeDealPartner(partnerId: string | undefined, partner: NewPartnerInput | undefined): string | null {
  if (partnerId && !partner) return `기존 거래처 ${partnerId}`;
  if (partner && !partnerId) return `거래처 "${partner.name}" 신규 등록`;
  return null;
}

/**
 * 청사진 §0-1: 이 도구는 실제 딜 생성도, ActionProposal 기안 생성도, 거래처 조회도 하지
 * 않는다. execute(input)는 userId를 모르므로(AgentTool 계약) 구조화된 writeIntent만
 * 반환하고, 승인 시점에 write-executor.handleCreateDeal이 거래처·부모 딜·옵션 딜을
 * 한 트랜잭션으로 만든다.
 */
async function execute(input: CreateDealInput): Promise<ToolResult<CreateDealData>> {
  const { partnerId, partner, mainDeal, optionDeals } = input;

  const partnerLabel = describeDealPartner(partnerId, partner);
  if (partnerLabel === null) {
    return missingParam(
      "딜을 만들 거래처를 정확히 하나로 지정해야 합니다: 이미 등록된 거래처는 partnerId, " +
        "새로 만들 거래처는 partner. 둘 다 없으면 거래처 정보를 먼저 확인해 주십시오.",
      { partnerId: partnerId ?? null, hasNewPartner: Boolean(partner) }
    );
  }
  if (!mainDeal?.dealName || !mainDeal.dealName.trim()) {
    return missingParam("등록할 딜(상품) 이름이 필요합니다.", { partnerId: partnerId ?? null });
  }

  const options = optionDeals ?? [];
  const writeIntent: WriteIntent = {
    action: "create_deal",
    args: {
      ...(partnerId ? { partnerId } : {}),
      ...(partner ? { partner } : {}),
      mainDeal,
      ...(options.length > 0 ? { optionDeals: options } : {}),
    },
    // 승인 시점 요약(`handleCreateDeal`)과 같은 문장 — 승인 카드와 실행 결과가 다른
    // 말을 하면 무엇을 승인했는지 되짚을 근거가 사라진다.
    summary:
      `딜 "${mainDeal.dealName}" 등록 (${partnerLabel})` +
      (options.length > 0 ? `, 옵션 ${options.length}건` : ""),
    // 이미 등록된 거래처에 붙는 딜만 가리킬 대상이 있다. 대상을 달아 두면 없는 거래처
    // id가 승인까지 끌려가지 않고 기안 시점에 걸린다. 거래처까지 새로 만드는 딜은
    // 아직 아무것도 없으므로 대상이 없다.
    targetEntityType: partnerId ? "PARTNER" : null,
    targetEntityId: partnerId ?? null,
  };

  // READ 도구와 달리 실조회가 없으므로 dataSources는 빈 배열이다 — 승인 전에는
  // 아무 데이터도 조회/변경하지 않았다는 사실을 evidence에 그대로 반영한다.
  return ok({ writeIntent }, [], {
    partnerId: partnerId ?? null,
    dealName: mainDeal.dealName,
    optionCount: options.length,
  });
}

export const createDealTool: AgentTool<CreateDealInput, CreateDealData> = {
  name: "create_deal",
  description:
    "새 딜(상품)을 등록합니다. 사용자가 딜/상품 등록을 명시적으로 요청할 때만 사용합니다. " +
    "거래처는 반드시 하나로 지정해야 합니다 — 이미 등록된 거래처면 partnerId(search_deals 등으로 " +
    "먼저 확인), 이번에 새로 만들 거래처면 partner에 그 정보를 담습니다(둘 다 주면 거부됩니다). " +
    "단가표에 옵션 줄이 있으면 optionDeals에 배열 순서대로 담으면 부모 딜 밑에 함께 만들어집니다. " +
    "실제로 만들지 않고 승인 대기 기안을 생성합니다 — 관리자 승인 후에만 실제 등록됩니다.",
  inputSchema,
  execute,
};
