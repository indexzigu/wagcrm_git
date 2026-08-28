"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Link2Icon } from "lucide-react";

import { CrmShell } from "./crm-shell";
import { LinkPreviewRefresh } from "./link-preview-refresh";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
import { cn } from "@/lib/utils";
import { PROFIT_TONE_TEXT_DENSE, resolveProfitTone } from "@/lib/profit-tone";
import type { InflowLinkRow, InflowReport } from "@/lib/inflow-report";

/**
 * 유입 리포트 — 발급된 단축링크를 캠페인 가로질러 본다.
 *
 * 답하려는 질문은 **"어느 셀러가, 어느 경로로 유입을 만들었는가"** 다. 사이드패널 카드가
 * "이 링크가 살아있는가"(클릭·순방문자 둘)를 답한다면, 여기는 그 위 질문이다.
 *
 * 한국 인플루언서 트래픽은 referer 가 비어 오는 경우가 대부분이라 **인앱 브라우저 판정이
 * 사실상 유입경로의 정본**이다. 이게 없으면 대부분이 "직접 유입" 으로 뭉개진다.
 */

/** 기계값 → 사람이 읽는 라벨. 없는 값은 원문 그대로 보여준다(새 채널을 숨기지 않는다). */
const CHANNEL_LABELS: Record<string, string> = {
  kakaotalk: "카카오톡",
  instagram: "인스타그램",
  facebook: "페이스북",
  naver: "네이버",
  daum: "다음",
  line: "라인",
  threads: "스레드",
  tiktok: "틱톡",
  youtube: "유튜브",
  x: "X",
  google: "구글",
  kakao: "카카오",
  webview: "인앱 브라우저",
  direct: "직접 유입",
};

const DEVICE_LABELS: Record<string, string> = {
  mobile: "모바일",
  tablet: "태블릿",
  desktop: "PC",
};

function labelOf(map: Record<string, string>, key: string) {
  return map[key] ?? key;
}

function formatDate(value: Date | string | null) {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function formatDateTime(value: Date | string | null) {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    // 24시간제 고정 — 오전/오후 글리프는 서버·브라우저의 ICU 데이터가 다르면
    // ("오전" vs "AM") 하이드레이션이 깨진다(실측: dev 서버 Node). 표 안 시각은
    // 24h 가 tabular 하게 읽히기도 한다.
    hour12: false,
    timeZone: "Asia/Seoul",
  }).format(date);
}

const nf = new Intl.NumberFormat("ko-KR");
const krw = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });

