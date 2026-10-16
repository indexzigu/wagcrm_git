import { getPrisma } from "@/lib/prisma";
import { approveProposal } from "@/lib/agent/approve-proposal";
import {
  insertAgentWorkerProposal,
  snapshotProductMappingExpected,
  type UpsertProductMappingsRequestArgs,
} from "@/lib/agent/agent-worker-proposal";
import { upsertProductMappingsTool } from "@/lib/agent/tools/upsert-product-mappings";
import { planProductMappingUpsert } from "@/lib/order-converter/product-mapping-upsert";
import { ActionProposalRepository } from "@/repositories/actionProposalRepository";
import {
  MAX_MAPPING_OPTION_NAME_CHARS,
  MAX_MAPPING_PRODUCT_NAME_CHARS,
  MAX_REJECTED_OPTION_NAME_CHARS,
  normalizeMappingOptionName,
  productMappingsAppliedStructuredDataSchema,
  type ProductMappingsAppliedStructuredData,
} from "@/lib/agent-worker/contracts";
import { agentInternalFailure, type AgentInternalFailure, type ApplyProductMappingsRequest } from "./api-contract";
import { loadStoreOptionsForApply, type StoreOptionsDeps } from "./store-product-options";
import { AGENT_MAPPING_APPLY_ACTOR } from "./actors";

/**
 * 봇 상품 매핑 **즉시 저장** — 봇 내부 창구 본체(오너 결정 2026-10-16: 짝 확인 「응」 한 번으로 바로 저장,
 * 결재함 승인 없음, 결재함에는 EXECUTED 기록만).
 *
 * 순서:
 *  ① 네이버 등록 옵션 대조 — 줄의 `optionName` 이 그 캠페인의 스토어 옵션 하나와 비교 키로 같아야 한다. 아니면
 *     그 줄만 `NOT_A_STORE_OPTION` 으로 돌려주고 나머지는 계속한다. 통과한 줄은 **스토어 옵션 글자 그대로**
 *     저장한다(봇이 보낸 글자가 아니라) — 매핑 줄의 키는 언제나 네이버 등록 옵션 글자다(설계 §3 불변).
 *  ② 지금 값 스냅샷 + 계획 — 봇 기안과 같은 함수(`snapshotProductMappingExpected` · `planProductMappingUpsert`).
 *     바뀌는 줄이 하나도 없으면 기록 없이 끝낸다(같은 요청을 다시 보내도 안전하다 — 두 번째는 「그대로」로 센다).
 *  ③ 기안 1건 INSERT(기안자 `AGENT_WORKER`, 출처 칸 = 슬랙 위치) → 정본 승인 함수 `approveProposal` 을
 *     실행자 `AGENT_MAPPING_APPLY_ACTOR` 로 즉시 부른다. 실행 순간의 가드(행 잠금·이름 대조·조건부 쓰기·
 *     자동 연결 후속 처리)는 결재함 승인과 **같은 코드**가 건다 — 여기서 쓰기를 다시 만들지 않는다.
 *
 * ⚠️ 새 줄의 상품명은 그 스토어 옵션 줄의 상품명으로 채운다(설정 창 「스토어 옵션 불러오기」와 같다 — 상품명이
 *    있으면 주문 대조가 상품명·옵션명 둘 다 본다). 추가구성상품 줄은 스토어 쪽에서 이미 빈칸이라 빈칸 그대로 둔다. 계약 상한(`MAX_MAPPING_PRODUCT_NAME_CHARS`)을 넘는 상품명은 빈칸으로
 *    둔다 — 빈칸이면 옵션명만으로 대조된다(봇 기안 경로와 같은 기본값). 고칠 줄의 상품명은 건드리지 않는다.
 */


type AppliedResult = { ok: true; data: ProductMappingsAppliedStructuredData } | AgentInternalFailure;

export type ApplyDeps = {
  storeOptions?: StoreOptionsDeps;
  approve?: typeof approveProposal;
};

type PreparedOutcome =
  | { kind: "NO_CHANGE"; unchanged: number }
  | { kind: "CREATED"; proposalId: string; created: number; updated: number; unchanged: number }
  | { kind: "UNUSABLE"; failure: AgentInternalFailure };

/**
 * 같은 캠페인의 저장을 한 번에 하나씩 줄 세운다(프로세스 안). 슬랙에서 「응」이 두 번 오거나 봇이 같은 작업을
 * 다시 보내면 두 요청이 둘 다 「새 줄」로 계획한 뒤, 뒤의 것이 정본 실행의 행 잠금 아래에서 「이미 있습니다」로
 * 실패하고 결재함에 FAILED 기록을 남긴다 — DB 는 이미 요청대로인데도. 줄을 세우면 뒤의 요청은 앞의 결과 위에서
 * 계획해 「그대로 n줄」이 된다. 화면 저장과의 경합은 여전히 정본 실행의 조건부 쓰기가 잡는다(정직한 실패).
 * 셀프호스트 앱은 프로세스 하나라 이것으로 충분하다(`globalThis` — 라우트 번들이 갈려도 같은 줄).
 */
