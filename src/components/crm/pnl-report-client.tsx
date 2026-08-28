"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import { InfoIcon } from "lucide-react";

import { CrmShell } from "./crm-shell";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  resolveProfitTone,
  PROFIT_TONE_TEXT,
  PROFIT_TONE_TEXT_DENSE,
} from "@/lib/profit-tone";
import { salesChannelLabels } from "@/lib/crm-types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  type ChartConfig,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CategoryBar } from "@/components/ui/category-bar";
import { ProgressCircle } from "@/components/ui/progress-circle";
import { cn } from "@/lib/utils";
import { computeChartLeftMargin, formatYAxisLabel } from "@/lib/y-axis-format";
import type { PnlCampaignRow, PnlReportData } from "@/lib/pnl-report";

const BRIDGE_CHART_CONFIG: ChartConfig = {
  amount: { label: "금액", color: "var(--chart-1)" },
};

const MONTHLY_CHART_CONFIG: ChartConfig = {
  preTaxOperatingProfit: { label: "세전 순이익", color: "var(--chart-2)" },
  afterTaxOperatingProfit: { label: "세후 예상 이익", color: "var(--chart-1)" },
};

type PnlReportClientProps = {
  report: PnlReportData;
};

function formatKRW(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(Math.round(value));
  if (absolute >= 100_000_000) {
    return `${sign}${(absolute / 100_000_000).toFixed(1)}억`;
  }
  if (absolute >= 10_000) {
    return `${sign}${Math.round(absolute / 10_000).toLocaleString()}만`;
  }
  return `${sign}${absolute.toLocaleString()}`;
}

function formatFullKRW(value: number): string {
  const rounded = Math.round(value);
  return `${rounded.toLocaleString()}원`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function formatDateRange(row: PnlCampaignRow): string {
  return `${row.startDate.slice(5).replace("-", ".")} - ${row.endDate
    .slice(5)
    .replace("-", ".")}`;
}

/**
 * 판매채널 라벨. 정본은 `salesChannelLabels`(`crm-types.ts`) 하나다 — 이 자리에 있던
 * 4개짜리 손수 사본은 지웠다. 사본은 `OWN_MALL`·`UNSPECIFIED` 를 몰라 화면에 원문 코드
 * (`OWN_MALL`)를 그대로 뱉었고, 아는 값의 문구마저 정본과 갈려 있었다
 * (사본 "자사몰N" vs 정본 "자사몰(네이버)"). `salesChannel` 은 스키마상 자유 문자열이라
 * 미지의 값은 원문으로 폴백한다 — 정본 키를 늘리는 것이 그때의 조치다.
 */
function channelLabel(channel: string): string {
  return (salesChannelLabels as Record<string, string>)[channel] ?? channel;
}

/**
 * KPI 타일.
 *
 * `emphasis="cost"` 는 색을 주지 않는다 — 라벨("셀러 지급액"·"공제세액")이 이미 비용이라고
 * 말하므로 색은 정보를 더하지 않고, 4개를 칠하면 습관화로 진짜 신호(적자)가 묻힌다.
 * 대신 이전의 `text-muted-foreground`(= "안 봐도 되는 값") **강등을 해제**한다 — 여기 버그는
 * 색이 없다는 게 아니라 KPI 값을 캡션처럼 흐리게 칠했다는 것이었다.
 *
 * `amount` 를 주면 손익 타일로 취급해 부호를 따른다(profit-tone SSOT). 이전엔
 * `emphasis="profit"` 이 `text-primary`(모든 제목과 같은 네이비)라 흑자·적자가 같은 색이었다.
 */
function MetricCard({
  label,
  value,
  description,
  emphasis,
  amount,
}: {
  label: string;
  value: string;
  description: string;
  emphasis?: "profit" | "cost";
  /** 손익 금액. 주면 부호에 따라 색이 갈린다(흑자=자금 유입 / 적자=경고). */
  amount?: number | null;
}) {
  const tone = emphasis === "profit" ? resolveProfitTone(amount) : null;
  return (
    <Card size="sm" className="rounded-lg">
      <CardHeader className="px-0">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={cn("text-xl", tone && PROFIT_TONE_TEXT[tone])}>
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 text-xs text-muted-foreground">
        {description}
      </CardContent>
    </Card>
  );
}

/**
 * 계산 근거 시트의 한 줄.
 *
 * 비용 줄은 색을 쓰지 않는다 — 값에 이미 `-` 부호가 붙어 있어 방향이 중복 표현되고,
 * 6줄을 칠하면 진짜 신호(적자)가 묻힌다. `amount` 를 준 손익 줄만 부호를 따른다.
 */
/**
 * 표의 금액 칸. **0 만** 무채색으로 낮춘다.
 *
 * ⚠️ 이건 종전에 기각된 "비용 열 강등"(`emphasis === "cost" && text-muted-foreground`,
 * `desktop-money-axis.test.ts` 가 재유입을 막는다)과 다른 규칙이다. 그때는 **값이 얼마든
 * 범주가 비용이면** 캡션처럼 흐리게 칠해 실제 지출액을 못 읽게 만든 것이 버그였다.
 * 여기 기준은 범주가 아니라 **값**이다 — 0 은 어느 열에 있든 읽을 것이 없고, P8 §2
 * ("무채색은 랭크지 부재가 아니다")가 말하는 "볼 것 없음" 등급 그 자체다. 운영비·기타비용이
 * 대부분 0 인 이 표에서 0 이 본문과 같은 농도면 실제 숫자가 그 격자에 묻힌다.
 */
function AmountCell({ value }: { value: number }) {
  return (
    <TableCell
      className={cn("text-right tabular-nums", value === 0 && "text-muted-foreground")}
    >
      {formatKRW(value)}
    </TableCell>
  );
}

function DetailLine({
  label,
  value,
  strong,
  amount,
}: {
  label: string;
  value: string;
  strong?: boolean;
  /** 손익 금액. 주면 부호에 따라 색이 갈린다(profit-tone SSOT). */
  amount?: number | null;
}) {
  const tone = amount === undefined ? null : resolveProfitTone(amount);
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("text-right tabular-nums", strong && "font-semibold", tone && PROFIT_TONE_TEXT_DENSE[tone])}>
        {value}
      </span>
    </div>
  );
}

