import { NextResponse, after } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { collectOgSnapshot } from "@/lib/og-snapshot";
import { getPrisma } from "@/lib/prisma";
import {
  buildShortUrl,
  createTrackedLink,
  ensureCampaignTrackedLink,
} from "@/lib/short-link";

const createSchema = z
  .object({
    campaignId: z.string().min(1).optional(),
    targetUrl: z.string().url().optional(),
    baseUrl: z.string().url().optional(),
    label: z.string().max(200).optional(),
    sellerId: z.string().optional(),
    dealId: z.string().optional(),
    expiresAt: z.coerce.date().optional(),
  })
  .refine((v) => Boolean(v.campaignId || v.targetUrl), {
    message: "campaignId 또는 targetUrl 중 하나는 필요합니다.",
  });

/** POST /api/tracked-links — 단축링크 발급(캠페인 기준은 멱등) */
export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "유효하지 않은 요청 본문입니다" },
      { status: 400 },
    );
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const prisma = getPrisma();
  try {
    const link = parsed.data.campaignId
      ? await ensureCampaignTrackedLink(prisma, parsed.data.campaignId)
      : await createTrackedLink(prisma, {
          targetUrl: parsed.data.targetUrl!,
          baseUrl: parsed.data.baseUrl ?? null,
          label: parsed.data.label ?? null,
          sellerId: parsed.data.sellerId ?? null,
          dealId: parsed.data.dealId ?? null,
          expiresAt: parsed.data.expiresAt ?? null,
        });

    // 외부 IO 는 라우트의 after() 가 소유한다(실사고 2026-07-30 — 서비스는 DB 트랜잭션만).
    // 발급 응답이 목적지 서버를 기다리게 하지 않고, 수집이 실패해도 발급은 그대로 성공한다.
    if (!link.ogFetchedAt) {
      after(async () => {
        try {
          const snapshot = await collectOgSnapshot(link.targetUrl);
          // 건질 게 없으면 쓰지 않는다 — 빈 스냅샷을 저장하면 ogFetchedAt 만 찍혀
          // 리다이렉터의 폴백 수집까지 24시간 막힌다.
          if (!snapshot) return;
          await prisma.trackedLink.update({
            where: { id: link.id },
            data: {
              ogTitle: snapshot.title,
              ogImage: snapshot.image,
              ogDescription: snapshot.description,
              ogFetchedAt: new Date(),
            },
          });
        } catch (error) {
          console.error("[tracked-links] OG 스냅샷 수집 실패:", error);
        }
      });
    }

    return NextResponse.json(
      { ...link, shortUrl: buildShortUrl(link.code) },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "링크 발급에 실패했습니다." },
      { status: 400 },
    );
  }
}

/** GET /api/tracked-links?campaignId=&sellerId=&dealId= — 목록 + 클릭 수 */
export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const url = new URL(request.url);
  const campaignId = url.searchParams.get("campaignId");
  const sellerId = url.searchParams.get("sellerId");
  const dealId = url.searchParams.get("dealId");

  const prisma = getPrisma();
  const links = await prisma.trackedLink.findMany({
    where: {
      ...(campaignId ? { salesCampaignId: campaignId } : {}),
      ...(sellerId ? { sellerId } : {}),
      ...(dealId ? { dealId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  // 봇 미리보기는 빼고 센다 — 목록 숫자와 상세 통계가 어긋나지 않게.
  // (필터 걸린 _count 는 filteredRelationCount preview 기능이라 쓰지 않는다)
  //
  // 총 클릭과 방문 연인원을 **한 번에** 낸다. groupBy 를 (code, visitorHash) 로 잡으면
  // 행 수 = 코드별 연인원이고, `_count._all` 을 더하면 총 클릭이 된다. 캠페인 사이드패널이
  // 두 숫자를 같이 쓰는데, 나눠 받으면 패널이 열릴 때마다 왕복이 두 번 난다. 반환 행은
  // 클릭 수가 아니라 **연인원**에 비례하므로 상한이 낮다.
  const grouped = links.length
    ? await prisma.linkClick.groupBy({
        by: ["code", "visitorHash"],
        where: { code: { in: links.map((l) => l.code) }, isBot: false },
        _count: { _all: true },
      })
    : [];

  const tally = new Map<string, { clicks: number; visitors: number }>();
  for (const row of grouped) {
    const bucket = tally.get(row.code) ?? { clicks: 0, visitors: 0 };
    bucket.clicks += row._count._all;
    bucket.visitors += 1;
    tally.set(row.code, bucket);
  }

  return NextResponse.json(
    links.map((link) => ({
      ...link,
      shortUrl: buildShortUrl(link.code),
      clickCount: tally.get(link.code)?.clicks ?? 0,
      // 하루를 넘는 구간이라 **연인원**이다(visitorHash 에 KST 날짜가 섞여 있다).
      visitDays: tally.get(link.code)?.visitors ?? 0,
    })),
  );
}
