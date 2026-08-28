import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { toCampaignRow } from "@/lib/campaign-row";
import { requireAuth } from "@/lib/api-auth";
import { buildWithholdingReport, isValidReportMonth } from "@/lib/withholding-report";

/**
 * 원천징수 신고 리포트 — 지급완료일이 해당 월인 개인 셀러 캠페인 집계.
 *
 * 주민등록번호(복호화)가 실리는 응답이다 — 오너 인증 뒤에서만 내려주고,
 * 셀러 포털 등 다른 표면에서 재사용하지 말 것(P0 Seller-Facing Data Exposure).
 */
export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!isValidReportMonth(month)) {
    return NextResponse.json({ error: "month 는 YYYY-MM 형식이어야 합니다." }, { status: 400 });
  }

  // KST 기준 월 경계. payoutCompletedAt 은 KST 로 문자열화되어 비교되므로
  // (toCampaignRow → toKstDateStr) DB 프리필터는 여유 있게 잡고 최종 판정은
  // buildWithholdingReport 의 startsWith(month) 가 한다.
  const monthStart = new Date(`${month}-01T00:00:00+09:00`);
  const [y, m] = month.split("-").map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const monthEnd = new Date(`${nextMonth}-01T00:00:00+09:00`);
  const dateRange = { gte: monthStart, lt: monthEnd };

  const prisma = getPrisma();
  const dbCampaigns = await prisma.salesCampaign.findMany({
    where: {
      OR: [{ payoutCompletedAt: dateRange }, { group: { payoutCompletedAt: dateRange } }],
    },
    include: {
      deal: { include: { partner: true } },
      campaignDeals: { include: { deal: true } },
      seller: {
        include: {
          agency: { include: { contacts: { take: 1, orderBy: { createdAt: "asc" } } } },
          histories: { orderBy: { snapshotDate: "asc" }, take: 1 },
        },
      },
      group: true,
    },
  });

  const report = buildWithholdingReport(
    dbCampaigns.map((campaign) => toCampaignRow(campaign)),
    month,
  );

  // 지급완료로 표시됐지만 지급일이 기록되지 않은 캠페인은 어느 월에도 잡히지 않는다
  // — 조용히 누락되는 대신 경고로 드러낸다(개수만, 월 무관 전수).
  const undatedCount = await prisma.salesCampaign.count({
    where: {
      AND: [
        { OR: [{ isPayoutCompleted: true }, { group: { isPayoutCompleted: true } }] },
        { payoutCompletedAt: null },
        { OR: [{ groupId: null }, { group: { payoutCompletedAt: null } }] },
      ],
    },
  });
  if (undatedCount > 0) {
    report.warnings.push(
      `지급완료로 표시됐지만 지급일이 기록되지 않은 캠페인 ${undatedCount}건: ` +
        `월별 집계에 포함되지 않습니다. 정산 화면에서 지급일을 입력하세요.`,
    );
  }

  // 개별 지급완료 처리된 캠페인이 나중에 정산 그룹으로 묶이면, 그룹 지급일(null)이
  // 개별 지급일을 가려(toCampaignRow 의 그룹 우선 폴딩) 어느 월에도 잡히지 않는다.
  // 위 undated 쿼리는 캠페인 자체 필드가 null 인 경우만 보므로 이 경로를 못 잡는다
  // — 별도 경고로 드러낸다 (code-reviewer MEDIUM, 2026-07-23).
  const groupMaskedCount = await prisma.salesCampaign.count({
    where: {
      payoutCompletedAt: { not: null },
      group: { is: { payoutCompletedAt: null } },
    },
  });
  if (groupMaskedCount > 0) {
    report.warnings.push(
      `개별 지급일이 있지만 정산 그룹에 묶이며 가려진 캠페인 ${groupMaskedCount}건: ` +
        `그룹 지급일이 입력되기 전까지 월별 집계에 포함되지 않습니다. ` +
        `그룹 정산을 완료 처리하거나 그룹에서 분리하세요.`,
    );
  }

  return NextResponse.json(report);
}