function campaignQueue(): Map<string, Promise<unknown>> {
  const g = globalThis as typeof globalThis & { __agentMappingApplyQueue?: Map<string, Promise<unknown>> };
  if (!g.__agentMappingApplyQueue) g.__agentMappingApplyQueue = new Map();
  return g.__agentMappingApplyQueue;
}

async function inCampaignQueue<T>(orderCampaignId: string, task: () => Promise<T>): Promise<T> {
  const queue = campaignQueue();
  const previous = queue.get(orderCampaignId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queue.set(orderCampaignId, settled);
  try {
    return await run;
  } finally {
    if (queue.get(orderCampaignId) === settled) queue.delete(orderCampaignId);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 승인 실행이 시작도 못 했을 때(승인 전이 실패·예외) 남은 승인대기 기록을 반려로 닫는다 — 그대로 두면 오너가
 * 결재함에서 낡은 줄을 나중에 승인할 수 있다. 이미 다른 상태면 건드리지 않는다(조건부 전이). 닫기 자체가 실패하면
 * 삼키지 않고 기록한 뒤 호출부의 실패 문구에 기록 id 를 남긴다.
 */
async function closeOrphanProposal(proposalId: string, reason: string): Promise<void> {
  try {
    await ActionProposalRepository.transition(proposalId, "REJECTED", {
      actor: AGENT_MAPPING_APPLY_ACTOR,
      note: `봇 즉시 저장 중단: ${reason}`.slice(0, 500),
      expectedFrom: "PENDING_APPROVAL",
    });
  } catch (error) {
    console.error(`[agent-internal] orphan proposal ${proposalId} could not be closed:`, describeError(error));
  }
}

function boundRejectedName(optionName: string): string {
  return optionName.length > MAX_REJECTED_OPTION_NAME_CHARS
    ? `${optionName.slice(0, MAX_REJECTED_OPTION_NAME_CHARS - 1)}…`
    : optionName;
}

export async function applyProductMappings(
  request: ApplyProductMappingsRequest,
  deps: ApplyDeps = {},
): Promise<AppliedResult> {
  return inCampaignQueue(request.orderCampaignId, () => applyInQueue(request, deps));
}

async function applyInQueue(request: ApplyProductMappingsRequest, deps: ApplyDeps): Promise<AppliedResult> {
  const loaded = await loadStoreOptionsForApply(request.orderCampaignId, deps.storeOptions);
  if (!loaded.ok) return loaded;
  const { snapshot } = loaded;

  // ①
  const storeByKey = new Map(snapshot.rows.map((row) => [normalizeMappingOptionName(row.optionName), row]));
  const rejected: ProductMappingsAppliedStructuredData["rejected"] = [];
  const accepted: UpsertProductMappingsRequestArgs["mappings"] = [];
  for (const row of request.mappings) {
    const store = storeByKey.get(normalizeMappingOptionName(row.optionName));
    if (!store) {
      rejected.push({ optionName: boundRejectedName(row.optionName), code: "NOT_A_STORE_OPTION" });
      continue;
    }
    if (store.optionName.trim().length > MAX_MAPPING_OPTION_NAME_CHARS) {
      rejected.push({ optionName: boundRejectedName(store.optionName), code: "OPTION_NAME_TOO_LONG" });
      continue;
    }
    accepted.push({ optionName: store.optionName, brandCode: row.brandCode, price: row.price });
  }

  const base = {
    kind: "product_mappings_applied" as const,
    version: 1 as const,
    orderCampaign: snapshot.orderCampaign,
  };
  if (accepted.length === 0) {
    return finalize({ ok: true, data: { ...base, proposalId: null, created: 0, updated: 0, unchanged: 0, rejected } });
  }

  // 새 줄의 상품명 = 그 스토어 옵션 줄의 상품명(`buildStoreMappingRows` 가 정한 값). 추가구성상품 줄은 거기서 이미
  // 빈칸이다 — 추가구성 주문의 상품명은 애드온 자체 이름이라 주상품명을 채우면 주문 대조가 실패한다(GPT 검수 2026-10-16).
  const productNameByKey = new Map(
    snapshot.rows.map((row) => [normalizeMappingOptionName(row.optionName), row.productName] as const),
  );
  const productNameForNewRow = (optionName: string): string | undefined => {
    const name = productNameByKey.get(normalizeMappingOptionName(optionName)) ?? "";
    return name !== "" && name.length <= MAX_MAPPING_PRODUCT_NAME_CHARS ? name : undefined;
  };
  const requestArgs: UpsertProductMappingsRequestArgs = {
    orderCampaignId: snapshot.orderCampaign.id,
    orderCampaignName: snapshot.orderCampaign.name,
    mappings: accepted,
  };

  // ② + ③ 기안 INSERT 는 스냅샷과 같은 트랜잭션이다 — 그 사이 화면 저장이 끼면 승인 실행의 조건부 쓰기가 잡는다.
  const prepared = await getPrisma().$transaction(async (tx): Promise<PreparedOutcome> => {
    const snap = await snapshotProductMappingExpected(requestArgs, tx);
    if (snap.kind === "DUPLICATE") return { kind: "UNUSABLE", failure: agentInternalFailure("DUPLICATE_MAPPING", snap.detail) };
    if (snap.kind === "OUT_OF_RANGE") return { kind: "UNUSABLE", failure: agentInternalFailure("OUT_OF_RANGE", snap.detail) };

    const storedArgs = {
      ...snap.args,
      mappings: snap.args.mappings.map((row) => {
        const productName = row.expectedBrandCode === null ? productNameForNewRow(row.optionName) : undefined;
        return productName ? { ...row, productName } : row;
      }),
    };
    const existing = await tx.productMapping.findMany({
      where: { campaignId: storedArgs.orderCampaignId },
      select: { id: true, optionName: true, productName: true, brandCode: true, price: true },
    });
    const plan = planProductMappingUpsert(existing, storedArgs.mappings);
    if (!plan.ok) return { kind: "UNUSABLE", failure: agentInternalFailure("APPLY_FAILED", plan.reason) };
    if (plan.creates.length === 0 && plan.updates.length === 0) return { kind: "NO_CHANGE", unchanged: plan.unchanged };

    const built = await upsertProductMappingsTool.execute(storedArgs);
    if (!built.ok) return { kind: "UNUSABLE", failure: agentInternalFailure("INVALID_INPUT", built.error.message) };
    const proposalId = await insertAgentWorkerProposal(tx, {
      intent: built.data.writeIntent,
      storedArgs,
      slack: request.slack,
      note: "봇 상품 매핑 즉시 저장(짝 확인 응답 = 승인, 오너 결정 2026-10-16)",
    });
    return {
      kind: "CREATED",
      proposalId,
      created: plan.creates.length,
      updated: plan.updates.length,
      unchanged: plan.unchanged,
    };
  });

  if (prepared.kind === "UNUSABLE") return prepared.failure;
  if (prepared.kind === "NO_CHANGE") {
    return finalize({
      ok: true,
      data: { ...base, proposalId: null, created: 0, updated: 0, unchanged: prepared.unchanged, rejected },
    });
  }

  const approve = deps.approve ?? approveProposal;
  let outcome: Awaited<ReturnType<typeof approveProposal>>;
  try {
    outcome = await approve(prepared.proposalId, AGENT_MAPPING_APPLY_ACTOR, { expectedStatus: "PENDING_APPROVAL" });
  } catch (error) {
    // 실행 뒤 FAILED 기록이나 커밋 뒤 후속 처리가 던진 경우다 — 기록 상태는 모르므로 승인대기일 때만 닫는다.
    await closeOrphanProposal(prepared.proposalId, describeError(error));
    return agentInternalFailure("APPLY_FAILED", `저장 결과를 확인하지 못했습니다(결재함 기록 ${prepared.proposalId}): ${describeError(error)}`);
  }
  if (!outcome.ok) {
    // 실행이 실패하면(EXECUTION_FAILED) 정본 함수가 이미 FAILED 로 기록했다. 그 밖(승인 전이 실패 등)은 승인대기로
    // 남아 있으므로 닫는다.
    if (outcome.status === "PENDING_APPROVAL") await closeOrphanProposal(prepared.proposalId, outcome.error);
    return agentInternalFailure(
      "APPLY_FAILED",
      `저장하지 못했습니다(결재함 기록 ${prepared.proposalId}): ${outcome.error}`,
    );
  }
  return finalize({
    ok: true,
    data: {
      ...base,
      proposalId: prepared.proposalId,
      created: prepared.created,
      updated: prepared.updated,
      unchanged: prepared.unchanged,
      rejected,
    },
  });
}

/** 응답이 계약(12KB 상한 포함)을 지키는지 내보내기 전에 잰다 — 못 지키면 저장은 끝났으므로 그 사실을 문구로 남긴다. */
function finalize(result: { ok: true; data: ProductMappingsAppliedStructuredData }): AppliedResult {
  const parsed = productMappingsAppliedStructuredDataSchema.safeParse(result.data);
  if (parsed.success) return { ok: true, data: parsed.data };
  return agentInternalFailure(
    "APPLY_FAILED",
    `저장은 끝났지만 결과를 봇에게 돌려줄 수 없습니다(결재함 기록 ${result.data.proposalId ?? "없음"}). CRM 캠페인 설정 창에서 확인해 주세요.`,
  );
}
