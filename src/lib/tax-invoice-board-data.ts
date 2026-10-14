/**
 * 세금계산서 작업 보드(정산 「세무 처리」 탭)의 **DB 쪽** — 캠페인을 읽어 보드를 만들고, 보드가
 * 함께 보여 주는 발행 자동 확정 목록을 모은다.
 *
 * 왜 따로 있나: 같은 그림을 두 곳이 본다 — 오너 화면(`api/settlement/tax-filing-board/route.ts`)과
 * 봇의 읽기 동작(`agent-worker/executor.ts` 의 `get_tax_invoice_status`). 둘이 쿼리를 각자 들면
 * 「봇이 말한 남은 의무」와 「화면의 남은 의무」가 조용히 갈린다. 판정은 순수 계층
 * (`tax-filing-board.ts` · `tax-filing-auto-confirm.ts`)이 그대로 소유하고, 여기는 그 입력을
 * 한 번만 정의한다.
 *
 * ⛔ 원천징수(지급월 축) 쿼리는 여기 두지 않는다 — 라우트에 남는다. 두 축이 한 where 를 공유하면
 *    2026-08-09 에 고친 버그가 재발한다(라우트 주석).
 */
import type { Prisma } from "@prisma/client";
import type { getPrisma } from "@/lib/prisma";
import { toCampaignRow } from "@/lib/campaign-row";
import { WORKSPACE_STATUS_GROUPS } from "@/lib/campaign-checklist";
import type { CampaignRow } from "@/lib/crm-types";
import { buildTaxInvoiceWorkBoard, type TaxInvoiceBoard } from "@/lib/tax-filing-board";
import {
  AUTO_CONFIRM_SEED_LOOKBACK_DAYS,
  buildAutoConfirmedEntries,
  TAX_INVOICE_AUTO_CONFIRM_TYPE_PREFIX,
  type AutoConfirmedEntry,
} from "@/lib/tax-filing-auto-confirm";
import { campaignInvoiceService } from "@/services/campaignInvoiceService";

type Db = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

/**
 * 보드가 읽는 캠페인 모양 — **보드 판정이 쓰는 칸만** 싣는다.
 *
 * `buildTaxInvoiceWorkBoard`(와 그것이 부르는 `validateTaxInvoiceCampaigns`·금액 판정)가 읽는
 * `CampaignRow` 칸은 캠페인 스칼라 · 딜명 · 거래처(이름·사업자번호·대표자·월정산) · 셀러(이름·
 * 별칭) · 셀러 사업자(상호·사업자번호·대표자) · 그룹 · 부가 항목이 전부다(2026-10-14 실독).
 * 그래서 아래는 싣지 않는다 — 넣어도 보드 행이 바뀌지 않고, 빼면 봇의 DB 역할에 그 표를 열지 않아도
 * 된다(`20261014120000_grant_agent_worker_tax_invoice_reads`):
 *   · `campaignDeals`(CampaignDeal) — 보드 금액은 캠페인 합계 칸에서 나온다.
 *   · `seller.histories`(SellersHistory) · 사업자 담당자(`agency.contacts`, PartnerContact) —
 *     팔로워 추이·이메일은 보드가 안 본다(이메일은 XLSX 빌더만 쓴다).
 *   · 셀러의 주민등록번호·계좌 · 거래처 주소·계좌·이메일 — 보드가 안 보고, 봇 경로에서는 읽을 이유조차 없다.
 * ⚠️ 보드가 새 칸을 읽기 시작하면 **여기에 먼저** 넣을 것 — 빠진 칸은 오류 없이 null 로 떨어져
 *    결번(「사업자등록번호」 등)으로 보인다. 같은 행인지는 `tax-invoice-board-data.test.ts` 가 대조한다.
 */
export const TAX_INVOICE_BOARD_CAMPAIGN_INCLUDE = {
  deal: {
    include: {
      partner: { select: { id: true, name: true, businessNumber: true, ceoName: true, monthlySettlement: true } },
    },
  },
  seller: {
    select: {
      name: true,
      alias: true,
      snsType: true,
      snsHandle: true,
      agency: { select: { name: true, type: true, businessNumber: true, ceoName: true } },
    },
  },
  group: true,
  // ⛔ 빼면 부가 항목이 있어도 보드 금액이 안 움직이고 **오류도 안 난다**(라우트 주석 · 설계 §9-6-3).
  settlementItems: { orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] },
} satisfies Prisma.SalesCampaignInclude;

export type TaxInvoiceWorkBoardData = {
  /** 보드가 다룬 캠페인 — 자동 확정 라벨·봇 투영이 이름을 찾는 데 쓴다. */
  campaignRows: CampaignRow[];
  board: TaxInvoiceBoard;
};

