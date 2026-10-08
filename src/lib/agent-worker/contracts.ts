import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";

export const AGENT_JOB_LEASE_MS = 120_000;
export const AGENT_JOB_HEARTBEAT_MS = 30_000;
export const AGENT_JOB_MAX_ATTEMPTS = 3;
export const AGENT_JOB_MAX_RUNTIME_MS = 300_000;
export const AGENT_JOB_IDEMPOTENCY_BUCKET_MS = 10 * 60_000;
export const MAX_RESULT_SUMMARY_CHARS = 2_000;
export const MAX_EVIDENCE_REFS = 10;
export const MAX_AGENT_JOB_JSON_BYTES = 16 * 1024;

export const AgentJobStatusSchema = z.enum([
  "QUEUED",
  "CLAIMED",
  "RUNNING",
  "SUCCEEDED",
  "NEEDS_APPROVAL",
  "NEEDS_EXTERNAL_EXECUTOR",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "RESOURCE_DEFERRED",
  "FAILED_SECURITY",
]);

export type AgentJobStatus = z.infer<typeof AgentJobStatusSchema>;

export const AgentJobTaskTypeSchema = z.enum([
  "deterministic",
  "long_context",
  "bulk",
  "routine",
  "research",
]);

// ⚠️ 순서가 계약이다 — 파이썬 쪽 검증기가 이 목록을 **글자 순서 그대로** 자기 목록과
// 대조한다(hermes `test_payload_mirror_matches_contract_literals`). 새 operation 은
// 끝에 붙인다.
export const AgentJobOperationSchema = z.enum([
  "search_deals",
  "get_pipeline_status",
  "get_order_snapshot",
  "get_campaign_financials",
  "create_action_proposal",
  "search_partners",
  "get_action_proposal",
  "get_settlement_report",
]);

export const AgentJobRouteSchema = z.enum([
  "python",
  "gemini",
  "gpt_luna",
  "director",
  "local_shadow",
  "local",
]);

export type AgentJobRoute = z.infer<typeof AgentJobRouteSchema>;

const scalarInputValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const scalarObjectSchema = z.record(z.string(), scalarInputValueSchema);

/**
 * 기안 입력 한 칸에 들어갈 수 있는 값: 스칼라 하나, 스칼라만 담은 객체 하나, 또는 그
 * 둘로 이루어진 배열 — **깊이 2에서 끊는다**.
 *
 * ⚠️ 더 깊게 열지 말 것. 이 한 단은 거래처의 담당자 목록·딜의 옵션 행처럼 **표가
 * 실제로 들어오는 자리** 하나를 받으려고 연 것이고, 그보다 깊은 입력은 필요한 적이
 * 없다. 무제한 중첩을 허용하면 남는 방어선이 16KB 상한(`MAX_AGENT_JOB_JSON_BYTES`)
 * 하나뿐이고 모양 검사는 사라진다 — 2026-09-09 에 파이썬 쪽 검증기를 `dict|list`
 * 통과로 바꾼 우회가 실제로 들어왔다가 되돌아갔다.
 *
 * 🔎 이 봉투가 넓어져도 **어떤 operation 이 받는 모양도 넓어지지 않는다** — 아래
 * `operationInputSchemas` 의 각 스키마가 `.strict()` 로 칸마다 모양을 강제하므로,
 * 예컨대 `search_deals.query` 에 객체를 넣으면 여전히 `z.string()` 에서 걸린다.
 */
const jobInputValueSchema = z.union([
  scalarInputValueSchema,
  scalarObjectSchema,
  z.array(z.union([scalarInputValueSchema, scalarObjectSchema])),
]);
const jobInputSchema = z.record(z.string(), jobInputValueSchema);
/** 불투명 엔티티 id 한 칸. 도구·실행기가 같은 상한을 쓰도록 계약이 정본을 내보낸다. */
export const opaqueIdSchema = z.string().trim().min(1).max(128);
const isoDateSchema = z.iso.datetime({ offset: true });

const searchDealsInputSchema = z
  .object({
    query: z.string().trim().min(1).max(160).optional(),
    status: z.string().trim().min(1).max(64).optional(),
    partnerId: opaqueIdSchema.optional(),
  })
  .strict();

const pipelineStatusInputSchema = z.object({}).strict();

