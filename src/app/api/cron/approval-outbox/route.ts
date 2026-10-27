import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { getPrisma } from "@/lib/prisma";
import { resolveEntityLabel, resolveProposalArgLabels } from "@/lib/agent/resolve-entity-label";
import { deserializeJsonField } from "@/repositories/actionProposalRepository";
import {
  APPROVAL_BATCH_THRESHOLD,
  formatApprovalMessages,
  type ApprovalNotifyProposal,
  type ApprovalOutboxMessage,
} from "@/lib/approval-notify";

// 결재 대기 알림 목록(outbox) — 결재함 「대기」 탭에 새로 오른 기안(WRITE · PENDING_APPROVAL)을 오너 텔레그램으로 알린다.
// 호스트 스크립트(`incident-notify.sh approval`)가 이 목록을 받아 notify.sh 로 보내고, 보낸 것만 POST 로 「보냈음」을 찍는다.
// 사고 알림(`/api/cron/incident-outbox`)과 같은 왕복이다 — GET 은 같은 상태에서 몇 번 불러도 같은 목록을 돌려준다.
//
// 레이더가 지켜보는 정기 작업이 아니다 — KNOWN_JOBS 에 넣지 않고 withSystemTaskStatus 로 감싸지 않는다(사고 알림과 같은 이유).
//
// ⏱ 올라온 지 MIN_AGE_MS 가 지난 기안만 싣는다 — 정산 자동 실행(`agent-auto-execute`, 2분마다)이 슬랙봇 정산 기안을
//   곧바로 승인해 대기에서 빼는 경우가 있어, 그 사이에 보내면 이미 처리된 기안을 알리게 된다. 승인·반려된 기안은
//   상태 조건으로 빠지므로 알림이 나가기 전에 오너가 처리한 기안도 울리지 않는다.
// ⚠️ `export const dynamic` 를 두지 않는다 — 이 레포는 `cacheComponents` 라 라우트 세그먼트 설정이 빌드를 깬다(incident-outbox 와 같다).

const MIN_AGE_MS = 5 * 60 * 1000;
/** 한 회차에 읽는 최대 기안 수 — 남은 것은 다음 회차가 싣는다(묶음 1통에 담기는 범위로 자른다). */
const MAX_ROWS = 50;
const ACK_FIELD = "ownerNotifiedAt" satisfies ApprovalOutboxMessage["ackField"];

async function pendingMessages(now: Date): Promise<ApprovalOutboxMessage[]> {
  const rows = await getPrisma().actionProposal.findMany({
    where: {
      kind: "WRITE",
      status: "PENDING_APPROVAL",
      ownerNotifiedAt: null,
      createdAt: { lte: new Date(now.getTime() - MIN_AGE_MS) },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_ROWS,
    select: {
      id: true,
      title: true,
      resultSummary: true,
      payload: true,
      createdBy: true,
      createdAt: true,
      targetEntityType: true,
      targetEntityId: true,
    },
  });
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || null;

  // 묶음 알림은 기안마다 종류와 제목만 싣는다 — 대상 이름을 풀 조회를 하지 않는다.
  if (rows.length >= APPROVAL_BATCH_THRESHOLD) {
    return formatApprovalMessages(
      rows.map((r) => ({ ...r, payload: deserializeJsonField(r.payload), targetName: null, argLabels: null })),
      baseUrl,
    );
  }
  const proposals: ApprovalNotifyProposal[] = await Promise.all(
    rows.map(async (r) => {
      // sqlite(dev:local)는 Json 을 문자열로 저장한다 — 결재함 상세 API 와 같이 역직렬화한다.
      const payload = deserializeJsonField(r.payload);
      // 이름 조회가 한 건에서 실패해도 그 기안을 이름 없이 보낸다 — 한 행의 실패가 다른 기안 알림까지 막지 않게.
      const [targetName, argLabels] = await Promise.all([
        resolveEntityLabel(r.targetEntityType, r.targetEntityId).catch((error: unknown) => {
          console.error("[approval-outbox] 대상 이름 조회 실패 — 이름 없이 보낸다", r.id, error);
          return null;
        }),
        resolveProposalArgLabels(payload).catch((error: unknown) => {
          console.error("[approval-outbox] 기안 인자 이름 조회 실패 — 이름 없이 보낸다", r.id, error);
          return null;
        }),
      ]);
      return { ...r, payload, targetName, argLabels };
    }),
  );
  return formatApprovalMessages(proposals, baseUrl);
}

export async function GET(request: Request): Promise<Response> {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const messages = await pendingMessages(new Date());
    return NextResponse.json({ ok: true, messages });
  } catch (error) {
    console.error("[approval-outbox] 알림 목록 계산 실패", error);
    return NextResponse.json({ ok: false, error: "알림 목록을 만들지 못했습니다" }, { status: 500 });
  }
}

function parseAcks(body: unknown): string[][] | null {
  const acks = (body as { acks?: unknown } | null)?.acks;
  if (!Array.isArray(acks)) return null;
  const parsed: string[][] = [];
  for (const ack of acks) {
    const { proposalIds, ackField } = (ack ?? {}) as { proposalIds?: unknown; ackField?: unknown };
    if (!Array.isArray(proposalIds) || !proposalIds.every((id) => typeof id === "string")) return null;
    if (ackField !== ACK_FIELD) return null;
    parsed.push(proposalIds as string[]);
  }
  return parsed;
}

/**
 * 보낸 알림의 확인 표시. 이미 찍힌 기안은 덮지 않는다 — 호스트 스크립트가 재시도해도 처음 보낸 시각이 남는다.
 * 본문이 하나라도 형식에 어긋나면 아무것도 바꾸지 않고 400.
 */
export async function POST(request: Request): Promise<Response> {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "본문이 JSON 이 아닙니다" }, { status: 400 });
  }
  const acks = parseAcks(body);
  if (!acks) {
    return NextResponse.json(
      { ok: false, error: `acks 는 { proposalIds: string[], ackField: "${ACK_FIELD}" } 의 배열이어야 합니다` },
      { status: 400 },
    );
  }
  try {
    const ids = [...new Set(acks.flat())];
    if (ids.length === 0) return NextResponse.json({ ok: true, updated: 0 });
    const result = await getPrisma().actionProposal.updateMany({
      where: { id: { in: ids }, ownerNotifiedAt: null },
      data: { ownerNotifiedAt: new Date() },
    });
    return NextResponse.json({ ok: true, updated: result.count });
  } catch (error) {
    console.error("[approval-outbox] 확인 표시 실패", error);
    return NextResponse.json({ ok: false, error: "확인 표시를 남기지 못했습니다" }, { status: 500 });
  }
}
