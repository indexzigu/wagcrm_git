import type { Prisma } from "@prisma/client";
import { serializeJsonFields } from "@/repositories/actionProposalRepository";
import { getRequestTypeForAction } from "@/lib/agent/approval-policy";
import type { WriteIntent } from "@/lib/agent/tools/types";
import {
  normalizeMappingOptionName,
  upsertProductMappingsArgsSchema,
  upsertProductMappingsRequestArgsSchema,
  type AgentJobSlackOrigin,
} from "@/lib/agent-worker/contracts";

/**
 * 봇 기안 두 가지 공용 조각 — 봇 작업 실행기(`agent-worker/executor.ts`, 봇 DB 역할)와 봇 내부 창구
 * (`agent-internal/apply-product-mappings.ts`, 앱 권한)가 같은 함수를 쓴다(2026-10-16).
 *  ① 상품 매핑 줄의 지금 값 스냅샷 ② 봇이 올린 기안 1건 + 첫 이벤트 INSERT.
 * 두 곳에 손으로 두면 한쪽만 NFC 키·중복 거절·출처 칸을 갖는 상태가 생긴다.
 *
 * ⛔ 이 파일은 읽기와 INSERT 만 한다 — 승인·실행 함수를 들이지 말 것(봇 작업 실행기가 import 하므로
 *    `agent-worker-boundary.contract.test.ts` 의 「실행기는 승인·실행 함수를 import 하지 않는다」가 여기까지 닿는다).
 */

/** 봇이 올린 기안의 기안자(`ActionProposal.createdBy`). */
export const AGENT_WORKER_ACTOR = "AGENT_WORKER";

type ProposalTx = Prisma.TransactionClient;

export type UpsertProductMappingsRequestArgs = ReturnType<typeof upsertProductMappingsRequestArgsSchema.parse>;
export type UpsertProductMappingsStoredArgs = ReturnType<typeof upsertProductMappingsArgsSchema.parse>;

/** 같은 옵션명 매핑이 DB 에 이미 여러 줄일 때 봇에게 주는 한 문장 — 어느 줄을 고칠지 정할 수 없다. */
function duplicateMappingDetail(optionName: string, count: number): string {
  return `「${optionName}」 매핑이 이미 ${count}줄 있습니다. CRM 화면에서 중복을 먼저 정리하세요.`;
}

/**
 * 지금 값이 저장 스키마 범위(상품코드 32자·가격 0~1억원) 밖일 때 봇에게 주는 한 문장. 화면은 길이·범위 제한 없이
 * 저장하므로(campaigns-handler) 그런 줄이 있을 수 있다 — 범위를 넓히지 않고 화면에서 고치게 한다.
 */
function outOfRangeMappingDetail(optionName: string): string {
  return `「${optionName}」 지금 값이 봇이 다룰 수 있는 범위를 벗어났습니다(상품코드 32자·가격 0~1억원). CRM 화면에서 고쳐 주세요.`;
}

export type ProductMappingSnapshot =
  | { kind: "READY"; args: UpsertProductMappingsStoredArgs }
  | { kind: "DUPLICATE"; detail: string }
  | { kind: "OUT_OF_RANGE"; detail: string };

/**
 * 상품 매핑 기안의 지금 값 스냅샷(2026-10-16). 봇은 지금 값을 옮겨 적지 않으므로, 기안을 만드는 트랜잭션 안에서
 * 캠페인의 매핑 줄을 읽어 줄마다 `expectedBrandCode`/`expectedPrice` 를 채운다.
 * 옵션명은 `normalizeMappingOptionName` 키로 맞춘다(NFD·공백 차이 흡수): 0줄 → null/null(새 줄),
 * 1줄 → 그 줄의 값, 2줄 이상 → 어느 줄을 고칠지 정할 수 없어 기안을 만들지 않는다.
 * 실행 시점 실행기는 이 스냅샷과 그때의 DB 를 다시 대조한다(그 사이 화면에서 바뀌면 실행되지 않는다).
 * ⛔ 봇 DB 역할은 ProductMapping 에 칸 단위 GRANT 만 있다 — 명시 select 로 GRANT 된 칸만 고른다.
 */
