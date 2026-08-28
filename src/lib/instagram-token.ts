// F5 IG 장기토큰 자동 갱신 (GROWTH_FLYWHEEL_PLAN.md §F5)
//
// 배경: INSTAGRAM_ACCESS_TOKEN(FB 장기 사용자 토큰, 60일)이 Vercel env에 고정돼 있어
// 만료(~2026-09-04) 시 Tier0 무료 수집이 통째로 유료 폴백(Apify)된다. 서버는 자기 env를
// 갱신할 수 없으므로, 주간 크론이 fb_exchange_token으로 새 60일 토큰을 받아 SystemSettings
// (DB)에 영속화한다. 각 수집 진입점은 applyDbInstagramToken()으로 프로세스 env를 DB 값으로
// 덮어써서, env를 직접 읽는 하위 코드(graphScraper·collectors)가 수정 없이 최신 토큰을 쓴다.
// env는 최초 시드이자 DB 부재 시 폴백. 갱신 실패는 lastError로 기록한다(무음 실패 금지).

import { getPrisma } from "@/lib/prisma";

const GRAPH_VERSION = "v23.0";

export type ApplyTokenResult = {
  source: "db" | "env" | "none";
  expiresAt: string | null;
};

/**
 * DB에 갱신된 토큰이 있으면 현재 프로세스의 INSTAGRAM_ACCESS_TOKEN을 덮어쓴다.
 * 수집 진입점(크론·채널조회·분석 워터폴) 최상단에서 1회 호출.
 */
export async function applyDbInstagramToken(): Promise<ApplyTokenResult> {
  try {
    const settings = await getPrisma().systemSettings.findUnique({ where: { id: "global" } });
    if (settings?.instagramAccessToken) {
      process.env.INSTAGRAM_ACCESS_TOKEN = settings.instagramAccessToken;
      return {
        source: "db",
        expiresAt: settings.instagramTokenExpiresAt?.toISOString() ?? null,
      };
    }
  } catch (e) {
    // DB 미가용이어도 수집은 env 토큰으로 계속 — 사유는 남긴다
    console.warn(
      "[instagram-token] DB 토큰 조회 실패 — env 폴백:",
      e instanceof Error ? e.message : e
    );
  }
  return { source: process.env.INSTAGRAM_ACCESS_TOKEN ? "env" : "none", expiresAt: null };
}

export type RefreshTokenResult =
  | { ok: true; expiresAt: string | null; neverExpires: boolean; source: "db" | "env" }
  | { ok: false; error: string };

async function recordError(message: string, now: Date): Promise<void> {
  try {
    await getPrisma().systemSettings.upsert({
      where: { id: "global" },
      create: { id: "global", instagramTokenLastError: `${now.toISOString()} ${message}` },
      update: { instagramTokenLastError: `${now.toISOString()} ${message}` },
    });
  } catch (e) {
    console.error("[instagram-token] lastError 기록도 실패:", e instanceof Error ? e.message : e);
  }
}

/**
 * fb_exchange_token으로 새 장기 토큰을 발급받아 DB에 영속화한다.
 * 장기 토큰은 발급 24시간 후부터 재교환 가능하며 매번 60일 유효기간이 리셋된다.
 * 시스템유저 무기한 토큰이면 debug_token의 expires_at=0 → neverExpires로 표기만 한다.
 */
export async function refreshInstagramToken(now = new Date()): Promise<RefreshTokenResult> {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!appId || !appSecret) {
    const error = "INSTAGRAM_APP_ID/INSTAGRAM_APP_SECRET 미설정: 토큰 교환 불가";
    await recordError(error, now);
    return { ok: false, error };
  }

  const prisma = getPrisma();
  const settings = await prisma.systemSettings
    .findUnique({ where: { id: "global" } })
    .catch(() => null);
  const currentToken = settings?.instagramAccessToken || process.env.INSTAGRAM_ACCESS_TOKEN;
  const source: "db" | "env" = settings?.instagramAccessToken ? "db" : "env";
  if (!currentToken) {
    const error = "현재 토큰 없음(DB·env 모두 부재): 소유자가 최초 토큰을 env에 시드해야 함";
    await recordError(error, now);
    return { ok: false, error };
  }

  // 1) 장기 토큰 재교환 — 성공 시 새 60일 토큰
  const exchangeUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token` +
    `?grant_type=fb_exchange_token&client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&fb_exchange_token=${encodeURIComponent(currentToken)}`;

  let newToken: string;
  try {
    const res = await fetch(exchangeUrl);
    const body = await res.json();
    if (!res.ok || !body.access_token) {
      const detail = body?.error?.message ?? `HTTP ${res.status}`;
      const error = `토큰 교환 실패: ${detail}`;
      await recordError(error, now);
      return { ok: false, error };
    }
    newToken = String(body.access_token);
  } catch (e) {
    const error = `토큰 교환 요청 실패: ${e instanceof Error ? e.message : String(e)}`;
    await recordError(error, now);
    return { ok: false, error };
  }

  // 2) debug_token으로 실제 만료 시각 확인 (expires_at=0 → 무기한)
  let expiresAt: Date | null = null;
  let neverExpires = false;
  try {
    const debugUrl =
      `https://graph.facebook.com/${GRAPH_VERSION}/debug_token` +
      `?input_token=${encodeURIComponent(newToken)}` +
      `&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`;
    const res = await fetch(debugUrl);
    const body = await res.json();
    const epoch = body?.data?.expires_at;
    if (typeof epoch === "number") {
      if (epoch === 0) neverExpires = true;
      else expiresAt = new Date(epoch * 1000);
    }
  } catch (e) {
    // 만료 시각 확인 실패는 치명적이지 않음 — 토큰 저장은 진행하되 기록
    console.warn(
      "[instagram-token] debug_token 조회 실패 — 만료 시각 미기록:",
      e instanceof Error ? e.message : e
    );
  }

  await prisma.systemSettings.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      instagramAccessToken: newToken,
      instagramTokenExpiresAt: expiresAt,
      instagramTokenRefreshedAt: now,
      instagramTokenLastError: null,
    },
    update: {
      instagramAccessToken: newToken,
      instagramTokenExpiresAt: expiresAt,
      instagramTokenRefreshedAt: now,
      instagramTokenLastError: null,
    },
  });

  // 이번 프로세스의 후속 작업도 즉시 새 토큰 사용
  process.env.INSTAGRAM_ACCESS_TOKEN = newToken;

  return { ok: true, expiresAt: expiresAt?.toISOString() ?? null, neverExpires, source };
}
