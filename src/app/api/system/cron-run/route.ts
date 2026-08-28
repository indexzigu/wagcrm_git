import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveAccess } from "@/lib/auth-allowlist";
import { KNOWN_JOB_KEYS } from "@/lib/cron-jobs";

// 수동 재실행도 크론 본체와 같은 상한을 갖는다(collect-instagram 등 장시간 잡을 끝까지 대기).
export const maxDuration = 300;

// 허용 목록은 레이더 표시 목록(cron-jobs.ts SSOT)에서 파생 — 별도 사본을 들고 있다가
// collect-qnas·analyze-voc 추가 때 여기만 빠져 버튼이 400으로 죽은 드리프트의 재발 방지.
const ALLOWED_JOBS = KNOWN_JOB_KEYS;

export async function POST(request: Request) {
  // 미들웨어 세션 게이트에 더한 라우트 내 2차 방어 — 이 라우트는 서버가 CRON_SECRET을 대신
  // 행사하는 특권 경로라, 미들웨어 제외 목록 실수 한 번에 공개되면 안 된다.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // 종전 판정은 `isEmailAllowed`(env 허가목록에 있는가)였다. 그 env 가 사라지면서
  // 판정을 `resolveAccess` 로 옮기고, 이 특권 경로가 요구하는 것을 **admin 으로 명시**한다 —
  // 미들웨어도 `/api/system/*` 을 operator 화이트리스트 밖으로 이미 끊으므로, 2차 방어가
  // 1차 방어와 같은 기준을 갖게 되는 것이지 느슨해지는 것이 아니다.
  const access = user ? resolveAccess(user.app_metadata, user.email) : null;
  if (!access?.approved || access.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let jobKey: unknown;
  try {
    ({ jobKey } = (await request.json()) as { jobKey?: unknown });
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문" }, { status: 400 });
  }
  if (typeof jobKey !== "string" || !ALLOWED_JOBS.has(jobKey)) {
    return NextResponse.json({ error: "알 수 없는 jobKey" }, { status: 400 });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET 미설정" }, { status: 503 });
  }

  // 같은 배포 호스트의 크론 엔드포인트를 서버 측에서 호출 — 시크릿은 클라이언트로 나가지 않는다.
  // jobKey는 위 화이트리스트로 고정되므로 경로 주입 여지가 없다.
  const target = new URL(`/api/cron/${jobKey}`, request.url);
  try {
    const res = await fetch(target, {
      headers: { authorization: `Bearer ${secret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(290_000),
    });
    const body = await res.json().catch(() => null);
    return NextResponse.json(
      { ok: res.ok, status: res.status, result: body },
      { status: res.ok ? 200 : 502 },
    );
  } catch (error) {
    console.error(`[system/cron-run] ${jobKey} 수동 실행 실패:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "실행 실패" },
      { status: 502 },
    );
  }
}
