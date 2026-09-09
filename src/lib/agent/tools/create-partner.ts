import { z } from "zod";
import {
  MAX_PARTNER_CONTACTS,
  newPartnerInputSchema,
  partnerContactInputSchema,
} from "@/lib/agent-worker/contracts";
import type { AgentTool, ToolResult, WriteIntent } from "./types";
import { missingParam, ok } from "./types";

/**
 * 칸의 모양은 계약(`@/lib/agent-worker/contracts`)이 export 한 조각을 그대로 부른다 —
 * 승인 시점 재검증(`write-executor.createPartnerArgsSchema`)이 같은 조각을 쓰므로,
 * 여기서 새로 적으면 두 검사가 조용히 갈린다.
 */
const inputSchema = z
  .object({
    partner: newPartnerInputSchema.describe(
      "새로 등록할 거래처 정보. name(상호)과 type(BRAND/VENDOR/AGENCY/AGENT/SELLER)은 필수, " +
        "businessNumber(사업자등록번호 숫자 10자리)·ceoName·representativeEmail·address·notes는 선택"
    ),
    contacts: z
      .array(partnerContactInputSchema)
      .max(MAX_PARTNER_CONTACTS)
      .optional()
      .describe(`이 거래처의 담당자 목록 (최대 ${MAX_PARTNER_CONTACTS}명, 각 담당자는 name 필수)`),
  })
  .strict();

export type CreatePartnerInput = z.infer<typeof inputSchema>;

export type CreatePartnerData = {
  writeIntent: WriteIntent;
};

/**
 * 청사진 §0-1: 이 도구는 실제 거래처 생성도, ActionProposal 기안 생성도 하지 않는다.
 * execute(input)는 userId를 모르므로(AgentTool 계약) 구조화된 writeIntent만 반환하고,
 * 승인 시점에 write-executor.handleCreatePartner가 실제 행을 만든다.
 */
async function execute(input: CreatePartnerInput): Promise<ToolResult<CreatePartnerData>> {
  const { partner, contacts } = input;

  if (!partner?.name || !partner.name.trim()) {
    return missingParam("등록할 거래처의 상호가 필요합니다.", { contactCount: contacts?.length ?? 0 });
  }

  const contactCount = contacts?.length ?? 0;
  const writeIntent: WriteIntent = {
    action: "create_partner",
    args: { partner, ...(contacts ? { contacts } : {}) },
    // 승인 시점 요약(`handleCreatePartner`)과 같은 문장 — 승인 카드와 실행 결과가
    // 다른 말을 하면 무엇을 승인했는지 되짚을 근거가 사라진다.
    summary:
      `거래처 "${partner.name}"(${partner.type}) 등록` +
      (contactCount > 0 ? `, 담당자 ${contactCount}명` : ""),
    // 붙일 대상이 애초에 없다 — 이 기안이 승인돼야 그 거래처가 처음 생긴다.
    targetEntityType: null,
    targetEntityId: null,
  };

  // READ 도구와 달리 실조회가 없으므로 dataSources는 빈 배열이다 — 승인 전에는
  // 아무 데이터도 조회/변경하지 않았다는 사실을 evidence에 그대로 반영한다.
  return ok({ writeIntent }, [], { partnerName: partner.name, contactCount });
}

export const createPartnerTool: AgentTool<CreatePartnerInput, CreatePartnerData> = {
  name: "create_partner",
  description:
    "새 거래처(브랜드/벤더/대행사/에이전트/셀러사)를 등록합니다. 사용자가 거래처 등록을 " +
    "명시적으로 요청할 때만 사용하며, 상호와 거래처 종류가 반드시 필요합니다. " +
    "담당자 정보를 함께 받으면 contacts에 담아 한 번에 등록합니다. " +
    "실제로 만들지 않고 승인 대기 기안을 생성합니다 — 관리자 승인 후에만 실제 등록됩니다. " +
    "이미 있는 거래처인지 확실하지 않으면 먼저 확인하고, 중복 등록을 만들지 마십시오.",
  inputSchema,
  execute,
};
