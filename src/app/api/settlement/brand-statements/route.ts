import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { scanBrandStatementMails } from "@/lib/tax-invoice-mail/brand-statement-scan";

/**
 * 브랜드 정산서 메일 **조회 전용**(T-242) — 월정산 계산서 창이 「정산서가 예고한 금액」을 미리
 * 보여 주는 데 쓴다. 쓰기는 없다(메일·DB 모두). 캠페인 대조는 화면이 `campaign-invoices.ts` 로 한다.
 * ⛔ 응답에 셀러 실명·매출이 들어 있다 — 오너 전용 화면에서만 쓰고 로그로 남기지 않는다(P0).
 */
export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const url = new URL(request.url);
  const sinceDays = Math.min(365, Math.max(7, Number(url.searchParams.get("sinceDays") ?? 120)));
  try {
    return NextResponse.json(await scanBrandStatementMails({ sinceDays }));
  } catch (error) {
    // 삼키지 않는다 — 실패를 「정산서 없음」으로 보이면 오너가 기대 금액이 없다고 오해한다(P0).
    const message = error instanceof Error ? error.message : "정산서 메일 조회에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
