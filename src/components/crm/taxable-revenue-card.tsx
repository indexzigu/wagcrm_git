// 네이버 판매자 등급 「과세기준매출」 여유 카드 — 홈 대시보드(데스크톱) 전용, 읽기 전용.
//
// 용도: 다음 등급 갱신(2/14 · 8/14) 전에 자사몰 매출을 조절할지 판단하는 근거. 그래서 카드의 주 숫자는 **다음 기준선까지 남은 금액(공급가액)** 이고, 넘으면
// 「기준선 N원 초과」로 바뀐다. 계산은 전부 `taxable-revenue-tracker.ts`(순수 SSOT)가 했다 —
// 여기서 금액·등급을 다시 계산하지 말 것(표시 포맷만 한다).
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
import { Landmark } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
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
const STATUS_TONE: Record<TaxableRevenueStatus, { value: string; bar: string }> = {
  WITHIN: { value: "text-foreground", bar: "bg-primary" },
  NEAR: { value: "text-status-caution-text", bar: "bg-status-caution" },
  OVER: { value: "text-status-urgent", bar: "bg-status-urgent" },
};

function ChannelRow({ label, subtotal, range }: { label: string; subtotal: TaxableChannelSubtotal; range?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="text-muted-foreground">
        {label}
        <span className="ml-1 tabular-nums">{subtotal.count}건</span>
      </span>
      <span className="font-medium tabular-nums text-foreground">{range ?? won(subtotal.supply)}</span>
    </div>
  );
}

function WarningRow({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-caution" />
      <span className="font-medium">{children}</span>
    </li>
  );
}

