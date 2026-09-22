import { NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { AgentJobRepository } from "@/repositories/agentJobRepository";
import { AGENT_JOBS_PAGE_SIZE, toListItem } from "@/lib/agent-jobs/list-item";

/** ISO 날짜만 커서로 받는다 — 파싱 불가면 커서 없음(첫 페이지). */
function parseBefore(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * GET /api/agent-jobs — 결재함 「봇 활동」 탭 (admin 전용, §3-C).
 * 기본은 SUCCEEDED 제외(성공은 조회 결과·기안 탭에 이미 있다) — includeSucceeded=1 로 포함.
 * before 커서로 페이지네이션한다.
 */
export async function GET(request: Request) {
  const auth = await requireRole("admin");
  if (!auth.authenticated) return auth.response;

  const { searchParams } = new URL(request.url);
  const includeSucceeded = searchParams.get("includeSucceeded") === "1";
  const before = parseBefore(searchParams.get("before"));

  const rows = await AgentJobRepository.listRecent({
    before,
    includeSucceeded,
    take: AGENT_JOBS_PAGE_SIZE + 1,
  });
  const page = rows.slice(0, AGENT_JOBS_PAGE_SIZE).map(toListItem);
  const nextBefore = rows.length > AGENT_JOBS_PAGE_SIZE ? page[page.length - 1].createdAt : null;

  return NextResponse.json({ items: page, nextBefore });
}
