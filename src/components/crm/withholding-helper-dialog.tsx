"use client";

/**
 * 원천징수 입력 도우미 — 캠페인 1건, 홈택스 수기 입력 가이드(개인 셀러 전용).
 *
 * 개인(비사업자) 셀러는 세금계산서를 주고받지 않는다 — 우리가 수수료에서 3.3%를
 * 떼고 지급하며, 그 원천세를 우리가 직접 신고한다. 그래서 트리거 게이트는 세금계산서
 * 도우미(`tax-invoice-helper-dialog.tsx`)와 다르다: 채널 조건이 없다. 원천징수는
 * 셀러 수수료를 지급하는 모든 채널에서 발생하고(`buildWithholdingReport`가 채널로
 * 걸러내지 않는 것과 동일), `isIndividualSeller(campaign)` 하나면 충분하다 — 여기서
 * 세금계산서 쪽의 `resolveTaxFilingChannelGroup === "SELLER_MALL"` 게이트를 그대로
 * 베끼면 우리몰·브랜드몰의 개인 셀러가 도우미를 못 열게 되는 사고가 난다.
 *
 * 금액 SSOT: `computeIndividualWithholding` + `getStatementDeals` — 원천징수 신고
 * 리포트(`withholding-report.ts`)가 쓰는 바로 그 쌍이다. 셀러에게 이미 발송된 정산
 * 명세서와 1원이라도 갈리면 안 되므로 여기서 다시 계산하지 않는다.
 *
 * ⚠️ 이 다이얼로그는 캠페인 1건 자료다. 홈택스 원천세 신고는 **월 합계** 단위라,
 * 이 숫자만 그대로 신고서에 옮기면 틀린다(다른 캠페인·다른 셀러 몫이 빠진다). 하단
 * 경고가 이 사실과, 월 합계를 확인할 경로(정산 페이지의 「세무 처리」 → 원천징수 탭)를
 * 함께 안내한다 — 이 다이얼로그를 만드는 순간 생기는 위험이므로 같은 변경에서 막는다.
 *
 * 금액 칸 이름(총 지급액(세전)·소득세)은 위 「세무 처리」 탭(`withholding-filing-cards.tsx`)과
 * 같은 어휘다(T-028/T-029, 2026-08-11) — 이 다이얼로그가 그 월 합계 화면으로 오너를
 * 보내는 문구를 담고 있으므로, 두 화면이 같은 칸을 다른 이름으로 부르면 옮겨 간 곳에서
 * 다시 헷갈린다. 한쪽만 고치지 말 것.
 */
