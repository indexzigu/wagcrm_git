import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { isValidReportMonth } from "@/lib/withholding-report";
import { isTaxFilingKind } from "@/lib/tax-filing-log";

/**
 * 원천징수 3절차 완료 기록(`TaxFilingLog`) CRUD.
 *
 * 세금계산서 보드의 완료 처리(`PATCH /api/campaign-checklist/items/[itemId]`)와 달리
 * 이 절차들은 캠페인이 아니라 "월"에 붙는 사실이라 별도 모델·라우트가 필요하다(설계
 * 문서 「스키마 변경 — TaxFilingLog」). GET 은 카드 렌더용 완료 목록, POST/DELETE 는
 * 완료·완료해제 — 둘 다 이미 완료(또는 이미 없음) 상태에 다시 호출해도 에러가 나지
 * 않는 **멱등**이다.
 *
 * ⚠️ `@@unique([month, kind])` 자체는 멱등을 만들어주지 않는다 — 오히려 그 반대다.
 * 두 탭·이중 클릭으로 같은 (month, kind) 에 대한 POST 가 동시에 들어오면 둘 다
 * 사전조회에서 "없음"을 보고 둘 다 `create`를 시도할 수 있는데, 그때 유니크 제약이
 * 두 번째 `create`를 P2002 로 거부한다. POST 가 실제로 멱등한 이유는 `upsert`가 그
 * 경쟁을 흡수하기 때문이다(아래).
 */
export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!isValidReportMonth(month)) {
    return NextResponse.json({ error: "month 는 YYYY-MM 형식이어야 합니다." }, { status: 400 });
  }

  const prisma = getPrisma();
  const logs = await prisma.taxFilingLog.findMany({ where: { month } });
  return NextResponse.json({
    month,
    completed: logs.map((log) => ({ kind: log.kind, completedAt: log.completedAt.toISOString() })),
  });
}

async function parseBody(request: Request): Promise<{ month: string; kind: string } | null> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return null;
  const { month, kind } = body as Record<string, unknown>;
  if (typeof month !== "string" || typeof kind !== "string") return null;
  return { month, kind };
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const parsed = await parseBody(request);
  if (!parsed || !isValidReportMonth(parsed.month) || !isTaxFilingKind(parsed.kind)) {
    return NextResponse.json({ error: "month·kind 가 올바르지 않습니다." }, { status: 400 });
  }
  const { month, kind } = parsed;

  const prisma = getPrisma();
  // upsert — 이미 있으면 그대로 두고(update: {}), 없으면 만든다. find-then-create로
  // 짰던 이전 버전은 동시 요청 사이 창(findUnique 가 둘 다 "없음"을 본 뒤 둘 다
  // create를 시도)에서 두 번째 create가 @@unique([month, kind]) 위반으로 던져
  // 라우트가 500을 내는 경쟁 조건이 있었다(체크박스가 "실패"로 보이지만 실제로는
  // 커밋됨 — 다음 조회에서 스스로 복구되긴 해도 오너에게 거짓 실패를 보여줬다).
  // upsert는 그 창을 DB 레벨에서 원자적으로 닫는다.
  const record = await prisma.taxFilingLog.upsert({
    where: { month_kind: { month, kind } },
    update: {},
    create: { month, kind, completedAt: new Date() },
  });

  return NextResponse.json({ month: record.month, kind: record.kind, completedAt: record.completedAt.toISOString() });
}

export async function DELETE(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const parsed = await parseBody(request);
  if (!parsed || !isValidReportMonth(parsed.month) || !isTaxFilingKind(parsed.kind)) {
    return NextResponse.json({ error: "month·kind 가 올바르지 않습니다." }, { status: 400 });
  }
  const { month, kind } = parsed;

  const prisma = getPrisma();
  // deleteMany는 대상이 없어도 0건 삭제로 성공한다 — 완료해제를 두 번 눌러도 에러가
  // 나지 않는 멱등 계약.
  await prisma.taxFilingLog.deleteMany({ where: { month, kind } });

  return NextResponse.json({ ok: true });
}
