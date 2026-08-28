import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { prepareInboxItems, splitUrlText } from "@/lib/reference-inbox";

/**
 * 미분류 레퍼런스 인박스 컬렉션 라우트(R2a).
 * GET: status 필터(기본 PENDING) 목록, 최신순.
 * POST: 여러 URL 일괄 추가 — 정규화·dedup·부분성공 집계(무효/중복 명시).
 *
 * auth 게이트는 다른 승인함 라우트(/api/action-proposals 등)와 동일하게 requireAuth 사용.
 */

const querySchema = z.object({
  status: z.enum(["PENDING", "DISMISSED"]).default("PENDING"),
  // H1: count=1이면 목록 대신 { count }만 반환(허브 배지용 — PENDING 전체 로드 낭비 제거).
  // z.coerce.boolean은 기존 라우트(assets includeArchived) 관례 — 파라미터 존재 시 true.
  count: z.coerce.boolean().default(false),
});

const bodySchema = z
  .object({
    text: z.string().optional(),
    urls: z.array(z.string()).optional(),
    items: z.array(
      z.object({
        url: z.string(),
        thumbnailUrl: z.string().nullable().optional(),
        videoUrl: z.string().nullable().optional(),
        igUsername: z.string().nullable().optional(),
        igProfilePicUrl: z.string().nullable().optional(),
      })
    ).optional(),
  })
  .refine((data) => data.text !== undefined || data.urls !== undefined || data.items !== undefined, {
    message: "text, urls, 또는 items 중 하나가 필요합니다.",
  });

export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    status: searchParams.get("status") ?? undefined,
    count: searchParams.get("count") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.count) {
    const count = await getPrisma().referenceInboxItem.count({
      where: { status: parsed.data.status },
    });
    return NextResponse.json({ count });
  }

  const items = await getPrisma().referenceInboxItem.findMany({
    where: { status: parsed.data.status },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // text(여러 줄)와 urls 배열을 모두 후보로 합친다(둘 다 오면 병합).
  const rawUrls: string[] = [
    ...(parsed.data.text ? splitUrlText(parsed.data.text) : []),
    ...(parsed.data.urls ?? []).map((u) => u.trim()).filter((u) => u.length > 0),
    ...(parsed.data.items ?? []).map((i) => i.url.trim()).filter((u) => u.length > 0),
  ];

  if (rawUrls.length === 0) {
    return NextResponse.json({ added: 0, skipped: 0, invalid: 0, items: [] });
  }

  const prisma = getPrisma();

  // 기존 PENDING 항목의 normalizedUrl을 조회해 dedup 근거로 쓴다.
  // (배치 내 중복은 prepareInboxItems가 함께 처리)
  const existingPending = await prisma.referenceInboxItem.findMany({
    where: { status: "PENDING" },
    select: { normalizedUrl: true },
  });

  const plan = prepareInboxItems(
    rawUrls,
    existingPending.map((row) => row.normalizedUrl),
  );

  const itemsMap = new Map();
  if (parsed.data.items) {
    for (const item of parsed.data.items) {
      itemsMap.set(item.url.trim(), item);
    }
  }

  const createdBy = auth.context.userId;
  const created =
    plan.toCreate.length > 0
      ? await prisma.$transaction(
          plan.toCreate.map((item) => {
            const extra = itemsMap.get(item.rawUrl) || {};
            return prisma.referenceInboxItem.create({
              data: {
                rawUrl: item.rawUrl,
                normalizedUrl: item.normalizedUrl,
                linkName: item.linkName,
                thumbnailUrl: extra.thumbnailUrl || null,
                videoUrl: extra.videoUrl || null,
                igUsername: extra.igUsername || null,
                igProfilePicUrl: extra.igProfilePicUrl || null,
                source: extra.thumbnailUrl ? "KAKAO" : "MANUAL",
                createdBy,
              },
            });
          }),
        )
      : [];

  return NextResponse.json({
    added: created.length,
    skipped: plan.skipped,
    invalid: plan.invalid,
    items: created,
  });
}
