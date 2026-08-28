/**
 * Apify 댓글 수집 지출 월별 리포트 — **읽기 전용**(findMany 만 한다. 쓰기·삭제 없음).
 *
 * 오너용 한 줄 질문의 답: "이번 달 Apify 지출이 무료 크레딧을 넘었나."
 * 판정선은 **계정(토큰)당 월 $5** 다 — 크레딧은 계정 간에 이동하지 않으므로 풀 합계만
 * 보면 오판한다. 그래서 토큰 지문별로 쪼개 보여준다.
 *
 * 실행:
 *   npm run report:apify-comments            # 최근 3개월(KST)
 *   npm run report:apify-comments -- 6       # 최근 6개월
 *   npm run report:apify-comments -- 3 --json
 *
 * ⚠️ 레포 `.env` 의 DATABASE_URL 은 **프로덕션 DB** 다(P0). 이 스크립트는 조회만 하지만
 *    실행 자체가 프로덕션 접속이라는 점을 인지하고 쓸 것.
 * ⚠️ 토큰 **값**은 출력하지 않는다 — 풀 인덱스와 비가역 지문(sha256 앞 6자)만 찍는다.
 */
import "dotenv/config";
import { getPrisma } from "../src/lib/prisma";
import {
  APIFY_COMMENT_SCOPE,
  APIFY_FREE_CREDIT_USD_PER_MONTH,
  describeApifyToken,
} from "../src/lib/seller-analysis/apify-comment-usage";
import {
  formatMonthlyReport,
  kstMonthStartUtc,
  summarizeCommentUsageByMonth,
} from "../src/lib/seller-analysis/apify-comment-usage-report";

/**
 * 현재 토큰 풀의 지문 → 풀 인덱스. **값은 절대 담지 않는다.**
 * env 에 토큰이 하나도 없으면 `null`(= 풀 미상)을 준다 — 빈 Map 을 주면 리포트가
 * 모든 계정을 '교체된 토큰'으로 오표기한다(.env 를 안 읽고 돌린 실행에서 발생).
 */
function buildTokenIndex(): Map<string, number> | null {
  const raw = [
    ...(process.env.APIFY_API_TOKENS ?? "").split(","),
    process.env.APIFY_API_TOKEN ?? "",
  ]
    .map((t) => t.trim())
    .filter(Boolean);
  if (raw.length === 0) return null;

  const index = new Map<string, number>();
  let n = 0;
  for (const token of raw) {
    const fp = describeApifyToken(token);
    if (!fp || index.has(fp)) continue;
    index.set(fp, ++n);
  }
  return index;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const monthsBack = Math.max(0, Number(args.find((a) => /^\d+$/.test(a)) ?? 3) - 1);

  const prisma = getPrisma();
  const since = kstMonthStartUtc(new Date(), monthsBack);

  // permissionScope + calledAt = ApiCallLog 의 기존 복합 인덱스를 그대로 탄다.
  const rows = await prisma.apiCallLog.findMany({
    where: { permissionScope: APIFY_COMMENT_SCOPE, calledAt: { gte: since } },
    select: { calledAt: true, success: true, statusCode: true, errorMessage: true, metadata: true },
    orderBy: { calledAt: "desc" },
  });

  const summaries = summarizeCommentUsageByMonth(rows);

  if (asJson) {
    console.log(JSON.stringify({ since: since.toISOString(), rows: rows.length, summaries }, null, 2));
    return;
  }

  console.log("Apify 댓글 수집 지출 리포트 (KST 월별)");
  console.log(`조회 창: ${since.toISOString()} 이후 · 원본 ${rows.length}행\n`);

  if (summaries.length === 0) {
    console.log("기록 없음 — 이 창에서 댓글 수집 호출이 없었거나, 계측 배포 이전 기간이다.");
    return;
  }
  const tokenIndex = buildTokenIndex();
  if (!tokenIndex) {
    console.log("ℹ️ APIFY_API_TOKENS 미로드 — 계정 번호(#N) 대신 지문만 표시한다.\n");
  }
  for (const summary of summaries) {
    console.log(formatMonthlyReport(summary, tokenIndex, APIFY_FREE_CREDIT_USD_PER_MONTH));
    console.log("");
  }
}

main()
  .catch((err) => {
    console.error("리포트 실패:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
