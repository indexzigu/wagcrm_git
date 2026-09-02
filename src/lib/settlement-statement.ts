import type { CampaignDealRow, CampaignRow } from "@/lib/crm-types";
import { isIndividualSeller, getSellerPayoutBase, calcIndividualIncomeTax, calcBusinessVatBreakdown, computeIndividualWithholding } from "./seller-tax-utils";
import { sumSellerPayoutItems } from "./settlement-items";
import { sortDealRowsByName } from "./deal-sort";

const YGRD_COMPANY = {
  name: "와이그라운드",
  businessNumber: "686-68-00667",
  ceo: "정지수",
  address: "서울특별시 송파구 중대로9길 35, 6층 S22호(가락동)",
  email: "info@ygrd.kr",
  type: "도매 및 소매업 / 전자상거래 중개 및 소매업, 공동구매",
};

type SettlementRecipient = {
  key: string;
  label: string;
  companyName: string | null;
  businessNumber: string | null;
  ceoName: string | null;
  address: string | null;
};

export type SettlementStatementValidation =
  | { ok: true; recipient: SettlementRecipient }
  | { ok: false; message: string };

function escapeHtml(value: string | number | null | undefined) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatCurrency(value: number | null | undefined, hideSuffix = false) {
  const formatted = Math.round(Number(value ?? 0)).toLocaleString();
  return hideSuffix ? formatted : `${formatted}원`;
}

function formatBusinessNumber(value?: string | null) {
  if (!value) return "-";
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 10) return value;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

function formatDate(value?: string | null) {
  return value ? value.slice(0, 10) : "-";
}

/**
 * 날짜 문자열의 정렬 키 — 미입력은 **뒤로** 보낸다.
 *
 * 빈 문자열을 그대로 비교하면 `""` 가 어떤 날짜보다 작아서 **기간 미입력 캠페인이 맨 앞**으로
 * 올라온다. 명세서를 읽는 사람은 첫 블록을 "가장 먼저 진행한 건"으로 읽으므로 그건 오독을 만든다.
 */
function dateSortKey(value?: string | null) {
  const trimmed = (value ?? "").slice(0, 10);
  return trimmed || "9999-99-99";
}

/**
 * 명세서에 실리는 **품목(딜)의 표시 순서** SSOT.
 *
 * ⚠️ Prisma 의 `campaignDeals` include 에는 `orderBy` 가 없다 — 즉 DB 가 돌려주는 순서는
 * **정의되지 않았고**, 캠페인을 수정하면 같은 명세서를 다시 뽑아도 품목 순서가 바뀔 수 있다.
 * 셀러에게 보내는 문서에서 그건 "지난번과 다른 명세서"로 보인다(T-023 오너 신고).
 * 그래서 표시 순서를 여기서 **결정론적으로** 고정한다: 품목명(한국어) → id 타이브레이크.
 *
 * 금액 소비처(`computeIndividualWithholding`·`withholding-report`)는 전부 합산이라 순서에
 * 영향받지 않는다 — 그래서 정렬을 HTML 빌더가 아니라 이 **딜 선택 SSOT** 에 둔다.
 * 화면마다 다시 정렬하면 또 갈라진다.
 */
function sortStatementDeals(deals: CampaignDealRow[]): CampaignDealRow[] {
  return sortDealRowsByName(deals);
}

/**
 * 명세서에 실리는 **캠페인 블록의 표시 순서** SSOT — 진행 기간 오름차순(과거 → 최근).
 *
 * 묶음 명세서는 호출부가 넘긴 배열 순서를 그대로 렌더했다. 그 배열은 정산표의 현재
 * 정렬·선택 순서라 오너가 표를 어떻게 정렬해 뒀는지에 따라 같은 셀러의 같은 묶음이
 * 매번 다른 순서로 나갔다(T-023). 문서번호도 이 순서로 만들어져 **같은 선택인데 문서번호가
 * 달라지는** 부작용까지 있었다.
 *
 * ⛔ 호출부에서 정렬하지 말 것 — 이메일(HTML)·PDF·PNG 가 같은 문서여야 하므로 정렬은
 * 정본 빌더 안에 있어야 한다.
 */
export function sortStatementCampaigns(campaigns: CampaignRow[]): CampaignRow[] {
  return [...campaigns].sort((left, right) => {
    const byStart = dateSortKey(left.startDate).localeCompare(dateSortKey(right.startDate));
    if (byStart !== 0) return byStart;
    const byEnd = dateSortKey(left.endDate).localeCompare(dateSortKey(right.endDate));
    if (byEnd !== 0) return byEnd;
    const byRound = (left.roundNumber ?? 0) - (right.roundNumber ?? 0);
    if (byRound !== 0) return byRound;
    const byName = (left.dealName ?? "").localeCompare(right.dealName ?? "", "ko");
    if (byName !== 0) return byName;
    return String(left.id).localeCompare(String(right.id));
  });
}

/**
 * 명세서가 계산에 쓰는 딜 집합 — campaignDeals 가 있으면 그것, 없으면 레거시
 * 단일 딜 폴백. 원천징수 신고 리포트(`withholding-report.ts`)가 같은 함수를 쓴다
 * — 딜 선택이 갈리면 명세서와 신고 금액이 갈리므로 여기 말고 재구현하지 말 것.
 *
 * 순서도 이 함수가 소유한다(`sortStatementDeals`) — 위 주석 참고.
 */
export function getStatementDeals(campaign: CampaignRow): CampaignDealRow[] {
  if (campaign.campaignDeals && campaign.campaignDeals.length > 0) {
    return sortStatementDeals(campaign.campaignDeals);
  }

  return [
    {
      id: `fallback-${campaign.id}`,
      campaignId: campaign.id,
      dealId: campaign.dealId,
      dealName: campaign.dealName,
      quantity: campaign.quantity ?? 0,
      actualSales: campaign.actualSales ?? 0,
      feeRate: campaign.totalMarginRate,
      sellerMarginRate: campaign.sellerMarginRate,
      costPrice: campaign.deal?.costPrice ?? 0,
      sellingPrice: campaign.deal?.sellingPrice ?? 0,
    },
  ];
}

function getFullDealName(campaignName: string, dealName: string) {
  if (!campaignName || dealName.includes(campaignName)) return dealName;
  return `[${campaignName}] ${dealName}`;
}

function getRecipient(campaign: CampaignRow): SettlementRecipient {
  if (campaign.sellerCompanyBusinessNumber || campaign.sellerCompanyName) {
    const companyIdentity = campaign.sellerCompanyBusinessNumber || campaign.sellerCompanyName;
    return {
      key: `company:${companyIdentity}`,
      label: campaign.sellerName,
      companyName: campaign.sellerCompanyName ?? null,
      businessNumber: campaign.sellerCompanyBusinessNumber ?? null,
      ceoName: campaign.sellerCompanyCeoName ?? null,
      address: campaign.sellerCompanyAddress ?? null,
    };
  }

  return {
    key: `seller:${campaign.sellerId}`,
    label: campaign.sellerName,
    companyName: null,
    businessNumber: null,
    ceoName: null,
    address: null,
  };
}

/**
 * Ensures a bundled statement has one unambiguous payout recipient.
 * Linked company identity takes precedence. Campaigns without one may only be
 * bundled when they belong to the same seller.
 */
export function validateSettlementStatementCampaigns(
  campaigns: CampaignRow[],
): SettlementStatementValidation {
  if (campaigns.length === 0) {
    return { ok: false, message: "정산 명세서를 발행할 캠페인을 선택해 주세요." };
  }

  const recipient = getRecipient(campaigns[0]);
  const hasDifferentRecipient = campaigns.some(
    (campaign) => getRecipient(campaign).key !== recipient.key,
  );

  if (hasDifferentRecipient) {
    return {
      ok: false,
      message: "묶음 정산서는 동일한 연결 회사 기준으로만 발행할 수 있습니다. 연결 회사가 없는 경우에는 동일 셀러 캠페인만 묶을 수 있습니다.",
    };
  }

  return { ok: true, recipient };
}