import { useState } from "react";
import { AlertTriangle, Copy, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { CampaignRow } from "@/lib/crm-types";
import { getStatementDeals } from "@/lib/settlement-statement";
import { computeIndividualWithholding } from "@/lib/seller-tax-utils";
import { maskResidentNumber, splitWithholdingTax } from "@/lib/withholding-report";
import { FieldRow } from "./helper-dialog-field-row";

function formatWon(value: number): string {
  return `${value.toLocaleString("ko-KR")}원`;
}

// 한 필드 행(라벨+값+행별 복사)은 세금계산서 도우미와 공유하는 `FieldRow`
// (`helper-dialog-field-row.tsx`)를 그대로 쓴다 — 로컬 복제가 폰트 크기 드리프트로
// 이어진 실사고(design review 2026-08-05) 이후 공유 컴포넌트로 뺐다.

/** 실명 행 — `Seller.realName`이 없으면 활동명으로 대신 채우지 않는다(신고서에는
 *  법적 실명이 실려야 한다, `withholding-report.ts` 계약과 동일). 다만 "누가"
 *  미입력인지는 알아야 오너가 실제로 고칠 수 있으므로 별칭을 괄호로 병기한다
 *  (`withholding-filing-cards.tsx`와 동일한 표기 방식). */
function RealNameRow({ realName, alias }: { realName: string | null; alias: string }) {
  const handleCopy = async () => {
    if (!realName) return;
    try {
      await navigator.clipboard.writeText(realName);
      toast.success("복사되었습니다");
    } catch {
      toast.error("복사에 실패했습니다");
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50/50 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-muted-foreground">실명</div>
        {realName ? (
          <div className="truncate text-sm font-medium text-slate-800">{realName}</div>
        ) : (
          <div className="flex items-center gap-1.5 text-sm font-semibold text-status-urgent-text">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-urgent" />
            <span>입력 필요</span>
            <span className="text-xs font-normal text-muted-foreground">({alias}: 활동명, 실명 아님)</span>
          </div>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="복사"
        disabled={!realName}
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-40"
        onClick={() => void handleCopy()}
      >
        <Copy className="size-3.5" />
      </Button>
    </div>
  );
}

/** 주민등록번호 행 — 기본 마스킹, 이 행에서만 펼침(P0). 캠페인이 바뀌면 이 컴포넌트가
 *  포함된 다이얼로그 트리(부모 `open` 토글)가 다시 마운트되므로, 펼침 상태를 로컬
 *  useState 로 둬도 다른 캠페인으로 전환됐을 때 초기값(마스킹)으로 항상 돌아온다. */
function ResidentNumberRow({ residentNumber }: { residentNumber: string | null }) {
  const [revealed, setRevealed] = useState(false);
  const hasValue = residentNumber != null && residentNumber !== "";

  const handleCopy = async () => {
    if (!residentNumber) return;
    try {
      await navigator.clipboard.writeText(residentNumber);
      toast.success("복사되었습니다");
    } catch {
      toast.error("복사에 실패했습니다");
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50/50 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-muted-foreground">주민등록번호</div>
        {hasValue ? (
          <div className="truncate font-mono text-sm font-medium text-slate-800">
            {revealed ? residentNumber : maskResidentNumber(residentNumber)}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-sm font-semibold text-status-urgent-text">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-urgent" />
            입력 필요
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {hasValue ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={revealed ? "주민등록번호 가리기" : "주민등록번호 보기"}
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => setRevealed((prev) => !prev)}
          >
            {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="복사"
          disabled={!hasValue}
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-40"
          onClick={() => void handleCopy()}
        >
          <Copy className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function WithholdingHelperDialog({
  campaign,
  open,
  onOpenChange,
}: {
  campaign: CampaignRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // ⛔ 금액 SSOT는 `computeIndividualWithholding` + `getStatementDeals` 하나다.
  // `withholding-report.ts`와 정산 명세서가 이미 이 쌍을 쓴다 — 여기서 다시 딜을
  // 합산하거나 3.3%를 새로 계산하면 세 표면의 숫자가 갈릴 여지가 생긴다.
  const { preTaxPayout, withholdingTax, postTaxPayout } = computeIndividualWithholding({
    deals: getStatementDeals(campaign),
    campaignSellerMarginRate: campaign.sellerMarginRate,
    savedSellerExpense: campaign.sellerExpense != null ? Number(campaign.sellerExpense) : null,
  });
  const hasPayout = preTaxPayout > 0;

  // 소득세(3%)·지방소득세(0.3%) 분리는 `splitWithholdingTax`(withholding-report.ts)가
  // SSOT다 — 공식을 여기 복사하지 않는다. 월별 리포트와 이 도우미가 각자 계산하면
  // 한쪽만 바뀌었을 때 화면과 신고서가 조용히 갈린다.
  //
  // 여기 지방소득세는 "실제로 뗀 명세서상 금액"이고, 위택스 신고 세액은 위택스가
  // 과세표준(소득세)에서 자동계산한다 — 두 값을 섞지 않는다(설계 문서
  // 「지방소득세 — 명세서 값과 신고 값을 구분한다」).
  const { incomeTax, localIncomeTax } = hasPayout
    ? splitWithholdingTax(preTaxPayout, withholdingTax)
    : { incomeTax: 0, localIncomeTax: 0 };

  const payoutMonth = campaign.payoutCompletedAt?.slice(0, 7) ?? null;
  const realName = campaign.sellerRealName ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>원천징수 입력 도우미</DialogTitle>
          <DialogDescription>{campaign.campaignName ?? campaign.dealName}</DialogDescription>
        </DialogHeader>

        <div className="grow overflow-y-auto pr-1 [scrollbar-gutter:stable]">
          <div className="flex flex-col gap-5">
            <section>
              <h3 className="text-sm font-semibold text-foreground">소득자</h3>
              <div className="mt-2 flex flex-col gap-2">
                <RealNameRow realName={realName} alias={campaign.sellerName} />
                <ResidentNumberRow residentNumber={campaign.sellerResidentNumber ?? null} />
              </div>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-foreground">금액</h3>
              <div className="mt-2 flex flex-col gap-2">
                <FieldRow label="지급일" value={campaign.payoutCompletedAt ?? null} />
                <FieldRow label="총 지급액(세전)" value={hasPayout ? formatWon(preTaxPayout) : null} />
                <FieldRow label="소득세" value={hasPayout ? formatWon(incomeTax) : null} />
                <FieldRow label="지방소득세" value={hasPayout ? formatWon(localIncomeTax) : null} />
                <FieldRow label="차인지급액" value={hasPayout ? formatWon(postTaxPayout) : null} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                지방소득세는 실제로 뗀 명세서상 금액입니다. 위택스 신고 세액은 과세표준(소득세)에서
                위택스가 자동계산하며 원단위 절사가 붙어 이 값과 1원 이상 다를 수 있습니다. 오차가 아니라
                계산 기준이 다른 것입니다.
              </p>
            </section>
          </div>
        </div>

        {/* 함정 방지(설계 문서 필수 요소) — 이 캠페인 1건 자료를 그대로 신고서에 옮기면
            틀린다. 홈택스 원천세 신고는 지급월 합계 단위이기 때문이다. 스크롤 영역 안에
            두면 필드가 늘어날 때 스크롤을 내려야만 보이는 요소가 되므로(design review
            2026-08-05), 스크롤 영역과 형제인 shrink-0 블록으로 둬 "안 스크롤돼도 항상
            보인다"를 오늘의 행 개수가 아니라 레이아웃이 보장하게 한다. 색은 심각도
            축으로만 쓴다(status-urgent) — 이 화면에서 가장 위험한 오입력이므로
            형태(아이콘)로도 함께 표시해 색맹 사용자·빠른 스캔 모두 놓치지 않게 한다. */}
        <div className="mt-3 shrink-0 border-t border-border pt-3">
          <div className="flex items-start gap-2 rounded-lg border border-status-urgent/20 bg-status-urgent-bg px-3 py-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-urgent-text" aria-hidden="true" />
            <div>
              <p className="text-xs font-semibold text-status-urgent-text">
                홈택스 원천세 신고는 월 합계 단위입니다. 이 캠페인 1건의 숫자만 넣지 마세요.
              </p>
              <p className="mt-1 text-xs text-status-urgent-text">
                {payoutMonth
                  ? `${payoutMonth} 지급분 월 합계는 `
                  : "지급일 확정 후, 해당 월 합계는 "}
                정산(/settlement) 페이지 → 「세무 처리」 버튼 → 「원천징수」 탭에서 확인하세요
                {payoutMonth ? `(월 선택에서 ${payoutMonth}로 변경)` : ""}.
              </p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
