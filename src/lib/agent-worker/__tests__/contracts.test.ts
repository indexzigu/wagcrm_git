import { describe, expect, it } from "vitest";
import { SETTLEMENT_AMOUNT_FIELD_LABELS } from "@/lib/settlement-amount-fields";
import {
  AgentJobOperationSchema,
  AgentJobPayloadSchema,
  AgentJobResultSchema,
  AgentJobSettlementAmountFieldSchema,
  MAX_RESULT_SUMMARY_CHARS,
  MAX_STORE_STATUS_CLAIMS,
  MAX_WORK_RECORDS_LIMIT,
  createActionProposalInputSchema,
  createAgentJobIdempotencyKey,
  isAgentJobTransitionAllowed,
  serializeAgentJobJson,
} from "../contracts";

const payload = {
  schemaVersion: 1,
  taskType: "routine",
  skill: "pipeline_status",
  operation: "get_pipeline_status",
  input: {},
  origin: {
    source: "hermes_slack",
    correlationId: "correlation-1",
    requesterDigest: "requester-digest",
    threadDigest: "thread-digest",
  },
} as const;

describe("AgentJob contracts", () => {
  it("accepts the bounded structured payload and produces a stable 10-minute idempotency key", () => {
    expect(AgentJobPayloadSchema.parse(payload)).toEqual(payload);

    const first = createAgentJobIdempotencyKey(payload, new Date("2026-09-02T00:01:00.000Z"));
    const sameBucket = createAgentJobIdempotencyKey(payload, new Date("2026-09-02T00:09:59.000Z"));
    expect(first).toBe(sameBucket);
  });

  it("rejects secret-like structured input instead of accepting it into the durable queue", () => {
    expect(
      AgentJobPayloadSchema.safeParse({
        ...payload,
        input: { apiToken: "not-for-storage" },
      }).success,
    ).toBe(false);
  });

  // 봉투가 깊이 2로 열리면서 시크릿 검사도 재귀(`inputKeyPaths`)로 함께 깊어졌다.
  // 최상위만 보던 검사를 그대로 두고 봉투만 열면 `input.partner.password` 가 통과한다.
  //
  // ⚠️ `success === false` 만 보면 이 테스트는 **헛돈다.** 모든 operation 스키마가
  // `.strict()` 라 시크릿 유사 키는 「모르는 칸」으로도 거부되기 때문에, 재귀 검사를
  // 통째로 지워도 초록으로 남는다. 그래서 거부됐다는 사실이 아니라 **그 경로에서 시크릿
  // 사유로 거부됐는지**를 짚는다. 배열 분기는 재귀에서 가장 빠뜨리기 쉬운 갈래라 따로 센다.
  it.each([
    [
      "중첩 객체 안",
      "create_action_proposal",
      { action: "create_partner", partner: { name: "테스트", type: "BRAND", password: "x" } },
      "input.partner.password",
    ],
    [
      "배열 안 객체",
      "create_action_proposal",
      {
        action: "create_partner",
        partner: { name: "테스트", type: "BRAND" },
        contacts: [{ name: "담당", api_key: "x" }],
      },
      "input.contacts.0.api_key",
    ],
    [
      "배열 안 객체(다른 operation)",
      "search_deals",
      { query: [{ authorization: "Bearer x" }] },
      "input.query.0.authorization",
    ],
  ])("flags a secret-like key nested %s at its own path", (_label, operation, input, path) => {
    const result = AgentJobPayloadSchema.safeParse({ ...payload, operation, input });
    expect(result.success).toBe(false);
    const secretIssues = result.success
      ? []
      : result.error.issues.filter((issue) => issue.message.includes("secret-like"));
    expect(secretIssues.map((issue) => issue.path.join("."))).toContain(path);
  });

  it("caps durable result summaries and evidence references", () => {
    expect(
      AgentJobResultSchema.safeParse({
        schemaVersion: 1,
        jobId: "job-1",
        status: "SUCCEEDED",
        route: "gemini",
        modelUsed: "gemini",
        validationResult: "pass",
        resultSummary: "x".repeat(MAX_RESULT_SUMMARY_CHARS + 1),
        actionProposalId: null,
        evidenceRefs: Array.from({ length: 11 }, (_, index) => `evidence-${index}`),
      }).success,
    ).toBe(false);
  });

  it("allows only the locked AgentJob state transitions", () => {
    expect(isAgentJobTransitionAllowed("QUEUED", "CLAIMED")).toBe(true);
    expect(isAgentJobTransitionAllowed("RUNNING", "QUEUED")).toBe(false);
    expect(isAgentJobTransitionAllowed("CLAIMED", "FAILED_SECURITY")).toBe(true);
    expect(isAgentJobTransitionAllowed("RUNNING", "FAILED_SECURITY")).toBe(true);
    expect(isAgentJobTransitionAllowed("SUCCEEDED", "QUEUED")).toBe(false);
    expect(isAgentJobTransitionAllowed("NEEDS_EXTERNAL_EXECUTOR", "RUNNING")).toBe(false);
  });

  it("uses bounded JSON text for the SQLite mirror without changing the payload shape", () => {
    expect(serializeAgentJobJson(payload, true)).toBe(JSON.stringify(payload));
  });
});

