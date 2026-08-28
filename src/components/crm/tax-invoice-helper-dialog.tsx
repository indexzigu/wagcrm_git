"use client";

/**
 * 세금계산서 입력 도우미 — 캠페인 1건, 홈택스 수기 입력 가이드.
 *
 * 오너는 홈택스 화면에 필드를 하나씩 직접 입력한다. 그래서 이 다이얼로그는 붙여넣을
 * 문단 하나를 만들지 않는다 — 라벨 + 값 + 필드별 복사 버튼을 나열해, 오너가 홈택스
 * 필드를 보면서 대응되는 값만 복사해 옮기게 한다. 한 덩어리 텍스트는 오너가 직접
 * 다시 쪼개야 해서 오히려 느리다.
 *
 * 값이 없는 필드는 절대 빈칸으로 두지 않는다 — 빈칸은 "안 채워도 된다"로 오인되어
 * 신고가 누락된 채 접수되고, 홈택스는 그 상태로 반려한다. 대신 심각도 색(P8
 * status-urgent)으로 「입력 필요」를 표시하고 복사 버튼을 비활성화한다.
 *
 * ⛔ 도메인을 이 레포에서 세 번째로 잘못 짚었던 지점(2026-08-04 정정): 이 다이얼로그는
 * 원래 "우리가 항상 셀러에게 총매출 세금계산서를 발행한다"는 가정으로 만들어졌다.
 * 실제로는 (1) 상대에게 발행하는 채널은 셀러몰뿐이고(우리몰은 발행 자체가 없고,
 * 브랜드몰의 발행 상대는 공급사다) (2) 그 발행 금액도 총매출이 아니라
 * `actualSales − sellerExpense`(셀러 수수료를 뺀 금액)다. 트리거 노출은
 * 사이드패널(`campaign-side-panel.tsx`의 `isSellerMallInvoiceChannel`)이 채널로
 * 게이트하고, 금액은 `resolveSellerIssueInvoiceObligation`(tax-filing-board.ts)
 * 하나로만 계산한다 — 두 곳 다 다시 손으로 채널 분기나 금액 식을 베끼면 이 사고가
 * 네 번째로 재발한다.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CampaignGroupMemberRow, CampaignRow } from "@/lib/crm-types";
import { buildInvoiceLineItems, normalizeBusinessNumber } from "@/lib/tax-invoice-builder";
import { resolveSellerIssueInvoiceObligation } from "@/lib/tax-filing-board";
import { FieldRow } from "./helper-dialog-field-row";

function formatAmount(value: number): string {
  return value.toLocaleString("ko-KR");
}

/**
 * "지금"의 KST 캘린더 날짜를 로컬 getter(getFullYear/getMonth/getDate)로 그대로 읽어도
 * 맞는 Date 객체로 만든다. 작성일자(todayYmd) 표시가 자정 근처 비-KST 브라우저에서
 * 실제 KST 날짜와 하루 어긋나지 않도록 시각 기준을 이 한 곳에서 고정한다.
 */
function resolveKstDate(): Date {
  const kstInstant = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return new Date(kstInstant.getUTCFullYear(), kstInstant.getUTCMonth(), kstInstant.getUTCDate());
}