export function preFlightValidateCampaigns(campaigns: CampaignRow[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!campaigns || campaigns.length === 0) {
    errors.push("선택된 정산 대상 캠페인이 없습니다.");
    return { errors, warnings };
  }

  // 1. 수령자(정산처) 일치 검증
  const validation = validateSettlementStatementCampaigns(campaigns);
  if (!validation.ok) {
    errors.push(validation.message);
  }

  campaigns.forEach((campaign) => {
    const isIndividual = isIndividualSeller(campaign);
    const prefix = campaigns.length > 1 ? `[${campaign.sellerName} · ${campaign.dealName}] ` : "";

    // 2. 총 거래액 검증
    const actualSales = campaign.actualSales ?? 0;
    if (actualSales <= 0) {
      errors.push(`${prefix}총 거래액이 0원이거나 누락되었습니다.`);
    }

    // 3. 수수료율 합산 검증 (총 마진율 = 셀러 마진율 + 영업이익율)
    const totalRate = campaign.totalMarginRate ?? 0;
    const sellerRate = campaign.sellerMarginRate ?? 0;
    const netRate = campaign.netMarginRate ?? 0;
    const rateDiff = Math.abs(totalRate - (sellerRate + netRate));
    if (rateDiff > 0.01) {
      errors.push(`${prefix}수수료율 합계가 일치하지 않습니다. (총: ${totalRate}% ≠ 셀러: ${sellerRate}% + 자사: ${netRate}%)`);
    }

    // 4. 음수 정산 금액 검증
    if (campaign.sellerExpense != null && campaign.sellerExpense < 0) {
      errors.push(`${prefix}판매 대행비 금액이 음수입니다.`);
    }
    if (campaign.settlementSales != null && campaign.settlementSales < 0) {
      errors.push(`${prefix}영업 수익이 음수입니다.`);
    }
    if (campaign.operatingProfit != null && campaign.operatingProfit < 0) {
      warnings.push(`${prefix}영업이익이 마이너스(적자 정산)입니다.`);
    }

    // 5. 계좌번호 누락 검증 (경고)
    if (!campaign.sellerCompanyBankAccount) {
      warnings.push(`${prefix}정산 계좌 정보가 누락되었습니다.`);
    }

    // 6. 사업자 셀러 필수 정보 검증 (경고)
    if (!isIndividual) {
      if (!campaign.sellerCompanyBusinessNumber) {
        warnings.push(`${prefix}사업자 셀러이나 사업자등록번호가 누락되었습니다. (세금계산서 발행 시 확인 필요)`);
      }
      if (!campaign.sellerCompanyName) {
        warnings.push(`${prefix}사업자 셀러이나 상호(사업자명)가 누락되었습니다.`);
      }
    }

    // 7. 거래처/브랜드 정보 누락 검증 (경고)
    if (!campaign.deal?.brandName && !campaign.partnerName) {
      warnings.push(`${prefix}연결된 브랜드(거래처) 정보가 누락되었습니다.`);
    }

    // 8. 진행 상태 검증 (경고)
    const allowedStatuses = ["SETTLEMENT_WAIT", "SETTLEMENT_IN_PROGRESS", "COMPLETED"];
    if (!allowedStatuses.includes(campaign.status)) {
      warnings.push(`${prefix}캠페인이 아직 정산 대기 상태가 아닙니다. (현재 상태: ${campaign.status})`);
    }

    // 9. 수수료 계산 오차 검증 (경고)
    const calculatedSettlementSales = actualSales * (totalRate / 100);
    if (campaign.settlementSales != null && Math.abs(campaign.settlementSales - calculatedSettlementSales) > 10) {
      warnings.push(`${prefix}영업 수익(${formatCurrency(campaign.settlementSales)})이 총 거래액 대비 계산값(${formatCurrency(calculatedSettlementSales)})과 10원 이상 차이납니다.`);
    }
    
    const sellerPayoutBase = getSellerPayoutBase(actualSales, isIndividual);
    const calculatedSellerExpense = sellerPayoutBase * (sellerRate / 100);
    if (campaign.sellerExpense != null && Math.abs(campaign.sellerExpense - calculatedSellerExpense) > 10) {
      warnings.push(`${prefix}판매 대행비 지출액(${formatCurrency(campaign.sellerExpense)})이 계산값(${formatCurrency(calculatedSellerExpense)})과 10원 이상 차이납니다.`);
    }
  });

  return { errors, warnings };
}

function buildRecipientHtml(recipient: SettlementRecipient) {
  if (!recipient.companyName && !recipient.businessNumber && !recipient.ceoName && !recipient.address) {
    return "";
  }

  return `
    <div style="margin-bottom: 20px; padding: 12px; border: 1px solid #cbd5e1; background-color: #ffffff;">
      <div style="font-size: 11px; font-weight: 700; color: #334155; margin-bottom: 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px;">[셀러 사업자 정보]</div>
      <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
        ${recipient.companyName ? `<tr><td style="padding: 3px 0; color: #64748b; width: 110px;">상호 (사업자명)</td><td style="padding: 3px 0; color: #1e293b; font-weight: 600;">${escapeHtml(recipient.companyName)}</td></tr>` : ""}
        ${recipient.businessNumber ? `<tr><td style="padding: 3px 0; color: #64748b;">사업자번호</td><td style="padding: 3px 0; color: #1e293b; font-weight: 600;">${escapeHtml(formatBusinessNumber(recipient.businessNumber))}</td></tr>` : ""}
        ${recipient.ceoName ? `<tr><td style="padding: 3px 0; color: #64748b;">대표자명</td><td style="padding: 3px 0; color: #1e293b;">${escapeHtml(recipient.ceoName)}</td></tr>` : ""}
        ${recipient.address ? `<tr><td style="padding: 3px 0; color: #64748b;">소재지 (주소)</td><td style="padding: 3px 0; color: #1e293b; line-height: 1.4;">${escapeHtml(recipient.address)}</td></tr>` : ""}
      </table>
    </div>
  `;
}

/**
 * 품목 표의 **열 너비·셀 스타일 SSOT** (T-024).
 *
 * 개인/법인 두 표가 같은 8열 뼈대를 **인라인 스타일로 각자** 갖고 있어서, 한쪽만 고치면
 * 그 순간 갈라진다(이 파일의 고질병 — T-023 과 같은 부류). 두 표가 공유해야 하는 값만
 * 여기 모은다. 열 **이름**은 표마다 다르므로(개인=공급가액·판매대행비·원천세,
 * 법인=총 거래액·공급가액·부가세액) 헤더 텍스트는 각 표가 소유한다.
 *
 * ⚠️ 인라인 스타일인 이유: 이 조각은 **메일 본문으로 붙여넣어진다.** 메일 클라이언트는
 * `<style>` 블록과 클래스를 떼어내므로 class 로 옮기면 셀러가 받는 문서에서 서식이 통째로
 * 사라진다(인쇄 문서만 `.stmt-campaign-block` 을 쓰는 것도 그래서다 — 그건 페이지 분할용
 * 이라 메일에서 빠져도 무해하다).
 */
const STMT_COL_WIDTHS = ["34%", "9%", "6%", "12%", "7%", "10%", "10%", "12%"] as const;

/**
 * 품목명 셀 — **줄바꿈 규칙이 이 티켓의 본체다.**
 *
 * 종전 `word-break: break-all` 은 "다음 글자가 안 들어가면 무조건 거기서 자른다"라
 * `샘플상품 - AB-123 그립형 20000` 같은 이름을 **`20000` 한가운데서** `2000` / `0` 으로 쪼갰다
 * (오너 신고 캡처). 숫자가 잘리면 셀러가 다른 모델로 읽을 수 있어 단순 미관 문제가 아니다.
 *
 * 처방은 두 선언의 조합이다:
 *   - `word-break: keep-all` — 한국어 어절과 라틴·숫자 토큰 안에서 자르지 않는다(공백에서 넘긴다).
 *   - `overflow-wrap: anywhere` — 토큰 하나가 열보다 길 때만 **최후수단으로** 자른다.
 *     이게 없으면 긴 SKU 하나가 열을 밀어 표가 넘친다(`table-layout: fixed` 라도 글자가 삐져나온다).
 * ⛔ `break-all` 로 되돌리지 말 것 — 위 캡처가 정확히 그 상태다.
 */
const STMT_NAME_CELL =
  "padding: 6px 8px; text-align: left; vertical-align: middle; word-break: keep-all; overflow-wrap: anywhere;";