describe("get_settlement_report input (spec §3-E)", () => {
  const base = {
    schemaVersion: 1,
    taskType: "deterministic",
    skill: "none",
    origin: { source: "hermes_slack", correlationId: "c-1", requesterDigest: "r", threadDigest: "t" },
  } as const;

  // 파이썬 미러가 글자 순서를 대조하므로 새 operation 은 끝에만 붙는다 — 정산 리포트 **뒤**에는
  // Phase 3 ②⑧(2026-10-09)의 세 읽기만 있어야 한다.
  it("keeps its place in the enum; only later operations are appended after it (python mirror compares literal order)", () => {
    const options = AgentJobOperationSchema.options;
    expect(options.slice(options.indexOf("get_settlement_report"))).toEqual([
      "get_settlement_report",
      "get_store_status",
      "list_work_record_rooms",
      "get_work_records",
    ]);
  });

  it.each([
    [{}],
    [{ month: "2026-09" }],
    [{ year: "2026", statusFilter: "COMPLETED" }],
    [{ sellerName: "홍" }],
  ])("accepts %j", (input) => {
    expect(AgentJobPayloadSchema.safeParse({ ...base, operation: "get_settlement_report", input }).success).toBe(true);
  });

  it.each([
    [{ month: "2026-9" }],
    [{ year: "26" }],
    [{ statusFilter: "PAID" }],
    [{ extra: "x" }],
    [{ sellerName: "" }],
  ])("rejects %j", (input) => {
    expect(AgentJobPayloadSchema.safeParse({ ...base, operation: "get_settlement_report", input }).success).toBe(false);
  });
});

describe("create_action_proposal — update_settlement_amount (정산 금액 수정)", () => {
  const base = {
    schemaVersion: 1,
    taskType: "deterministic",
    skill: "none",
    operation: "create_action_proposal",
    origin: { source: "hermes_slack", correlationId: "c-1", requesterDigest: "r", threadDigest: "t" },
  } as const;
  const valid = {
    action: "update_settlement_amount",
    campaignId: "camp-1",
    field: "settlementSales",
    expectedCurrentKrw: 1_200_000,
    newAmountKrw: 1_350_000,
  } as const;
  const accepts = (input: Record<string, unknown>) =>
    AgentJobPayloadSchema.safeParse({ ...base, input }).success;

  it("is the last action literal in the union (python mirror compares literal order)", () => {
    const actions = createActionProposalInputSchema.options.map((option) => option.shape.action.value);
    expect(actions[actions.length - 1]).toBe("update_settlement_amount");
  });

  it("field enum matches the screen-label table key for key, in order", () => {
    expect([...AgentJobSettlementAmountFieldSchema.options]).toEqual(Object.keys(SETTLEMENT_AMOUNT_FIELD_LABELS));
  });

  it.each([
    ["기본", valid],
    ["현재 값이 비어 있음(null)", { ...valid, field: "settlementGoodsCost", expectedCurrentKrw: null, newAmountKrw: 0 }],
    ["메모 포함", { ...valid, memo: "10월 정산매출 정정" }],
    ["운영 비용 음수", { ...valid, field: "operatingExpense", expectedCurrentKrw: 0, newAmountKrw: -999_999_999 }],
    ["기타 비용 음수", { ...valid, field: "miscExpense", expectedCurrentKrw: -5_000, newAmountKrw: -1 }],
    ["상한 그대로", { ...valid, field: "actualSales", newAmountKrw: 999_999_999_999 }],
  ])("accepts %s", (_label, input) => {
    expect(accepts(input)).toBe(true);
  });

  it.each([
    ["파생 칸(영업이익)", { ...valid, field: "operatingProfit" }],
    ["모르는 칸 이름", { ...valid, field: "settlement_sales" }],
    ["음수 불가 칸의 음수", { ...valid, field: "settlementSales", newAmountKrw: -1 }],
    ["물품대금 음수", { ...valid, field: "settlementGoodsCost", newAmountKrw: -1 }],
    ["운영 비용 하한 밖", { ...valid, field: "operatingExpense", newAmountKrw: -1_000_000_000 }],
    ["기타 비용 상한 밖(±999,999,999)", { ...valid, field: "miscExpense", newAmountKrw: 1_000_000_000 }],
    ["전체 상한 밖", { ...valid, newAmountKrw: 1_000_000_000_000 }],
    ["현재 값 범위 밖", { ...valid, expectedCurrentKrw: 1_000_000_000_000 }],
    ["정수 아님", { ...valid, newAmountKrw: 1.5 }],
    ["숫자 문자열", { ...valid, newAmountKrw: "1350000" }],
    ["현재 값 누락", { action: "update_settlement_amount", campaignId: "camp-1", field: "settlementSales", newAmountKrw: 1 }],
    ["새 값 누락", { action: "update_settlement_amount", campaignId: "camp-1", field: "settlementSales", expectedCurrentKrw: 1 }],
    ["빈 캠페인 id", { ...valid, campaignId: "  " }],
    ["모르는 칸 추가", { ...valid, extra: "x" }],
    ["빈 메모", { ...valid, memo: "   " }],
    ["메모 500자 초과", { ...valid, memo: "가".repeat(501) }],
  ])("rejects %s", (_label, input) => {
    expect(accepts(input as Record<string, unknown>)).toBe(false);
  });
});

