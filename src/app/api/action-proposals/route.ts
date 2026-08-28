import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { ActionProposalRepository, deserializeJsonField } from "@/repositories/actionProposalRepository";
import type { ActionProposalStatus } from "@/repositories/actionProposalRepository";
import { resolveEntityLabel } from "@/lib/agent/resolve-entity-label";

const TAKE_LIMIT = 100;

const DEFAULT_STATUS: ActionProposalStatus = "PENDING_APPROVAL";

const VALID_STATUSES: ReadonlySet<ActionProposalStatus> = new Set([
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "EXECUTED",
  "REJECTED",
  "FAILED",
]);

/**
 * m2 [Minor, 보안]: status 쿼리 파라미터를 ActionProposalStatus 화이트리스트로 좁힌다.
 * 인젝션 경로는 없지만(Prisma where 값으로만 쓰임) 방어적으로 임의 문자열이 그대로
 * where.status에 흘러가지 않게 한다 — 화이트리스트 밖 값은 기본값으로 대체한다.
 */
function parseStatusParam(raw: string | null): ActionProposalStatus {
  if (raw && (VALID_STATUSES as Set<string>).has(raw)) {
    return raw as ActionProposalStatus;
  }
  return DEFAULT_STATUS;
}

/**
 * GET /api/action-proposals — 승인 대기함 목록 (청사진 §2).
 * status 필터 기본값은 PENDING_APPROVAL(승인함의 기본 화면), 최신순, take 상한.
 * 각 항목에 서버에서 해석한 targetEntityName을 붙여 승인자가 실제 대상을 보게 한다(§0-6).
 */
export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = new URL(request.url);
  const status = parseStatusParam(searchParams.get("status"));

  const proposals = await ActionProposalRepository.findMany({
    where: { status },
    orderBy: { createdAt: "desc" },
    take: TAKE_LIMIT,
  });

  const items = await Promise.all(
    proposals.map(async (proposal) => {
      const targetEntityName = await resolveEntityLabel(
        proposal.targetEntityType,
        proposal.targetEntityId
      );
      // payload는 SQLite에서 문자열 저장이므로 역직렬화(Postgres 객체엔 no-op) — 인박스/카드가
      // payload.action으로 라벨을 읽는다.
      return { ...proposal, payload: deserializeJsonField(proposal.payload), targetEntityName };
    })
  );

  return NextResponse.json({ items, count: items.length });
}
