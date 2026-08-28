import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { toCampaignRow } from "@/lib/campaign-row";
import { requireAuth } from "@/lib/api-auth";
import { buildTaxInvoiceWorkBoard } from "@/lib/tax-filing-board";
import {
  isSupplierInvoiceLabel,
  isSellerInvoiceLabel,
  WORKSPACE_STATUS_GROUPS,
} from "@/lib/campaign-checklist";
import { buildWithholdingReport, isValidReportMonth, withholdingDueDate, simplifiedStatementDueDate } from "@/lib/withholding-report";
import { computeWithholdingFilingSummary, type TaxFilingKind } from "@/lib/tax-filing-log";
import {
  AUTO_CONFIRM_SEED_LOOKBACK_DAYS,
  buildAutoConfirmedEntries,
  TAX_INVOICE_AUTO_CONFIRM_TYPE_PREFIX,
} from "@/lib/tax-filing-auto-confirm";

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

  // 두 축이 같은 include 를 쓰되 **where 는 절대 공유하지 않는다** — 공유가 이번 버그의
  // 원인이었다(설계 2026-08-09 §2).
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

  // ① 세금계산서 — 캠페인 상태 축(월 무관).
  //    정산 사정권에 든 상태만 본다. 그 이전 단계는 매출·정산금이 아직 없어 전부 결번으로
  //    나오므로 넣으면 목록이 결번으로 뒤덮인다.
  const invoiceCampaigns = await prisma.salesCampaign.findMany({
    where: { status: { in: [...WORKSPACE_STATUS_GROUPS.settlement] } },
    include: CAMPAIGN_INCLUDE,
  });

  // ② 원천징수 — 지급월 축(현행 그대로). ⛔ 이 where 를 위 쿼리와 합치지 말 것:
  //    상태 필터에 종속되면 법정 신고 자료에서 캠페인이 조용히 빠진다.
  const withholdingCampaigns = await prisma.salesCampaign.findMany({
    where: {
      OR: [{ payoutCompletedAt: dateRange }, { group: { payoutCompletedAt: dateRange } }],
    },
    include: CAMPAIGN_INCLUDE,
  });

  const campaignRows = invoiceCampaigns.map((campaign) => toCampaignRow(campaign));
  const withholdingRows = withholdingCampaigns.map((campaign) => toCampaignRow(campaign));
  // ⚠️ 이름을 바꿨다 — 이제 「이 달」이 아니라 「보드가 다루는」 캠페인이다. 자동 확정 표시가
  //    보드와 다른 모집단을 보면 오너가 「기계가 건드린 범위」를 잘못 읽는다.
  const boardCampaignIds = campaignRows.map((row) => row.id);
  const board = buildTaxInvoiceWorkBoard(campaignRows, month);

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
    return { ...row, checklistItemId: match?.id ?? null };
  });

  // 발행 자동 확정 크론이 보드 대상 캠페인에 찍은 건. 찍힌 순간 그 의무는 보드 행에서
  // 사라지므로(`tax-filing-board.ts`의 "이미 처리됨 — 행을 만들지 않는다"), 이 목록이
  // 없으면 오너는 **기계가 확정한 건을 자기가 확인한 건과 구분할 수 없다.**
  // ⚠️ 조회 축은 보드와 같은 캠페인 집합(상태 축, 월 무관)이다 — 크론의 조회 창
  //    (90+180일)이 더 넓으므로, 상태가 바뀌어 보드에 들어오는 순간 그 자동 확정도 보인다.
  //
  // ⛔ **그 캠페인 집합은 단조 증가하므로 기간 컷이 반드시 필요하다.** 정산 완료 캠페인은
  //    보드 집합에서 빠지지 않아, 컷이 없으면 「자동 확정됨 N건」이 전 기간 누적치가 되어
  //    매달 커지기만 한다(배지가 영구히 고정돼 신호가 죽는 실패 형태 — 설계가 pendingCount
  //    에서 명시적으로 막은 것과 같은 부류). 창의 크기와 근거는
  //    `AUTO_CONFIRM_SEED_LOOKBACK_DAYS` 주석에 있다(같은 다이얼로그의 수취 스캔 기본
  //    90일과 맞춘 것). 화면도 이 창을 문구로 밝힌다.
  //
  // ⚠️ **조회가 두 단계인 이유** — 보드 캠페인의 로그만 읽으면 그 확정에 걸린 멤버 수가
  //    조용히 줄어든다. 크론은 그룹 확정 1건을 멤버 **전원**에게 로그로 남기는데, 그중
  //    일부가 나중에 그룹에서 분리돼 다른 상태로 옮겨가면(`campaign-row.ts` 가 그룹 소속
  //    여부에 따라 `payoutCompletedAt` 을 다른 소스에서 읽는다) 그 로그는 조회 자체에서
  //    빠져 "기계가 2건에 손댔다"가 "1건"으로 보고된다. 개수를 줄여 보고하는 것은 이
  //    화면이 막으려는 오해(기계가 건드린 범위) 그 자체다.
  //    ① 보드 캠페인의 로그로 **어떤 확정이 있었나**를 찾고
  //    ② 그 확정의 로그를 캠페인 제한 없이 다시 모아 멤버 전원을 복원한다.
  //    `content` 는 크론이 op 당 한 번 계산해 멤버 전원에게 똑같이 남기므로 op 의 키가
  //    된다(`tax-filing-auto-confirm.ts` 의 접기 규칙과 같은 축). `in` 절 크기는 보드의
  //    확정 건수 규모로 자연히 묶인다.
  //
  // ⛔ **`type` 은 접두사로 잡는다** — 크론이 완전 일치(`…AUTO_CONFIRM`)와 허용오차 흡수
  //    (`…AUTO_CONFIRM_TOLERATED`)를 다른 type 으로 남긴다. 정확 일치로 조회하면 흡수
  //    확정 건이 화면에서 통째로 사라지는데, 하필 그쪽이 오너가 더 봐야 하는 건이다.
  const SELECT_LOG = {
    entityId: true,
    type: true,
    fieldName: true,
    newValue: true,
    content: true,
    createdAt: true,
  } as const;
  const autoConfirmSince = new Date(
    Date.now() - AUTO_CONFIRM_SEED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const seedLogs = boardCampaignIds.length
    ? await prisma.activityLog.findMany({
        where: {
          entityType: "CAMPAIGN",
          entityId: { in: boardCampaignIds },
          type: { startsWith: TAX_INVOICE_AUTO_CONFIRM_TYPE_PREFIX },
          createdAt: { gte: autoConfirmSince },
        },
        select: SELECT_LOG,
      })
    : [];
  // `content` 가 비어 있는 로그(있어선 안 되지만 방어)는 op 키가 없어 2단계로 복원할 수
  // 없다 — 그 행은 1단계 결과 그대로 쓴다(줄이 사라지는 것보다 낫다).
  const opContents = [...new Set(seedLogs.map((log) => log.content).filter((c): c is string => !!c))];
  const memberLogs = opContents.length
    ? await prisma.activityLog.findMany({
        where: {
          entityType: "CAMPAIGN",
          type: { startsWith: TAX_INVOICE_AUTO_CONFIRM_TYPE_PREFIX },
          content: { in: opContents },
        },
        select: SELECT_LOG,
      })
    : [];
  const autoConfirmed = buildAutoConfirmedEntries(
    [...seedLogs.filter((log) => !log.content), ...memberLogs],
    new Map(campaignRows.map((row) => [row.id, row.campaignName ?? row.dealName])),
  );

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
