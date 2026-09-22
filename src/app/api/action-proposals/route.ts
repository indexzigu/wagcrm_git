import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { ActionProposalRepository, deserializeJsonField } from "@/repositories/actionProposalRepository";
import type { ActionProposalKind, ActionProposalStatus } from "@/repositories/actionProposalRepository";
import { resolveEntityLabel } from "@/lib/agent/resolve-entity-label";

/**
 * 한 페이지 크기. 조회 결과는 봇이 돌 때마다 쌓이므로 커서(before)로 넘긴다(§3-B).
 * export하지 않는다 — Next App Router route.ts는 GET/POST 등 알려진 이름 외의
 * export를 허용하지 않는다(typedRoutes 타입 생성이 그 계약을 강제, 실측 확인됨).
 */
const PAGE_SIZE = 50;

const DEFAULT_STATUS: ActionProposalStatus = "PENDING_APPROVAL";
/**
 * kind 기본값은 WRITE — 결재함의 기안 4탭(대기/완료/실패/반려)이 봇 조회 결과(READ, EXECUTED)를
 * 삼키지 않게 한다. 조회 결과 탭만 kind=READ 를 명시한다.
 */
const DEFAULT_KIND: ActionProposalKind = "WRITE";

const VALID_STATUSES: ReadonlySet<ActionProposalStatus> = new Set([
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "EXECUTED",
  "REJECTED",
  "FAILED",
]);
const VALID_KINDS: ReadonlySet<ActionProposalKind> = new Set(["READ", "WRITE"]);

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

function parseKindParam(raw: string | null): ActionProposalKind {
  if (raw && (VALID_KINDS as Set<string>).has(raw)) return raw as ActionProposalKind;
  return DEFAULT_KIND;
}

/** ISO 날짜만 커서로 받는다 — 파싱 불가면 커서 없음(첫 페이지). */
function parseBeforeParam(raw: string | null): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * GET /api/action-proposals — 승인 대기함 목록 (청사진 §2).
 * status 필터 기본값은 PENDING_APPROVAL(승인함의 기본 화면), 최신순, take 상한.
 * kind 필터 기본값은 WRITE(§3-B) — 조회 결과(READ) 탭은 kind=READ 를 명시해 받는다.
 * before 커서로 페이지네이션하고, count는 페이지 크기가 아닌 조건 전체 건수를 돌려준다.
 * 각 항목에 서버에서 해석한 targetEntityName을 붙여 승인자가 실제 대상을 보게 한다(§0-6).
 */
export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = new URL(request.url);
  const status = parseStatusParam(searchParams.get("status"));
  const kind = parseKindParam(searchParams.get("kind"));
  const before = parseBeforeParam(searchParams.get("before"));

  const where = { status, kind, ...(before ? { createdAt: { lt: before } } : {}) };
  const [proposals, count] = await Promise.all([
    ActionProposalRepository.findMany({ where, orderBy: { createdAt: "desc" }, take: PAGE_SIZE + 1 }),
    ActionProposalRepository.count({ status, kind }),
  ]);
  const page = proposals.slice(0, PAGE_SIZE);
  const nextBefore = proposals.length > PAGE_SIZE ? new Date(page[page.length - 1].createdAt).toISOString() : null;

  const items = await Promise.all(
    page.map(async (proposal) => {
      const targetEntityName = await resolveEntityLabel(
        proposal.targetEntityType,
        proposal.targetEntityId
      );
      // payload는 SQLite에서 문자열 저장이므로 역직렬화(Postgres 객체엔 no-op) — 인박스/카드가
      // payload.action으로 라벨을 읽는다.
      return { ...proposal, payload: deserializeJsonField(proposal.payload), targetEntityName };
    })
  );

  return NextResponse.json({ items, count, nextBefore });
}