export function InflowReportClient({ report }: { report: InflowReport }) {
  const [selected, setSelected] = useState<InflowLinkRow | null>(null);

  return (
    <CrmShell>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 md:p-6 md:px-8">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/70 bg-background/70 shadow-ambient backdrop-blur md:rounded-[24px]">
          <div className="crm-topbar flex shrink-0 flex-col gap-3 border-b border-border/70 bg-background/60 px-4 py-4 md:flex-row md:items-start md:justify-between md:px-5">
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-bold text-foreground">유입 리포트</h2>
                <Badge variant="outline">링크 {nf.format(report.links.length)}개</Badge>
                {report.attention.activeNoClickLinks > 0 && (
                  // 판매 기간인데 클릭이 0 — 아직 안 뿌렸거나 셀러가 게시를 안 했다.
                  // 이건 지금 손을 써야 하는 유일한 부류라 상단에 둔다.
                  <Badge variant="status-urgent">
                    판매 중 클릭 없음 {nf.format(report.attention.activeNoClickLinks)}건
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                셀러에게 준 단축링크의 유입을 봅니다. 정산이 확정되면 매출과 순이익이 같은 표에
                붙습니다.
              </p>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 md:p-5">
            <div className="flex flex-col gap-5">
              {/* 요약 행은 **지금 손을 써야 하는 것**만 답한다.
                  ⛔ 전 기간 누적(총 클릭·총 방문자)을 되돌리지 말 것 — 단조증가라
                  어떤 결정도 걸리지 않는 허영 지표다(오너 판단 2026-07-31). 셀러 비교는
                  아래 표가 한다. */}
              <div className="grid gap-3 md:grid-cols-3">
                <SummaryTile
                  label="판매 중 클릭 없음"
                  value={report.attention.activeNoClickLinks}
                  unit="건"
                  note="아직 안 뿌렸거나 게시 전"
                />
                <SummaryTile
                  label="클릭 없는 링크"
                  value={report.attention.noClickLinks}
                  unit="건"
                  note={`전체 ${nf.format(report.links.length)}개 중`}
                />
                <SummaryTile
                  label="만료 임박"
                  value={report.attention.expiringSoonLinks}
                  unit="건"
                  note="7일 이내"
                />
              </div>

              {report.links.length === 0 ? (
                <EmptyState />
              ) : (
                <div className="overflow-hidden rounded-xl border border-border/70 bg-white/90">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>캠페인</TableHead>
                        <TableHead>셀러</TableHead>
                        <TableHead>기간</TableHead>
                        <TableHead className="text-right">클릭</TableHead>
                        <TableHead className="text-right">직전 회차 대비</TableHead>
                        <TableHead className="text-right">클릭당 매출</TableHead>
                        <TableHead className="text-right">클릭당 순이익</TableHead>
                        <TableHead className="text-right">마지막 클릭</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.links.map((link) => (
                        <TableRow
                          key={link.code}
                          onClick={() => setSelected(link)}
                          className="cursor-pointer"
                        >
                          <TableCell>
                            <div className="flex flex-col gap-0.5">
                              <span className="font-medium text-foreground">
                                {link.campaignName ?? link.label ?? "캠페인 미연결"}
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {link.code}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <span>{link.sellerName ?? "-"}</span>
                              {link.roundNumber != null && (
                                <Badge variant="outline" className="text-[10px]">
                                  {link.roundNumber}차
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {link.startDate ? `${formatDate(link.startDate)} ~ ${formatDate(link.endDate)}` : "-"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            <div className="flex flex-col items-end gap-0.5">
                              <span>{nf.format(link.clicks)}</span>
                              <span className="text-[10px] text-muted-foreground">
                                연인원 {nf.format(link.visitDays)}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <RoundDelta clicks={link.clicks} previous={link.previousRoundClicks} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            <Money value={link.revenuePerClick} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            <Money value={link.profitPerClick} tone />
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">
                            {formatDateTime(link.lastClickAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <LinkDetailSheet link={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </CrmShell>
  );
}

/**
 * 원 단위 금액 — 값이 없으면 **"정산 대기"**로 표기한다.
 *
 * 0 으로 접지 말 것. 리포트는 시차를 담는 물건이라(오너 2026-07-31) "아직 정산 전"과
 * "정산했는데 0원"은 전혀 다른 상태이고, 0 으로 뭉개면 그 구분이 사라진다.
 */
function Money({ value, tone = false }: { value: number | null; tone?: boolean }) {
  if (value === null) {
    // 대비 하한 준수 — P8 데이터 그리드 3단 사다리가 소극 상태의 하한을 slate-500 으로
    // 못박았고, 같은 표의 보조 셀(기간·마지막 클릭)이 이미 이 처리를 쓴다. slate-400 은
    // 흰 카드에서 2.57:1 로 AA 미달이다.
    return <span className="text-xs text-muted-foreground">정산 대기</span>;
  }
  // ⚠️ 손익 판정색은 **부호가 뒤집힐 수 있는 값**에만 얹는다(P8: 색은 주의가 필요한
  // 소수에만). 매출은 항상 양수라 색을 주면 늘 초록이고, 그건 정보가 없는 장식이 된다.
  // 순이익만 적자로 뒤집힐 수 있으므로 그쪽만 tone 을 켠다.
  const profitTone = tone ? resolveProfitTone(value) : null;
  return (
    <span className={cn("tabular-nums", profitTone && PROFIT_TONE_TEXT_DENSE[profitTone])}>
      {krw.format(Math.round(value))}
    </span>
  );
}

/**
 * 직전 회차 대비 클릭 증감.
 *
 * 색을 쓰지 않는다 — 증감은 P8 의 5개 의미축(방향·판정·심각도·생애주기·달성) 어디에도
 * 속하지 않아서, 색을 얹으면 6번째 축을 발명하는 셈이다. 방향은 기호가 말한다.
 */
function RoundDelta({ clicks, previous }: { clicks: number; previous: number | null }) {
  if (previous === null) {
    return <span className="text-xs text-muted-foreground">비교 대상 없음</span>;
  }
  if (previous === 0) {
    // 0 으로 나누지 않는다. 직전이 0 이면 배수가 무한이라 숫자가 거짓말을 한다.
    return <span className="text-xs text-muted-foreground">직전 0회</span>;
  }
  const delta = (clicks - previous) / previous;
  const sign = delta > 0 ? "▲" : delta < 0 ? "▼" : "―";
  const percent = Math.abs(Math.round(delta * 100));
  const direction = delta > 0 ? "증가" : delta < 0 ? "감소" : "동일";
  return (
    <span
      className="text-xs tabular-nums text-muted-foreground"
      // 기호가 유일한 전달 수단이면 스크린리더에는 "위쪽 삼각형 38%" 로만 읽힌다.
      aria-label={`직전 회차 대비 ${percent}% ${direction}`}
    >
      <span aria-hidden>{sign} {percent}%</span>
    </span>
  );
}

function SummaryTile({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: number;
  unit: string;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-white/90 p-4 shadow-soft-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-foreground">
        <span className="text-2xl font-semibold tabular-nums">{nf.format(value)}</span>
        <span className="ml-1 text-xs text-muted-foreground">{unit}</span>
      </p>
      {note && <p className="mt-1 text-[11px] text-slate-500">{note}</p>}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-slate-50/50 p-10 text-center">
      <Link2Icon className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">아직 발급된 단축링크가 없습니다</p>
      <p className="max-w-md text-xs leading-relaxed text-slate-500">
        판매 관리에서 캠페인을 열고 &ldquo;셀러 배포용 링크&rdquo; 카드에서 발급하면 여기에
        유입이 쌓입니다.
      </p>
    </div>
  );
}

type LinkStatsResponse = {
  stats: {
    totalClicks: number;
    visitDays: number;
    botClicks: number;
    byChannel: Array<{
      key: string;
      clicks: number;
      byDay: Array<{ date: string; clicks: number }>;
    }>;
    byDevice: Array<{ key: string; clicks: number }>;
    bySub: Array<{ key: string; clicks: number }>;
    byHour: Array<{ hour: number; clicks: number }>;
    byDay: Array<{
      date: string;
      clicks: number;
      uniqueVisitors: number;
      byHour: Array<{ hour: number; clicks: number }>;
    }>;
  };
};

export function LinkDetailSheet({
  link,
  onOpenChange,
}: {
  link: InflowLinkRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [includeBots, setIncludeBots] = useState(false);
  const [data, setData] = useState<LinkStatsResponse["stats"] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  // 닫힘 애니메이션 동안 내용이 비지 않도록 마지막 값을 스냅샷으로 유지한다(P8 Sheet 관례).
  const [snapshot, setSnapshot] = useState<InflowLinkRow | null>(null);
  useEffect(() => {
    if (link) setSnapshot(link);
  }, [link]);

  const code = link?.code;
  const load = useCallback(async () => {
    if (!code) return;
    setState("loading");
    try {
      const res = await fetch(
        `/api/tracked-links/${encodeURIComponent(code)}/stats${includeBots ? "?includeBots=1" : ""}`,
      );
      if (!res.ok) throw new Error("조회 실패");
      const body = (await res.json()) as LinkStatsResponse;
      setData(body.stats);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [code, includeBots]);

  useEffect(() => {
    if (code) void load();
  }, [code, load]);

  // 링크를 바꾸면 토글은 기본값으로 되돌린다 — 앞 링크에서 켠 "봇 포함" 이 따라오면
  // 다음 링크의 숫자를 봇 포함으로 오독한다.
  useEffect(() => {
    setIncludeBots(false);
  }, [code]);

  return (
    <Sheet open={Boolean(link)} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="text-sm font-bold text-slate-800">
            {snapshot?.campaignName ?? snapshot?.label ?? "링크 상세"}
          </SheetTitle>
          <SheetDescription>
            {snapshot?.sellerName ? `${snapshot.sellerName} · ` : ""}
            <span className="font-mono">{snapshot?.shortUrl}</span>
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-6">
          {/* 소스는 `link` 가 아니라 `snapshot` 이다 — 이 시트는 닫힘 애니메이션
              동안 마지막 값을 유지하고, 새 행만 link 를 쓰면 그 줄만 먼저 사라진다. */}
          {snapshot ? (
            // key: 표시 중인 링크가 바뀌면 내부 snapshot state 를 새로 시작해야
            // 한다 — prop 은 마운트 시 1회만 소비되므로 없으면 이전 링크의
            // 제목·썸네일이 남는다.
            <LinkPreviewRefresh
              key={snapshot.code}
              code={snapshot.code}
              shortUrl={snapshot.shortUrl}
              preview={snapshot}
            />
          ) : null}

          <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
            <div className="flex flex-col">
              <span className="text-xs font-medium text-foreground">봇 클릭 포함</span>
              <span className="text-[11px] text-slate-500">
                {data ? `링크 미리보기 크롤러 ${nf.format(data.botClicks)}회` : "링크 미리보기 크롤러"}
              </span>
            </div>
            <Switch
              checked={includeBots}
              onCheckedChange={setIncludeBots}
              aria-label="봇 클릭 포함"
            />
          </div>

          {state === "loading" ? (
            <div className="space-y-4">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : state === "error" ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed p-4">
              <span className="text-xs text-muted-foreground">상세를 불러오지 못했습니다.</span>
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-md px-2 py-1 text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                다시 시도
              </button>
            </div>
          ) : data ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <SummaryTile label="클릭" value={data.totalClicks} unit="회" />
                {/* 캠페인 전 기간이라 **연인원**이다. 아래 일자별 표의 "순 방문자"만
                    진짜 사람 수다(visitorHash 에 KST 날짜가 섞여 있다). */}
                <SummaryTile label="방문 연인원" value={data.visitDays} unit="명" />
              </div>

              <SettlementSection link={snapshot} />

              <HourlySection rows={data.byHour} total={data.totalClicks} />

              <Breakdown
                title="유입 경로"
                hint="referer 가 비어 오는 경우가 많아 인앱 브라우저 판정이 정본입니다. 경로를 누르면 일자별로 펼쳐집니다."
                rows={data.byChannel.map((r) => ({ ...r, label: labelOf(CHANNEL_LABELS, r.key) }))}
                total={data.totalClicks}
              />
              <Breakdown
                title="기기"
                rows={data.byDevice.map((r) => ({ ...r, label: labelOf(DEVICE_LABELS, r.key) }))}
                total={data.totalClicks}
              />
              <Breakdown
                title="콘텐츠"
                hint="셀러가 링크 뒤에 ?s= 를 붙인 경우에만 갈립니다."
                rows={data.bySub.map((r) => ({ ...r, label: r.key }))}
                total={data.totalClicks}
                emptyText="콘텐츠 구분자를 쓴 클릭이 없습니다."
              />
              <DailyTable rows={data.byDay} />
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * 정산 조인 — 리포트는 시차를 담는다. 아직 정산 전이면 그 사실을 말하고 0 을 만들지 않는다.
 *
 * 클릭당 **셀러비용**은 목록 표에 넣지 않았다(열이 이미 8개다). 여기서는 지면이 있으므로
 * 매출·비용·순이익 셋을 같이 놓아 "이 셀러의 트래픽을 얼마에 사서 얼마가 남았나" 를
 * 한눈에 본다.
 */
function SettlementSection({ link }: { link: InflowLinkRow | null }) {
  if (!link) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">정산</h3>
      {link.sales === null ? (
        <p className="rounded-lg border border-dashed bg-slate-50/50 px-3 py-4 text-center text-xs text-muted-foreground">
          아직 정산 전입니다. 확정되면 매출과 순이익이 여기 붙습니다.
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-3 text-xs">
          <SettlementRow label="확정 매출" value={link.sales} />
          <SettlementRow label="클릭당 매출" value={link.revenuePerClick} />
          <SettlementRow label="셀러 지급액" value={link.sellerExpense} />
          <SettlementRow label="클릭당 셀러비용" value={link.costPerClick} />
          <SettlementRow label="영업이익" value={link.operatingProfit} tone />
          <SettlementRow label="클릭당 순이익" value={link.profitPerClick} tone />
        </dl>
      )}
      {link.quantity !== null && (
        <p className="text-[11px] text-slate-500">
          확정 판매 수량 {nf.format(link.quantity)}개. 주문 건수가 아니라 수량입니다.
        </p>
      )}
    </section>
  );
}

function SettlementRow({
  label,
  value,
  tone = false,
}: {
  label: string;
  value: number | null;
  tone?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">
        <Money value={value} tone={tone} />
      </dd>
    </div>
  );
}

/**
 * 시간대별 분포 — "어느 시간대에 반응이 오는가"(다음 게시 시각 판단의 근거).
 *
 * 24칸 고정 컬럼 차트다. 분포는 **빈 시간대가 자리를 가져야** 모양이 성립하므로
 * 0인 시간대도 그린다. 시간대는 좋고 나쁨이 없는 축이라 색을 받지 않는다(P8 §4) —
 * 최다 시간대 하나만 진하게 해 "피크가 어디인가"를 읽게 한다(강조는 색상 축이 아니라
 * 명도 차이라 무지개 금지에 걸리지 않는다).
 */
function HourlySection({
  rows,
  total,
}: {
  rows: Array<{ hour: number; clicks: number }>;
  total: number;
}) {
  const max = Math.max(...rows.map((r) => r.clicks), 0);
  // 동률 피크는 전부 강조하고 캡션도 전부 말한다 — 차트가 3칸을 강조했는데 문구가
  // 1개만 언급하면 시각과 어긋난다(ss-ux 검토 P1).
  const peakHours = max > 0 ? rows.filter((r) => r.clicks === max).map((r) => r.hour) : [];

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">시간대별</h3>
        {peakHours.length > 0 && (
          <span className="text-[10px] text-slate-500">
            가장 반응이 많은 시간대 {peakHours.map((h) => `${h}시`).join("·")} (
            {nf.format(max)}회)
          </span>
        )}
      </div>
      {total === 0 ? (
        <p className="rounded-lg border border-dashed bg-slate-50/50 px-3 py-4 text-center text-xs text-slate-500">
          아직 클릭이 없습니다.
        </p>
      ) : (
        <div className="rounded-lg border border-border/70 bg-muted/30 px-3 pb-2 pt-3">
          <div className="flex h-16 items-end gap-[3px]" role="img" aria-label="시간대별 클릭 분포">
            {rows.map((row) => (
              <div
                key={row.hour}
                // h-full + items-end 가 없으면 자식의 height:% 가 auto 부모에서 0 으로
                // 풀려 막대가 아예 안 그려진다(실렌더에서 잡힌 결함).
                className="flex h-full flex-1 items-end"
                title={`${row.hour}시 ${nf.format(row.clicks)}회`}
              >
                <div
                  className={cn(
                    "w-full rounded-sm",
                    row.clicks === 0
                      ? "bg-slate-200/70"
                      : row.clicks === max
                        ? "bg-slate-600"
                        : "bg-slate-400",
                  )}
                  style={{
                    // 최소 4% 높이 — 0(연회색)도 소량(중회색)도 자리를 갖는다. 둘의
                    // 구분은 높이가 아니라 색이 진다.
                    height: max > 0 ? `${Math.max((row.clicks / max) * 100, 4)}%` : "4%",
                  }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] tabular-nums text-slate-500" aria-hidden>
            <span>0시</span>
            <span>6시</span>
            <span>12시</span>
            <span>18시</span>
            <span>23시</span>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 분해표 — 채널·기기·콘텐츠는 **좋고 나쁨이 없는 범주**라 색을 받지 않는다(P8 §4).
 * 비율은 색이 아니라 막대 길이로 읽힌다.
 *
 * 행에 `byDay` 가 있으면(유입 경로) 클릭으로 일자별 추이가 펼쳐진다 — "이 경로가
 * 며칠까지 살아 있었나"(스토리는 하루, 피드는 며칠)를 여기서 가른다.
 */
function Breakdown({
  title,
  hint,
  rows,
  total,
  emptyText = "데이터가 없습니다.",
}: {
  title: string;
  hint?: string;
  rows: Array<{
    key: string;
    label: string;
    clicks: number;
    byDay?: Array<{ date: string; clicks: number }>;
  }>;
  total: number;
  emptyText?: string;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  return (
    <section className="space-y-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {hint && <p className="text-[11px] leading-5 text-slate-500">{hint}</p>}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-slate-50/50 px-3 py-4 text-center text-xs text-slate-500">
          {emptyText}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row) => {
            const ratio = total > 0 ? row.clicks / total : 0;
            const expandable = (row.byDay?.length ?? 0) > 0;
            const expanded = expandable && expandedKey === row.key;
            const bar = (
              <>
                <span className="flex w-24 shrink-0 items-center gap-1 truncate text-left text-xs text-foreground">
                  {row.label}
                  {expandable && (
                    <span aria-hidden className="text-[10px] text-slate-500">
                      {expanded ? "▾" : "▸"}
                    </span>
                  )}
                </span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <span
                    className="block h-full rounded-full bg-slate-400"
                    style={{ width: `${Math.max(ratio * 100, ratio > 0 ? 2 : 0)}%` }}
                  />
                </span>
                <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {nf.format(row.clicks)}회 · {Math.round(ratio * 100)}%
                </span>
              </>
            );
            return (
              <li key={row.key}>
                {expandable ? (
                  <button
                    type="button"
                    onClick={() => setExpandedKey(expanded ? null : row.key)}
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-3 rounded-md px-1 py-0.5 -mx-1 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    {bar}
                  </button>
                ) : (
                  <div className="flex items-center gap-3">{bar}</div>
                )}
                {expanded && row.byDay && (
                  <ul className="mt-1 space-y-1 rounded-md bg-muted/30 px-2 py-1.5">
                    {row.byDay.map((day) => {
                      const dayRatio = row.clicks > 0 ? day.clicks / row.clicks : 0;
                      return (
                        <li key={day.date} className="flex items-center gap-3">
                          <span className="w-24 shrink-0 text-[10px] tabular-nums text-slate-500">
                            {day.date.slice(5)}
                          </span>
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <span
                              className="block h-full rounded-full bg-slate-300"
                              style={{ width: `${Math.max(dayRatio * 100, dayRatio > 0 ? 2 : 0)}%` }}
                            />
                          </span>
                          <span className="w-20 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                            {nf.format(day.clicks)}회
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * 일자별 표 — 행을 누르면 그 날의 시간대 기록이 펼쳐진다(구체적인 기록 확인용).
 * 시간대 상세는 클릭이 있던 시간만 나열한다 — 여기는 분포 모양이 아니라 "그날 몇 시에
 * 정확히 몇 번"이라는 장부라서, 0인 시간대 20줄이 오히려 판독을 방해한다.
 */
function DailyTable({
  rows,
}: {
  rows: Array<{
    date: string;
    clicks: number;
    uniqueVisitors: number;
    byHour: Array<{ hour: number; clicks: number }>;
  }>;
}) {
  const [expandedDate, setExpandedDate] = useState<string | null>(null);

  // 데이터가 다시 로드되면(링크 전환·봇 포함 토글·재시도 — rows 는 매 조회 새 참조다)
  // 펼친 날짜를 접는다. 펼친 채 두면 토글 전 수치로 읽은 시간대 상세가 낡은 채 남는다.
  useEffect(() => {
    setExpandedDate(null);
  }, [rows]);

  return (
    <section className="space-y-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-foreground">일자별</h3>
        {rows.length > 0 && (
          <p className="text-[11px] leading-5 text-slate-500">
            날짜를 누르면 그 날의 시간대별 기록이 펼쳐집니다.
          </p>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-slate-50/50 px-3 py-4 text-center text-xs text-slate-500">
          아직 클릭이 없습니다.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/70">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>날짜</TableHead>
                <TableHead className="text-right">클릭</TableHead>
                <TableHead className="text-right">순 방문자</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const expanded = expandedDate === row.date;
                return (
                  <Fragment key={row.date}>
                    {/* 행 클릭은 포인터 편의이고, 접근성 계약(키보드 도달·aria-expanded)은
                        날짜 셀의 실제 button 이 진다 — tr 의 암묵 role(row)에는 aria-expanded
                        가 유효하지 않다(ss-ux 검토 P0). */}
                    <TableRow
                      onClick={() => setExpandedDate(expanded ? null : row.date)}
                      className="cursor-pointer"
                    >
                      <TableCell className="text-xs">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={(event) => {
                            // 행 onClick 과 겹치면 토글이 두 번 돌아 원위치가 된다.
                            event.stopPropagation();
                            setExpandedDate(expanded ? null : row.date);
                          }}
                          className="flex items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                        >
                          {row.date}
                          <span aria-hidden className="text-[10px] text-slate-500">
                            {expanded ? "▾" : "▸"}
                          </span>
                        </button>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {nf.format(row.clicks)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {nf.format(row.uniqueVisitors)}
                      </TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={3} className="bg-muted/30 py-2">
                          <ul className="space-y-1">
                            {row.byHour.map((slot) => {
                              const ratio = row.clicks > 0 ? slot.clicks / row.clicks : 0;
                              return (
                                <li key={slot.hour} className="flex items-center gap-3">
                                  <span className="w-12 shrink-0 text-[10px] tabular-nums text-slate-500">
                                    {slot.hour}시
                                  </span>
                                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                                    <span
                                      className="block h-full rounded-full bg-slate-300"
                                      style={{
                                        width: `${Math.max(ratio * 100, ratio > 0 ? 2 : 0)}%`,
                                      }}
                                    />
                                  </span>
                                  <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                                    {nf.format(slot.clicks)}회
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