const orderSnapshotInputSchema = z
  .object({
    campaignId: opaqueIdSchema.optional(),
    startAt: isoDateSchema.optional(),
    endAt: isoDateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.startAt && value.endAt && value.startAt > value.endAt) {
      context.addIssue({ code: "custom", message: "startAt must not be later than endAt" });
    }
  });

const campaignFinancialsInputSchema = z
  .object({
    campaignId: opaqueIdSchema,
  })
  .strict();

export const MAX_PARTNER_CONTACTS = 20;
export const MAX_OPTION_DEALS = 50;

/**
 * 거래처 종류. **정본은 `src/lib/validations/partner.ts` 의 `PARTNER_TYPES` 다** —
 * 값을 여기서 새로 고르지 말고 그쪽을 보고 맞춘다. 딜 상태(`newStatus`)를 이 파일에
 * 그대로 적어 둔 것과 같은 이유로 글자를 펼쳐 둔다: 파이썬 쪽 검증기가 이 파일의
 * **글자**를 읽어 자기 목록과 대조한다(hermes `test_payload_mirror_matches_contract_literals`).
 */
export const AgentJobPartnerTypeSchema = z.enum(["BRAND", "VENDOR", "AGENCY", "AGENT", "SELLER"]);

/**
 * 거래처를 이름으로 찾아 **id 를 돌려주는** 조회. `create_deal` 이 이미 등록된 거래처에
 * 붙으려면 그 id 가 필요한데, `search_deals` 는 딜 id 만 돌려주고 딜이 없는 거래처는
 * 결과에 아예 나오지 않아 라우터가 이 값을 채울 방법이 없었다(2026-09-10).
 *
 * ⛔ 이름으로 딜을 거는 길을 대신 열지 말 것 — 동명이인 거래처를 실행기가 임의로 고르게
 * 된다. 사람이 목록에서 고르고 라우터는 고른 id 를 그대로 넘기는 것이 이 조회의 목적이다.
 */
const searchPartnersInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    type: AgentJobPartnerTypeSchema.optional(),
  })
  .strict();

/** 거래처 담당자 한 명. 정본 화면(`POST /api/partners/[id]/contacts`)이 만드는 것과 같은 칸이다. */
export const partnerContactInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().min(1).max(200).optional(),
    phoneNumber: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

/**
 * 새로 만들 거래처의 최소 정보.
 *
 * ⚠️ 담당자(`contacts`)가 여기 없는 것은 빠뜨린 게 아니다 — `create_deal` 이 이 객체를
 * 품는데, 담당자까지 품으면 `input.partner.contacts[].name` 이 깊이 3이 되어 위
 * `jobInputValueSchema` 의 깊이 2 상한을 넘는다. 담당자는 `create_partner` 로 등록한다.
 */
export const newPartnerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: AgentJobPartnerTypeSchema,
    // 정본과 같은 자리수 검사(`src/lib/validations/partner.ts`): 사업자등록번호는 숫자 10자리다.
    businessNumber: z.string().trim().regex(/^\d{10}$/).optional(),
    ceoName: z.string().trim().min(1).max(120).optional(),
    representativeEmail: z.string().trim().min(1).max(200).optional(),
    address: z.string().trim().min(1).max(300).optional(),
    notes: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

/**
 * 단가표의 머리 — 상품 하나. 옵션 줄들의 부모가 된다.
 *
 * ⚠️ `dealType` 과 `parentDealId` 는 여기 없다. 받는 값이 아니라 실행기가 정하는 값이고
 * (부모는 언제나 `MAIN`), 라우터가 고를 수 있게 두면 틀린 값을 고르는 길만 생긴다.
 */
