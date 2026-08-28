import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { getLinkStats } from "@/lib/short-link";

/**
 * 기간 파라미터는 반드시 여기서 거른다.
 *
 * `new Date("아무거나")` 는 던지지 않고 **Invalid Date** 를 만들고, 그게 Prisma 의
 * `occurredAt: { gte: ... }` 로 흘러가면 직렬화 시점에 `RangeError: Invalid time value`
 * 로 터져 라우트가 500 을 낸다. 즉 "운영자가 URL 을 손으로 고쳤다" 가 서버 오류로
 * 보고되는데, 실제로는 400 이어야 하는 입력 문제다.
 */
const rangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** GET /api/tracked-links/{code}/stats?from=&to=&includeBots=1 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { code } = await params;
  const url = new URL(request.url);

  const range = rangeSchema.safeParse({
    // 미지정과 빈 문자열을 같게 취급한다 — `?from=` 만 남은 URL 이 400 이 되면
    // 기간 필터를 지우는 흔한 조작이 오류로 보인다.
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
  });
  if (!range.success) {
    return NextResponse.json(
      { error: "from/to 는 날짜 형식이어야 합니다.", detail: range.error.flatten() },
      { status: 400 },
    );
  }

  const prisma = getPrisma();
  const link = await prisma.trackedLink.findUnique({ where: { code } });
  if (!link) {
    return NextResponse.json({ error: "링크를 찾을 수 없습니다." }, { status: 404 });
  }

  const stats = await getLinkStats(prisma, code, {
    from: range.data.from,
    to: range.data.to,
    includeBots: url.searchParams.get("includeBots") === "1",
  });

  return NextResponse.json({ link, stats });
}