export function TaxableRevenueCard({ tracker }: { tracker: TaxableRevenueTracker }) {
  const tone = STATUS_TONE[tracker.status];
  const isOver = tracker.status === "OVER";
  const threshold = tracker.thresholdSupply;
  const { channels, crossingCost } = tracker;
  const unspecifiedRange =
    channels.UNSPECIFIED.count > 0
      ? `${won(channels.UNSPECIFIED.lowerSupply)} ~ ${won(channels.UNSPECIFIED.supply)}`
      : undefined;

  const primaryLabel =
    threshold === null
      ? "최상위 등급 구간(기준선 없음)"
      : isOver
        ? `기준선 ${formatEok(threshold)} 초과 (공급가액)`
        : tracker.status === "NEAR"
          ? // 근접은 색만으로 전하지 않는다(P8 §3) — 라벨에도 한 단어를 싣는다.
            `기준선 ${formatEok(threshold)} 근접 · 남은 금액 (공급가액)`
          : `기준선 ${formatEok(threshold)}까지 남은 금액 (공급가액)`;
  const primaryValue = isOver ? tracker.overSupply : tracker.headroomSupply;
  // 넘기 전에는 내림 — 99.5% 를 「100%」로 읽어 주면 여유가 남았는데 꽉 찼다고 안내하게 된다.
  // `+ 1e-9`: 0.29 * 100 = 28.999…96 같은 부동소수점 오차가 내림에서 1%p 를 깎지 않게 한다.
  const progressPercent = isOver ? 100 : Math.floor(tracker.progressRatio * 100 + 1e-9);
  const subtitle =
    `다음 갱신 ${dotted(tracker.nextUpdateYmd)} · 기준기간 ${tracker.referencePeriod.label}` +
    (tracker.referencePeriod.assumed ? " (8월 갱신 기준기간은 원문 미확인)" : "");

  return (
    <Card className="border-black/5 bg-white/85 shadow-soft-sm p-0" data-testid="taxable-revenue-card">
      <CardContent className="px-4 py-3">
        <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
          <Landmark className="size-4 shrink-0 text-[var(--primary)]" aria-hidden />
          <p className="shrink-0 text-[13px] font-semibold tracking-tight text-[var(--primary)]">
            네이버 판매자 등급 · 과세기준매출
          </p>
          {/* 좁은 폭에서 잘리면 끝의 「원문 미확인」 가정 경고부터 사라진다 — title 로 전문을 남긴다(형제 카드 규약). */}
          <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={subtitle}>
            {subtitle}
          </p>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            현재 등급(CRM 추정) {tracker.currentGrade.label} {formatRate(tracker.currentGrade.feeRateMilliPercent)}
          </span>
        </div>

        <div className="mt-3 grid gap-5 md:grid-cols-[1.3fr_1fr_1fr]">
          {/* 1. 주 숫자 — 기준선까지 여유(또는 초과분) */}
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{primaryLabel}</p>
            {primaryValue !== null && (
              <p className={`text-2xl font-semibold tabular-nums tracking-tight ${tone.value}`}>{won(primaryValue)}</p>
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
                <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${tracker.progressRatio * 100}%` }} />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              누적 <span className="font-medium tabular-nums text-foreground">{won(tracker.cumulativeSupply)}</span>
              {threshold !== null ? ` / 기준선 ${formatEok(threshold)}` : ""} · 예상 등급 {tracker.estimatedGrade.label}
            </p>
            {tracker.vatIncludedMargin !== null && (
              <p className="text-xs text-muted-foreground">
                {/* 대안 가설(기준선을 VAT 포함 매출로 판정)의 여유 — 단위 혼합은 의도다(트래커 타입 주석). */}
                기준선을 VAT 포함 매출로 판정할 경우:{" "}
                {tracker.vatIncludedMargin >= 0
                  ? `여유 ${won(tracker.vatIncludedMargin)}`
                  : `${won(-tracker.vatIncludedMargin)} 초과`}
              </p>
            )}
            {isOver && tracker.nextThresholdHeadroomSupply !== null && tracker.estimatedGrade.upperSupply !== null && (
              <p className="text-xs text-muted-foreground">
                다음 기준선 {formatEok(tracker.estimatedGrade.upperSupply)}까지 {won(tracker.nextThresholdHeadroomSupply)}
              </p>
            )}
          </div>

          {/* 2. 채널 그룹별 소계(공급가액) — 범주라 무채색 */}
          <div className="flex flex-col">
            <p className="pb-1 text-xs text-muted-foreground">채널별 소계 (공급가액)</p>
            <div className="divide-y divide-slate-100">
              <ChannelRow label="자사몰" subtotal={channels.OWN_MALL} />
              <ChannelRow label="브랜드몰" subtotal={channels.BRAND_MALL} />
              <ChannelRow label="셀러몰" subtotal={channels.SELLER_MALL} />
              <ChannelRow label="미지정" subtotal={channels.UNSPECIFIED} range={unspecifiedRange} />
            </div>
          </div>

          {/* 3. 넘었을 때 비용 + 확인 필요 */}
          <div className="flex flex-col gap-2">
            {crossingCost ? (
              <div>
                <p className="text-xs text-muted-foreground">
                  {crossingCost.kind === "ALREADY_OVER" ? "추정대로 갱신되면" : "넘으면"}
                </p>
                <p className="text-sm font-semibold tabular-nums text-foreground">
                  반년 약 {won(crossingCost.amount)} 추가 수수료
                </p>
                {/* break-keep: 「110,000,000원」의 「원」만 다음 줄로 떨어지지 않게 한글 단어 단위로 끊는다. */}
                <p className="mt-1 break-keep text-[11px] text-muted-foreground">
                  {crossingCost.from.label} {formatRate(crossingCost.from.feeRateMilliPercent)} → {crossingCost.to.label}{" "}
                  {formatRate(crossingCost.to.feeRateMilliPercent)} · 네이버 자사몰 최근 6개월 {won(crossingCost.naverOwnMallSales)}
                  {crossingCost.naverOwnMallMissingCount > 0 ? ` (금액 미입력 ${crossingCost.naverOwnMallMissingCount}건 제외)` : ""}
                </p>
                <p className="text-[11px] text-muted-foreground">네이버페이 결제분만 반영 · 카카오 등 다른 PG 미포함</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">최상위 등급이라 더 오를 등급이 없습니다</p>
            )}
            {tracker.pendingCount > 0 && (
              // 진행·예정 캠페인의 매출 미반영은 입력 오류가 아니다 — 「확인 필요」 목록과 가르고 무채색으로 둔다.
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-slate-400" />
                <span>진행·예정 {tracker.pendingCount}건 매출 미반영 (여유가 더 줄어들 수 있음)</span>
              </p>
            )}
            {(tracker.unspecifiedCount > 0 || tracker.missingAmountCount > 0) && (
              <ul className="flex flex-col gap-1" aria-label="확인 필요">
                {tracker.unspecifiedCount > 0 && <WarningRow>채널 미지정 {tracker.unspecifiedCount}건 분류 필요</WarningRow>}
                {tracker.missingAmountCount > 0 && <WarningRow>금액 미입력 {tracker.missingAmountCount}건 (합계 제외)</WarningRow>}
              </ul>
            )}
          </div>
        </div>

        <p className="mt-3 border-t border-slate-100 pt-2 text-[11px] text-muted-foreground">
          CRM 캠페인 기준 추정치. 현재 등급은 직전 갱신({dotted(tracker.previousGradeUpdate.updateYmd)}) 기준기간{" "}
          {tracker.previousGradeUpdate.referencePeriod.label}의 CRM 누적으로 추정했습니다. CRM 밖 매출·반품은 반영되지
          않습니다.
        </p>
      </CardContent>
    </Card>
  );
}