export const mainDealInputSchema = z
  .object({
    dealName: z.string().trim().min(1).max(200),
    brandName: z.string().trim().min(1).max(200).optional(),
    costPrice: z.number().finite().min(0).optional(),
    sellingPrice: z.number().finite().min(0).optional(),
    supplyPrice: z.number().finite().min(0).optional(),
    listPrice: z.number().finite().min(0).optional(),
    shippingFee: z.number().finite().min(0).optional(),
    unit: z.string().trim().min(1).max(60).optional(),
    unitQuantity: z.number().int().min(1).optional(),
    sourcingMemo: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

/**
 * 단가표의 옵션 한 줄. 부모 딜과 함께 만들어지며 `parentDealId` 로 묶인다.
 *
 * ⚠️ `optionSortOrder` 도 받지 않는다 — 배열에 적힌 **순서가 곧 그 값**이다. 라우터가
 * 순서를 따로 세게 하면 배열 순서와 어긋난 번호를 보낼 수 있고, 어느 쪽이 맞는지
 * 실행기가 알 방법이 없다.
 */
export const optionDealInputSchema = z
  .object({
    dealName: z.string().trim().min(1).max(200),
    supplyPrice: z.number().finite().min(0).optional(),
    sellingPrice: z.number().finite().min(0).optional(),
    listPrice: z.number().finite().min(0).optional(),
    unit: z.string().trim().min(1).max(60).optional(),
    unitQuantity: z.number().int().min(1).optional(),
    sourcingMemo: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

/**
 * 「정산 금액 수정」이 고칠 수 있는 캠페인 금액 칸 — 사람이 재무 카드에서 직접 고치는 8칸뿐이다.
 * 영업이익(`operatingProfit`) 같은 **파생 칸은 넣지 않는다** — 실행기가 정본 PATCH 와 같은
 * 함수로 다시 계산해 쓰므로, 받으면 그 계산을 덮어쓰는 길이 된다.
 *
 * ⚠️ 글자를 펼쳐 둔 이유는 위 `AgentJobPartnerTypeSchema` 와 같다(파이썬 미러가 이 파일의
 * 글자를 읽는다). 화면 이름 표(`src/lib/settlement-amount-fields.ts`)와의 짝은 테스트가 고정한다.
 */
export const AgentJobSettlementAmountFieldSchema = z.enum([
  "actualSales",
  "settlementSales",
  "sellerExpense",
  "taxExpense",
  "operatingExpense",
  "miscExpense",
  "settlementSupplyCost",
  "settlementGoodsCost",
]);

/** 금액 칸 하나의 상한(원). 브리지 쪽 JSON Schema 의 `maximum` 과 같은 값이다. */
export const MAX_SETTLEMENT_AMOUNT_KRW = 999_999_999_999;
/**
 * 음수가 허용되는 두 칸(공동 운영 비용·기타 조정 비용)의 절댓값 상한 — 정본 PATCH
 * (`updateCampaignSchema` 의 `operatingExpense`·`miscExpense`)와 같은 값이다. 모든 칸의
 * 하한(음수 쪽)도 이 값이고, 그 안에서 음수를 받는 칸은 아래 부호 검사가 둘로 좁힌다.
 */
export const SIGNED_SETTLEMENT_AMOUNT_LIMIT_KRW = 999_999_999;

/** 음수를 받을 수 있는 칸. 나머지는 정본 PATCH 가 `nonnegative()` 로 받는 칸이다. */
export const SIGNED_SETTLEMENT_AMOUNT_FIELDS: ReadonlySet<string> = new Set([
  "operatingExpense",
  "miscExpense",
]);

const settlementAmountKrwSchema = z
  .number()
  .int()
  .min(-SIGNED_SETTLEMENT_AMOUNT_LIMIT_KRW)
  .max(MAX_SETTLEMENT_AMOUNT_KRW);

/**
 * 정산 금액 수정의 칸 모양(액션 이름 제외). `expectedCurrentKrw` 는 **기안자가 본 현재 값**이고
 * 실행기는 실제 값이 이것과 같을 때만 고친다(낙관적 동시성). ⚠️ `null` 과 `0` 은 다른 값이다 —
 * 물품대금의 0 은 「다른 캠페인 계산서에 합산됨」 표시이고 null 은 미입력이다.
 */
const updateSettlementAmountInputSchema = z
  .object({
    campaignId: opaqueIdSchema,
    field: AgentJobSettlementAmountFieldSchema,
    expectedCurrentKrw: settlementAmountKrwSchema.nullable(),
    newAmountKrw: settlementAmountKrwSchema,
    memo: z.string().trim().min(1).max(500).optional(),
  });

/** 칸마다 다른 부호 규칙. 계약(기안 시점)과 실행기(승인 시점)가 같은 함수로 거른다. */
function refineSettlementAmountSign(
  value: { field: string; newAmountKrw: number },
  context: z.RefinementCtx,
): void {
  const signed = SIGNED_SETTLEMENT_AMOUNT_FIELDS.has(value.field);
  if (!signed && value.newAmountKrw < 0) {
    context.addIssue({
      code: "custom",
      path: ["newAmountKrw"],
      message: `${value.field} 는 음수가 될 수 없다. 음수는 operatingExpense·miscExpense 만 받는다.`,
    });
  }
  if (signed && Math.abs(value.newAmountKrw) > SIGNED_SETTLEMENT_AMOUNT_LIMIT_KRW) {
    context.addIssue({
      code: "custom",
      path: ["newAmountKrw"],
      message: `${value.field} 는 ±${SIGNED_SETTLEMENT_AMOUNT_LIMIT_KRW.toLocaleString("en-US")} 범위 안이어야 한다.`,
    });
  }
}

/** 실행기(`write-actions/update-settlement-amount.ts`)의 argsSchema — 아래 계약 변형에서 `action` 만 뺀 것. */
export const updateSettlementAmountArgsSchema = updateSettlementAmountInputSchema
  .strict()
  .superRefine(refineSettlementAmountSign);

export const createActionProposalInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("add_entity_memo"),
      entityType: z.enum(["PARTNER", "SELLER", "DEAL", "CAMPAIGN"]),
      entityId: opaqueIdSchema,
      content: z.string().trim().min(1).max(4_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("change_deal_status"),
      dealId: opaqueIdSchema,
      newStatus: z.enum([
        "SOURCING",
        "NEGOTIATING",
        "SAMPLE_TESTING",
        "CONFIRMED",
        "ARCHIVED",
        "DROPPED",
      ]),
    })
    .strict(),
  z
    .object({
      action: z.literal("confirm_settlement"),
      campaignId: opaqueIdSchema,
      target: z.enum(["deposit", "payout"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("create_partner"),
      // 새로 만들 거래처는 두 액션에서 **같은 칸 이름·같은 모양**(`partner`)으로 받는다.
      // 라우터가 기억할 규칙이 하나로 줄어든다 — 거래처를 만드는 자리는 언제나 `partner` 다.
      partner: newPartnerInputSchema,
      contacts: z.array(partnerContactInputSchema).max(MAX_PARTNER_CONTACTS).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("create_deal"),
      partnerId: opaqueIdSchema.optional(),
      partner: newPartnerInputSchema.optional(),
      mainDeal: mainDealInputSchema,
      optionDeals: z.array(optionDealInputSchema).max(MAX_OPTION_DEALS).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      // 딜은 거래처 없이 서지 않는다 — 정본 `createDealSchema.partnerId` 가 필수이고
      // (`src/lib/validations/deal.ts`), 거래처 없는 딜은 어느 화면에도 안 걸린다.
      // 그래서 "둘 중 정확히 하나"다: 이미 있는 거래처면 `partnerId`, 이번에 새로
      // 만들 거래처면 `partner`. 둘 다 없으면 여기서 막고 **무엇이 없는지 말해** 준다
      // — 라우터가 거래처 정보를 먼저 받아오게 하려는 것이 이 메시지의 목적이다
      // (오너 결정 2026-09-10).
      if (Boolean(value.partnerId) === Boolean(value.partner)) {
        context.addIssue({
          code: "custom",
          path: ["partnerId"],
          message:
            "거래처를 정확히 하나로 지정해야 한다: 이미 등록된 거래처는 partnerId, " +
            "새로 만들 거래처는 partner. 둘 다 없으면 거래처 정보를 먼저 받아야 한다.",
        });
      }
    }),
  // ⚠️ 새 액션은 **끝에 붙인다** — 파이썬 미러가 `action: z.literal(...)` 의 글자 순서를 대조한다.
  z
    .object({
      action: z.literal("update_settlement_amount"),
      ...updateSettlementAmountInputSchema.shape,
    })
    .strict()
    .superRefine(refineSettlementAmountSign),
]);

/**
 * 봇이 올린 기안 하나의 **현재 상태**를 읽는다. 기안은 오너가 CRM 화면에서 승인하는데
 * 그 결과가 봇에게 돌아올 길이 없어서, 봇이 "올렸다"까지만 보고하고 멈췄다(2026-09-10).
 * 봇이 이 조회로 결정(완료·실패·반려)을 확인해 같은 스레드로 결과를 전하고, 거래처가
 * 만들어졌으면 그 **정확한 id**(`executedRefId`)로 이어지는 딜 기안을 올린다.
 *
 * ⛔ 실행기는 봇이 올린 기안(`createdBy = AGENT_WORKER`)만 돌려준다 — 사람이 올린 기안은
 *    id 를 알아도 읽지 못한다. 이 조회가 필요한 범위는 봇 자신의 기안뿐이다.
 */
const getActionProposalInputSchema = z
  .object({
    proposalId: opaqueIdSchema,
  })
  .strict();

/**
 * 정산 리포트(§3-E, 2026-09-22) — 웹 어시스턴트 도구 `getSettlementReportTool` 의 입력을
 * 그대로 옮긴 모양. 월·연도 형식은 도구도 다시 검사하지만, 파이썬 미러가 같은 정규식을
 * 들고 있어야 슬랙에서 잘못된 값이 소켓까지 오지 않는다.
 */
const settlementReportInputSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    year: z.string().regex(/^\d{4}$/).optional(),
    sellerName: z.string().trim().min(1).max(80).optional(),
    statusFilter: z.enum(["SETTLEMENT_IN_PROGRESS", "COMPLETED", "ALL"]).optional(),
  })
  .strict();

const operationInputSchemas = {
  search_deals: searchDealsInputSchema,
  get_pipeline_status: pipelineStatusInputSchema,
  get_order_snapshot: orderSnapshotInputSchema,
  get_campaign_financials: campaignFinancialsInputSchema,
  create_action_proposal: createActionProposalInputSchema,
  search_partners: searchPartnersInputSchema,
  get_action_proposal: getActionProposalInputSchema,
  get_settlement_report: settlementReportInputSchema,
};

const secretLikeInputKey = /(?:api[_-]?key|authorization|credential|password|secret|token)/i;

/**
 * `input` 안의 **모든** 키를 경로와 함께 훑는다. 중첩 한 단(`jobInputValueSchema`)을
 * 열면서 함께 깊어져야 하는 검사다 — 최상위 키만 보던 때 그대로 두면
 * `input.partner.password` 가 그냥 통과한다.
 */
function* inputKeyPaths(
  value: unknown,
  path: readonly (string | number)[] = []
): Generator<{ readonly key: string; readonly path: readonly (string | number)[] }> {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      yield* inputKeyPaths(item, [...path, index]);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    yield { key, path: [...path, key] };
    yield* inputKeyPaths(item, [...path, key]);
  }
}

