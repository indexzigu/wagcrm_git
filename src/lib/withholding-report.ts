/**
 * 원천징수(사업소득 3.3%) 신고 리포트 — 홈택스 수기 입력 가이드용 집계.
 *
 * 목적: 개인(비사업자) 셀러에게 지급한 판매대행비의 원천세를 **지급한 달 기준**으로
 * 집계해, 오너가 홈택스/위택스에 직접 입력할 숫자(인원·총지급액·소득세·지방소득세)와
 * 소득자별 명단(실명·주민등록번호·지급액·세액)을 만든다. 파일 업로드 서식은 만들지
 * 않는다(오너 환경상 수기 입력 전제, 2026-07-23).
 *
 * 금액 SSOT: 캠페인별 지급·원천세는 정산 명세서와 같은 함수
 * (`computeIndividualWithholding` + `getStatementDeals`)로 계산한다 — 셀러에게 발송된
 * 명세서에 찍힌 원천세와 신고 금액이 1원도 어긋나면 안 되기 때문이다.
 *
 * 세액 분리: 명세서는 3.3% 를 한 번에 반올림해 떼므로, 신고 서식의 소득세(3%)·
 * 지방소득세(0.3%) 분리값과 1원 차이가 날 수 있다. 여기서는 소득세 = floor(지급액×3%),
 * 지방소득세 = (실제 원천징수액 − 소득세) 로 분리해 **합계가 실제 뗀 금액과 항상
 * 일치**하도록 한다. 홈택스 자동계산과 1원 단위가 다르면 홈택스 값을 따르면 된다
 * (실무상 무시 가능한 단수 차이 — 가이드에 명시).
 */
import type { CampaignRow } from "./crm-types";
import { getStatementDeals } from "./settlement-statement";
import { computeIndividualWithholding, isIndividualSeller } from "./seller-tax-utils";

export type WithholdingCampaignLine = {
  campaignId: string;
  /** 자동 조합 캠페인명(딜명 - 셀러명 N차) — 없으면 딜명 폴백 */
  label: string;
  payoutDate: string;
  preTaxPayout: number;
  withholdingTax: number;
};

export type WithholdingSellerRow = {
  sellerId: string;
  /**
   * 신고 표기용 실명(`Seller.realName`). **null 이면 신고 불가 — 행 경고 대상이다.**
   * ⛔ 활동명으로 폴백하지 않는다: 홈택스 소득자 성명은 법적 실명이어야 하는데
   * `Seller.name` 에는 실무상 SNS 활동명이 들어가 있어, 폴백하면 잘못된 이름이
   * 신고서에 그대로 실린다(2026-08-04 오너 지적).
   */
  sellerRealName: string | null;
  /** 화면 식별용 표기명(별칭 우선). 실명과 같으면 null — 실명이 비어 있으면 항상 채워진다. */
  sellerAlias: string | null;
  /** 복호화된 주민등록번호. null 이면 신고 불가 — 행 경고 대상. */
  residentNumber: string | null;
  lines: WithholdingCampaignLine[];
  preTaxTotal: number;
  /** 실제 원천징수한 금액(명세서와 동일한 3.3% 계산의 합) */
  withholdingTotal: number;
  /** 소득세(3%) — floor(preTaxTotal × 0.03) */
  incomeTax: number;
  /** 지방소득세(0.3%) — withholdingTotal − incomeTax (합계 보존 분리) */
  localIncomeTax: number;
  postTaxTotal: number;
};