export async function snapshotProductMappingExpected(
  args: UpsertProductMappingsRequestArgs,
  client: ProposalTx,
): Promise<ProductMappingSnapshot> {
  const existing = await client.productMapping.findMany({
    where: { campaignId: args.orderCampaignId },
    select: { id: true, optionName: true, brandCode: true, price: true },
  });
  const byKey = new Map<string, Array<(typeof existing)[number]>>();
  for (const row of existing) {
    const key = normalizeMappingOptionName(row.optionName);
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const mappings: UpsertProductMappingsStoredArgs["mappings"] = [];
  for (const row of args.mappings) {
    const matches = byKey.get(normalizeMappingOptionName(row.optionName)) ?? [];
    if (matches.length >= 2) {
      return { kind: "DUPLICATE", detail: duplicateMappingDetail(row.optionName, matches.length) };
    }
    const current = matches[0];
    mappings.push({
      ...row,
      expectedBrandCode: current ? current.brandCode : null,
      expectedPrice: current ? current.price : null,
    });
  }
  // 봇 줄은 이미 계약을 통과했으므로 여기서 걸리는 것은 DB 에서 채운 지금 값뿐이다. parse 로 던지면 재시도
  // 대상 오류가 되어 같은 실패를 세 번 되풀이하고 이유도 남지 않는다 — 최종 실패 + 이유로 끝낸다.
  const stored = upsertProductMappingsArgsSchema.safeParse({ ...args, mappings });
  if (!stored.success) {
    const rowIndex = stored.error.issues
      .map((issue) => (issue.path[0] === "mappings" && typeof issue.path[1] === "number" ? issue.path[1] : null))
      .find((index): index is number => index !== null);
    const optionName = args.mappings[rowIndex ?? 0]?.optionName ?? "";
    return { kind: "OUT_OF_RANGE", detail: outOfRangeMappingDetail(optionName) };
  }
  return { kind: "READY", args: stored.data };
}

/**
 * 기안의 출처 칸(`ActionProposal.sourceRef`). 슬랙 위치가 있을 때만 만든다 — 없으면 칸을 아예 넘기지 않아
 * DB 기본값 NULL 로 남는다. 계약이 이미 `.strict()` 로 모양을 검사했지만 네 칸만 골라 **새 객체로** 옮긴다 —
 * 받은 객체를 그대로 넘기면 계약이 넓어질 때 그 칸이 검토 없이 DB 까지 따라 들어간다.
 */
export function proposalSourceRef(
  slack: AgentJobSlackOrigin | undefined,
): { sourceRef: Prisma.InputJsonValue } | Record<string, never> {
  if (!slack) return {};
  const { channelId, threadTs, messageTs, rid } = slack;
  return { sourceRef: { slack: { channelId, threadTs, messageTs, rid } } };
}

/**
 * 봇이 올린 기안 1건을 PENDING_APPROVAL 로 넣고 첫 이벤트(DRAFT → PENDING_APPROVAL)를 남긴다. 만든 기안 id 를
 * 돌려준다. 승인은 이 함수가 하지 않는다 — 사람(결재함) 또는 오너가 정한 전용 경로가 따로 한다.
 */
export async function insertAgentWorkerProposal(
  tx: ProposalTx,
  input: { intent: WriteIntent; storedArgs: unknown; slack: AgentJobSlackOrigin | undefined; note: string },
): Promise<string> {
  const { intent, storedArgs, slack, note } = input;
  const created = await tx.actionProposal.create({
    data: serializeJsonFields({
      requestType: getRequestTypeForAction(intent.action),
      kind: "WRITE",
      status: "PENDING_APPROVAL",
      title: intent.summary.slice(0, 200),
      resultSummary: intent.summary,
      payload: { action: intent.action, args: storedArgs as Prisma.InputJsonValue },
      targetEntityType: intent.targetEntityType,
      targetEntityId: intent.targetEntityId,
      campaignId: intent.targetEntityType === "CAMPAIGN" ? intent.targetEntityId : null,
      reviewRequired: true,
      createdBy: AGENT_WORKER_ACTOR,
      ...proposalSourceRef(slack),
    }),
  });
  await tx.actionProposalEvent.create({
    data: {
      proposalId: created.id,
      fromStatus: "DRAFT",
      toStatus: "PENDING_APPROVAL",
      actor: AGENT_WORKER_ACTOR,
      note,
    },
  });
  return created.id;
}
