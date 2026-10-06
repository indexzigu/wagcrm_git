// 네이버 판매자 등급 「과세기준매출」 여유 카드 — 홈 대시보드(데스크톱) 전용, 읽기 전용.
//
// 용도: 다음 등급 갱신(2/14 · 8/14) 전에 자사몰 매출을 조절할지 판단하는 근거. 그래서 카드의 주 숫자는 **다음 기준선까지 남은 금액(공급가액)** 이고, 넘으면
// 「기준선 N원 초과」로 바뀐다. 계산은 전부 `taxable-revenue-tracker.ts`(순수 SSOT)가 했다 —
// 여기서 금액·등급을 다시 계산하지 말 것(표시 포맷만 한다).
//
// 화면에는 **판단에 쓰는 숫자만** 둔다(오너 지시 2026-10-06: 「상세 설명은 롤오버로, 데이터만 집중」).
// 계산 근거·가정·제외 항목 설명은 숫자 옆 호버 패널(`HoverCard`)로 옮겼다. 예외 둘 — 결론을 바꾸는
// 신호는 패널에 숨기지 않는다: ① VAT 포함 판정 가설에서 **이미 초과**가 되면 본문에 한 줄로 올린다
// ② 분류·입력이 필요한 건수(미지정·금액 미입력)는 조치 대상이라 본문에 남긴다.
// ⛔ 호버 패널 안에 조작 요소를 넣지 말 것(`ui/hover-card.tsx` 헤더 — 터치·키보드 도달 불가).
//
// 색은 **심각도 축 하나만** 탄다(P8 §1): 근접 = caution, 초과 = urgent. 여유 충분은 상태색이 아니라
// 브랜드 네이비 막대다 — 무채색은 아니지만 상태 hue 와 혼동되지 않는 중립 캐리어로 둔다(P8 §4).
// 채널 소계는 좋고 나쁨이 없는 **범주**라 색을 받지 않는다(P8 §4).
//
// 막대의 빈 구간 = 기준선까지 남은 금액(주 숫자)이라 **보여야 하는 정보**다. 트랙을 slate-100 으로 두면
// 흰 카드 대비 1.09:1 로 거의 사라졌다(오너 지적). 오너 결정으로 slate-300(흰 카드 대비 1.47:1)까지
// 진하게 하고, 채움 대 트랙은 네이비 7.62 · caution 3.38 · **urgent 3.16** 으로 3:1 을 지킨다.
// ⚠️ urgent 여유는 0.16 뿐이다 — 채움을 더 연하게 하거나 트랙을 더 진하게(slate-400: urgent 1.83) 하지 말 것.
// shadow-inner 는 붙이지 않는다: 오목 홈의 윗줄(검정 5%)에서 urgent 대비가 2.83 으로 3:1 아래로 떨어진다.
import type { ReactNode } from "react";
import { Info, Landmark } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  TaxableChannelSubtotal,
  TaxableRevenueStatus,
  TaxableRevenueTracker,
} from "@/lib/taxable-revenue-tracker";

const EOK = 100_000_000;

/** 기준선 라벨 — 등급 상한은 전부 억 단위(3억·5억·10억·30억)다. */
function formatEok(amount: number): string {
  const eok = amount / EOK;
  return Number.isInteger(eok) ? `${eok}억` : `${formatCurrency(amount)}원`;
}

function won(amount: number): string {
  return `${formatCurrency(amount)}원`;
}

function formatRate(milliPercent: number): string {
  return `${(milliPercent / 1000).toFixed(3)}%`;
}

function dotted(ymd: string): string {
  return ymd.replaceAll("-", ".");
}

/** 심각도 → 캐리어(주 숫자 텍스트·막대 fill). 흰 카드 위 대비는 토큰 정의 주석 참조(P8 §5). */
const STATUS_RANK: Record<TaxableRevenueStatus, number> = { WITHIN: 0, NEAR: 1, OVER: 2 };