/**
 * 숫자 셀 — 금액·수량은 **우측 정렬**이 명세서 관례다. 자릿수가 세로로 맞아야 셀러가
 * 소계와 대조할 수 있다(가운데 정렬하면 자릿수 축이 행마다 흔들려 대조가 불가능해진다).
 * `tabular-nums` 는 글리프 폭을 고정해 그 축을 한 번 더 잡아준다.
 *
 * ## 「행마다 우측 정렬이 안 맞는다」는 신고는 정렬 결함이 아니었다 (2026-08-19)
 *
 * 오너가 특정 셀 5개를 짚어 신고했다. **오너가 받은 원본 PNG(1520px = 760 × scale 2)를
 * 픽셀로 직접 재서 확정한 결론**은 이렇다:
 *
 * | 열 | 오른쪽 끝 행간 최대차 | **왼쪽 끝 행간 최대차** |
 * | --- | --- | --- |
 * | 수량 | 4px | **13px** |
 * | 총 거래액 | 1px | **13px** |
 * | 공급가액 | 4px | **17px** |
 * | 부가세액 | 1px | **13px** |
 * | 차인지급액 | **0px** | **17px** |
 *
 * (2배 좌표 기준. 지목된 5개 셀의 오른쪽 편차는 0~1px = 0.5 CSS px 이하다.)
 *
 * **우측 정렬은 맞다.** 어긋나 보이는 것은 **왼쪽 끝**이고, 자릿수가 다르면 그쪽이
 * 들쭉날쭉해지는 것은 우측 정렬 숫자 표의 정상 동작이다. 지목된 5개 셀은 예외 없이
 * **그 열에서 자릿수가 늘어 왼쪽 끝이 처음 튀는 행**이었다(5/5 일치).
 *
 * ⛔ **오른쪽 여백을 늘려도 이 신고는 해결되지 않는다 — 이미 해 보고 되돌렸다.**
 * #424 가 罫線 쪽 여백을 8→10px 로 벌렸으나(끝자리 `1` 의 잉크가 3px 안쪽에 서는 것을
 * 덜 도드라지게 하려는 완화), 배포 후 원본 PNG 실측에서 **여백만 8→10px 로 바뀌고
 * 신고 증상은 그대로**였다. 원인이 왼쪽이었기 때문이다. 그래서 원복했다.
 *
 * ⛔ **그럼에도 다시 손댈 때 오른쪽만 늘리지 말 것.** 열 너비가 퍼센트라 패딩을 키운
 * 만큼 **글자 자리가 줄어든다.** 실측상 공급가액 열의 여유는 6.60px 뿐이고(콘텐츠
 * 55.75px vs 최장값 49.15px), 정산금이 1천만 원대면 10자리 값(≈55.4px)이 들어와 여유가
 * 0.35px 로 떨어진다 — 거기서 오른쪽을 2px 더 먹으면 **금액이 두 줄로 갈라진다**(셀러에게
 * 가는 문서라 미관 문제가 아니다). `settlement-statement-table-style.contract.test.ts` 가
 * **좌우 합 16px** 를 고정해 그 경로를 막는다.
 */
const STMT_NUM_CELL =
  "padding: 6px 8px; text-align: right; vertical-align: middle; font-variant-numeric: tabular-nums;";

/**
 * 수수료율 셀 — 이 열만 **가운데 정렬**이다. 자릿수 대조 대상이 아니고(`15%` 고정폭),
 * 값이 행마다 거의 같아서 우측에 붙이면 옆 금액 열과 뭉쳐 읽힌다.
 */
const STMT_RATE_CELL = "padding: 6px 8px; text-align: center; vertical-align: middle;";

/**
 * 상하 정렬은 **명시 선언한다.** 브라우저에서는 UA 기본값이 `middle` 이라 이미 가운데로
 * 보이지만(실측 확인), 그건 선언이 아니라 기본값 의존이다 — 메일 클라이언트·PDF 엔진 중
 * 기본이 `baseline` 인 곳에서는 품목명이 2줄로 넘어가는 순간 옆 숫자들이 **첫 줄 기준선**에
 * 붙어 위로 쏠린다. 셀러가 받는 문서라 렌더러를 고를 수 없으므로 값을 못 박는다.
 */
const STMT_HEAD_CELL_BASE =
  "padding: 6px 8px; vertical-align: middle; font-weight: 600; color: #334155; border: 1px solid #cbd5e1;";

/**
 * **차감 항목(원천세) 글자색** — 명세서 안에서 유일한 유채색 텍스트다(T-027).
 *
 * 종전 `#ef4444` 는 흰 배경 대비 **3.76:1** 로 WCAG AA 본문 기준(4.5:1)에 미달했다. 10px
 * 글자라 화면·인쇄 모두에서 읽기 어려웠고, 셀러가 "내 지급액에서 얼마가 빠졌나"를 확인하는
 * 숫자라 흐리면 안 되는 자리다.
 *
 * ## 왜 앱 토큰을 그대로 못 쓰는가 — **표면 종속**(P8 §5)을 실측으로 확인했다
 *
 * | 후보 | 흰 배경 | 소계 행 `#f8fafc` |
 * | --- | --- | --- |
 * | `#ef4444` (종전) | 3.76 ❌ | 3.60 ❌ |
 * | `--money-out` `#E11D48` | 4.70 ✅ | **4.49 ❌** |
 * | `--status-urgent` `#BF5050` | 4.69 ✅ | **4.48 ❌** |
 * | `#be123c` (채택) | **6.29 ✅** | **6.01 ✅** |
 *
 * 원천세는 의미상 `--money-out` 축이 맞다(지급·차감은 **경고가 아니라 정상적인 사실** —
 * `money-direction.ts` 가 그 경계를 소유한다). 그런데 이 표는 소계 행에 `#f8fafc` 틴트가
 * 깔려 있어서 그 토큰이 **0.01 차이로 미달한다.** P8 §5 가 말하는 "같은 의미라도 배경이
 * 바뀌면 못 쓴다"의 교과서적 사례라, 규칙대로 대비를 직접 계산해 한 단계 어두운 같은 계열
 * (rose-700)을 쓴다. 색상 계열을 유지하므로 앱의 money-out 과 시각적으로 이어진다.
 *
 * ⚠️ 이 문서는 토큰(CSS 변수)을 쓸 수 없다 — 메일 본문으로 붙여넣어지면 `:root` 정의가
 * 따라가지 않아 색이 통째로 죽는다. 그래서 리터럴이고, 그래서 **대비를 사람이 계산해
 * 주석에 남긴다.** 계약 테스트가 이 값의 대비를 매번 다시 계산한다.
 * ⛔ 밝은 빨강으로 되돌리지 말 것.
 */
const STMT_DEDUCTION_TEXT = "#be123c";

/**
 * 헤더 셀 — **전 열 가운데 정렬**이다(오너 확정 2026-08-10, T-024).
 *
 * 본문은 열마다 축이 다르다(품목명 좌 · 수수료율 가운데 · 나머지 우 — 금액은 자릿수를 세로로
 * 맞춰야 셀러가 소계와 대조할 수 있다). 헤더는 그 축을 따라가지 **않는다**: 헤더 행은 값이
 * 아니라 **열 이름표 띠**이고, 거래명세서·세금계산서 서식이 오래 써 온 형태가 그것이다.
 *
 * ⚠️ 이 자리는 초안에서 "헤더도 본문 축을 따른다"로 구현됐다가 오너가 뒤집은 지점이다.
 * 당시 근거("헤더 우측 끝이 숫자 우측 끝과 같은 세로선에 서야 한 열로 묶인다")는 웹 데이터
 * 테이블의 관례이지 **국내 명세서 서식의 관례가 아니었다** — 사실이 아니라 취향이었다.
 * ⛔ "본문과 축이 다르다"를 이유로 되돌리지 말 것. 축이 다른 것이 의도다.
 */
function stmtHeadCell(label: string, index: number) {
  return `<th style="${STMT_HEAD_CELL_BASE} text-align: center; width: ${STMT_COL_WIDTHS[index]};">${label}</th>`;
}

/**
 * 소계 행의 숫자 셀 — 본문 숫자 셀과 정렬축이 같아야 한다(상하 패딩만 8px 로 더 준다).
 * 좌우는 본문과 **같은 8/8** 이다: 소계 숫자가 본문 숫자와 같은 세로선에 서야 대조가
 * 되므로, 좌우 여백이 어긋나면 소계만 밀려 보인다(위 `STMT_NUM_CELL` 주석의 실측 근거 동일).
 */
const STMT_TOTAL_NUM_CELL =
  "padding: 8px; text-align: right; vertical-align: middle; font-variant-numeric: tabular-nums;";

