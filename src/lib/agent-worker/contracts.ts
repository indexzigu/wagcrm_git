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

export const AgentJobOperationSchema = z.enum([
  "search_deals",
  "get_pipeline_status",
  "get_order_snapshot",
  "get_campaign_financials",
  "create_action_proposal",
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
]);

const operationInputSchemas = {
  search_deals: searchDealsInputSchema,
  get_pipeline_status: pipelineStatusInputSchema,
  get_order_snapshot: orderSnapshotInputSchema,
  get_campaign_financials: campaignFinancialsInputSchema,
  create_action_proposal: createActionProposalInputSchema,
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

export function createAgentJobIdempotencyKey(payload: AgentJobPayload, now: Date): string {
  const bucket = Math.floor(now.getTime() / AGENT_JOB_IDEMPOTENCY_BUCKET_MS);
  const source = [
    payload.schemaVersion,
    payload.operation,
    canonicalize(payload.input),
    payload.origin.requesterDigest,
    bucket,
  ].join("|");

  return createHash("sha256").update(source).digest("hex");
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
