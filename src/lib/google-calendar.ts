import { getPrisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "./asset-storage";
import { parseStoredJsonObject } from "./stored-json";

export const GOOGLE_CALENDAR_PROVIDER = "GOOGLE_CALENDAR";

// 캘린더 ID 는 이메일 형태다(`primary` 별칭 제외 — 그건 저장할 값이 아니라 미설정의 의미다).
const CALENDAR_ID_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;

export function isValidCalendarId(value: string): boolean {
  return value.length <= 320 && CALENDAR_ID_PATTERN.test(value);
}

/**
 * 회계·정산 일정(입금/출금 이벤트)을 분리 수용하는 캘린더 ID.
 * StorageIntegration(GOOGLE_CALENDAR).metadata JSON 의 `financeCalendarId` 에 저장한다.
 * 미설정(null)이면 종전대로 모든 이벤트가 primary 로 간다 — 안전한 폴백.
 */
export async function getFinanceCalendarId(): Promise<string | null> {
  const prisma = getPrisma();
  const integration = await prisma.storageIntegration.findUnique({
    where: { provider: GOOGLE_CALENDAR_PROVIDER },
    select: { metadata: true },
  });
  const metadata = parseStoredJsonObject(integration?.metadata);
  const value = metadata.financeCalendarId;
  return typeof value === "string" && isValidCalendarId(value) ? value : null;
}

/** 회계·정산 캘린더 ID 저장(null = 해제). 기존 metadata 의 다른 키는 보존한다. */
export async function setFinanceCalendarId(value: string | null): Promise<void> {
  const prisma = getPrisma();
  const integration = await prisma.storageIntegration.findUnique({
    where: { provider: GOOGLE_CALENDAR_PROVIDER },
    select: { metadata: true },
  });
  const metadata = parseStoredJsonObject(integration?.metadata);
  if (value === null) delete metadata.financeCalendarId;
  else metadata.financeCalendarId = value;
  const serialized = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
  await prisma.storageIntegration.upsert({
    where: { provider: GOOGLE_CALENDAR_PROVIDER },
    update: { metadata: serialized },
    create: {
      provider: GOOGLE_CALENDAR_PROVIDER,
      status: "DISCONNECTED",
      metadata: serialized,
    },
  });
}

function calendarConfig() {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID ?? null;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? null;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const redirectUri = `${appUrl}/api/integrations/google-calendar/callback`;
  return { clientId, clientSecret, redirectUri };
}

export function buildGoogleCalendarAuthUrl() {
  const config = calendarConfig();
  if (!config.clientId) throw new Error("GOOGLE_DRIVE_CLIENT_ID is not configured");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/userinfo.email",
    ].join(" "),
  );
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeGoogleCalendarCode(code: string) {
  const config = calendarConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("Google Calendar OAuth env is not configured");
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed: ${response.status}`);
  return (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
}

export async function getGoogleCalendarAccessToken(): Promise<string> {
  const prisma = getPrisma();
  const integration = await prisma.storageIntegration.findUnique({
    where: { provider: GOOGLE_CALENDAR_PROVIDER },
  });
  if (!integration?.encryptedRefreshToken) {
    throw new Error("Google Calendar is not connected");
  }
  const config = calendarConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("Google Calendar OAuth env is not configured");
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: decryptSecret(integration.encryptedRefreshToken),
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    // 상태코드만으로는 처방이 갈리지 않는다 — 구글이 주는 `error` 코드가 진단의 전부다.
    // `invalid_grant`  = 리프레시 토큰 문제(폐기·만료, 또는 다른 OAuth 클라이언트로 발급)
    //                    → 재승인 필요. `invalid_client` = 클라이언트 자격 불일치
    //                    (`GOOGLE_DRIVE_CLIENT_ID/SECRET` 가 토큰 발급 때와 다름) → env 확인.
    // 실사고(2026-07-30): 로컬에서 400 만 보여 둘 중 무엇인지 가리지 못했고, 그 탓에
    // "prod 연동이 깨진 것"과 "로컬 자격 불일치"를 구분하는 데 시간을 썼다.
    // ⛔ 응답 본문에 시크릿이 없음을 전제로 싣는다(구글 토큰 엔드포인트는 error·
    // error_description 만 준다) — 요청 본문(client_secret·refresh_token)은 절대 싣지 않는다.
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string; error_description?: string };
      if (body?.error) {
        detail = ` (${body.error}${body.error_description ? `: ${body.error_description}` : ""})`;
      }
    } catch {
      // 본문이 JSON 이 아니면 상태코드만으로 보고한다
    }
    throw new Error(`Google Calendar token refresh failed: ${response.status}${detail}`);
  }
  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

export async function getGoogleCalendarConnectionStatus() {
  const prisma = getPrisma();
  const integration = await prisma.storageIntegration.findUnique({
    where: { provider: GOOGLE_CALENDAR_PROVIDER },
  });
  const hasConnectionMaterial = Boolean(
    integration?.encryptedRefreshToken || integration?.accountEmail,
  );
  const metadata = parseStoredJsonObject(integration?.metadata);
  const financeCalendarId = metadata.financeCalendarId;
  return {
    connected: integration?.status === "CONNECTED" && hasConnectionMaterial,
    status: integration?.status ?? "DISCONNECTED",
    accountEmail: integration?.accountEmail ?? null,
    lastError: integration?.lastError ?? null,
    financeCalendarId:
      typeof financeCalendarId === "string" && isValidCalendarId(financeCalendarId)
        ? financeCalendarId
        : null,
  };
}

export { encryptSecret };