// Phase 2 묶음 A(2026-10-09): 작업 출처에 슬랙 위치를 선택 칸으로 싣는다. 이 칸은 기안의
// `sourceRef` 로 복사되고, CRM 이 슬랙 원문을 직접 읽어 대조할 **좌표**가 된다.
describe("origin.slack — 슬랙 원문 위치(선택 칸)", () => {
  const slack = {
    channelId: "C0ABCDEFGHI",
    threadTs: "1760000000.000100",
    messageTs: "1760000000.000200",
    rid: "01JABCDEFGHJKMNPQRSTVWXYZ0",
  } as const;
  const withSlack = (value: unknown) => ({ ...payload, origin: { ...payload.origin, slack: value } });
  const at = new Date("2026-09-02T00:01:00.000Z");

  it("accepts a job without slack exactly as before (backward compatible)", () => {
    expect(AgentJobPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("accepts a job carrying a well-formed slack location and keeps it verbatim", () => {
    const parsed = AgentJobPayloadSchema.parse(withSlack(slack));
    expect(parsed.origin.slack).toEqual(slack);
  });

  it("accepts a private-channel id and a top-level message (threadTs = messageTs)", () => {
    expect(
      AgentJobPayloadSchema.safeParse(withSlack({ ...slack, channelId: "G01234567", threadTs: slack.messageTs })).success,
    ).toBe(true);
  });

  it.each([
    ["DM 채널", { ...slack, channelId: "D0ABCDEFGHI" }],
    ["소문자 채널", { ...slack, channelId: "c0abcdefghi" }],
    ["짧은 채널", { ...slack, channelId: "C0ABC" }],
    ["ts 소수점 없음", { ...slack, messageTs: "1760000000000200" }],
    ["ts 자리수 틀림", { ...slack, threadTs: "1760000000.0001" }],
    ["ts 전각 숫자", { ...slack, messageTs: "１760000000.000200" }],
    ["ts 앞뒤 공백", { ...slack, messageTs: " 1760000000.000200" }],
    ["rid 길이 25", { ...slack, rid: slack.rid.slice(0, 25) }],
    ["rid 첫 글자 8 이상", { ...slack, rid: `8${slack.rid.slice(1)}` }],
    ["rid 에 I·L·O·U", { ...slack, rid: `${slack.rid.slice(0, 25)}U` }],
    ["rid 소문자", { ...slack, rid: slack.rid.toLowerCase() }],
    ["rid 끝 줄바꿈", { ...slack, rid: `${slack.rid}\n` }],
    ["칸 누락(rid)", { channelId: slack.channelId, threadTs: slack.threadTs, messageTs: slack.messageTs }],
    ["모르는 칸 추가", { ...slack, userId: "U0ABCDEFGHI" }],
    ["숫자 ts", { ...slack, messageTs: 1760000000.0002 }],
    ["null", null],
    ["문자열", "C0ABCDEFGHI/1760000000.000200"],
  ])("rejects a malformed slack location: %s", (_label, value) => {
    expect(AgentJobPayloadSchema.safeParse(withSlack(value)).success).toBe(false);
  });

  it("still rejects unknown keys beside slack in origin (.strict() unchanged)", () => {
    expect(
      AgentJobPayloadSchema.safeParse({ ...payload, origin: { ...payload.origin, slack, channel: "C0ABCDEFGHI" } }).success,
    ).toBe(false);
  });

  // 고정값: 이 칸이 생기기 전 계약(origin/main 258fd346)이 같은 payload·시각에 낸 키다.
  // 슬랙 위치 없는 작업의 키가 바뀌면 배포 순간 진행 중이던 재제출이 중복 작업이 된다.
  it("leaves the idempotency key of a job without slack byte-for-byte unchanged", () => {
    expect(createAgentJobIdempotencyKey(payload, at)).toBe(
      "098ca58119599c2f7562a3488ca52273473ee304230ed0e9b141ed2c0155e541",
    );
  });

  it("separates two different Slack requests with identical input, but folds a resubmit of the same one", () => {
    const first = AgentJobPayloadSchema.parse(withSlack(slack));
    const resubmit = AgentJobPayloadSchema.parse(withSlack({ ...slack }));
    const other = AgentJobPayloadSchema.parse(
      withSlack({ ...slack, messageTs: "1760000000.000300", rid: "01JABCDEFGHJKMNPQRSTVWXYZ1" }),
    );
    expect(createAgentJobIdempotencyKey(first, at)).toBe(createAgentJobIdempotencyKey(resubmit, at));
    expect(createAgentJobIdempotencyKey(first, at)).not.toBe(createAgentJobIdempotencyKey(other, at));
    expect(createAgentJobIdempotencyKey(first, at)).not.toBe(createAgentJobIdempotencyKey(payload, at));
  });
});

describe("Phase 3 store / Kakao read inputs (get_store_status · list_work_record_rooms · get_work_records)", () => {
  const base = {
    schemaVersion: 1,
    taskType: "deterministic",
    skill: "none",
    origin: { source: "hermes_slack", correlationId: "c-1", requesterDigest: "r", threadDigest: "t" },
  } as const;
  const parse = (operation: string, input: unknown) =>
    AgentJobPayloadSchema.safeParse({ ...base, operation, input }).success;

  it.each([
    [{}],
    [{ claimsLimit: 1 }],
    [{ claimsLimit: MAX_STORE_STATUS_CLAIMS }],
    [{ since: "2026-10-01T00:00:00+09:00" }],
    [{ since: "2026-10-01T00:00:00.000Z", claimsLimit: 20 }],
  ])("get_store_status accepts %j", (input) => {
    expect(parse("get_store_status", input)).toBe(true);
  });

  it.each([
    [{ claimsLimit: 0 }],
    [{ claimsLimit: MAX_STORE_STATUS_CLAIMS + 1 }],
    [{ claimsLimit: 2.5 }],
    [{ claimsLimit: "20" }],
    [{ since: "2026-10-01" }],
    [{ since: "yesterday" }],
    [{ storeId: "x" }],
  ])("get_store_status rejects %j", (input) => {
    expect(parse("get_store_status", input)).toBe(false);
  });

  it("list_work_record_rooms takes no input at all", () => {
    expect(parse("list_work_record_rooms", {})).toBe(true);
    expect(parse("list_work_record_rooms", { roomKey: "123" })).toBe(false);
    expect(parse("list_work_record_rooms", { includeExcluded: true })).toBe(false);
  });

  const valid = { roomKey: "18273645", since: "2026-10-01T00:00:00+09:00" };

  it.each([
    [valid],
    [{ ...valid, roomKey: "TXT:0123456789abcdef" }],
    [{ ...valid, until: "2026-10-09T00:00:00+09:00", limit: 1 }],
    [{ ...valid, limit: MAX_WORK_RECORDS_LIMIT }],
    // 오프셋이 달라도 **시각**으로 비교한다: 문자열로는 since 가 더 늦어 보이지만 실제로는 같은 순간이다.
    [{ roomKey: "1", since: "2026-10-01T09:00:00+09:00", until: "2026-10-01T00:00:00Z" }],
  ])("get_work_records accepts %j", (input) => {
    expect(parse("get_work_records", input)).toBe(true);
  });

  it.each([
    ["no since", { roomKey: "1" }],
    ["no roomKey", { since: valid.since }],
    ["empty roomKey", { ...valid, roomKey: "" }],
    ["roomKey with a space", { ...valid, roomKey: "a b" }],
    ["roomKey with a quote", { ...valid, roomKey: "1'--" }],
    ["roomKey over 128", { ...valid, roomKey: "1".repeat(129) }],
    ["date-only since", { ...valid, since: "2026-10-01" }],
    ["since after until", { ...valid, until: "2026-09-30T00:00:00+09:00" }],
    ["limit 0", { ...valid, limit: 0 }],
    ["limit over max", { ...valid, limit: MAX_WORK_RECORDS_LIMIT + 1 }],
    ["fractional limit", { ...valid, limit: 1.5 }],
    ["unknown key", { ...valid, roomName: "x" }],
  ])("get_work_records rejects %s", (_label, input) => {
    expect(parse("get_work_records", input)).toBe(false);
  });
});