/**
 * 세금계산서 작업 보드 — 캠페인 **상태 축**(월 무관). `month` 는 응답의 `month` 칸에만 실린다.
 * 정산 사정권에 든 상태만 본다(그 이전 단계는 금액이 없어 전부 결번으로 뒤덮인다).
 */
export async function loadTaxInvoiceWorkBoard(prisma: Db, month: string): Promise<TaxInvoiceWorkBoardData> {
  const invoiceCampaigns = await prisma.salesCampaign.findMany({
    where: { status: { in: [...WORKSPACE_STATUS_GROUPS.settlement] } },
    include: TAX_INVOICE_BOARD_CAMPAIGN_INCLUDE,
  });
  const campaignRows = invoiceCampaigns.map((campaign) => toCampaignRow(campaign));
  // 월정산 공급사 칸은 달별 계산서가 「끝」을 정한다(T-244) — 완료 게이트와 같은 판정을 넘긴다.
  const monthlyProgress = await campaignInvoiceService.loadInvoiceProgress(
    prisma,
    campaignRows.filter((row) => row.partnerMonthlySettlement).map((row) => row.id),
  );
  return { campaignRows, board: buildTaxInvoiceWorkBoard(campaignRows, month, monthlyProgress) };
}

/** 자동 확정 로그에서 읽는 칸 — 봇의 DB 역할에도 이 칸만 열려 있다(칸 단위 GRANT). */
const AUTO_CONFIRM_LOG_SELECT = {
  entityId: true,
  type: true,
  fieldName: true,
  newValue: true,
  content: true,
  createdAt: true,
} as const;

/**
 * 발행 자동 확정 크론이 보드 대상 캠페인에 찍은 건(최근 `AUTO_CONFIRM_SEED_LOOKBACK_DAYS` 일).
 *
 * ⚠️ 조회가 두 단계인 이유 — 보드 캠페인의 로그만 읽으면 그룹 확정에 걸린 멤버 수가 조용히 준다
 *    (일부 멤버가 그룹에서 분리돼 보드 집합을 떠나면 그 로그가 빠진다). ① 보드 캠페인의 로그로
 *    **어떤 확정이 있었나**를 찾고 ② 그 확정의 로그(`content` = op 키)를 캠페인 제한 없이 다시 모아
 *    멤버 전원을 복원한다.
 * ⛔ `type` 은 접두사로 잡는다 — 완전 일치(`…AUTO_CONFIRM`)와 허용오차 흡수(`…_TOLERATED`)가 다른
 *    type 이다. 정확 일치로 조회하면 오너가 더 봐야 하는 흡수 건이 통째로 사라진다.
 * ⛔ 기간 컷은 필수다 — 보드 캠페인 집합은 단조 증가하므로 컷이 없으면 전 기간 누적치가 된다.
 */
export async function loadTaxInvoiceAutoConfirmed(
  prisma: Db,
  campaignRows: readonly CampaignRow[],
  now: Date,
): Promise<AutoConfirmedEntry[]> {
  const boardCampaignIds = campaignRows.map((row) => row.id);
  const autoConfirmSince = new Date(now.getTime() - AUTO_CONFIRM_SEED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const seedLogs = boardCampaignIds.length
    ? await prisma.activityLog.findMany({
        where: {
          entityType: "CAMPAIGN",
          entityId: { in: boardCampaignIds },
          type: { startsWith: TAX_INVOICE_AUTO_CONFIRM_TYPE_PREFIX },
          createdAt: { gte: autoConfirmSince },
        },
        select: AUTO_CONFIRM_LOG_SELECT,
      })
    : [];
  // `content` 가 비어 있는 로그(있어선 안 되지만 방어)는 op 키가 없어 2단계로 복원할 수 없다 —
  // 그 행은 1단계 결과 그대로 쓴다(줄이 사라지는 것보다 낫다).
  const opContents = [...new Set(seedLogs.map((log) => log.content).filter((c): c is string => !!c))];
  const memberLogs = opContents.length
    ? await prisma.activityLog.findMany({
        where: {
          entityType: "CAMPAIGN",
          type: { startsWith: TAX_INVOICE_AUTO_CONFIRM_TYPE_PREFIX },
          content: { in: opContents },
        },
        select: AUTO_CONFIRM_LOG_SELECT,
      })
    : [];
  return buildAutoConfirmedEntries(
    [...seedLogs.filter((log) => !log.content), ...memberLogs],
    new Map(campaignRows.map((row) => [row.id, row.campaignName ?? row.dealName])),
  );
}
