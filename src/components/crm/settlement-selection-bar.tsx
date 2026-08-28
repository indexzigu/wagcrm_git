"use client";

import { useMemo } from "react";
import { createPortal } from "react-dom";
import { Copy, Printer, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { toast } from "sonner";
import { MONEY_DIRECTION_ICON, MONEY_DIRECTION_TEXT } from "@/lib/money-direction";
import { resolveProfitTone, PROFIT_TONE_TEXT } from "@/lib/profit-tone";
import { cn } from "@/lib/utils";
import type { CampaignRow } from "@/lib/crm-types";
import {
  buildPartnerSettlementBreakdown,
  type PartnerSettlementBreakdown,
} from "@/lib/settlement-partner-breakdown";
import type { SettlementSelectionSummary } from "@/lib/settlement-selection-summary";
import {
  validateSettlementStatementCampaigns,
  buildSettlementStatementFileName,
  buildSettlementStatementHtml,
  buildSettlementStatementPrintDoc,
  buildSettlementStatementText,
  renderSettlementStatementPng,
} from "@/lib/settlement-statement";
// 세금·지급액 계산은 전부 `@/lib/settlement-statement` 안으로 들어갔다 — 화면이 세율을
// 직접 계산하면 표면마다 갈라진다(이 파일과 상세 패널이 실제로 갈라져 있었다).

interface SettlementSelectionBarProps {
  /** 선택된 캠페인 원본 — 명세서 3종은 이 배열을 그대로 소비한다. */
  selectedCampaigns: CampaignRow[];
  /**
   * 표시할 합계. ⚠️ 계산은 호출부가 한다 — 「정산 진행 중」과 「정산 완료」 표는
   * 영업수익·판매대행비의 **출처가 다르므로**(완료 표는 리포트 파생값을 렌더한다)
   * 각 표가 화면에 실제로 보여주는 값으로 합산해 넘겨야 라벨과 합계가 어긋나지 않는다
   * (`toCompletedSelectionInput` 주석 참조).
   */
  summary: SettlementSelectionSummary;
}

const formatCurrency = (value: number | null | undefined) => {
  if (value == null) return "-";
  return Math.round(Number(value)).toLocaleString();
};

/**
 * 부호를 붙여 보여준다 — 내역 줄에서는 방향이 곧 그 줄의 성격이라 `+`/`−` 가 라벨 역할을 한다.
 * 재무 카드(`formatSettlementSignedMoney`)와 같은 하이픈 글리프를 쓴다: 한 도메인 안에서
 * 「-60,000」과 「−60,000」이 섞이면 다른 종류의 값처럼 보인다.
 */
const formatSignedCurrency = (value: number) => {
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  return `${rounded < 0 ? "-" : "+"}${Math.abs(rounded).toLocaleString()}`;
};

/**
 * 거래처별 금액의 **출처** — 어느 캠페인에서 얼마가 나왔는지(오너 요청 2026-08-28).
 *
 * 호버로만 열리는 패널이므로 **읽기 전용**이다(조작 요소 금지 — `ui/hover-card` 주석).
 * 테스트가 직접 렌더할 수 있도록 export 한다: 호버 상태를 만들지 않고도 내용 계약을 고정한다.
 */
export function SettlementPartnerBreakdownList({
  breakdown,
}: {
  breakdown: PartnerSettlementBreakdown;
}) {
  return (
    <div data-testid="settlement-partner-breakdown">
      <div className="mb-1 text-xs font-semibold text-foreground">거래처별 금액</div>
      <p className="mb-2 text-[11px] leading-4 text-muted-foreground">
        같은 거래처의 캠페인은 상계한 순액입니다.
      </p>
      <div className="grid gap-2">
        {breakdown.groups.map((group) => (
          <div key={group.key} className="grid gap-0.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="min-w-0 truncate text-xs font-semibold text-slate-800">
                  {group.partnerName}
                </span>
                {/* 물품대금이 미입력이면 총액이 공식 추정이다 — 재무 카드가 「추정 포함」으로
                    이미 말하는 사실이라 여기서 떨어뜨리면 같은 금액이 두 화면에서 다른
                    확실성을 갖게 된다(교차 검증 지적 2026-08-28). */}
                {group.estimated ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">추정 포함</span>
                ) : null}
              </span>
              <span
                className={cn(
                  "shrink-0 text-xs font-semibold tabular-nums",
                  // 0 은 방향이 없으므로 색도 얹지 않는다 — 초록으로 칠하면 「받을 게 있다」로 읽힌다.
                  group.amount === 0
                    ? "text-slate-500"
                    : MONEY_DIRECTION_TEXT[group.amount > 0 ? "in" : "out"],
                )}
              >
                {group.amount === 0
                  ? "상계 0"
                  : `${group.amount > 0 ? "입금" : "지급"} ${Math.abs(Math.round(group.amount)).toLocaleString()}`}
              </span>
            </div>
            {group.campaigns.map((campaign) => (
              <div
                key={campaign.campaignId}
                className="flex items-baseline justify-between gap-3 pl-2"
              >
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                    {campaign.label}
                  </span>
                  {campaign.estimated ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">추정</span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-[11px] tabular-nums",
                    MONEY_DIRECTION_TEXT[campaign.amount > 0 ? "in" : "out"],
                  )}
                >
                  {formatSignedCurrency(campaign.amount)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 정산 표에서 캠페인을 선택했을 때 뜨는 **단일** 하단 고정 액션 바.
 * ⛔ 표마다 자기 바를 렌더하지 말 것 — 둘 다 `position: fixed` 라 진행·완료를 함께
 * 선택하면 바가 겹쳐 아래쪽이 가려진다. 선택 상태는 페이지가 소유하고 바는 하나다.
 */
export function SettlementSelectionBar({
  selectedCampaigns,
  summary,
}: SettlementSelectionBarProps) {
  const summaryProfitTone = resolveProfitTone(summary.operatingProfit);
  // 거래처와 주고받을 금액 — 판정·상계는 lib SSOT 가 소유한다(재무 카드의 「브랜드사에
  // 지급할/에서 받을 총액」과 **같은 값**이다). ⚠️ 훅이라 이른 반환보다 위에 있어야 한다.
  // ℹ️ 위 4종 합계와 달리 **캠페인 원본 컬럼**에서 계산한다(`summary` 는 완료 표에서
  //    리포트 파생값을 쓴다 — `toCompletedSelectionInput`). 저장 파생이 한 번도 안 돈
  //    레거시 완료 건에서는 두 값의 출처가 갈릴 수 있다. 그래도 원본 컬럼을 쓰는 이유는
  //    이 칸이 약속하는 것이 「재무 카드와 같은 금액」이고 그 카드도 원본 컬럼을 읽기
  //    때문이다 — 여기서 리포트 파생을 쓰면 바와 상세가 어긋난다(교차 검증 2026-08-28).
  const partnerBreakdown = useMemo(
    () => buildPartnerSettlementBreakdown(selectedCampaigns),
    [selectedCampaigns],
  );
  const hasPartnerAmounts = partnerBreakdown.groups.length > 0;

  if (selectedCampaigns.length === 0) return null;

  const handleCopyStatements = async () => {
    const validation = validateSettlementStatementCampaigns(selectedCampaigns);
    if (!validation.ok) {
      toast.error(validation.message);
      return;
    }

    try {
      // 합계·평문 서식은 `@/lib/settlement-statement` 가 정본이다 — 상세 패널이 자체 평문
      // 빌더를 갖고 있다가 셀러 메일에 자사 마진을 태우던 사고가 여기서 갈라져 나왔다.
      // 두 표면이 같은 함수를 쓰는 한 다시 갈라지지 않는다.
      const htmlString = buildSettlementStatementHtml(selectedCampaigns);
      const plainText = buildSettlementStatementText(selectedCampaigns);

      const blobHtml = new Blob([htmlString], { type: "text/html" });
      const blobText = new Blob([plainText], { type: "text/plain" });

      const data = [
        new ClipboardItem({
          "text/html": blobHtml,
          "text/plain": blobText,
        }),
      ];

      await navigator.clipboard.write(data);
      toast.success("묶음 명세서가 HTML 형식으로 클립보드에 복사되었습니다.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "복사 중 오류가 발생했습니다.");
    }
  };

  const handlePrintStatements = () => {
    const validation = validateSettlementStatementCampaigns(selectedCampaigns);
    if (!validation.ok) {
      toast.error(validation.message);
      return;
    }

    try {
      // 인쇄용 완전 문서는 정본 SSOT 하나에서 온다 — 크롬 기본 머리말/꼬리말/쪽번호/문서제목을
      // 없애는 `@page{margin:0}`+빈 `<title>` 이 그 안에 있다. 이 경로는 예전에 `margin:20mm`+
      // `<title>정산명세서_셀러명` 이라 머리말/꼬리말과 셀러명이 페이지 상단에 찍혔다.
      const htmlString = buildSettlementStatementPrintDoc(selectedCampaigns);
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      document.body.appendChild(iframe);

      const doc = iframe.contentWindow?.document || iframe.contentDocument;
      if (!doc) {
        throw new Error("인쇄용 문서를 준비할 수 없습니다.");
      }

      let didPrint = false;
      const printFrame = () => {
        if (didPrint) return;
        didPrint = true;
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
        setTimeout(() => iframe.remove(), 1000);
      };

      iframe.onload = printFrame;
      doc.open();
      doc.write(htmlString);
      doc.close();
      setTimeout(printFrame, 150);
      toast.success("인쇄/PDF 저장 창이 실행되었습니다.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "인쇄 중 오류가 발생했습니다.");
    }
  };

  const handleSaveStatementsImage = async () => {
    const validation = validateSettlementStatementCampaigns(selectedCampaigns);
    if (!validation.ok) {
      toast.error(validation.message);
      return;
    }

    try {
      // 이 오프스크린 렌더 패턴이 이 파일에서 나와 `@/lib/settlement-statement` 로 올라갔다 —
      // 상세 패널은 명세서를 SVG 로 손수 다시 그리고 있었고 그게 내부 문서였다(마진 유출).
      // 이제 두 표면이 같은 함수를 쓴다.
      const dataUrl = await renderSettlementStatementPng(selectedCampaigns);
      const link = document.createElement("a");
      // 파일명도 `@/lib/settlement-statement` 가 정본이다 — 상세 패널이 자기 이름
      // (`settlement-{id}.png`)을 손으로 짓고 있었다(T-023).
      link.download = buildSettlementStatementFileName(selectedCampaigns);
      link.href = dataUrl;
      link.click();
      toast.success("명세서 이미지가 성공적으로 저장되었습니다.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "이미지 저장 중 오류가 발생했습니다.");
    }
  };

  return createPortal(
        /* 뷰포트 하단 고정 액션 바 — reference-inbox 다중 선택 바와 동일 패턴(ss-ux 판정
           2026-08-24). 종전 absolute -top-16 오버레이는 ①테이블과 함께 스크롤돼 긴 목록
           하단에서 선택하면 바가 화면 밖이었고 ②섹션 제목을 덮었고 ③bg-primary/5 반투명이라
           뒤 텍스트가 비쳤다(오너 지적). 배경은 완전 불투명 bg-card — 내용 텍스트 색들의
           AA 대비가 애초에 흰 카드 기준으로 정의된 값이라(P8 §5) 표면과 정의가 일치한다.
           blur 는 불투명 배경에서 무의미해 제거. shadow-soft-lg = P8 사다리 lg 층("플로팅
           바" 명시 예시). z-40 은 Sheet/Dialog(z-50) 아래라 패널이 열리면 자연히 가려진다.
           ⚠️ body 포털이 필수다 — 정산 페이지의 유리 패널(`backdrop-blur`)이 fixed 의
           containing block 이 되어, 포털 없이는 바가 패널 하단(뷰포트 밖)에 그려진다
           (실측 top 779 > viewport 720). P8 「filter 는 자손 position:fixed 를 깨뜨린다」의
           backdrop-filter 판이며, 선택 시에만 렌더되므로 document 접근은 안전하다. */
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
        <div className="pointer-events-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-4 rounded-xl border border-border/70 bg-card px-4 py-2.5 shadow-soft-lg xl:max-w-6xl">
          <div className="flex min-w-0 items-center gap-4">
            <span className="shrink-0 text-xs font-semibold text-primary">
              선택됨: {selectedCampaigns.length}건
            </span>
            {/* 합산 4종의 값 색은 테이블 열과 같은 축을 탄다(P8 — 축 밖 신규색 금지):
                판매 대행비 = 자금 방향(`--money-out`), 영업이익 = 손익 판정(profit-tone,
                합산값의 부호), 나머지는 무채색. 열과 색이 갈라지면 같은 숫자가 두 의미로
                읽힌다. */}
            <div
              data-testid="settlement-selection-summary"
              className="flex min-w-0 items-center gap-3 overflow-x-auto whitespace-nowrap text-xs"
            >
              <span className="flex items-baseline gap-1.5">
                <span className="text-muted-foreground">거래액</span>
                <span className="font-semibold tabular-nums text-slate-500">
                  {formatCurrency(summary.actualSales)}
                </span>
              </span>
              <span className="flex items-baseline gap-1.5">
                <span className="text-muted-foreground">영업수익</span>
                <span className="font-semibold tabular-nums text-slate-600">
                  {formatCurrency(summary.settlementSales)}
                </span>
              </span>
              <span className="flex items-baseline gap-1.5">
                <span className="text-muted-foreground">판매대행비</span>
                <span className="font-semibold tabular-nums text-money-out">
                  {formatCurrency(summary.sellerExpense)}
                </span>
              </span>
              <span className="flex items-baseline gap-1.5">
                <span className="text-muted-foreground">영업이익</span>
                <span
                  className={cn(
                    "font-semibold tabular-nums",
                    summaryProfitTone ? PROFIT_TONE_TEXT[summaryProfitTone] : "text-slate-600",
                  )}
                >
                  {formatCurrency(summary.operatingProfit)}
                </span>
              </span>
            </div>
            {/* 거래처 칸은 위 4종과 **다른 묶음**이다 — 앞의 넷은 이 선택의 손익이고 이쪽은
                「지금 은행에서 움직일 돈」이다. 그래서 같은 줄에 이어 붙이지 않고 헤어라인으로
                끊는다(관계는 여백·경계가 말한다). 오갈 돈이 없으면 칸 자체를 만들지 않는다. */}
            {hasPartnerAmounts ? (
              <HoverCard>
                <HoverCardTrigger asChild>
                  {/* 조작이 아니라 **읽기**지만 버튼인 것은 의도다 — 호버로만 열리면 키보드
                      사용자에게는 내역이 존재하지 않는 것과 같다. 포커스 가능한 요소라야
                      Radix 가 포커스에서도 열어준다. 높이 하한 24px 은 취향이 아니라
                      고밀도 CRM 조작 영역의 하한이다(P8 · WCAG 2.5.8). */}
                  <button
                    type="button"
                    data-testid="settlement-partner-amounts"
                    className="flex min-h-6 shrink-0 cursor-help items-center gap-3 whitespace-nowrap rounded-md border-l border-border/70 py-1 pl-3 pr-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
                  >
                    {/* ⛔ 여기에 `aria-label` 을 달지 말 것 — 접근성 이름 계산에서 자식 텍스트를
                        **덮어써서** 화면에 보이는 금액을 스크린리더가 못 듣게 된다. 접두 문구는
                        숨김 텍스트로 얹어 이름이 「출처 + 실제 금액」으로 조립되게 한다. */}
                    <span className="sr-only">거래처별 금액 출처. </span>
                    <span className="text-muted-foreground">거래처</span>
                    {partnerBreakdown.payable > 0 ? (
                      <span className="flex items-center gap-1">
                        <MONEY_DIRECTION_ICON.out className={cn("size-3", MONEY_DIRECTION_TEXT.out)} />
                        <span className="text-muted-foreground">지급</span>
                        <span
                          className={cn(
                            "font-semibold tabular-nums",
                            MONEY_DIRECTION_TEXT.out,
                          )}
                        >
                          {formatCurrency(partnerBreakdown.payable)}
                        </span>
                      </span>
                    ) : null}
                    {partnerBreakdown.receivable > 0 ? (
                      <span className="flex items-center gap-1">
                        <MONEY_DIRECTION_ICON.in className={cn("size-3", MONEY_DIRECTION_TEXT.in)} />
                        <span className="text-muted-foreground">입금</span>
                        <span
                          className={cn("font-semibold tabular-nums", MONEY_DIRECTION_TEXT.in)}
                        >
                          {formatCurrency(partnerBreakdown.receivable)}
                        </span>
                      </span>
                    ) : null}
                    {/* 선택한 건 전부가 상계로 0 이 된 경우 — 칸을 비워 두면 「거래처」라는
                        라벨만 덩그러니 남는다. 오갈 돈이 없다는 사실 자체를 말한다. */}
                    {partnerBreakdown.payable === 0 && partnerBreakdown.receivable === 0 ? (
                      <span className="text-slate-500">상계 0</span>
                    ) : null}
                    {/* 합계에 공식 추정이 섞였다는 사실은 **바에서** 말한다 — 팝오버에만 두면
                        마우스를 올리지 않은 오너는 추정을 확정으로 읽는다. 방향마다 붙이지
                        않는 것은 폭 때문이 아니라, 이 바에서 물어야 할 것이 「어느 쪽이
                        추정인가」가 아니라 「이 숫자를 그대로 믿어도 되나」이기 때문이다. */}
                    {partnerBreakdown.estimated ? (
                      <span className="text-[10px] text-muted-foreground">추정 포함</span>
                    ) : null}
                  </button>
                </HoverCardTrigger>
                <HoverCardContent className="w-80">
                  <SettlementPartnerBreakdownList breakdown={partnerBreakdown} />
                </HoverCardContent>
              </HoverCard>
            ) : null}
          </div>
          {/* `ml-auto` 는 **줄바꿈됐을 때**를 위한 것이다 — 한 줄에 들어갈 때는 justify-between
              이 이미 오른쪽으로 밀지만, 버튼 묶음만 다음 줄로 내려가면 그 줄에서는 왼쪽에
              붙어 위 줄과 축이 어긋난다. */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={handleCopyStatements}
              className="h-8 rounded-lg text-xs"
            >
              <Copy className="mr-1 size-3" />
              명세서 복사
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={handlePrintStatements}
              className="h-8 rounded-lg text-xs"
            >
              <Printer className="mr-1 size-3" />
              명세서 인쇄
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={handleSaveStatementsImage}
              className="h-8 rounded-lg text-xs"
            >
              <ImageIcon className="mr-1 size-3" />
              명세서 저장
            </Button>
          </div>
        </div>
        </div>,
    document.body,
  );
}
