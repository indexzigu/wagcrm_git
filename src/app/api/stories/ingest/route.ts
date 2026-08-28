import { NextResponse } from "next/server";
import { verifyIngestAuth } from "@/lib/kakao/ingest-auth";
import { ingestLaneGuard } from "@/lib/kakao/ingest-lane";
import { getPrisma } from "@/lib/prisma";
import { normalizeHandle, parseStoryItems, storeStorySnapshots, type StoryCaptureResult } from "@/lib/story-capture";

// 스토리 원시 items 인제스트 — 브라우저 없는 경로(로컬 러너·북마클릿)가 뷰어에서 긁은 스토리를
// 밀어넣는 입구. 서버는 브라우저를 안 띄우고 파싱+리호스팅+저장만 한다(Vercel 자동 경로가 IP
// 차단으로 막힐 때의 보조). 인증=INGEST_TOKEN(Bearer, verifyIngestAuth 공용).
export const maxDuration = 120;

export async function POST(request: Request) {
  if (!verifyIngestAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 레인 게이트 — 인제스트 계열(INGEST_TOKEN) 라우트 전원이 부른다. 이 라우트의 호출자는
  // 세션을 가진 북마클릿이라 2026-08-26 오배송 사고와 부류가 다르지만, 예외를 두면 다음
  // 라우트가 거기 숨는다. 선언하지 않는 호출자에게는 무동작이라 동작 변화가 없다.
  const lane = ingestLaneGuard(request);
  if (lane.rejection) return lane.rejection;

  let body: { handle?: unknown; items?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const handle = typeof body.handle === "string" ? normalizeHandle(body.handle) : "";
  if (!handle) return NextResponse.json({ error: "handle 필요" }, { status: 400 });
  if (!Array.isArray(body.items)) return NextResponse.json({ error: "items 배열 필요" }, { status: 400 });

  const prisma = getPrisma();
  // 핸들 → 셀러. 대소문자·@ 무관 매칭.
  const seller = await prisma.seller.findFirst({
    where: { snsHandle: { equals: handle, mode: "insensitive" } },
    select: { id: true },
  });
  if (!seller) {
    return NextResponse.json({ error: `해당 핸들의 셀러 없음: ${handle}` }, { status: 404 });
  }

  const stories = parseStoryItems(body.items);
  const result: StoryCaptureResult = {
    activeSellers: 1,
    handles: [handle],
    storiesSeen: stories.length,
    storiesNew: 0,
    thumbnailsRehosted: 0,
    // 이 경로는 뷰어 조회를 하지 않는다(호출자가 items를 실어 보낸다) — 조회 실패 개념 자체가 없다.
    handlesFailed: 0,
    errors: [],
  };
  await storeStorySnapshots(prisma, seller.id, handle, stories, result);

  return NextResponse.json({ ...lane.envelope, ok: true, ...result });
}