export function PnlReportClient({ report }: PnlReportClientProps) {
  const [selectedCampaign, setSelectedCampaign] = useState<PnlCampaignRow | null>(null);
  const { totals, taxEstimate } = report;

  const bridgeChartData = useMemo(
    () =>
      report.bridge.map((row) => ({
        ...row,
        displayAmount: formatFullKRW(row.amount),
      })),
    [report.bridge],
  );

  const monthlyChartData = useMemo(
    () =>
      report.monthly.map((row) => ({
        month: row.month.slice(5),
        preTaxOperatingProfit: row.preTaxOperatingProfit,
        afterTaxOperatingProfit: row.afterTaxOperatingProfit,
      })),
    [report.monthly],
  );

  const campaignsByMonth = useMemo(() => {
    const grouped = new Map<
      string,
      { month: string; rows: PnlCampaignRow[]; preTaxOperatingProfit: number; afterTaxOperatingProfit: number }
    >();

    for (const campaign of report.campaigns) {
      if (!grouped.has(campaign.month)) {
        grouped.set(campaign.month, {
          month: campaign.month,
          rows: [],
          preTaxOperatingProfit: 0,
          afterTaxOperatingProfit: 0,
        });
      }

      const monthGroup = grouped.get(campaign.month)!;
      monthGroup.rows.push(campaign);
      monthGroup.preTaxOperatingProfit += campaign.preTaxOperatingProfit;
      monthGroup.afterTaxOperatingProfit += campaign.afterTaxOperatingProfit;
    }

    return Array.from(grouped.values()).sort((a, b) => b.month.localeCompare(a.month));
  }, [report.campaigns]);

  const maxChartValue = Math.max(
    0,
    ...report.bridge.map((row) => Math.abs(row.amount)),
    ...report.monthly.map((row) => Math.abs(row.preTaxOperatingProfit)),
    ...report.monthly.map((row) => Math.abs(row.afterTaxOperatingProfit)),
  );

  return (
    <CrmShell>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 md:p-6 md:px-8">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/70 bg-background/70 shadow-ambient backdrop-blur md:rounded-[24px]">
          <div className="crm-topbar flex shrink-0 flex-col gap-3 border-b border-border/70 bg-background/60 px-4 py-4 md:flex-row md:items-start md:justify-between md:px-5">
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-bold text-foreground">
                  {report.year}년 영업 순수익 리포트
                </h2>
                <Badge variant="outline">{totals.campaignCount}개 캠페인</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                완료 캠페인 기준으로 캠페인 비용과 개인사업자 예상 세금을 반영한
                세후 영업이익을 봅니다.
              </p>
            </div>
            <div className="flex flex-col items-start gap-1 text-xs text-muted-foreground md:items-end">
              <span>{report.taxRules.label}</span>
              <span>
                귀속 {report.taxRules.incomeYear}년 · 신고 {report.taxRules.filingYear}년
              </span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 md:p-5">
            <div className="flex flex-col gap-5">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                  label="총 상품매출"
                  value={`${formatKRW(totals.grossSales)}원`}
                  description="완료 캠페인의 판매 총액"
                />
                <MetricCard
                  label="수수료 매출"
                  value={`${formatKRW(totals.commissionRevenue)}원`}
                  description="브랜드/채널에서 확보한 수수료 매출"
                />
                <MetricCard
                  label="세전 영업순이익"
                  value={`${formatKRW(totals.preTaxOperatingProfit)}원`}
                  description="캠페인 비용과 공제세액 반영 후"
                  emphasis="profit"
                  amount={totals.preTaxOperatingProfit}
                />
                {/* 두 타일은 각자 부호를 본다 — 세금 부담이 크면 세전 흑자·세후 적자가 갈린다 */}
                <MetricCard
                  label="세후 예상 영업이익"
                  value={`${formatKRW(totals.afterTaxOperatingProfit)}원`}
                  description={`예상 세금 ${formatKRW(totals.estimatedTotalTax)}원 차감`}
                  emphasis="profit"
                  amount={totals.afterTaxOperatingProfit}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                  label="셀러 지급액"
                  value={`${formatKRW(totals.sellerPayout)}원`}
                  description="셀러 수수료와 지급 비용"
                  emphasis="cost"
                />
                <MetricCard
                  label="공제세액"
                  value={`${formatKRW(totals.deductedTax)}원`}
                  description="원천세, VAT 등 캠페인 공제 항목"
                  emphasis="cost"
                />
                <MetricCard
                  label="운영비 + 기타비용"
                  value={`${formatKRW(totals.operatingExpense + totals.miscExpense)}원`}
                  description="택배비, 보정비, 기타 조정 비용"
                  emphasis="cost"
                />
                <MetricCard
                  label="예상 소득세 + 지방세"
                  value={`${formatKRW(totals.estimatedTotalTax)}원`}
                  description={`예상 유효세율 ${formatPercent(taxEstimate.effectiveTaxRate)}`}
                  emphasis="cost"
                />
              </div>

              {/* 수익 구성(CategoryBar) + 순이익률(ProgressCircle) — 카드 8개를 눈으로
                  합산하지 않고 "수수료매출이 어디로 나가고 얼마 남나"를 그래픽으로. */}
              <Card className="rounded-lg">
                <CardHeader>
                  <CardTitle>수익 구성 · 이익률</CardTitle>
                  <CardDescription>
                    수수료매출 {formatKRW(totals.commissionRevenue)}원이 어디로 나가고 얼마가 남는지
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid items-center gap-6 md:grid-cols-[minmax(0,1fr)_auto]">
                    <CategoryBar
                      total={totals.commissionRevenue}
                      formatValue={(v) => `${formatKRW(v)}`}
                      segments={[
                        { label: "셀러 지급", value: totals.sellerPayout, color: "var(--chart-5)" },
                        { label: "공제세액", value: totals.deductedTax, color: "var(--chart-2)" },
                        { label: "운영비+기타", value: totals.operatingExpense + totals.miscExpense, color: "var(--chart-1)" },
                        { label: "예상 세금", value: totals.estimatedTotalTax, color: "var(--status-caution)" },
                        { label: "순이익(세후)", value: totals.afterTaxOperatingProfit, color: "var(--accent-gold)" },
                      ]}
                    />
                    <div className="flex flex-col items-center gap-1 md:border-l md:border-border/60 md:pl-6">
                      <ProgressCircle
                        value={totals.afterTaxOperatingProfit}
                        max={totals.commissionRevenue}
                        label={formatPercent(
                          totals.commissionRevenue > 0
                            ? (totals.afterTaxOperatingProfit / totals.commissionRevenue) * 100
                            : 0,
                        )}
                        caption="순이익률"
                      />
                      <span className="text-[10px] text-muted-foreground">
                        수수료매출 대비 세후이익
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Alert>
                <InfoIcon />
                <AlertTitle>세금 계산 기준</AlertTitle>
                <AlertDescription>
                  과세표준은 CRM상 세전 영업순이익을 보수적으로 사용합니다. 외부
                  소득, 필요경비, 소득공제, 세액공제는 반영하지 않은 예상
                  충당금입니다. 2025 실제 신고와 부가세 구조는 검토했지만, 상반기
                  영업 비중이 낮아 현재 추정 세율을 직접 보정하는 기준으로는
                  반영하지 않았습니다.
                </AlertDescription>
              </Alert>

              <div className="grid gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
                <Card className="rounded-lg">
                  <CardHeader>
                    <CardTitle>수익 브릿지</CardTitle>
                    <CardDescription>
                      상품매출에서 세후 예상 영업이익까지의 금액 흐름
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {bridgeChartData.length > 0 ? (
                      <ChartContainer
                        config={BRIDGE_CHART_CONFIG}
                        className="h-[290px] w-full"
                      >
                        <BarChart
                          data={bridgeChartData}
                          margin={{
                            top: 12,
                            right: 12,
                            left: computeChartLeftMargin(maxChartValue),
                            bottom: 0,
                          }}
                        >
                          <CartesianGrid vertical={false} strokeDasharray="3 3" />
                          <XAxis
                            dataKey="label"
                            tickLine={false}
                            axisLine={false}
                            tick={{ fontSize: 11 }}
                          />
                          <YAxis
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={(value) => formatYAxisLabel(value)}
                            tick={{ fontSize: 11 }}
                          />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Bar
                            dataKey="amount"
                            name="금액"
                            fill="var(--chart-1)"
                            radius={[4, 4, 0, 0]}
                            maxBarSize={38}
                          />
                        </BarChart>
                      </ChartContainer>
                    ) : (
                      <div className="flex h-[240px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                        표시할 손익 데이터가 없습니다.
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="rounded-lg">
                  <CardHeader>
                    <CardTitle>월별 순이익 흐름</CardTitle>
                    <CardDescription>
                      세전 순이익과 예상 세후 이익의 월별 차이
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {monthlyChartData.length > 0 ? (
                      <ChartContainer
                        config={MONTHLY_CHART_CONFIG}
                        className="h-[290px] w-full"
                      >
                        <ComposedChart
                          data={monthlyChartData}
                          margin={{
                            top: 12,
                            right: 12,
                            left: computeChartLeftMargin(maxChartValue),
                            bottom: 0,
                          }}
                        >
                          <CartesianGrid vertical={false} strokeDasharray="3 3" />
                          <XAxis
                            dataKey="month"
                            tickLine={false}
                            axisLine={false}
                            tick={{ fontSize: 11 }}
                          />
                          <YAxis
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={(value) => formatYAxisLabel(value)}
                            tick={{ fontSize: 11 }}
                          />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Bar
                            dataKey="preTaxOperatingProfit"
                            name="세전 순이익"
                            fill="var(--chart-2)"
                            radius={[4, 4, 0, 0]}
                            maxBarSize={32}
                          />
                          <Line
                            type="monotone"
                            dataKey="afterTaxOperatingProfit"
                            name="세후 예상 이익"
                            stroke="var(--chart-1)"
                            strokeWidth={2}
                            dot={{ r: 3, strokeWidth: 1.5, fill: "var(--background)" }}
                          />
                        </ComposedChart>
                      </ChartContainer>
                    ) : (
                      <div className="flex h-[240px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                        완료된 캠페인이 없습니다.
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              <Card className="rounded-lg">
                <CardHeader>
                  <CardTitle>캠페인별 순수익</CardTitle>
                  <CardDescription>
                    진행 월별로 구분했습니다. 행을 선택하면 계산 근거를 확인합니다.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-4">
                    {campaignsByMonth.map((monthGroup) => (
                      <div key={monthGroup.month} className="overflow-hidden rounded-lg border">
                        <div className="flex flex-col gap-2 border-b bg-muted/30 px-4 py-3 md:flex-row md:items-center md:justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-foreground">
                              {monthGroup.month.replace("-", "년 ")}월
                            </span>
                            <Badge variant="outline">{monthGroup.rows.length}건</Badge>
                          </div>
                          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                            <span>세전 {formatKRW(monthGroup.preTaxOperatingProfit)}원</span>
                            <span>세후 {formatKRW(monthGroup.afterTaxOperatingProfit)}원</span>
                          </div>
                        </div>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="min-w-[220px]">캠페인명</TableHead>
                              <TableHead>기간</TableHead>
                              <TableHead className="text-right">상품매출</TableHead>
                              <TableHead className="text-right">수수료 매출</TableHead>
                              <TableHead className="text-right">셀러 지급</TableHead>
                              <TableHead className="text-right">공제세액</TableHead>
                              <TableHead className="text-right">운영비</TableHead>
                              <TableHead className="text-right">기타비용</TableHead>
                              {/* 결과 블록 시작 — 구성요소(매출·비용)와 결론(순이익·이익률)을
                                  헤어라인 하나로 가른다. 열이 9개라 경계가 없으면 눈이 "어디까지가
                                  재료이고 어디부터가 답인가"를 매 행 다시 찾는다. */}
                              <TableHead className="border-l text-right">세전 순이익</TableHead>
                              <TableHead className="text-right">세후 예상</TableHead>
                              <TableHead className="text-right">이익률</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {monthGroup.rows.map((row) => {
                              const preTaxTone = resolveProfitTone(row.preTaxOperatingProfit);
                              const afterTaxTone = resolveProfitTone(row.afterTaxOperatingProfit);
                              return (
                              <TableRow
                                key={row.id}
                                className="cursor-pointer"
                                tabIndex={0}
                                onClick={() => setSelectedCampaign(row)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    setSelectedCampaign(row);
                                  }
                                }}
                              >
                                {/* 손익 리포트의 초점은 숫자다 — 이름 칸은 배지 없이 한 줄로 둔다.
                                    걷어낸 둘:
                                    ① "비용 미입력" — 운영비·기타비용은 원래 안 드는 캠페인이 많아
                                       전 행에 떴다. 발화율 100% 인 경고는 신호가 0 이고(습관화),
                                       0 원 계산 사실은 행을 열면 상세 시트가 항목까지 말한다.
                                    ② 채널 — 좋고 나쁨이 없는 범주다(P8 색 원칙 4). 이 표가 돕는
                                       판단은 "어느 캠페인이 얼마 남겼나"라서 채널은 그 판단에
                                       참여하지 않는다. 역시 상세 시트가 보유한다.
                                    남긴 배지는 "적자" 하나뿐 — 소수 행에만 뜨는 예외라 표에서 색을
                                    받을 자격이 있는 유일한 항목이다(P8 "표=주의가 필요한 소수만").
                                    status-urgent 로 정렬 — shadcn 범용 destructive 는 별개 토큰
                                    계열이라 같은 "적자"가 모바일(캠페인 카드)과 다른 빨강으로
                                    떴다. 이 variant 는 --status-urgent-text 를 쓰므로 옆의
                                    손익 숫자와 같은 hex 가 되어 한 색으로 읽힌다. */}
                                <TableCell className="max-w-[280px]">
                                  <div className="flex items-center gap-2">
                                    <span className="truncate font-medium">
                                      {row.campaignName}
                                    </span>
                                    {row.preTaxOperatingProfit < 0 ? (
                                      <Badge variant="status-urgent">적자</Badge>
                                    ) : null}
                                  </div>
                                </TableCell>
                                <TableCell>{formatDateRange(row)}</TableCell>
                                <AmountCell value={row.grossSales} />
                                <AmountCell value={row.commissionRevenue} />
                                <AmountCell value={row.sellerPayout} />
                                <AmountCell value={row.deductedTax} />
                                <AmountCell value={row.operatingExpense} />
                                <AmountCell value={row.miscExpense} />
                                {/* 손익 3열은 부호를 따르되 **밀집 강도**다(profit-tone SSOT):
                                    적자만 색을 받고 흑자는 본문 색을 상속한다. 이 표는 대부분의
                                    행이 흑자라 초점 강도를 쓰면 열 전체가 초록이 되고, 그러면
                                    색이 값의 함수이기를 멈춘다 — 같은 회차에 걷어낸 "전 행에
                                    뜨는 비용 미입력 배지"와 구조가 같은 습관화다(P8 §2·§3).
                                    비용 열들은 그대로 무채색: 라벨이 이미 비용이라고 말한다. */}
                                <TableCell className={cn("border-l text-right font-semibold tabular-nums", preTaxTone && PROFIT_TONE_TEXT_DENSE[preTaxTone])}>
                                  {formatKRW(row.preTaxOperatingProfit)}
                                </TableCell>
                                <TableCell className={cn("text-right font-semibold tabular-nums", afterTaxTone && PROFIT_TONE_TEXT_DENSE[afterTaxTone])}>
                                  {formatKRW(row.afterTaxOperatingProfit)}
                                </TableCell>
                                <TableCell className={cn("text-right font-semibold tabular-nums", afterTaxTone && PROFIT_TONE_TEXT_DENSE[afterTaxTone])}>
                                  {formatPercent(row.afterTaxProfitRate)}
                                </TableCell>
                              </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>

      <Sheet
        open={selectedCampaign != null}
        onOpenChange={(open) => {
          if (!open) setSelectedCampaign(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selectedCampaign ? (
            <>
              <SheetHeader>
                <SheetTitle>{selectedCampaign.campaignName}</SheetTitle>
                <SheetDescription>
                  {selectedCampaign.startDate} - {selectedCampaign.endDate}
                </SheetDescription>
              </SheetHeader>

              <div className="flex flex-col gap-5 px-4 pb-4">
                <Card size="sm" className="rounded-lg">
                  <CardHeader className="px-0">
                    <CardTitle>캠페인 메타</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3 px-0">
                    <DetailLine label="상품/딜" value={selectedCampaign.dealName} />
                    <DetailLine label="셀러" value={selectedCampaign.sellerName} />
                    <DetailLine
                      label="브랜드"
                      value={selectedCampaign.brandName ?? "미입력"}
                    />
                    <DetailLine
                      label="거래처"
                      value={selectedCampaign.partnerName ?? "미연결"}
                    />
                    <DetailLine
                      label="채널"
                      value={channelLabel(selectedCampaign.salesChannel)}
                    />
                  </CardContent>
                </Card>

                <Card size="sm" className="rounded-lg">
                  <CardHeader className="px-0">
                    <CardTitle>계산 근거</CardTitle>
                    <CardDescription>
                      수수료 매출에서 캠페인 비용과 예상 세금을 차감합니다.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3 px-0">
                    <DetailLine
                      label="총 상품매출"
                      value={formatFullKRW(selectedCampaign.grossSales)}
                    />
                    <DetailLine
                      label="수수료 매출"
                      value={formatFullKRW(selectedCampaign.commissionRevenue)}
                      strong
                    />
                    <DetailLine
                      label="셀러 지급액"
                      value={`-${formatFullKRW(selectedCampaign.sellerPayout)}`}
                    />
                    <DetailLine
                      label="공제세액"
                      value={`-${formatFullKRW(selectedCampaign.deductedTax)}`}
                    />
                    <DetailLine
                      label="운영비"
                      value={`-${formatFullKRW(selectedCampaign.operatingExpense)}`}
                    />
                    <DetailLine
                      label="기타비용"
                      value={`-${formatFullKRW(selectedCampaign.miscExpense)}`}
                    />
                    <DetailLine
                      label="세전 영업순이익"
                      value={formatFullKRW(selectedCampaign.preTaxOperatingProfit)}
                      strong
                      amount={selectedCampaign.preTaxOperatingProfit}
                    />
                    <DetailLine
                      label="예상 소득세"
                      value={`-${formatFullKRW(selectedCampaign.estimatedIncomeTax)}`}
                    />
                    <DetailLine
                      label="예상 지방세"
                      value={`-${formatFullKRW(selectedCampaign.estimatedLocalIncomeTax)}`}
                    />
                    <DetailLine
                      label="세후 예상 영업이익"
                      value={formatFullKRW(selectedCampaign.afterTaxOperatingProfit)}
                      strong
                      amount={selectedCampaign.afterTaxOperatingProfit}
                    />
                  </CardContent>
                </Card>

                {selectedCampaign.missingCostFields.length > 0 ? (
                  <Alert>
                    <InfoIcon />
                    <AlertTitle>비용 미입력 항목</AlertTitle>
                    <AlertDescription>
                      {selectedCampaign.missingCostFields.join(", ")} 값이 없어 0원으로
                      계산했습니다.
                    </AlertDescription>
                  </Alert>
                ) : null}

                <Alert>
                  <InfoIcon />
                  <AlertTitle>예상 세금 배분</AlertTitle>
                  <AlertDescription>
                    연간 예상 소득세와 지방세를 이 캠페인의 양수 세전 이익 비중에
                    따라 배분했습니다. 확정 신고 세액과 다를 수 있습니다.
                  </AlertDescription>
                </Alert>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </CrmShell>
  );
}
