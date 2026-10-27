import { createHash } from "node:crypto";
import { ACTION_LABELS } from "@/lib/agent/action-labels";
import type { ProposalArgLabels } from "@/lib/agent/resolve-entity-label";
import { kstDateTime } from "@/lib/cron-incident-report";
import { displayLabel } from "@/lib/display-label";
import { ENTITY_TYPE_LABELS } from "@/components/crm/approvals/entity-type-labels";
import { sourceLabelOf } from "@/components/crm/approvals/source-badge";

/**
 * 결재 대기 기안 → 오너 텔레그램 알림 문구. 순수 함수만 둔다 — 조회·확인 표시는 `/api/cron/approval-outbox`
 * 라우트가 하고, 호스트 발송기(`infra/selfhost/incident-notify.sh approval`)가 그 목록을 notify.sh 로 보낸다.
 *
 * 발송기는 `<아이콘> <제목> — <상세>` 한 통으로 붙여 보낸다(notify.sh). 상세 첫 줄이 제목 줄에 이어 붙으므로
 * 첫 줄에는 기안 종류를 둔다. 텔레그램 한 통 상한(4096자)을 넘지 않게 요약·목록을 자른다.
 */

/** 한 회차에 이만큼 이상 쌓이면 기안마다 보내지 않고 1통으로 묶는다 — 일괄 기안(재캠페인 제안 등)이 폰을 연달아 울리지 않게. */
export const APPROVAL_BATCH_THRESHOLD = 4;
/** 묶음 알림에 제목을 나열하는 최대 개수 */
const BATCH_LIST_MAX = 10;
const TITLE_MAX = 120;
const SUMMARY_MAX = 1200;

export type ApprovalOutboxMessage = {
  key: string;
  icon: "📝";
  title: string;
  detail: string;
  /** 보낸 뒤 POST 로 「보냈음」을 찍을 칸 */
  ackField: "ownerNotifiedAt";
  /** 개별 알림은 1건, 묶음 알림은 실린 기안 전부 */
  proposalIds: string[];
};

/** 문구에 필요한 기안 칸(ActionProposal 의 부분집합 + 서버가 푼 이름) */
export type ApprovalNotifyProposal = {
  id: string;
  title: string;
  resultSummary: string | null;
  /** 역직렬화한 실행 명세 — `{ action, args }` */
  payload: unknown;
  createdBy: string;
  createdAt: Date;
  targetEntityType: string | null;
  /** `resolveEntityLabel` 이 푼 대상 이름 */
  targetName: string | null;
  /** `resolveProposalArgLabels` 가 푼 이름(새 회차 생성 기안만) */
  argLabels: ProposalArgLabels | null;
};

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function actionOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const action = (payload as { action?: unknown }).action;
  return typeof action === "string" && action ? action : null;
}

function targetLine(p: ApprovalNotifyProposal): string | null {
  if (p.argLabels) {
    const parts = [
      p.argLabels.seller ? `셀러 ${p.argLabels.seller}` : null,
      p.argLabels.deal ? `판매 조건 ${p.argLabels.deal}` : null,
    ].filter(Boolean);
    if (parts.length > 0) return `대상: ${parts.join(" · ")}`;
  }
  if (!p.targetName) return null;
  const type = p.targetEntityType ? ENTITY_TYPE_LABELS[p.targetEntityType] : undefined;
  return `대상: ${type ? `${type} ` : ""}${p.targetName}`;
}

function linkTo(baseUrl: string | null, path: string): string | null {
  return baseUrl ? `${baseUrl.replace(/\/+$/, "")}${path}` : null;
}

export function formatApprovalMessage(p: ApprovalNotifyProposal, baseUrl: string | null): ApprovalOutboxMessage {
  const action = actionOf(p.payload);
  const lines: string[] = [action ? displayLabel(ACTION_LABELS, action, action) : "기안"];
  const target = targetLine(p);
  if (target) lines.push(target);
  lines.push(`올린 곳: ${sourceLabelOf(p.createdBy)} · ${kstDateTime(p.createdAt)}`);
  const summary = p.resultSummary?.trim();
  // 봇 기안은 요약을 잘라 제목으로 쓴다 — 같은 글을 두 번 싣지 않는다.
  if (summary && summary !== p.title.trim()) lines.push("", clip(summary, SUMMARY_MAX));
  const link = linkTo(baseUrl, `/approvals/${p.id}`);
  if (link) lines.push("", `열기: ${link}`);
  return {
    key: `approval-${p.id}`,
    icon: "📝",
    title: `결재 대기: ${clip(p.title, TITLE_MAX)}`,
    detail: lines.join("\n"),
    ackField: "ownerNotifiedAt",
    proposalIds: [p.id],
  };
}

/**
 * 묶음 1통. 제목은 BATCH_LIST_MAX 건까지만 나열하지만 `proposalIds` 에는 실린 기안 **전부**를 담는다 — 나머지는
 * 「외 N건」과 결재함 링크로 알렸으므로 함께 확인한다(다음 회차에 같은 기안을 또 묶어 보내지 않게).
 */
export function formatApprovalBatch(
  proposals: Pick<ApprovalNotifyProposal, "id" | "title">[],
  baseUrl: string | null,
): ApprovalOutboxMessage {
  const lines = proposals.slice(0, BATCH_LIST_MAX).map((p) => `· ${clip(p.title, TITLE_MAX)}`);
  if (proposals.length > BATCH_LIST_MAX) lines.push(`외 ${proposals.length - BATCH_LIST_MAX}건`);
  const link = linkTo(baseUrl, "/approvals");
  if (link) lines.push("", `결재함: ${link}`);
  return {
    // 키는 실린 기안 **구성 전체**의 지문이다. 🪤 첫 기안 id 만 쓰면, 확인 POST 가 실패한 뒤 다음 회차에 같은 첫 기안
    // + 새 기안으로 묶음이 다시 만들어질 때 notify.sh 의 같은 키 6시간 하한이 발송을 건너뛰고(exit 0) 발송기는 그것을
    // 「보냈음」으로 읽어 새 기안을 알림 없이 확인해 버린다. 구성이 바뀌면 키도 바뀌어 다시 나간다(유실 대신 중복).
    key: `approval-batch-${batchFingerprint(proposals.map((p) => p.id))}`,
    icon: "📝",
    title: `결재 대기 ${proposals.length}건`,
    detail: lines.join("\n"),
    ackField: "ownerNotifiedAt",
    proposalIds: proposals.map((p) => p.id),
  };
}

function batchFingerprint(ids: string[]): string {
  return createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 16);
}

/** 한 회차 목록 — 임계 미만이면 기안마다 1통, 이상이면 묶음 1통. 빈 목록이면 빈 배열. */
export function formatApprovalMessages(
  proposals: ApprovalNotifyProposal[],
  baseUrl: string | null,
): ApprovalOutboxMessage[] {
  if (proposals.length === 0) return [];
  if (proposals.length >= APPROVAL_BATCH_THRESHOLD) return [formatApprovalBatch(proposals, baseUrl)];
  return proposals.map((p) => formatApprovalMessage(p, baseUrl));
}