function buildCampaignHtml(campaign: CampaignRow, isIndividual: boolean) {
  const deals = getStatementDeals(campaign);
  const totalOrderCount = deals.reduce((sum, deal) => sum + deal.quantity, 0);
  const totalSales = deals.reduce((sum, deal) => sum + deal.actualSales, 0);
  
  const savedSellerExpense = campaign.sellerExpense != null ? Number(campaign.sellerExpense) : null;

  let totalPreTaxPayout = 0;
  let totalPostTaxPayout = 0;

  if (isIndividual) {
    // 개인 셀러 합계는 SSOT(computeIndividualWithholding)로 계산한다 — 원천징수
    // 신고 리포트가 같은 함수를 쓰므로 명세서와 신고 금액이 구조적으로 일치한다.
    const withholding = computeIndividualWithholding({
      deals,
      campaignSellerMarginRate: campaign.sellerMarginRate,
      savedSellerExpense,
    });
    totalPreTaxPayout = withholding.preTaxPayout;
    totalPostTaxPayout = withholding.postTaxPayout;
  } else {
    deals.forEach(deal => {
      const sellerRate = Number(deal.sellerMarginRate ?? campaign.sellerMarginRate ?? 0);
      const sellerBase = getSellerPayoutBase(deal.actualSales, isIndividual);
      const preTaxPayout = Math.round(sellerBase * sellerRate / 100);
      totalPreTaxPayout += preTaxPayout;
      totalPostTaxPayout += preTaxPayout;
    });

    // 수동 조정 또는 저장된 값 적용
    if (savedSellerExpense !== null) {
      totalPreTaxPayout = savedSellerExpense;
      totalPostTaxPayout = savedSellerExpense;
    }
  }

  const roundLabel = campaign.roundNumber ? ` (제${campaign.roundNumber}회차)` : "";

  if (isIndividual) {
    const totalWithholdingTaxOnly = totalPreTaxPayout - totalPostTaxPayout;

    return `
    <div class="stmt-campaign-block" style="margin-top: 24px; padding-bottom: 8px;">
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: 12px;">
        <tr><td style="padding: 3px 0; color: #1e293b; font-weight: 700; width: 80px;">캠페인명</td><td style="padding: 3px 0; color: #1e293b; font-weight: 700;">${escapeHtml(campaign.dealName)}${escapeHtml(roundLabel)}</td></tr>
        <tr><td style="padding: 3px 0; color: #64748b; font-weight: 600;">진행 기간</td><td style="padding: 3px 0; color: #475569;">${escapeHtml(formatDate(campaign.startDate))} ~ ${escapeHtml(formatDate(campaign.endDate))}</td></tr>
      </table>
      <table style="width: 100%; border-collapse: collapse; font-size: 10px; border: 1px solid #cbd5e1; background-color: #ffffff; table-layout: fixed; margin-bottom: 16px;">
        <thead>
          <tr style="background-color: #f1f5f9; white-space: nowrap;">
            ${stmtHeadCell("품목명", 0)}
            ${stmtHeadCell("판매가", 1)}
            ${stmtHeadCell("수량", 2)}
            ${stmtHeadCell("공급가액", 3)}
            ${stmtHeadCell("수수료율", 4)}
            ${stmtHeadCell("판매대행비", 5)}
            ${stmtHeadCell("원천세", 6)}
            ${stmtHeadCell("차인지급액", 7)}
          </tr>
        </thead>
        <tbody>
          ${deals.map((deal) => {
            const sellerRate = Number(deal.sellerMarginRate ?? campaign.sellerMarginRate ?? 0);
            const sellerBase = getSellerPayoutBase(deal.actualSales, isIndividual);
            let preTaxPayout = Math.round(sellerBase * sellerRate / 100);
            
            const withholdingTax = calcIndividualIncomeTax(preTaxPayout);
            
            let finalPayout = preTaxPayout - withholdingTax;

            if (deals.length === 1 && savedSellerExpense !== null) {
              preTaxPayout = savedSellerExpense;
              finalPayout = preTaxPayout - calcIndividualIncomeTax(savedSellerExpense);
            }
            
            const displayTax = deals.length === 1 && savedSellerExpense !== null 
              ? calcIndividualIncomeTax(savedSellerExpense)
              : withholdingTax;
            
            return `<tr style="background-color: #ffffff;">
              <td style="${STMT_NAME_CELL} color: #334155; border: 1px solid #e2e8f0;">${escapeHtml(getFullDealName(campaign.dealName, deal.dealName))}</td>
              <td style="${STMT_NUM_CELL} color: #334155; border: 1px solid #e2e8f0;">${formatCurrency(deal.sellingPrice, true)}</td>
              <td style="${STMT_NUM_CELL} color: #334155; border: 1px solid #e2e8f0;">${deal.quantity.toLocaleString()}</td>
              <td style="${STMT_NUM_CELL} color: #334155; border: 1px solid #e2e8f0;">${formatCurrency(Math.round(deal.actualSales / 1.1), true)}</td>
              <td style="${STMT_RATE_CELL} color: #334155; border: 1px solid #e2e8f0;">${sellerRate}%</td>
              <td style="${STMT_NUM_CELL} color: #334155; border: 1px solid #e2e8f0;">${formatCurrency(preTaxPayout, true)}</td>
              <td style="${STMT_NUM_CELL} color: ${STMT_DEDUCTION_TEXT}; border: 1px solid #e2e8f0;">${formatCurrency(displayTax, true)}</td>
              <td style="${STMT_NUM_CELL} color: #1e293b; font-weight: 600; border: 1px solid #e2e8f0;">${formatCurrency(finalPayout, true)}</td>
            </tr>`;
          }).join("")}
          <tr style="background-color: #f8fafc; font-weight: 600;">
            <td style="padding: 8px; vertical-align: middle; color: #334155; border: 1px solid #cbd5e1;" colspan="2">캠페인 소계</td>
            <td style="${STMT_TOTAL_NUM_CELL} color: #334155; border: 1px solid #cbd5e1;">${totalOrderCount.toLocaleString()}</td>
            <td style="${STMT_TOTAL_NUM_CELL} color: #334155; border: 1px solid #cbd5e1;">${formatCurrency(Math.round(totalSales / 1.1), true)}</td>
            <td style="padding: 8px; border: 1px solid #cbd5e1;"></td>
            <td style="${STMT_TOTAL_NUM_CELL} color: #334155; border: 1px solid #cbd5e1;">${formatCurrency(totalPreTaxPayout, true)}</td>
            <td style="${STMT_TOTAL_NUM_CELL} color: ${STMT_DEDUCTION_TEXT}; border: 1px solid #cbd5e1;">${formatCurrency(totalWithholdingTaxOnly, true)}</td>
            <td style="${STMT_TOTAL_NUM_CELL} color: #1e293b; border: 1px solid #cbd5e1;">${formatCurrency(totalPostTaxPayout, true)}</td>
          </tr>
        </tbody>
      </table>
    </div>
    `;
  }

  // Business Seller Table
  return `
    <div class="stmt-campaign-block" style="margin-top: 24px; padding-bottom: 8px;">
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: 12px;">
        <tr><td style="padding: 3px 0; color: #64748b; width: 80px; font-weight: 600;">캠페인명</td><td style="padding: 3px 0; color: #1e293b; font-weight: 700;">${escapeHtml(campaign.dealName)}${escapeHtml(roundLabel)}</td></tr>
        <tr><td style="padding: 3px 0; color: #64748b; font-weight: 600;">진행 기간</td><td style="padding: 3px 0; color: #475569;">${escapeHtml(formatDate(campaign.startDate))} ~ ${escapeHtml(formatDate(campaign.endDate))}</td></tr>
      </table>
      <table style="width: 100%; border-collapse: collapse; font-size: 10px; border: 1px solid #cbd5e1; background-color: #ffffff; table-layout: fixed; margin-bottom: 16px;">
        <thead>
          <tr style="background-color: #f1f5f9; white-space: nowrap;">
            ${stmtHeadCell("품목명", 0)}
            ${stmtHeadCell("판매가", 1)}
            ${stmtHeadCell("수량", 2)}
            ${stmtHeadCell("총 거래액", 3)}
            ${stmtHeadCell("수수료율", 4)}
            ${stmtHeadCell("공급가액", 5)}
            ${stmtHeadCell("부가세액", 6)}
            ${stmtHeadCell("차인지급액", 7)}
          </tr>
        </thead>
        <tbody>
          ${deals.map((deal) => {
            const sellerRate = Number(deal.sellerMarginRate ?? campaign.sellerMarginRate ?? 0);
            let payout = Math.round(deal.actualSales * sellerRate / 100);
            if (deals.length === 1 && savedSellerExpense !== null) {
              payout = savedSellerExpense;
            }
            const { supply, vat } = calcBusinessVatBreakdown(payout);
            return `<tr style="background-color: #ffffff;">
              <td style="${STMT_NAME_CELL} color: #334155; border: 1px solid #e2e8f0;">${escapeHtml(getFullDealName(campaign.dealName, deal.dealName))}</td>
              <td style="${STMT_NUM_CELL} color: #334155; border: 1px solid #e2e8f0;">${formatCurrency(deal.sellingPrice, true)}</td>
              <td style="${STMT_NUM_CELL} color: #334155; border: 1px solid #e2e8f0;">${deal.quantity.toLocaleString()}</td>
              <td style="${STMT_NUM_CELL} color: #334155; border: 1px solid #e2e8f0;">${formatCurrency(deal.actualSales, true)}</td>
              <td style="${STMT_RATE_CELL} color: #334155; border: 1px solid #e2e8f0;">${sellerRate}%</td>
              <td style="${STMT_NUM_CELL} color: #334155; border: 1px solid #e2e8f0;">${formatCurrency(supply, true)}</td>
              <td style="${STMT_NUM_CELL} color: #334155; border: 1px solid #e2e8f0;">${formatCurrency(vat, true)}</td>
              <td style="${STMT_NUM_CELL} color: #1e293b; font-weight: 600; border: 1px solid #e2e8f0;">${formatCurrency(payout, true)}</td>
            </tr>`;
          }).join("")}
          <tr style="background-color: #f8fafc; font-weight: 600;">
            <td style="padding: 8px; vertical-align: middle; color: #334155; border: 1px solid #cbd5e1;" colspan="2">캠페인 소계</td>
            <td style="${STMT_TOTAL_NUM_CELL} color: #334155; border: 1px solid #cbd5e1;">${totalOrderCount.toLocaleString()}</td>
            <td style="${STMT_TOTAL_NUM_CELL} color: #334155; border: 1px solid #cbd5e1;">${formatCurrency(totalSales, true)}</td>
            <td style="padding: 8px; border: 1px solid #cbd5e1;"></td>
            <td style="${STMT_TOTAL_NUM_CELL} color: #334155; border: 1px solid #cbd5e1;">${formatCurrency(calcBusinessVatBreakdown(totalPostTaxPayout).supply, true)}</td>
            <td style="${STMT_TOTAL_NUM_CELL} color: #334155; border: 1px solid #cbd5e1;">${formatCurrency(calcBusinessVatBreakdown(totalPostTaxPayout).vat, true)}</td>
            <td style="${STMT_TOTAL_NUM_CELL} color: #1e293b; border: 1px solid #cbd5e1;">${formatCurrency(totalPostTaxPayout, true)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

export type SettlementPayoutTotals = {
  /** 셀러 개인(원천세 3.3%) 여부 — 대표 캠페인 기준(수신자가 단일임은 validate 가 보장) */
  isIndividual: boolean;
  totalSales: number;
  /** 세전 대행비 합계 */
  totalPreTaxPayout: number;
  /** 셀러가 실제로 받는 금액 */
  totalPostTaxPayout: number;
  /** 개인일 때만 의미 있음(법인은 0) */
  totalWithholdingTaxOnly: number;
  /**
   * 대상=셀러인 **부가 항목**(광고비·제작비 등)의 세전 합. 0 이면 명세서에 줄을 만들지 않는다.
   *
   * ⛔ 이 값은 셀러 정산 **기준액**이 아니다 — 기준은 `actualSales × 셀러수수료율`
   * 하나뿐이고(불변식) 이 합은 「지급 총액」에만 더해진다.
   */
  totalSettlementItemPayout: number;
};

/**
 * 명세서에 실을 셀러 대상 부가 항목만 고른다.
 *
 * ⛔ 대상=브랜드사·자사 항목은 **어떤 셀러 대면 표면에도 싣지 않는다**(P0 —
 * 브랜드사·자사 간 원가·청구·상계 정보다). 이 필터가 그 경계이고
 * `settlement-items.contract.test.ts` 가 명세서 출력에 그 항목이 등장하지 않음을 고정한다.
 */
function getSellerStatementItems(campaign: CampaignRow) {
  return (campaign.settlementItems ?? []).filter((item) => item.counterparty === "SELLER");
}

/**
 * 명세서 금액 합계 — HTML·평문이 같은 숫자를 말하게 하는 단일 원천.
 *
 * `sellerExpense`(운영자가 저장한 확정 대행비)가 있으면 그걸 쓰고, 없을 때만 딜별
 * `sellerMarginRate` 로 역산한다 — 확정값이 추정값을 이긴다.
 */
export function computeSettlementPayoutTotals(campaigns: CampaignRow[]): SettlementPayoutTotals {
  const isIndividual = isIndividualSeller(campaigns[0]);
  let totalSales = 0;
  let totalPreTaxPayout = 0;
  let totalPostTaxPayout = 0;
  let totalWithholdingTaxOnly = 0;
  let totalSettlementItemPayout = 0;

  for (const campaign of campaigns) {
    const deals = getStatementDeals(campaign);
    totalSales += deals.reduce((sum, deal) => sum + Number(deal.actualSales ?? 0), 0);

    const savedSellerExpense = campaign.sellerExpense != null ? Number(campaign.sellerExpense) : null;
    const preTaxPayouts =
      savedSellerExpense !== null
        ? [savedSellerExpense]
        : deals.map((deal) => {
            const sellerRate = Number(deal.sellerMarginRate ?? campaign.sellerMarginRate ?? 0);
            const sellerBase = getSellerPayoutBase(deal.actualSales ?? 0, isIndividual);
            return Math.round((sellerBase * sellerRate) / 100);
          });

    for (const preTaxPayout of preTaxPayouts) {
      totalPreTaxPayout += preTaxPayout;
      if (isIndividual) {
        const withholdingTax = calcIndividualIncomeTax(preTaxPayout);
        totalWithholdingTaxOnly += withholdingTax;
        totalPostTaxPayout += preTaxPayout - withholdingTax;
      } else {
        totalPostTaxPayout += preTaxPayout;
      }
    }

    totalSettlementItemPayout += sumSellerPayoutItems(getSellerStatementItems(campaign));
  }

  // 부가 항목의 원천세는 **수수료분과 합산해 한 줄로** 공제한다(오너 확정) — 항목마다
  // 세후로 쪼개면 오너가 실제로 이체할 원천세 합계를 어디서도 읽을 수 없다.
  //
  // ⚠️ 수수료분 원천세 계산(`computeIndividualWithholding` 계열)의 계약은 건드리지 않고
  // 부가 항목분만 얹는다 — 그 함수는 원천징수 신고 리포트와 공유하는 SSOT 라, 식을
  // 바꾸면 명세서와 신고 금액이 갈린다.
  if (totalSettlementItemPayout !== 0) {
    const itemTax = isIndividual ? calcIndividualIncomeTax(totalSettlementItemPayout) : 0;
    totalWithholdingTaxOnly += itemTax;
    totalPostTaxPayout += totalSettlementItemPayout - itemTax;
  }

  return {
    isIndividual,
    totalSales,
    totalPreTaxPayout,
    totalPostTaxPayout,
    totalWithholdingTaxOnly,
    totalSettlementItemPayout,
  };
}

/**
 * 클립보드 `text/plain` 용 평문 명세서 — **셀러가 읽는 문서다.**
 *
 * ⚠️ **자사 마진을 절대 넣지 말 것**(AGENTS.md P0 "Seller-Facing Data Exposure", 오너 확정).
 * 영업이익·순이익·자사 순수수료율·총 수수료율은 내부 값이다. 클립보드는 `text/html` 과
 * `text/plain` 을 **함께** 실어보내므로, 평문만 내부 서식이면 메일 클라이언트가 평문을 고르는
 * 순간 마진이 셀러에게 그대로 간다 — 실제로 그런 상태였다:
 * 정산 **목록**은 이 서식(총 거래액·차인지급액·원천세)을 쓰는데 **상세 패널**은 자체 평문
 * 빌더로 `■ 재무 정산 상세(영업이익·순이익)` + `■ 정산 수수료율(자사 순수수료율)` 을 실어
 * 보냈다. HTML 은 양쪽이 같아 눈에 안 띄었고, 오너가 *"목록은 정상인데 상세만 다르게 작동"*
 * 으로 발견했다. 그래서 두 표면이 이 한 함수를 **공유**한다 — 갈라지면 또 새는 쪽이 생긴다.
 *
 * 검증 실패 시 `buildSettlementStatementHtml` 과 동일하게 throw 한다(수신자 불명 = 발행 불가).
 */
export function buildSettlementStatementText(campaigns: CampaignRow[], now = new Date()) {
  const validation = validateSettlementStatementCampaigns(campaigns);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const { recipient } = validation;
  const totals = computeSettlementPayoutTotals(campaigns);
  const won = (value: number) => `${Math.round(value).toLocaleString()}원`;
  const breakdown = totals.isIndividual
    ? `  (대행비 합계: ${won(totals.totalPreTaxPayout)}, 원천세 3.3%: ${won(totals.totalWithholdingTaxOnly)})`
    : (() => {
        const { supply, vat } = calcBusinessVatBreakdown(totals.totalPostTaxPayout);
        return `  (공급가액: ${won(supply)}, 부가세액: ${won(vat)})`;
      })();
  // 평문도 HTML 과 **같은 합계 함수**를 쓴다 — 두 표면이 갈리면 메일 클라이언트가
  // 평문을 고르는 순간 다른 금액이 셀러에게 간다(이 파일이 이미 한 번 낸 사고).
  const itemLine =
    totals.totalSettlementItemPayout !== 0
      ? `\n- 별도 지급 항목 (광고비 등): ${won(totals.totalSettlementItemPayout)}  ※ 수수료 정산과 별개`
      : "";

  return `
[정산 명세서]
정산 대상: ${recipient.label} (캠페인 ${campaigns.length}건)
발행일: ${now.toISOString().slice(0, 10)}

■ 정산 합계
- 총 거래액: ${won(totals.totalSales)}${itemLine}
- 차인지급액: ${won(totals.totalPostTaxPayout)}
${breakdown}
`.trim();
}

/**
 * 명세서 조각(`buildSettlementStatementHtml`)을 **인쇄용 완전 문서**로 감싼다 — PDF(브라우저 인쇄)
 * 표면의 정본이다.
 *
 * `buildSettlementStatementHtml` 은 `<div>` **조각**만 돌려주므로, 각 인쇄 경로가 자기 방식으로
 * `<html><head>` 를 감싸다가 갈라져 있었다(이메일·PDF·이미지가 평문 빌더 중복으로 갈라졌던
 * 사고와 같은 계열). 사이드패널은 조각을 그대로 써서 크롬 기본 머리말/꼬리말이 붙었고, 정산표는
 * `@page{margin:0}` 을 감쌌지만 `<title>` 은 없었다. 이제 세 경로가 이 함수 하나를 쓴다.
 *
 * **크롬 인쇄 머리말/꼬리말 4종(날짜·문서제목·URL·쪽번호)을 없애는 것은 `@page{margin:0}` 하나다.**
 * 이건 텍스트를 지우는 게 아니라 크롬이 그것들을 그리는 **여백 박스(margin box) 자체를 없애는** 것이라,
 * 제목이 무엇이든 상관없이 넷 다 사라진다(JS·헤더로는 못 끈다 — 브라우저 인쇄 설정 소관).
 *
 * ⚠️ **빈 `<title>` 은 인과적으로 무관하다(주석 정정 — ss-ux 검토 포렌식).** 크롬은 인쇄 머리말의
 * 제목을 **이 iframe 문서가 아니라 탑레벨 window 의 `document.title`** 에서 읽는다
 * (`privacy-mode-provider.tsx` 가 "W CRM" 으로 세팅·유지). 구버전 사이드패널은 iframe 에 `<title>` 을
 * 아예 안 줬는데도 "W CRM" 이 찍혔던 게 그 증거다. 빈 title 을 둔 건 무해하나, "title 을 넣으면 머리말이
 * 살아난다" 는 반대 결론을 내리지 말 것 — 머리말을 지우는 건 오직 `margin:0` 이다.
 *
 * ⚠️ `@page{margin:0}` 을 되돌려 여백을 주면 머리말/꼬리말이 되살아난다. 셀러에게 가는 문서라
 * 내부 URL(`crm.ygrd.kr/settlement?...`)이 꼬리말에 찍히는 건 P0 성격의 노출이기도 하다.
 *
 * 문서 자체 여백은 body 패딩으로 준다(`@page` 여백은 못 쓴다 — 0 이 아니면 머리말이 되살아난다).
 *
 * **다중 페이지 여백 완화책(적용됨 — 위 문서화된 후속 커밋).** body 상하 패딩(16mm)은 CSS 분할
 * 규칙상 **첫/마지막 장에만** 적용돼, 정산표 묶음(다중 캠페인)이 2페이지를 넘기면 중간 장 상단이
 * 용지 끝(0mm)에 붙는다. `@page{margin:0}` 을 유지해야 머리말/꼬리말이 안 살아나므로(위 P0),
 * @page 여백으로는 못 푼다. 대신 정본 조각(`buildCampaignHtml`)의 각 캠페인 블록에
 * `class="stmt-campaign-block"` 을 달아 두 규칙을 건다:
 *   1. `break-inside: avoid` — 블록이 장 경계에서 표 중간에 쪼개지지 않고 통째로 다음 장으로 넘어간다.
 *   2. `.stmt-campaign-block + .stmt-campaign-block { padding-top: 8mm }` — 넘어간 블록이 용지 상단에
 *      바짝 붙지 않게 상단 여백을 확보한다. **`margin` 이 아니라 `padding`** 인 이유: 크롬은 페이지
 *      경계에 걸린 박스의 상단 margin 을 절단하지만 padding 은 유지한다. 인접 형제 선택자라 첫 블록엔
 *      안 붙으므로 **단일 캠페인(사이드패널) 경로는 스타일이 그대로다**(1페이지라 완화책 불요).
 * ⚠️ 검증: 네이티브 인쇄창이 자동화를 막으므로 **headless 크롬(Playwright `page.pdf()`)** 으로
 * 2장+ 묶음을 렌더해 중간 장 상단 여백을 실측한다 — 정적 검사만으로 "완료" 보고 금지.
 */
export function buildSettlementStatementPrintDoc(campaigns: CampaignRow[], now = new Date()) {
  const body = buildSettlementStatementHtml(campaigns, now);
  return `<!DOCTYPE html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title></title>
    <style>
      @page { size: A4; margin: 0; }
      html, body { margin: 0; padding: 0; background-color: #ffffff; }
      body {
        padding: 16mm 14mm;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      /* 다중 페이지 완화책: 캠페인 블록이 장 경계에서 쪼개지지 않게 통째로 다음 장으로 넘긴다.
         body 상하 패딩(16mm)은 CSS 분할 규칙상 첫/마지막 장에만 적용되므로, 넘어간 블록이
         용지 상단에 바짝 붙지 않도록 블록 자체에 상단 여백을 준다. 크롬은 페이지 경계에서
         일반 margin 을 절단하므로 padding 으로 확보한다(margin-top 은 못 믿는다). */
      .stmt-campaign-block { break-inside: avoid; }
      .stmt-campaign-block + .stmt-campaign-block { padding-top: 8mm; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

/**
 * 명세서 이미지의 **파일명 SSOT** — `정산명세서_{수신자}_{발행일}.png`.
 *
 * 두 표면이 같은 함수로 같은 그림을 굽는데 **파일명만 갈라져 있었다**(T-023 오너 신고):
 * 정산 목록은 `정산명세서_{셀러}_{날짜}.png`, 캠페인 상세 패널은
 * `settlement-{캠페인id 앞 8자}.png` 였다. 셀러에게 파일을 그대로 전달하는 문서라
 * 상세에서 뽑으면 받는 쪽에 내부 식별자가 이름으로 가고, 오너 입장에서는 같은 버튼이
 * 표면마다 다른 이름을 뱉는다.
 *
 * ⛔ 호출부에서 파일명을 다시 조립하지 말 것 — 갈라진 원인이 그것이다
 * (`settlement-statement-surface-parity.contract.test.ts` 가 소스 스캔으로 막는다).
 *
 * 파일명은 **로컬 다운로드** 이름이라 수신자명(셀러/상호)을 담아도 P0 공개 노출이 아니다.
 * 경로 구분자·따옴표 등 파일 시스템이 싫어하는 문자는 제거한다.
 */
export function buildSettlementStatementFileName(campaigns: CampaignRow[], now = new Date()) {
  const validation = validateSettlementStatementCampaigns(campaigns);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const safeLabel = (validation.recipient.label || "셀러")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim() || "셀러";
  const issued = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `정산명세서_${safeLabel}_${issued}.png`;
}

/**
 * **html2canvas 의 폰트 기준선 프로브 복구** — 없으면 셀러가 받는 PNG 의 글자가 통째로
 * 아래로 밀린다(오너 신고 2026-08-19 「표마다 하단 정렬」의 진범).
 *
 * ## 무엇이 깨져 있나
 *
 * `html2canvas` 는 텍스트를 `fillText(…, bounds.top + baseline)` 로 그리고, 그 `baseline` 을
 * `FontMetrics.parseMetrics` 로 **실시간 측정**한다. 측정 방식은 **인라인 `<img>` 를
 * `vertical-align: baseline` 으로 세워 두고 `img.offsetTop - span.offsetTop` 을 읽는 것**이다.
 *
 * 그런데 Tailwind preflight 가 `img, svg, video, … { display: block }` 을 건다. 그러면 프로브의
 * img 가 **인라인이 아니라 자기 줄로 내려가서**, 반환되는 값이 폰트의 ascent 가 아니라
 * **줄 높이만큼 큰 값**이 된다. 그 값으로 모든 텍스트가 그려지므로 문서 전체가 아래로 밀린다.
 * 프로브 컨테이너는 `visibility: hidden` 이라 사람 눈에는 안 보이고, DOM·인쇄·메일 경로는
 * 멀쩡하다 — **PNG 에서만** 틀어진다.
 *
 * ## 실측 (앱 런타임 계측, 2배 좌표)
 *
 * | | 기준 행(높이 54) 위/아래 여백 | 중심 편차 |
 * | --- | --- | --- |
 * | 현행 | **위 29 / 아래 5** | **+12** |
 * | 이 복구 적용 | **위 17 / 아래 17** | **0** |
 *
 * 오너가 받은 원본 PNG 의 같은 행이 **위 29 / 아래 5** 로 정확히 일치했다(재현 확인).
 *
 * ⛔ **폰트 스택·`line-height` 로 고치려 하지 말 것 — 둘 다 실측으로 기각됐다**
 * (한글 폰트를 스택 맨 앞으로: +11.5 · 셀에 `line-height` 명시: 변화 없음). 원인은 문서가
 * 아니라 **측정기**다.
 *
 * ## 왜 셀렉터가 이렇게 생겼나
 *
 * 프로브 컨테이너는 클론이 아니라 **살아있는 `document.body`** 에 잠깐 붙고, 클래스도 id 도
 * 없이 인라인 스타일만 갖는다(`visibility: hidden` + `white-space: nowrap`). 그래서 그 조합으로
 * 특정한다. 전역 `img { display: inline }` 도 같은 결과를 내지만(실측 동일), 굽는 300ms 동안
 * **앱의 실제 이미지 레이아웃까지 흔들므로** 스코프를 좁힌 쪽을 쓴다.
 *
 * ⚠️ html2canvas 를 올리면 이 프로브 구현이 바뀔 수 있다 — 그때는 이 복구가 무해한 무동작이
 * 되는지 확인하고 걷어낸다. 판정은 `/settings/png-vcheck` 같은 실렌더 계측이지 코드 리뷰가
 * 아니다(격리 하네스는 preflight 가 없어 이 결함을 **재현하지 못한다** — 실제로 못 했다).
 */
const HTML2CANVAS_BASELINE_PROBE_FIX =
  'body > div[style*="visibility: hidden"][style*="white-space: nowrap"] > img { display: inline !important; }';

/**
 * 명세서를 PNG 로 굽는다 — **셀러가 받는 이미지다.**
 *
 * 화면을 캡처하지 않고 **정본 HTML(`buildSettlementStatementHtml`)을 오프스크린에 렌더해서
 * 찍는다.** 그래서 이메일·PDF·이미지 셋이 자동으로 같은 문서가 된다.
 *
 * ⚠️ **패널 DOM(`html2canvas(financialCardRef)`)을 캡처하는 방식으로 되돌리지 말 것.**
 * 그 패널은 내부 문서라 `영업이익 (자사 순수익)`·정산 수수료율이 렌더돼 있고, 캡처하면
 * 그대로 셀러에게 간다(P0 Seller-Facing Data Exposure) — 실제로 그 상태였다. 별도 SVG 를
 * 손으로 그리는 방식도 안 된다: 명세서의 **세 번째 표현**이 생겨 또 갈라진다(이 파일이
 * 겪은 사고가 정확히 그것 — HTML 은 셀러용인데 평문만 내부용이었다).
 *
 * 브라우저 전용(`document`·`html2canvas`). 서버에서 부르지 말 것.
 */

export async function renderSettlementStatementPng(campaigns: CampaignRow[]): Promise<string> {
  const html = buildSettlementStatementHtml(campaigns);
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.top = "-9999px";
  container.style.left = "-9999px";
  container.style.width = "760px";

  // ⚠️ 아래 프로브 복구 없이 구우면 **문서 전체 글자가 아래로 밀린다**(P0 성격은 아니나
  // 셀러가 받는 문서다). 근거는 `HTML2CANVAS_BASELINE_PROBE_FIX` 주석.
  const probeFix = document.createElement("style");
  probeFix.setAttribute("data-html2canvas-probe-fix", "");
  probeFix.textContent = HTML2CANVAS_BASELINE_PROBE_FIX;

  try {
    document.head.appendChild(probeFix);
    container.innerHTML = html;
    document.body.appendChild(container);
    // 이미지 로드·웹폰트 렌더링 대기 — 목록 표면이 쓰던 값 그대로.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const html2canvas = (await import("html2canvas")).default;
    const canvas = await html2canvas(container, {
      useCORS: true,
      scale: 2,
      backgroundColor: "#ffffff",
      logging: false,
    });
    return canvas.toDataURL("image/png");
  } finally {
    if (document.body.contains(container)) {
      document.body.removeChild(container);
    }
    if (probeFix.parentNode) {
      probeFix.parentNode.removeChild(probeFix);
    }
  }
}

/**
 * Builds one printable Rich HTML settlement statement for one or more campaigns.
 */
export function buildSettlementStatementHtml(campaigns: CampaignRow[], now = new Date()) {
  const validation = validateSettlementStatementCampaigns(campaigns);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const { recipient } = validation;
  // 순서는 정본 빌더가 정한다 — 문서번호까지 이 순서에서 파생되므로, 같은 캠페인 묶음이면
  // 오너가 정산표를 어떻게 정렬해 뒀든 **같은 문서번호·같은 배열**이 나온다.
  const ordered = sortStatementCampaigns(campaigns);
  const issuedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const docNumber = `WAG-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${ordered.map((campaign) => campaign.id.slice(0, 3)).join("").slice(0, 9).toUpperCase()}`;
  const isIndividual = isIndividualSeller(ordered[0]);

  // ⛔ 합계는 `computeSettlementPayoutTotals` 하나가 소유한다 — HTML·평문·PNG 가
  // 각자 계산하면 갈린다(이 파일이 실제로 낸 사고 계열). 종전 이 자리의 인라인 루프는
  // 그 함수와 같은 식이었으나 부가 항목이 붙으면서 두 번째 진실이 될 위험이 생겨 제거했다.
  const {
    totalSales,
    totalPreTaxPayout,
    totalPostTaxPayout,
    totalWithholdingTaxOnly,
    totalSettlementItemPayout,
  } = computeSettlementPayoutTotals(campaigns);

  const payoutDates = Array.from(
    new Set(
      ordered
        .map((c) => c.expectedPayoutDate)
        .filter(Boolean)
        .map((d) => formatDate(d))
    )
  );
  const payoutDateStr = payoutDates.length > 0 ? payoutDates.join(", ") : "-";

  /**
   * 별도 지급 항목 줄 — 대상=셀러 부가 항목이 있을 때만 만든다(없으면 현행과 바이트 동일).
   * 「수수료 정산과 별개」를 명시해 셀러가 다음 회차 정산 기준에 이 금액이 포함된다고
   * 오해하지 않게 한다(오너 확정).
   */
  const settlementItemRow =
    totalSettlementItemPayout !== 0
      ? `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 8px 4px; color: #475569;">별도 지급 항목 (광고비 등)<span style="color: #64748b; font-size: 11px;"> · 수수료 정산과 별개</span></td>
        <td style="padding: 8px 4px; text-align: right; font-weight: 700; color: #334155;">${formatCurrency(totalSettlementItemPayout)}</td>
      </tr>`
      : "";

  const businessSummary = `
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 12px;">
      <tr style="border-top: 2px solid #334155; border-bottom: 1px solid #cbd5e1; font-weight: 600;">
        <td style="padding: 8px 4px; color: #475569;">구분</td>
        <td style="padding: 8px 4px; text-align: right; color: #475569;">금액</td>
      </tr>
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 8px 4px; color: #475569;">총 거래액</td>
        <td style="padding: 8px 4px; text-align: right; font-weight: 700; color: #334155;">${formatCurrency(totalSales)}</td>
      </tr>
      ${settlementItemRow}
      <tr style="border-bottom: 1px solid #e2e8f0; background-color: #f8fafc; font-weight: 700;">
        <td style="padding: 10px 4px; color: #1e293b; font-size: 13px;">차인지급액 (정산금)</td>
        <td style="padding: 10px 4px; text-align: right; color: #1e293b; font-size: 13px;">${formatCurrency(totalPostTaxPayout)}</td>
      </tr>
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 8px 4px; color: #64748b; padding-left: 12px;">├ 공급가액 합계</td>
        <td style="padding: 8px 4px; text-align: right; color: #475569;">${formatCurrency(calcBusinessVatBreakdown(totalPostTaxPayout).supply)}</td>
      </tr>
      <tr style="border-bottom: 2px solid #334155;">
        <td style="padding: 8px 4px; color: #64748b; padding-left: 12px;">└ 부가세액 합계</td>
        <td style="padding: 8px 4px; text-align: right; color: #475569;">${formatCurrency(calcBusinessVatBreakdown(totalPostTaxPayout).vat)}</td>
      </tr>
    </table>
  `;

  const individualSummary = `
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 12px;">
      <tr style="border-top: 2px solid #334155; border-bottom: 1px solid #cbd5e1; font-weight: 600;">
        <td style="padding: 8px 4px; color: #475569;">구분</td>
        <td style="padding: 8px 4px; text-align: right; color: #475569;">금액</td>
      </tr>
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 8px 4px; color: #475569;">총 거래액</td>
        <td style="padding: 8px 4px; text-align: right; font-weight: 700; color: #334155;">${formatCurrency(totalSales)}</td>
      </tr>
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 8px 4px; color: #64748b; padding-left: 12px;">└ 공급가액</td>
        <td style="padding: 8px 4px; text-align: right; color: #475569;">${formatCurrency(Math.round(totalSales / 1.1))}</td>
      </tr>
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 8px 4px; color: #475569;">판매 대행비 합계</td>
        <td style="padding: 8px 4px; text-align: right; font-weight: 700; color: #334155;">${formatCurrency(totalPreTaxPayout)}</td>
      </tr>
      ${settlementItemRow}
      <tr style="border-bottom: 1px solid #cbd5e1;">
        <td style="padding: 8px 4px; color: ${STMT_DEDUCTION_TEXT}; padding-left: 12px;">└ 원천세 (3.3%)${totalSettlementItemPayout !== 0 ? "<span style=\"color: #64748b; font-size: 11px; font-weight: 400;\"> · 대행비 + 별도 지급 항목 합산</span>" : ""}</td>
        <td style="padding: 8px 4px; text-align: right; color: ${STMT_DEDUCTION_TEXT};">${totalWithholdingTaxOnly > 0 ? `-${formatCurrency(totalWithholdingTaxOnly)}` : "0원"}</td>
      </tr>
      <tr style="border-bottom: 2px solid #334155; background-color: #f8fafc; font-weight: 700;">
        <td style="padding: 10px 4px; color: #1e293b; font-size: 13px;">차인지급액 (세후)</td>
        <td style="padding: 10px 4px; text-align: right; color: #1e293b; font-size: 13px;">${formatCurrency(totalPostTaxPayout)}</td>
      </tr>
    </table>
  `;

  const taxInvoiceBlock = `
    <div style="margin: 24px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #1e293b; margin-bottom: 6px;">[세금계산서 발행 정보 (공급받는 자)]</div>
      <table style="width: 100%; border-collapse: collapse; font-size: 11px; border: 1px solid #cbd5e1;">
        <tr>
          <td style="padding: 6px; color: #475569; background-color: #f1f5f9; border: 1px solid #cbd5e1; width: 120px; font-weight: 600;">발행 대상 금액</td>
          <td style="padding: 6px; color: #1e293b; border: 1px solid #cbd5e1; font-weight: 700; font-size: 12px;">${formatCurrency(totalPostTaxPayout)}</td>
        </tr>
        ${payoutDateStr !== "-" ? `
        <tr>
          <td style="padding: 6px; color: #475569; background-color: #f1f5f9; border: 1px solid #cbd5e1; font-weight: 600;">입금 예정일</td>
          <td style="padding: 6px; color: #166534; border: 1px solid #cbd5e1; font-weight: 700;">${payoutDateStr}</td>
        </tr>
        ` : ""}
        <tr>
          <td style="padding: 6px; color: #475569; background-color: #f1f5f9; border: 1px solid #cbd5e1; font-weight: 600;">상호 (법인명)</td>
          <td style="padding: 6px; color: #1e293b; border: 1px solid #cbd5e1; font-weight: 600;">${escapeHtml(YGRD_COMPANY.name)}</td>
        </tr>
        <tr>
          <td style="padding: 6px; color: #475569; background-color: #f1f5f9; border: 1px solid #cbd5e1; font-weight: 600;">등록번호</td>
          <td style="padding: 6px; color: #1e293b; border: 1px solid #cbd5e1; font-weight: 600;">${escapeHtml(formatBusinessNumber(YGRD_COMPANY.businessNumber))}</td>
        </tr>
        <tr>
          <td style="padding: 6px; color: #475569; background-color: #f1f5f9; border: 1px solid #cbd5e1; font-weight: 600;">대표자명</td>
          <td style="padding: 6px; color: #1e293b; border: 1px solid #cbd5e1;">${escapeHtml(YGRD_COMPANY.ceo)}</td>
        </tr>
        <tr>
          <td style="padding: 6px; color: #475569; background-color: #f1f5f9; border: 1px solid #cbd5e1; font-weight: 600;">소재지</td>
          <td style="padding: 6px; color: #1e293b; border: 1px solid #cbd5e1; line-height: 1.4;">${escapeHtml(YGRD_COMPANY.address)}</td>
        </tr>
        <tr>
          <td style="padding: 6px; color: #475569; background-color: #f1f5f9; border: 1px solid #cbd5e1; font-weight: 600;">업태/종목</td>
          <td style="padding: 6px; color: #1e293b; border: 1px solid #cbd5e1;">${escapeHtml(YGRD_COMPANY.type)}</td>
        </tr>
        <tr>
          <td style="padding: 6px; color: #475569; background-color: #f1f5f9; border: 1px solid #cbd5e1; font-weight: 600;">이메일</td>
          <td style="padding: 6px; color: #1e293b; border: 1px solid #cbd5e1;">${escapeHtml(YGRD_COMPANY.email)}</td>
        </tr>
      </table>
    </div>
  `;

  return `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 760px; margin: 0 auto; padding: 24px; border: 1px solid #cbd5e1; background-color: #ffffff; color: #334155;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #334155; padding-bottom: 12px; margin-bottom: 18px;">
        <h2 style="margin: 0; font-size: 20px; font-weight: 800; color: #1e293b;">정산 명세서</h2>
        <div style="text-align: right; font-size: 11px; color: #64748b; line-height: 1.6;"><div>문서번호: ${docNumber}</div><div>발행일: ${issuedDate}</div></div>
      </div>
      <div style="font-size: 12px; margin-bottom: 14px;">정산 대상: <strong>${escapeHtml(recipient.label)}</strong> (캠페인 ${campaigns.length}건)</div>
      ${buildRecipientHtml(recipient)}
      ${isIndividual ? individualSummary : businessSummary}
      ${isIndividual && payoutDateStr !== "-" ? `
      <div style="margin-bottom: 24px; font-size: 12px; color: #166534; font-weight: 600; text-align: right;">
        * 입금 예정일: <span style="font-weight: 700; text-decoration: underline;">${payoutDateStr}</span>
      </div>
      ` : ""}
      ${!isIndividual ? taxInvoiceBlock : ""}
      <div style="margin: 32px 0 10px; font-size: 13px; font-weight: 700; color: #1e293b; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px;">캠페인별 매출 상세 내역</div>
      ${ordered.map(c => buildCampaignHtml(c, isIndividual)).join("")}
    </div>
  `;
}
