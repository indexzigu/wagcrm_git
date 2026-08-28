import { connection, NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";

// 시스템 레이더 클릭 인박스용 — 특정 크론(jobKey)의 최근 실행 이력(SystemTaskLog)을 최신순으로
// 반환한다. 대부분의 크론은 withSystemTaskStatus 래퍼가 종결 상태를 append하므로 앞으로 누적되고,
// enrich-inbox는 자체적으로 details까지 남긴다. 기록이 없는 크론은 빈 배열 → 카드가 "아직 기록된
// 실행 로그가 없습니다"로 표시한다. 읽기 전용이라 jobKey는 Prisma 파라미터로만 쓰인다(주입 여지 없음).
export async function GET(request: Request) {
  await connection();
  try {
    const { searchParams } = new URL(request.url);
    const jobKey = searchParams.get("jobKey");
    if (!jobKey) {
      return NextResponse.json({ success: false, error: "jobKey가 필요합니다." }, { status: 400 });
    }

    const prisma = getPrisma();
    const logs = await prisma.systemTaskLog.findMany({
      where: { jobKey },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        message: true,
        details: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ success: true, data: logs });
  } catch (error) {
    console.error("[SystemTaskLogAPI] Error fetching logs:", error);
    return NextResponse.json({ success: false, error: "Internal Server Error" }, { status: 500 });
  }
}
