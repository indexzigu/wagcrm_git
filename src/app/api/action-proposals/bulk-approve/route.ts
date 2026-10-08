import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/api-auth";
import { bulkApproveProposals } from "@/lib/agent/approve-proposal";
import { BULK_APPROVE_MAX_IDS } from "@/lib/action-proposal-bulk";

/**
 * id 는 불투명 문자열로만 다룬다(cuid 형식을 가정하지 않는다) — 다듬지도 않는다.
 * 중복은 조용히 접지 않고 거부한다: 같은 id 를 두 번 보낸 호출부는 선택 상태가 깨진
 * 것이고, 접으면 「N건 승인」 요약과 실제 처리 건수가 어긋난다.
 */
const BulkApproveBodySchema = z.object(
  {
    ids: z
      .array(
        z
          .string({ error: "id 는 문자열이어야 합니다." })
          .min(1, "빈 id 는 보낼 수 없습니다.")
          .max(200, "id 가 너무 깁니다."),
        { error: "ids 배열이 필요합니다." }
      )
      .min(1, "승인할 기안을 1건 이상 골라 주세요.")
      .max(BULK_APPROVE_MAX_IDS, `한 번에 최대 ${BULK_APPROVE_MAX_IDS}건까지 승인할 수 있습니다.`)
      .refine((ids) => new Set(ids).size === ids.length, "같은 기안이 두 번 들어 있습니다."),
  },
  { error: "요청 본문은 { ids: string[] } 형식이어야 합니다." }
);

/**
 * 최대 50건을 순차 실행한다. 실행 도중 플랫폼 시간 제한에 잘리면 tx1(APPROVED) 커밋 뒤
 * tx2·FAILED 기록 전에 멈춘 기안이 APPROVED 에 남을 수 있어 넉넉히 둔다(화면은 10건씩 보낸다).
 */
export const maxDuration = 300;

/**
 * POST /api/action-proposals/bulk-approve — 기안 일괄 승인+실행.
 *
 * 본문 `{ ids: string[] }`(1~50건, 중복 불가). 주어진 순서대로 한 건씩 단건 승인과 **같은
 * 함수**(`approveProposal`)를 태운다 — 건별 self-approval 게이트·CAS·실행·FAILED 기록·
 * 후속 처리가 단건과 같다. 한 건이 실패해도 나머지는 계속한다.
 *
 * 응답은 부분 실패여도 200 이다: `{ results: [{id, ok, outcome, status, error?}], counts }`.
 * 승인 대기(또는 재시도 가능한 실패 — 단건 승인과 같은 규칙)가 아닌 기안은 오류가 아니라
 * `skipped` 로 돌아온다. 한 번 실행된(EXECUTED) 기안은 같은 목록으로 다시 불러도 건너뜀이고
 * 다시 실행되지 않는다. ⚠️ 실패(FAILED)한 기안은 단건 승인처럼 **재시도로 다시 실행된다.**
 */
export async function POST(request: Request) {
  const auth = await requireRole("admin");
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 올바른 JSON 이 아닙니다." }, { status: 400 });
  }

  const parsed = BulkApproveBodySchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "요청 형식이 올바르지 않습니다.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const response = await bulkApproveProposals(parsed.data.ids, auth.context.userId);
  return NextResponse.json(response);
}
