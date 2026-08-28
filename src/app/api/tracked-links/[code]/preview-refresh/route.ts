import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { collectOgSnapshot } from "@/lib/og-snapshot";
import { getPrisma } from "@/lib/prisma";

/**
 * POST /api/tracked-links/{code}/preview-refresh
 * — 목적지 OG 를 다시 읽어 `TrackedLink` 스냅샷을 채운다.
 *
 * ⚠️ **형제 발급 라우트와 달리 `after()` 가 아니라 await 한다.**
 * 2026-07-30 규약이 막는 것은 ①도메인 서비스 안의 fetch ②성공 여부가 응답과
 * 무관한 IO 다. 여기서는 fetch 가 라우트에만 있고(도메인 서비스 무변경),
 * "목적지를 다시 읽었나"가 곧 운영자가 알아야 할 답이다 — 미루면 스냅샷이
 * null 인 채 아무도 모르는 무증상 열화가 된다. 게다가 호출부는 이 요청 전에
 * 클립보드 복사를 이미 끝내 두므로 기다림이 아무것도 막지 않는다.
 *
 * ⛔ `TrackedLink` 의 writer 는 wag-crm 하나다(스키마 단일 writer 규약) —
 * Worker 는 읽기만 하고 자기 Cache API 에만 담는다.
 */
export const maxDuration = 60;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { code } = await params;
  const prisma = getPrisma();

  const link = await prisma.trackedLink.findUnique({
    where: { code },
    select: { id: true, targetUrl: true },
  });
  if (!link) {
    return NextResponse.json({ error: "링크를 찾을 수 없습니다." }, { status: 404 });
  }

  const snapshot = await collectOgSnapshot(link.targetUrl);
  // ⛔ 건질 게 없으면 쓰지 않는다 — 빈 스냅샷을 저장하면 ogFetchedAt 만 찍혀
  // 리다이렉터의 폴백 수집까지 24시간 막힌다(발급 훅과 같은 계약).
  if (!snapshot) {
    return NextResponse.json({ refreshed: false });
  }

  const updated = await prisma.trackedLink.update({
    where: { id: link.id },
    data: {
      ogTitle: snapshot.title,
      ogImage: snapshot.image,
      ogDescription: snapshot.description,
      ogFetchedAt: new Date(),
    },
    select: { ogTitle: true, ogImage: true, ogFetchedAt: true },
  });

  return NextResponse.json({ refreshed: true, ...updated });
}
