import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { toCampaignRow } from "@/lib/campaign-row";
import { requireAuth } from "@/lib/api-auth";
import { loadTaxInvoiceAutoConfirmed, loadTaxInvoiceWorkBoard } from "@/lib/tax-invoice-board-data";
import { isSupplierInvoiceLabel, isSellerInvoiceLabel } from "@/lib/campaign-checklist";
import { buildWithholdingReport, isValidReportMonth, withholdingDueDate, simplifiedStatementDueDate } from "@/lib/withholding-report";
import { computeWithholdingFilingSummary, type TaxFilingKind } from "@/lib/tax-filing-log";

/**
 * 세금계산서·원천징수 두 탭을 한 응답으로 서빙한다 — **시간 축이 서로 다르다.**
 * 세금계산서는 캠페인 상태 축(월 무관, `buildTaxInvoiceWorkBoard`)이고, 원천징수는
 * 지급월 축(`buildWithholdingReport`, `month` 쿼리 파라미터)이다. 행마다 대응하는
 * 체크리스트 항목 id 를 붙여 UI 의 「완료」가 기존
 * `PATCH /api/campaign-checklist/items/[itemId]` 를 그대로 타게 한다 — 날짜 필드만
 * 직접 세팅하는 경로를 새로 만들면 체크리스트와 이중 SSOT 가 된다.
 */