/**
 * 슬랙 원문의 위치 — 브리지가 처리한 요청 메시지 하나를 가리킨다(Phase 2, 2026-10-09).
 * 기안 INSERT 때 `ActionProposal.sourceRef = { slack: <이 값> }` 로 그대로 복사된다.
 *
 * ⚠️ **자기 신고 값이다.** 작업 통로는 같은 계정의 아무 프로그램이나 쓸 수 있으므로 이 값의
 *    존재 자체는 아무것도 증명하지 않는다. 이 값은 "어느 메시지를 대조하라"는 **좌표**일 뿐이고,
 *    믿을지는 그 메시지를 슬랙에서 직접 읽어 대조하는 쪽(CRM 앱)이 정한다.
 * 🔎 글자 규칙은 일부러 ASCII 클래스만 쓴다(`\d` 대신 `[0-9]`) — 파이썬 미러의 `\d` 는
 *    유니코드 숫자를 받으므로 양쪽 철자를 같은 뜻으로 맞춰 두려는 것이다.
 *    - channelId: 공개(C)·비공개(G) 채널 id. DM(D)은 받지 않는다 — 브리지는 채널만 듣는다.
 *    - threadTs·messageTs: 슬랙 ts(`초.마이크로초`). 최상위 글이면 둘이 같다(브리지가 그렇게 채운다).
 *    - rid: 요청 블록의 ULID — 브리지 `protocol.py` 의 `ULID_PATTERN` 과 같은 규칙.
 */