const STATUS_TONE: Record<TaxableRevenueStatus, { value: string; bar: string }> = {
  WITHIN: { value: "text-foreground", bar: "bg-primary" },
  NEAR: { value: "text-status-caution-text", bar: "bg-status-caution" },
  OVER: { value: "text-status-urgent", bar: "bg-status-urgent" },
};

/**
 * 숫자 위에 마우스를 올리거나 포커스하면 근거 패널이 뜬다. 트리거가 버튼인 것은 **읽기**라도
 * 키보드로 열 수 있어야 해서다(`settlement-selection-bar` 선례). 점선 밑줄 = 「근거가 숨어 있다」 표지.
 * ⛔ 트리거에 `aria-label` 을 달지 말 것 — 자식 텍스트(실제 숫자)를 덮어써 스크린리더가 금액을 못 듣는다.
 */
function DetailHover({
  srPrefix,
  trigger,
  children,
  testId,
  className,
}: {
  srPrefix: string;
  trigger: ReactNode;
  children: ReactNode;
  testId: string;
  className?: string;
}) {
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          className={cn(
            "min-h-6 cursor-help rounded-sm text-left underline decoration-slate-400 decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring",
            className,
          )}
        >
          <span className="sr-only">{srPrefix}. </span>
          {trigger}
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-80 p-3">{children}</HoverCardContent>
    </HoverCard>
  );
}

