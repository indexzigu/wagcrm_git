import { getPrisma } from "@/lib/prisma";

export const NAVER_APIFY_PROVIDER = "NAVER";
export const NAVER_APIFY_SCOPE = "apify_naver_price_scraper";
export const NAVER_APIFY_ENDPOINT_LABEL =
  "POST /v2/actors/topapi~naver-shopping-scraper/runs";

export type NaverApifyCallUsage = {
  statusCode: number;
  ok: boolean;
  durationMs: number;
  errorMessage: string | null;
};

function sanitizeErrorMessage(value: string | null): string | null {
  if (!value) return null;
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|api[_-]?key|secret)=)[^&\s]+/gi, "$1[REDACTED]");
}

export async function recordNaverApifyUsage(usage: NaverApifyCallUsage): Promise<boolean> {
  try {
    await getPrisma().apiCallLog.create({
      data: {
        provider: NAVER_APIFY_PROVIDER,
        permissionScope: NAVER_APIFY_SCOPE,
        endpoint: NAVER_APIFY_ENDPOINT_LABEL,
        statusCode: usage.statusCode,
        success: usage.ok,
        errorMessage: sanitizeErrorMessage(usage.errorMessage),
        metadata: JSON.stringify({ durationMs: usage.durationMs }),
      },
    });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    console.error("[naver-apify] ApiCallLog 계측 기록 실패:", sanitizeErrorMessage(detail));
    return false;
  }
}