export type WithholdingReport = {
  /** 지급 귀속 월 (YYYY-MM) */
  month: string;
  rows: WithholdingSellerRow[];
  totals: {
    sellerCount: number;
    preTaxTotal: number;
    withholdingTotal: number;
    incomeTax: number;
    localIncomeTax: number;
  };
  warnings: string[];
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 실제 원천징수액(3.3%)을 신고 서식의 소득세(3%)·지방소득세(0.3%)로 가르는 **SSOT**.
 *
 * `withholdingTotal` 은 캠페인(딜)별 3.3% 반올림의 합이라, 합산 지급액에 한 번만 3% 를
 * 적용한 값보다 작아질 수 있다(딜별 반올림이 0 으로 떨어지는 극소액 다건). 그래서 소득세를
 * **실제 원천징수액 이하로 클램프**해 지방소득세 비음수와 합계 보존을 동시에 지킨다
 * (code-reviewer MEDIUM, 2026-07-23).
 *
 * ⛔ 이 두 줄을 호출부에 복사하지 말 것. 월별 리포트와 캠페인 단위 도우미가 각자 계산하면
 * 한쪽만 바뀌었을 때 화면과 신고서가 조용히 갈린다 — 이 기능이 여섯 번 정정된 원인이
 * 전부 "같은 사실을 두 곳에서 계산"이었다(설계 문서 「빌더 정정 설계」 참조).
 */
export function splitWithholdingTax(
  preTaxAmount: number,
  withholdingAmount: number,
): { incomeTax: number; localIncomeTax: number } {
  const incomeTax = Math.min(Math.floor(preTaxAmount * 0.03), withholdingAmount);
  return { incomeTax, localIncomeTax: withholdingAmount - incomeTax };
}

export function isValidReportMonth(month: string): boolean {
  return MONTH_RE.test(month);
}

/**
 * 지급완료일(`payoutCompletedAt`, 그룹 지급일 폴백은 `toCampaignRow` 가 이미 접었다)이
 * 해당 월인 개인 셀러 캠페인만 집계한다. 지급액 0 인 라인은 신고 대상이 아니므로
 * 제외한다.
 */
export function buildWithholdingReport(campaigns: CampaignRow[], month: string): WithholdingReport {
  const bySeller = new Map<string, WithholdingSellerRow>();
  const warnings: string[] = [];

  for (const campaign of campaigns) {
    if (!campaign.payoutCompletedAt?.startsWith(month)) continue;
    if (!isIndividualSeller(campaign)) continue;

    const { preTaxPayout, withholdingTax } = computeIndividualWithholding({
      deals: getStatementDeals(campaign),
      campaignSellerMarginRate: campaign.sellerMarginRate,
      savedSellerExpense: campaign.sellerExpense != null ? Number(campaign.sellerExpense) : null,
    });
    if (preTaxPayout <= 0) continue;

    let row = bySeller.get(campaign.sellerId);
    if (!row) {
      const realName = campaign.sellerRealName ?? null;
      row = {
        sellerId: campaign.sellerId,
        sellerRealName: realName,
        sellerAlias: campaign.sellerName !== realName ? campaign.sellerName : null,
        residentNumber: campaign.sellerResidentNumber ?? null,
        lines: [],
        preTaxTotal: 0,
        withholdingTotal: 0,
        incomeTax: 0,
        localIncomeTax: 0,
        postTaxTotal: 0,
      };
      bySeller.set(campaign.sellerId, row);
    }

    row.lines.push({
      campaignId: campaign.id,
      label: campaign.campaignName ?? campaign.dealName,
      payoutDate: campaign.payoutCompletedAt,
      preTaxPayout,
      withholdingTax,
    });
    row.preTaxTotal += preTaxPayout;
    row.withholdingTotal += withholdingTax;
  }

  const rows = [...bySeller.values()]
    .map((row) => {
      const { incomeTax, localIncomeTax } = splitWithholdingTax(row.preTaxTotal, row.withholdingTotal);
      return {
        ...row,
        lines: [...row.lines].sort((a, b) => a.payoutDate.localeCompare(b.payoutDate)),
        incomeTax,
        localIncomeTax,
        postTaxTotal: row.preTaxTotal - row.withholdingTotal,
      };
    })
    // 실명 미입력 행은 정렬 키가 없으므로 표기명으로 대신 정렬한다(표시는 여전히 빈칸).
    .sort((a, b) =>
      (a.sellerRealName ?? a.sellerAlias ?? "").localeCompare(b.sellerRealName ?? b.sellerAlias ?? "", "ko"),
    );

  const missingRealName = rows.filter((row) => !row.sellerRealName);
  if (missingRealName.length > 0) {
    warnings.push(
      `실명 미등록 셀러 ${missingRealName.length}명: 홈택스 소득자 성명은 활동명이 아닌 법적 실명이어야 합니다. ` +
        `셀러 상세 > 정산 정보 에서 실명을 입력한 뒤 다시 조회하세요.`,
    );
  }

  const missing = rows.filter((row) => !row.residentNumber);
  if (missing.length > 0) {
    warnings.push(
      `주민등록번호 미등록 셀러 ${missing.length}명: 홈택스 소득자 입력이 불가합니다. ` +
        `셀러 상세 > 정산 정보 에서 주민등록번호를 입력한 뒤 다시 조회하세요.`,
    );
  }

  const totals = rows.reduce(
    (acc, row) => {
      acc.preTaxTotal += row.preTaxTotal;
      acc.withholdingTotal += row.withholdingTotal;
      acc.incomeTax += row.incomeTax;
      acc.localIncomeTax += row.localIncomeTax;
      return acc;
    },
    { sellerCount: rows.length, preTaxTotal: 0, withholdingTotal: 0, incomeTax: 0, localIncomeTax: 0 },
  );

  return { month, rows, totals, warnings };
}

/** `900101-1234567` → `900101-1******`. 형식이 어긋나면 앞 6자리만 남기고 가린다. */
export function maskResidentNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 13) return `${digits.slice(0, 6)}-${digits.slice(6, 7)}******`;
  if (digits.length > 6) return `${digits.slice(0, 6)}-${"*".repeat(digits.length - 6)}`;
  return value.length > 2 ? `${value.slice(0, 2)}${"*".repeat(value.length - 2)}` : "**";
}

/** 신고월(지급월) 기준 원천세 신고·납부 기한 = 다음 달 10일. */
export function withholdingDueDate(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return `${next}-10`;
}

/** 간이지급명세서(거주자 사업소득) 제출 기한 = 지급월 다음 달 말일. */
export function simplifiedStatementDueDate(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  // Date(y, m, 0) 은 m월(1-기반)의 마지막 날 — 0-기반 Date 에서 m 이 곧 "다음 달의 0일"이다.
  const nextLastDay = new Date(next.y, next.m, 0).getDate();
  return `${next.y}-${String(next.m).padStart(2, "0")}-${String(nextLastDay).padStart(2, "0")}`;
}