function todayYmd(kstDate: Date): string {
  const y = kstDate.getFullYear();
  const m = String(kstDate.getMonth() + 1).padStart(2, "0");
  const d = String(kstDate.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 한 필드 행(라벨+값+행별 복사)은 `withholding-helper-dialog.tsx`와 공유하는
// `FieldRow`(`helper-dialog-field-row.tsx`)를 그대로 쓴다 — 로컬 복제가
// 폰트 크기 드리프트로 이어진 실사고(design review 2026-08-05) 이후 공유
// 컴포넌트로 뺐다. 결번 표시가 점(dot) 글리프로 색과 형태 둘 다 구분되는 것도
// 그 공유 컴포넌트의 계약이다.

export function TaxInvoiceHelperDialog({
  campaign,
  groupMembers,
  open,
  onOpenChange,
}: {
  campaign: CampaignRow;
  /**
   * 정산 그룹 소속이면 그룹 멤버 전원(자기 자신 포함) — Finding 2(2026-08-04
   * 재검토): 보드는 그룹 세금계산서를 멤버 전원 합산 1건으로 취급하는데, 이
   * 다이얼로그가 캠페인 1건 금액만 보여주면 오너가 두 표면에서 서로 다른 숫자를
   * 보게 된다. 미제공(또는 1건뿐)이면 캠페인 단독 금액으로 동작한다(기존 동작 유지
   * — 무그룹 캠페인, 또는 그룹이지만 호출부가 아직 형제 데이터를 로드하지 않은
   * 과도기 렌더).
   */
  groupMembers?: CampaignGroupMemberRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const businessNumber = campaign.sellerCompanyBusinessNumber
    ? normalizeBusinessNumber(campaign.sellerCompanyBusinessNumber)
    : null;

  const kstDate = resolveKstDate();

  // ⛔ 금액 SSOT는 `resolveSellerIssueInvoiceObligation`(tax-filing-board.ts) 하나다.
  // 옛 코드는 `mapLineItems`(딜별 actualSales 합산)를 썼는데, 그 결과는
  // 사실상 `actualSales/1.1` — 셀러몰 발행 기준(스펙 「⛔ 채널별 세금계산서 거래
  // 구조」표)인 `actualSales−sellerExpense`보다 셀러 수수료 전액만큼 과다표시됐다.
  // 오너가 이 숫자를 홈택스에 그대로 손으로 입력하는 경로라 되돌릴 수 없는 오신고로
  // 이어진다(같은 도메인을 이 레포가 세 번째로 잘못 짚은 사고). 이 다이얼로그는
  // 이제 그 함수의 계산을 그대로 쓰고 다시 계산하지 않는다.
  //
  // 이 버튼은 채널이 셀러몰일 때만 노출되도록 사이드패널에서 게이트가 걸려 있지만
  // (SellerSettlementInfo의 isSellerMallInvoiceChannel), 그 게이트를 건너뛴 경로가
  // 생겨도 여기서 금액을 추정해 채우지 않는다 — obligation이 null이면(우리몰·
  // 브랜드몰처럼 셀러 발행 의무 자체가 없는 채널) 그대로 「입력 필요」로 떨어진다.
  const obligation = resolveSellerIssueInvoiceObligation(
    campaign,
    // ⚠️ 필드를 **골라 넘기지 말 것** — 여기서 빠뜨린 필드는 오류 없이 조용히 0으로
    //    취급된다(설계 §9-6-2 가 발행 기대건 빌더에서 잡은 것과 같은 부류의 함정).
    //    `settlementItems` 가 빠지면 보드보다 작은 금액이 표시되고, 오너는 그 숫자를
    //    홈택스에 손으로 입력한다.
    groupMembers?.map((m) => ({
      salesChannel: m.salesChannel,
      actualSales: m.actualSales,
      sellerExpense: m.sellerExpense,
      settlementItems: m.settlementItems,
    })),
  );
  const hasSettledAmount = obligation != null && obligation.blockingReasons.length === 0;
  const supplyAmount = hasSettledAmount ? obligation.amount.supplyAmount : 0;
  const taxAmount = hasSettledAmount ? obligation.amount.taxAmount : 0;
  const totalAmount = supplyAmount + taxAmount;
  const isGroupAmount = obligation?.isGroupAmount === true;

  // 품목 — **딜별로 쪼개지 않는다.** 위 금액 SSOT는 캠페인 전체의 한 값이지 딜별
  // 실매출이 아니다. 옛 `mapLineItems`처럼 딜별 actualSales로 쪼개 합산하면 그 합이
  // 다시 actualSales 총액(이 파일이 고치려는 바로 그 과다표시)으로 돌아간다.
  //
  // 다만 **부가 항목은 별도 행으로 나눈다**(오너 확정, 설계 §3-3 — 1행 상품 매출,
  // 2행 부대비용). 분리 규칙(잔차 흡수·4품목 상한)은 XLSX 빌더와 **같은 함수**를
  // 쓴다 — 여기서 다시 쪼개면 사이드패널에서 손으로 입력한 계산서와 일괄 업로드한
  // 계산서의 품목 구성이 갈린다.
  const lineItems = hasSettledAmount
    ? buildInvoiceLineItems({
        mainName: isGroupAmount
          ? `${campaign.campaignName ?? campaign.dealName} 외 그룹 ${obligation!.memberCount - 1}건`
          : campaign.campaignName ?? campaign.dealName,
        amount: obligation!.amount,
        appliedItems: obligation!.settlementItemEffect.applied,
      }).map((item) => ({
        name: item.name,
        // 수량 1 · 단가를 공급가액으로 두면 표의 수량×단가가 공급가액과 그대로 일치해
        // 오너가 홈택스 화면에 그대로 옮겨 적을 수 있다(이 다이얼로그 전용 표기).
        quantity: 1,
        unitPrice: item.supplyAmount,
      }))
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>세금계산서 입력 도우미</DialogTitle>
          <DialogDescription>{campaign.campaignName ?? campaign.dealName}</DialogDescription>
        </DialogHeader>

        <div className="grow overflow-y-auto pr-1 [scrollbar-gutter:stable]">
          <div className="flex flex-col gap-5">
            <section>
              <h3 className="text-sm font-semibold text-foreground">공급받는자</h3>
              <div className="mt-2 flex flex-col gap-2">
                <FieldRow label="사업자등록번호" value={businessNumber} />
                <FieldRow label="상호" value={campaign.sellerCompanyName} />
                <FieldRow label="대표자명" value={campaign.sellerCompanyCeoName} />
                <FieldRow label="사업장주소" value={campaign.sellerCompanyAddress} wrap />
                <FieldRow label="업태" value={campaign.sellerCompanyBusinessType} />
                <FieldRow label="종목" value={campaign.sellerCompanyBusinessItem} />
                <FieldRow label="이메일" value={campaign.sellerCompanyEmail} />
              </div>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-foreground">금액</h3>
              {isGroupAmount ? (
                // Finding 2 — 이 금액은 캠페인 1건이 아니라 정산 그룹 멤버 전원의
                // 합산이다(세무 처리 보드와 동일 계산). 이 사실을 숨기면 오너가 이
                // 캠페인 하나에 그대로 발행해 셀러몰에 과다·누락 청구하게 된다.
                <p className="mt-2 rounded-lg border border-slate-100 bg-slate-50/50 px-3 py-2 text-xs font-medium text-muted-foreground">
                  정산 그룹 전체({obligation!.memberCount}건 합산) 금액입니다. 이 캠페인 1건의 금액이
                  아닙니다.
                </p>
              ) : null}
              <div className="mt-2 flex flex-col gap-2">
                <FieldRow label="작성일자" value={todayYmd(kstDate)} />
                <FieldRow label="공급가액" value={hasSettledAmount ? formatAmount(supplyAmount) : null} />
                <FieldRow label="세액" value={hasSettledAmount ? formatAmount(taxAmount) : null} />
                <FieldRow label="합계" value={hasSettledAmount ? formatAmount(totalAmount) : null} />
              </div>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-foreground">품목</h3>
              {lineItems.length > 0 ? (
                <div className="mt-2 overflow-x-auto rounded-lg border border-slate-100">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50/50 text-left text-[10px] uppercase text-muted-foreground">
                        <th className="px-3 py-2 font-medium">딜명</th>
                        <th className="px-3 py-2 text-right font-medium">수량</th>
                        <th className="px-3 py-2 text-right font-medium">단가</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineItems.map((item, idx) => (
                        <tr key={`${item.name}-${idx}`} className="border-b border-slate-50 last:border-b-0">
                          <td className="px-3 py-2 text-slate-800">{item.name}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-800">{item.quantity}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-800">
                            {formatAmount(item.unitPrice)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                // 금액이 확정되지 않은 상태(정산금 미확정 등)에서는 품목도 만들 수 없다.
                // 위 금액 필드와 마찬가지로 빈 표를 보여주지 않고 「입력 필요」로 명시한다.
                <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-slate-100 bg-slate-50/50 px-3 py-2 text-sm font-semibold text-status-urgent-text">
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-urgent" />
                  입력 필요: 금액이 확정되지 않아 품목을 만들 수 없습니다
                </div>
              )}
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