/** 호버 패널 안의 「라벨 — 값」 한 줄. */
function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function DetailNote({ children }: { children: ReactNode }) {
  // break-keep: 한글을 단어 단위로 끊는다(「누적으/로」처럼 낱말 중간에서 줄이 넘어가지 않게).
  return (
    <p className="mt-2 break-keep border-t border-slate-100 pt-2 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

function ChannelRow({
  label,
  subtotal,
  value,
}: {
  label: string;
  subtotal: TaxableChannelSubtotal;
  value?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="text-muted-foreground">
        {label}
        <span className="ml-1 tabular-nums">{subtotal.count}건</span>
      </span>
      <span className="font-medium tabular-nums text-foreground">{value ?? won(subtotal.supply)}</span>
    </div>
  );
}

function StatusRow({ tone, children }: { tone: "caution" | "neutral"; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", tone === "caution" ? "bg-status-caution" : "bg-slate-400")}
      />
      <span className={tone === "caution" ? "font-medium" : undefined}>{children}</span>
    </li>
  );
}

export function TaxableRevenueCard({ tracker }: { tracker: TaxableRevenueTracker }) {
  const tone = STATUS_TONE[tracker.status];
  const isOver = tracker.status === "OVER";
  const threshold = tracker.thresholdSupply;
  const { channels, crossingCost } = tracker;
  // 미지정은 과세 대상 여부를 몰라 범위다. 주 숫자(여유)는 **상한**(보수적)으로 계산돼 있으므로 그 사실을 패널에 남긴다.
  const unspecifiedValue =
    channels.UNSPECIFIED.count > 0 ? (
      <DetailHover
        srPrefix="미지정 범위 근거"
        testId="taxable-revenue-unspecified"
        // 24px 클릭 영역은 지키되 표 행 높이는 늘리지 않는다(음수 마진으로 행 패딩 안에 겹쳐 둔다).
        className="-my-1"
        trigger={`${won(channels.UNSPECIFIED.lowerSupply)} ~ ${won(channels.UNSPECIFIED.supply)}`}
      >
        <p className="text-xs font-semibold text-foreground">미지정 채널 범위</p>
        <DetailRow label="하한 반영 시 누적" value={won(tracker.cumulativeSupplyLower)} />
        <DetailRow label="상한 반영 시 누적" value={won(tracker.cumulativeSupply)} />
        <DetailNote>
          채널이 정해지지 않아 과세 대상 금액을 범위로 잡았습니다. 남은 금액은 상한(보수적)으로 계산합니다. 채널을
          분류하면 범위가 사라집니다.
        </DetailNote>
      </DetailHover>
    ) : undefined;

  const primaryLabel =
    threshold === null
      ? "최상위 등급 구간 (기준선 없음)"
      : isOver
        ? `${formatEok(threshold)} 초과한 공급가액`
        : tracker.status === "NEAR"
          ? // 근접은 색만으로 전하지 않는다(P8 §3) — 라벨에도 한 단어를 싣는다.
            `${formatEok(threshold)} 근접 · 남은 공급가액`
          : `${formatEok(threshold)}까지 남은 공급가액`;
  const primaryValue = isOver ? tracker.overSupply : tracker.headroomSupply;
  // 넘기 전에는 내림 — 99.5% 를 「100%」로 읽어 주면 여유가 남았는데 꽉 찼다고 안내하게 된다.
  // `+ 1e-9`: 0.29 * 100 = 28.999…96 같은 부동소수점 오차가 내림에서 1%p 를 깎지 않게 한다.
  const progressPercent = isOver ? 100 : Math.floor(tracker.progressRatio * 100 + 1e-9);
  const assumed = tracker.referencePeriod.assumed;
  const vatMargin = tracker.vatIncludedMargin;
  // VAT 포함 가설의 판정이 본 판정보다 나쁠 때(여유인데 근접·초과, 근접인데 초과)만 본문에 올린다.
  // 판정은 트래커가 했다(`vatIncludedStatus`) — 근접 비율을 여기서 다시 곱하지 말 것.
  const vatStatus = tracker.vatIncludedStatus;
  const vatWorse = vatStatus !== null && vatMargin !== null && STATUS_RANK[vatStatus] > STATUS_RANK[tracker.status];
  // 현재와 같은 등급이면 「예상」은 새 정보가 아니다.
  const gradeChanges = tracker.estimatedGrade.label !== tracker.currentGrade.label;
  const needsAction = tracker.unspecifiedCount > 0 || tracker.missingAmountCount > 0;

  return (
    <Card className="border-black/5 bg-white/85 shadow-soft-sm p-0" data-testid="taxable-revenue-card">
      <CardContent className="px-4 py-3">
        <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
          <Landmark className="size-4 shrink-0 text-[var(--primary)]" aria-hidden />
          <p className="shrink-0 text-[13px] font-semibold tracking-tight text-[var(--primary)]">
            네이버 판매자 등급 · 과세기준매출
          </p>
          <HoverCard>
            <HoverCardTrigger asChild>
              <button
                type="button"
                data-testid="taxable-revenue-basis"
                className="flex size-6 shrink-0 cursor-help items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
              >
                <Info className="size-3.5" aria-hidden />
                <span className="sr-only">추정 근거</span>
              </button>
            </HoverCardTrigger>
            <HoverCardContent className="w-80 p-3">
              <p className="text-xs font-semibold text-foreground">CRM 캠페인 기준 추정치</p>
              <DetailRow label="기준기간" value={tracker.referencePeriod.label} />
              <DetailRow label="현재 등급 근거" value={`${tracker.previousGradeUpdate.referencePeriod.label} 누적`} />
              <DetailRow label="금액 단위" value="공급가액 (VAT 제외)" />
              <DetailNote>
                {assumed ? "8월 갱신 기준기간은 원문 미확인 가정입니다. " : ""}
                현재 등급은 직전 갱신(
                {dotted(tracker.previousGradeUpdate.updateYmd)}) 기준기간의 CRM 누적으로 추정했습니다. CRM 밖
                매출·반품은 반영되지 않습니다.
                {tracker.pendingCount > 0 ? ` 진행·예정 캠페인은 매출이 들어오면 여유가 더 줄어듭니다.` : ""}
                {tracker.missingAmountCount > 0 ? ` 금액 미입력 건은 합계에서 빠져 있습니다.` : ""}
              </DetailNote>
            </HoverCardContent>
          </HoverCard>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            다음 갱신 <span className="font-medium text-foreground">{dotted(tracker.nextUpdateYmd)}</span>
            {assumed ? " (가정)" : ""}
            <span className="mx-2 text-slate-300" aria-hidden>
              |
            </span>
            {/* 「(추정)」은 지우지 말 것 — 네이버 실제 등급과 대조할 수 있는 값이라 공식 값처럼 읽히면 안 된다. */}
            현재(추정) <span className="font-medium text-foreground">{tracker.currentGrade.label}</span>{" "}
            {formatRate(tracker.currentGrade.feeRateMilliPercent)}
          </span>
        </div>

        <div className="mt-3 grid gap-6 md:grid-cols-[1.3fr_1fr_1fr]">
          {/* 1. 주 숫자 — 기준선까지 여유(또는 초과분). 근거(VAT 가설·진행률)는 호버.
              확인 필요 항목도 여기 둔다 — 이 숫자의 신뢰도를 깎는 항목이라 숫자 곁이 제자리다. */}
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{primaryLabel}</p>
            {primaryValue !== null && (
              <DetailHover
                srPrefix="남은 금액 근거"
                testId="taxable-revenue-primary"
                className="self-start"
                trigger={
                  <span className={cn("font-semibold tabular-nums tracking-tight", tone.value)}>
                    <span className="text-2xl">{formatCurrency(primaryValue)}</span>
                    <span className="ml-0.5 text-sm">원</span>
                  </span>
                }
              >
                <p className="text-xs font-semibold text-foreground">기준선 판정 근거</p>
                <DetailRow label="누적 공급가액" value={won(tracker.cumulativeSupply)} />
                {threshold !== null && <DetailRow label="기준선" value={formatEok(threshold)} />}
                {threshold !== null && <DetailRow label="진행률" value={isOver ? "초과" : `${progressPercent}%`} />}
                {vatMargin !== null && (
                  <DetailRow
                    label="VAT 포함 매출로 판정 시"
                    value={vatMargin >= 0 ? `여유 ${won(vatMargin)}` : `${won(-vatMargin)} 초과`}
                  />
                )}
                <DetailNote>
                  네이버 기준선이 공급가액인지 VAT 포함 매출인지 원문으로 확정되지 않아 두 가설을 함께 계산합니다.
                </DetailNote>
              </DetailHover>
            )}
            {threshold !== null && (
              <div
                role="progressbar"
                aria-label="기준선 대비 누적 과세기준매출"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent}
                aria-valuetext={
                  isOver
                    ? `누적 ${won(tracker.cumulativeSupply)}, 기준선 ${formatEok(threshold)} 초과`
                    : `누적 ${won(tracker.cumulativeSupply)}, 기준선 ${formatEok(threshold)}의 ${progressPercent}%`
                }
                className="h-2.5 overflow-hidden rounded-full bg-slate-300"
              >
                <div
                  className={`h-full rounded-full ${tone.bar}`}
                  style={{ width: `${tracker.progressRatio * 100}%` }}
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              누적 <span className="font-medium tabular-nums text-foreground">{won(tracker.cumulativeSupply)}</span>
              {threshold !== null ? ` / ${formatEok(threshold)}` : ""}
              {gradeChanges && (
                <>
                  {" "}
                  · 예상 <span className="font-medium text-foreground">{tracker.estimatedGrade.label}</span>
                </>
              )}
            </p>
            {isOver && tracker.nextThresholdHeadroomSupply !== null && tracker.estimatedGrade.upperSupply !== null && (
              <p className="text-xs text-muted-foreground">
                다음 기준선 {formatEok(tracker.estimatedGrade.upperSupply)}
                까지{" "}
                <span className="font-medium tabular-nums text-foreground">
                  {won(tracker.nextThresholdHeadroomSupply)}
                </span>
              </p>
            )}
            {(vatWorse || needsAction || tracker.pendingCount > 0) && (
              <div className="flex flex-col gap-1">
                {vatWorse && (
                  <ul aria-label="판정 가설 주의">
                    <StatusRow tone="caution">
                      {vatMargin < 0
                        ? `VAT 포함 기준이면 ${won(-vatMargin)} 초과`
                        : `VAT 포함 기준이면 ${won(vatMargin)} 남음 (근접)`}
                    </StatusRow>
                  </ul>
                )}
                {needsAction && (
                  <ul className="flex flex-col gap-1" aria-label="확인 필요">
                    {tracker.unspecifiedCount > 0 && (
                      <StatusRow tone="caution">채널 미지정 {tracker.unspecifiedCount}건 분류 필요</StatusRow>
                    )}
                    {tracker.missingAmountCount > 0 && (
                      <StatusRow tone="caution">금액 미입력 {tracker.missingAmountCount}건</StatusRow>
                    )}
                  </ul>
                )}
                {tracker.pendingCount > 0 && (
                  // 진행·예정 캠페인의 매출 미반영은 입력 오류가 아니다 — 「확인 필요」 목록과 가르고 무채색으로 둔다.
                  <ul aria-label="반영 대기">
                    <StatusRow tone="neutral">진행·예정 {tracker.pendingCount}건 매출 미반영</StatusRow>
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* 2. 채널 그룹별 소계(공급가액) — 범주라 무채색 */}
          <div className="flex flex-col">
            <p className="pb-1 text-xs text-muted-foreground">채널별 공급가액</p>
            <div className="divide-y divide-slate-100">
              <ChannelRow label="자사몰" subtotal={channels.OWN_MALL} />
              <ChannelRow label="브랜드몰" subtotal={channels.BRAND_MALL} />
              <ChannelRow label="셀러몰" subtotal={channels.SELLER_MALL} />
              <ChannelRow label="미지정" subtotal={channels.UNSPECIFIED} value={unspecifiedValue} />
            </div>
          </div>

          {/* 3. 넘었을 때 비용. 산식은 호버 */}
          <div className="flex flex-col gap-3">
            {crossingCost ? (
              <div className="flex flex-col gap-1">
                <p className="text-xs text-muted-foreground">
                  {crossingCost.kind === "ALREADY_OVER"
                    ? "추정대로 갱신되면 반년 추가 수수료"
                    : "넘으면 반년 추가 수수료"}
                </p>
                <DetailHover
                  srPrefix="추가 수수료 산식"
                  testId="taxable-revenue-cost"
                  className="self-start"
                  trigger={
                    <span className="text-lg font-semibold tabular-nums tracking-tight text-foreground">
                      약 {won(crossingCost.amount)}
                    </span>
                  }
                >
                  <p className="text-xs font-semibold text-foreground">추가 수수료 산식</p>
                  <DetailRow
                    label="수수료율"
                    value={`${crossingCost.from.label} ${formatRate(crossingCost.from.feeRateMilliPercent)} → ${crossingCost.to.label} ${formatRate(crossingCost.to.feeRateMilliPercent)}`}
                  />
                  <DetailRow label="네이버 자사몰 최근 6개월" value={won(crossingCost.naverOwnMallSales)} />
                  {crossingCost.naverOwnMallMissingCount > 0 && (
                    <DetailRow label="금액 미입력 (제외)" value={`${crossingCost.naverOwnMallMissingCount}건`} />
                  )}
                  <DetailNote>네이버페이 결제분만 반영합니다. 카카오 등 다른 PG 결제는 포함하지 않습니다.</DetailNote>
                </DetailHover>
                <p className="text-xs text-muted-foreground">
                  {crossingCost.from.label} → {crossingCost.to.label}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">최상위 등급이라 더 오를 등급이 없습니다</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