export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!isValidReportMonth(month)) {
    return NextResponse.json({ error: "month 는 YYYY-MM 형식이어야 합니다." }, { status: 400 });
  }

  // withholding 라우트와 같은 월 경계 관용구 — payoutCompletedAt 은 KST 문자열로
  // 비교되므로 이 range 는 KST 월의 정확한 [시작, 다음달 시작) 경계이고, 최종 판정
  // (개인 셀러 제외 등)은 buildWithholdingReport 의 startsWith(month) 가 한다.
  const monthStart = new Date(`${month}-01T00:00:00+09:00`);
  const [y, m] = month.split("-").map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const monthEnd = new Date(`${nextMonth}-01T00:00:00+09:00`);
  const dateRange = { gte: monthStart, lt: monthEnd };

  const prisma = getPrisma();

  // 원천징수 축의 include. ⛔ where 는 세금계산서 축과 **절대 공유하지 않는다** — 공유가
  // 2026-08-09 버그의 원인이었다(설계 §2). 세금계산서 축은 보드가 쓰는 칸만 읽는 자기 include 를
  // `@/lib/tax-invoice-board-data` 에 두고, 봇의 읽기 동작(`get_tax_invoice_status`)과 공유한다.
  const CAMPAIGN_INCLUDE = {
    deal: { include: { partner: true } },
    campaignDeals: { include: { deal: true } },
    seller: {
      include: {
        agency: { include: { contacts: { take: 1, orderBy: { createdAt: "asc" as const } } } },
        histories: { orderBy: { snapshotDate: "asc" as const }, take: 1 },
      },
    },
    group: true,
    // ⛔ 빼면 부가 항목이 있어도 보드 금액이 안 움직이고 **오류도 안 난다**
    //    (설계 §9-6-3 — 2-A 에서 가장 조용한 실패 지점). 오너는 보드 숫자를
    //    홈택스에 손으로 옮기므로 그대로 오신고가 된다. 정렬은 `campaignService`
    //    의 select 와 동일하게 맞춘다.
    settlementItems: { orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] },
  };

  // ① 세금계산서 — 캠페인 상태 축(월 무관). 정산 사정권 상태만 읽어 보드를 만든다 — 쿼리·
  //    월정산 진행·보드 판정은 `loadTaxInvoiceWorkBoard` 하나가 소유한다(봇 조회와 같은 함수).
  //    ⚠️ 보드가 다루는 캠페인 집합(`campaignRows`)은 자동 확정 표시의 모집단이기도 하다 —
  //    자동 확정 표시가 보드와 다른 모집단을 보면 오너가 「기계가 건드린 범위」를 잘못 읽는다.
  const { campaignRows, board } = await loadTaxInvoiceWorkBoard(prisma, month);

  // ② 원천징수 — 지급월 축(현행 그대로). ⛔ 이 where 를 위 쿼리와 합치지 말 것:
  //    상태 필터에 종속되면 법정 신고 자료에서 캠페인이 조용히 빠진다.
  const withholdingCampaigns = await prisma.salesCampaign.findMany({
    where: {
      OR: [{ payoutCompletedAt: dateRange }, { group: { payoutCompletedAt: dateRange } }],
    },
    include: CAMPAIGN_INCLUDE,
  });

  const withholdingRows = withholdingCampaigns.map((campaign) => toCampaignRow(campaign));

  // 진입점 배지는 세금계산서뿐 아니라 원천징수 3절차의 미처리도 함께 세야 한다 —
  // 지급월 원천세 신고를 놓치는 것도 이 배지가 잡아야 할 대상이다(설계 문서 「B. 정산
  // 페이지」절). 지급월 축으로 다시 조회한 캠페인을 그대로 순수 함수에 넘긴다.
  const withholdingReport = buildWithholdingReport(withholdingRows, month);
  const filingLogs = await prisma.taxFilingLog.findMany({ where: { month } });
  const completedKinds = new Set(filingLogs.map((log) => log.kind as TaxFilingKind));
  const withholdingSummary = computeWithholdingFilingSummary(withholdingReport.rows.length > 0, completedKinds, {
    WITHHOLDING_RETURN: withholdingDueDate(month),
    LOCAL_INCOME_TAX: withholdingDueDate(month),
    SIMPLIFIED_STATEMENT: simplifiedStatementDueDate(month),
  });

  // 지급완료로 표시됐지만 지급일이 기록되지 않은 캠페인은 어느 월에도 잡히지 않는다
  // — withholding 리포트와 같은 안전망(경고로 드러냄, 개수만·월 무관 전수).
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
    board.warnings.push(
      `지급완료로 표시됐지만 지급일이 기록되지 않은 캠페인 ${undatedCount}건: ` +
        `원천징수 신고 집계(지급월 기준)에 포함되지 않습니다. 정산 화면에서 지급일을 입력하세요.`,
    );
  }

  // 개별 지급완료 처리된 캠페인이 나중에 정산 그룹으로 묶이면, 그룹 지급일(null)이
  // 개별 지급일을 가려(toCampaignRow 의 그룹 우선 폴딩) 어느 월에도 잡히지 않는다
  // — withholding 리포트와 같은 이유로 별도 경고를 남긴다.
  const groupMaskedCount = await prisma.salesCampaign.count({
    where: {
      payoutCompletedAt: { not: null },
      group: { is: { payoutCompletedAt: null } },
    },
  });
  if (groupMaskedCount > 0) {
    board.warnings.push(
      `개별 지급일이 있지만 정산 그룹에 묶이며 가려진 캠페인 ${groupMaskedCount}건: ` +
        `그룹 지급일이 입력되기 전까지 원천징수 신고 집계에 포함되지 않습니다. ` +
        `그룹 정산을 완료 처리하거나 그룹에서 분리하세요.`,
    );
  }

  // 보드에 남은 캠페인의 체크리스트 항목만 조회한다(스칼라 컬럼 필터 — P7: groupBy·
  // 집계 쿼리에 관계 필터를 쓰면 에러 없이 0건이 나온다). 그룹 행은 campaignId(대표
  // 멤버) 하나가 아니라 campaignIds(멤버 전원)에 걸쳐 조회해야 한다 — 대표만 조회하면
  // 정상 동작하지만, 대표의 체크리스트가 어떤 이유로든 아직 없는 예외 상황에서 그룹
  // 행 전체가 완료 버튼을 잃는 사고를 막는 여유분이다.
  const campaignIds = [...new Set(board.rows.flatMap((row) => row.campaignIds))];
  const items = campaignIds.length
    ? await prisma.campaignChecklistItem.findMany({
        where: { campaignId: { in: campaignIds }, status: "SETTLEMENT_IN_PROGRESS" },
        select: { id: true, campaignId: true, label: true },
      })
    : [];

  // 체크리스트 라벨(공급사용/셀러용) 판정은 row.sourceField 를 그대로 쓴다 —
  // `counterpart`·`direction`으로 라벨 조건을 다시 유도하던 옛 코드는
  // `TAX_INVOICE_OBLIGATION_TABLE`(2번째 인코딩)에 이미 있는 사실을 세 번째로
  // 다시 인코딩한 것이었고, 미래에 RECEIVE·SELLER 조합이 supplierInvoiceIssuedAt
  // 에서 나오는 의무가 생기면 조용히 틀릴 수 있었다(2026-08-04 재검토 지적).
  // sourceField 는 tax-filing-board.ts 가 테이블을 순회하며 이미 알던 값을 그대로
  // 실어 온 것이라 이 라우트는 더는 규칙을 재해석하지 않는다.
  const rows = board.rows.map((row) => {
    const matchesLabel =
      row.sourceField === "sellerInvoiceIssuedAt" ? isSellerInvoiceLabel : isSupplierInvoiceLabel;
    const match = items.find(
      (item) => row.campaignIds.includes(item.campaignId) && matchesLabel(item.label),
    );
    // 월정산 공급사 행에는 「완료」(체크리스트로 날짜 찍기)를 주지 않는다 — 그 경로는 서버가
    // 거절하고(`MonthlyInvoiceManagedError`), 화면은 달별 계산서 창을 연다(T-244).
    return { ...row, checklistItemId: row.monthlyInvoice ? null : (match?.id ?? null) };
  });

  // 발행 자동 확정 크론이 보드 대상 캠페인에 찍은 건. 찍힌 순간 그 의무는 보드 행에서
  // 사라지므로(`tax-filing-board.ts`의 "이미 처리됨 — 행을 만들지 않는다"), 이 목록이
  // 없으면 오너는 **기계가 확정한 건을 자기가 확인한 건과 구분할 수 없다.**
  // 조회 축(보드와 같은 캠페인 집합)·기간 컷(`AUTO_CONFIRM_SEED_LOOKBACK_DAYS`)·두 단계 조회·
  // type 접두사 규칙은 `loadTaxInvoiceAutoConfirmed` 주석에 있다 — 화면도 그 창을 문구로 밝힌다.
  const autoConfirmed = await loadTaxInvoiceAutoConfirmed(prisma, campaignRows, new Date());

  return NextResponse.json({
    ...board,
    rows,
    autoConfirmed,
    // 세금계산서 pendingCount 는 그대로 두고(순수 함수 계약 · 기존 테스트가 이를
    // 고정한다), 원천징수 미처리는 별도 필드로 얹는다 — 배지는 두 값을 더해 쓴다.
    withholdingPendingCount: withholdingSummary.pendingCount,
    withholdingNextDueDate: withholdingSummary.nextDueDate,
  });
}