export const AgentJobSlackOriginSchema = z
  .object({
    channelId: z.string().regex(/^[CG][A-Z0-9]{8,12}$/),
    threadTs: z.string().regex(/^[0-9]{10}\.[0-9]{6}$/),
    messageTs: z.string().regex(/^[0-9]{10}\.[0-9]{6}$/),
    rid: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  })
  .strict();

export type AgentJobSlackOrigin = z.infer<typeof AgentJobSlackOriginSchema>;

export const AgentJobPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskType: AgentJobTaskTypeSchema,
    skill: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    operation: AgentJobOperationSchema,
    input: jobInputSchema,
    origin: z
      .object({
        source: z.literal("hermes_slack"),
        correlationId: opaqueIdSchema,
        requesterDigest: z.string().trim().min(1).max(128),
        threadDigest: z.string().trim().min(1).max(128),
        // 선택 칸 — 없는 작업(Hermes 일반 대화의 도구 호출 등)은 지금처럼 그대로 받는다.
        slack: AgentJobSlackOriginSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const { key, path } of inputKeyPaths(value.input)) {
      if (secretLikeInputKey.test(key)) {
        context.addIssue({
          code: "custom",
          path: ["input", ...path],
          message: "secret-like input cannot be persisted in AgentJob",
        });
      }
    }

    const parsed = operationInputSchemas[value.operation].safeParse(value.input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          ...issue,
          path: ["input", ...issue.path],
        });
      }
    }
  });

