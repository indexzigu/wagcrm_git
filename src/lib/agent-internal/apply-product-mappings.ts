import { getPrisma } from "@/lib/prisma";
import { approveProposal } from "@/lib/agent/approve-proposal";
import {
  insertAgentWorkerProposal,
  snapshotProductMappingExpected,
  type UpsertProductMappingsRequestArgs,
} from "@/lib/agent/agent-worker-proposal";
import { upsertProductMappingsTool } from "@/lib/agent/tools/upsert-product-mappings";
import { planProductMappingUpsert } from "@/lib/order-converter/product-mapping-upsert";
import {
  MAX_MAPPING_PRODUCT_NAME_CHARS,
  normalizeMappingOptionName,
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
 * ⚠️ 새 줄의 상품명은 스토어 상품명으로 채운다(설정 창 「스토어 옵션 불러오기」와 같다 — 상품명이 있으면 주문
 *    대조가 상품명·옵션명 둘 다 본다). 계약 상한(`MAX_MAPPING_PRODUCT_NAME_CHARS`)을 넘는 상품명은 빈칸으로
 *    둔다 — 빈칸이면 옵션명만으로 대조된다(봇 기안 경로와 같은 기본값). 고칠 줄의 상품명은 건드리지 않는다.
 */

export { AGENT_MAPPING_APPLY_ACTOR };

type AppliedResult = { ok: true; data: ProductMappingsAppliedStructuredData } | AgentInternalFailure;

export type ApplyDeps = {
  storeOptions?: StoreOptionsDeps;
  approve?: typeof approveProposal;
};

type PreparedOutcome =
  | { kind: "NO_CHANGE"; unchanged: number }
  | { kind: "CREATED"; proposalId: string; created: number; updated: number; unchanged: number }
  | { kind: "UNUSABLE"; failure: AgentInternalFailure };

export async function applyProductMappings(
  request: ApplyProductMappingsRequest,
  deps: ApplyDeps = {},
): Promise<AppliedResult> {
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
      rejected.push({ optionName: row.optionName, code: "NOT_A_STORE_OPTION" });
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
    return { ok: true, data: { ...base, proposalId: null, created: 0, updated: 0, unchanged: 0, rejected } };
  }

  const productNameForNewRows =
    snapshot.productName.length <= MAX_MAPPING_PRODUCT_NAME_CHARS ? snapshot.productName : undefined;
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
      mappings: snap.args.mappings.map((row) =>
        row.expectedBrandCode === null && productNameForNewRows ? { ...row, productName: productNameForNewRows } : row,
      ),
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
    return {
      ok: true,
      data: { ...base, proposalId: null, created: 0, updated: 0, unchanged: prepared.unchanged, rejected },
    };
  }

  const approve = deps.approve ?? approveProposal;
  const outcome = await approve(prepared.proposalId, AGENT_MAPPING_APPLY_ACTOR, { expectedStatus: "PENDING_APPROVAL" });
  if (!outcome.ok) {
    return agentInternalFailure(
      "APPLY_FAILED",
      `저장하지 못했습니다(결재함 기록 ${prepared.proposalId}): ${outcome.error}`,
    );
  }
  return {
    ok: true,
    data: {
      ...base,
      proposalId: prepared.proposalId,
      created: prepared.created,
      updated: prepared.updated,
      unchanged: prepared.unchanged,
      rejected,
    },
  };
}