export type AgentJobPayload = z.infer<typeof AgentJobPayloadSchema>;

export const AgentJobResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: opaqueIdSchema,
    status: z.enum(["SUCCEEDED", "NEEDS_APPROVAL", "NEEDS_EXTERNAL_EXECUTOR", "FAILED_FINAL"]),
    route: AgentJobRouteSchema,
    modelUsed: z.string().trim().min(1).max(128),
    validationResult: z.enum(["pass", "fail", "not_validated"]),
    resultSummary: z.string().trim().min(1).max(MAX_RESULT_SUMMARY_CHARS),
    actionProposalId: opaqueIdSchema.nullable(),
    evidenceRefs: z.array(z.string().trim().min(1).max(256)).max(MAX_EVIDENCE_REFS),
  })
  .strict();

export type AgentJobResult = z.infer<typeof AgentJobResultSchema>;

const allowedTransitions: Record<AgentJobStatus, readonly AgentJobStatus[]> = {
  QUEUED: ["CLAIMED"],
  CLAIMED: ["RUNNING", "RESOURCE_DEFERRED", "FAILED_FINAL", "FAILED_SECURITY"],
  RUNNING: [
    "SUCCEEDED",
    "NEEDS_APPROVAL",
    "NEEDS_EXTERNAL_EXECUTOR",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
    "RESOURCE_DEFERRED",
    "FAILED_SECURITY",
  ],
  SUCCEEDED: [],
  NEEDS_APPROVAL: [],
  NEEDS_EXTERNAL_EXECUTOR: [],
  FAILED_RETRYABLE: [],
  FAILED_FINAL: [],
  RESOURCE_DEFERRED: [],
  FAILED_SECURITY: [],
};

export function isAgentJobTransitionAllowed(
  fromStatus: AgentJobStatus,
  toStatus: AgentJobStatus,
): boolean {
  return allowedTransitions[fromStatus].some((candidate) => candidate === toStatus);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${canonicalize(nestedValue)}`)
    .join(",")}}`;
}

/**
 * 같은 요청자가 같은 입력을 10분 안에 다시 내면 같은 작업으로 접는다.
 *
 * 🔎 `origin.slack` 이 있으면 그 값도 키에 넣는다 — **있을 때만**. 이유:
 *    - 슬랙 위치가 있는 작업은 메시지 하나(rid)에 묶인다. 넣지 않으면 서로 다른 두 요청이
 *      입력만 같다는 이유로 한 작업으로 접히고, 둘째 요청의 출처는 어디에도 남지 않은 채
 *      첫째 기안(첫째 rid 의 `sourceRef`)이 둘째 요청의 답이 된다.
 *    - 같은 rid 의 재제출(브리지 재시도)은 위치가 같으므로 여전히 한 작업으로 접힌다.
 *    - 슬랙 위치가 없는 작업은 키 재료가 한 글자도 바뀌지 않는다 — 이 칸을 들이기 전에
 *      만들어진 키와 그대로 같다(계약 테스트가 고정값으로 지킨다).
 */
export function createAgentJobIdempotencyKey(payload: AgentJobPayload, now: Date): string {
  const bucket = Math.floor(now.getTime() / AGENT_JOB_IDEMPOTENCY_BUCKET_MS);
  const parts: Array<string | number> = [
    payload.schemaVersion,
    payload.operation,
    canonicalize(payload.input),
    payload.origin.requesterDigest,
    bucket,
  ];
  if (payload.origin.slack) {
    parts.push(`slack:${canonicalize(payload.origin.slack)}`);
  }

  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** Serializes only Zod-validated payload/result data and enforces the durable queue byte cap. */
export function serializeAgentJobJson<T extends AgentJobPayload | AgentJobResult>(
  value: T,
  useSqlite: boolean,
): T | string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_AGENT_JOB_JSON_BYTES) {
    throw new Error(`AgentJob JSON exceeds ${MAX_AGENT_JOB_JSON_BYTES} bytes`);
  }
  return useSqlite ? serialized : value;
}
