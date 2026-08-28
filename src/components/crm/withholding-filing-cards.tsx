"use client";

/**
 * 「세무 처리」 다이얼로그의 원천징수 탭 — 절차 3카드.
 *
 * 원천징수 실무는 하나의 절차가 아니라 셋이고(원천세 신고 · 지급명세 제출 · 지방소득세
 * 특별징수), 서식·제출처·기한이 전부 다르다. 오너가 "어디에 뭘 입력해야 하는지
 * 모르겠다"고 보고한 지점이라, 각 카드는 그 절차의 **실제 화면 필드명을 그대로** 쓴다
 * (docs/private/specs/2026-08-03-tax-filing-helper-design.md 「실제 화면 필드명」).
 * ⚠️ `귀속년월`·`지급년월`은 화면 라벨 그대로다("연월"이 아니다) — "고쳐서" 법정 서식
 * 표기로 되돌리지 말 것.
 *
 * ⚠️ **금액 칸 이름은 2026-08-11 오너 실측으로 정정됐다**(T-028): `(5)총지급금액` →
 * `(5)총 지급액` · `(6)소득세 등` → `(6)소득세` · 지급명세의 `지급액`. 초판 라벨은
 * 안내자료 캡처에서 옮긴 것이었고, 오너가 실제 입력하는 신고서 화면과 달랐다(T-025 의
 * 홈택스 바이트 상한과 같은 부류 — 안내자료보다 오너의 실측이 이긴다). 세 칸이
 * 「총지급금액/소득세 등/지급액」으로 제각각이던 것도 이때 한 어휘로 모았다.
 * ⛔ 법정 서식 표기(`총지급액`·`소득세 등`)로 되돌리지 말 것.
 *
 * **(세전) 접미사는 장식이 아니라 오입력 방지선이다.** 이 값들은 전부 원천징수 **전**
 * 금액인데, 화면 어디에도 그 기준이 적혀 있지 않으면 오너가 셀러에게 실제로 이체한
 * 금액(차인지급액)을 총 지급액 칸에 넣을 수 있다 — 소득을 과소신고하는 방향이라
 * 카드 3의 과세표준 오입력(세액 10배)과 반대 방향의 같은 급 사고다. 라벨 자체에
 * 기준을 박아 값을 복사하는 순간 눈에 들어오게 한다.
 *
 * 이전엔 이 탭이 `WithholdingReportDialog`를 여는 버튼 하나였다(중첩 Dialog를 피하려는
 * 임시 조치). 절차 카드로 교체하면서 그 중첩 다이얼로그를 없앤다 — 탭 안에 카드를
 * 직접 그린다.
 *
 * 금액 SSOT: 새 계산을 하지 않는다. `buildWithholdingReport`의 출력(`totals`·`rows`)을
 * 재배열만 한다 — 셀러에게 발송된 정산 명세서와 1원이라도 갈리면 안 되기 때문이다.
 *
 * 귀속월 = 지급월(오너 확정, 2026-08-04) — 이 리포트의 단일 지급월 축이 그대로 귀속월
 * 축이다. 2축 집계는 하지 않는다(설계 문서 「✅ 확정 — 귀속월 = 지급월」).
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Copy, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import type { WithholdingReport } from "@/lib/withholding-report";
import { maskResidentNumber, simplifiedStatementDueDate, withholdingDueDate } from "@/lib/withholding-report";
import {
  SIMPLIFIED_STATEMENT_INDUSTRY_CODE,
  SIMPLIFIED_STATEMENT_INDUSTRY_NAME,
  formatDDay,
  getDDayLevel,
  isTaxFilingKind,
  type TaxFilingKind,
} from "@/lib/tax-filing-log";

function formatWon(value: number): string {
  return `${value.toLocaleString("ko-KR")}원`;
}

type FilingLogResponse = { month: string; completed: { kind: string; completedAt: string }[] };

/** 절차 카드 본문의 공통 단위 — 라벨 + 값 + 행별 복사. 덩어리 텍스트를 주지 않는다 —
 *  오너가 홈택스 칸에 직접 값을 옮겨 적으므로 칸 단위로 끊어야 빠르다(설계 문서
 *  「A. 캠페인 사이드패널」 공통 포맷 절과 동일 원칙).
 *
 *  `highlight`는 이 화면에서 가장 위험한 값(위택스 과세표준) 하나만을 위한 별도
 *  carrier다 — 값 자체에 urgent 톤을 주는 것과는 별개로, 박스 자체를
 *  `bg-status-urgent-bg`로 물들여 "실명 미등록"·"세액 칸이 없습니다" 같은 흔한
 *  caution/urgent 문구들과 시각적으로 같은 무게로 읽히지 않게 한다(design-system.md
 *  §2 — 위험 색이 흔해지면 습관화로 신호가 희석된다). 총 지급액을 넣으면 세액이
 *  10배가 되는 이 화면 최상위 위험 요소라 카드마다 하나만 쓴다.
 *
 *  ⚠️ 그래서 `note` 는 톤 없이도 쓴다 — (5)총 지급액의 「세전」 안내처럼 **위험이 아니라
 *  기준을 알리는** 문구는 무채색으로 둔다(P8 §1 「축을 섞지 말 것」: 세전/세후는 심각도
 *  축이 아니다). 안내마다 caution 을 얹으면 위 습관화 방지선이 그대로 무너진다.
 *
 *  `copyable=false` 는 **고르는 칸**을 위한 것이다(2026-08-11, 오너 실측 화면 대조). 위택스
 *  한건신고의 `납부시기`는 라디오, `지급연월`·`귀속연월`은 드롭다운이라 복사할 대상이
 *  없는데, 그래도 오너가 무엇을 고를지는 알아야 하므로 값 칩으로는 남긴다. 이 카드에서
 *  복사 버튼의 유무는 그래서 장식이 아니라 **"치는 칸이냐 고르는 칸이냐"의 표지**다 —
 *  전부 버튼을 달면 그 구분이 사라지고, 누를 수 없는 버튼만 늘어난다. */
function FieldRow({
  label,
  value,
  tone,
  note,
  testId,
  highlight,
  copyable = true,
}: {
  label: string;
  value: string;
  tone?: "urgent" | "caution";
  note?: string;
  testId?: string;
  highlight?: boolean;
  copyable?: boolean;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} 값을 복사했습니다.`);
    } catch {
      toast.error("클립보드 복사에 실패했습니다.");
    }
  };
  const toneClass =
    tone === "urgent" ? "text-status-urgent-text" : tone === "caution" ? "text-status-caution-text" : "text-foreground";
  return (
    <div
      className={`flex items-start justify-between gap-2 rounded-md border px-2.5 py-1.5 ${
        highlight ? "border-status-urgent/20 bg-status-urgent-bg" : "border-border/60"
      }`}
    >
      <div className="min-w-0">
        <div className="text-[10px] text-muted-foreground">{label}</div>
        <div className={`text-sm font-semibold tabular-nums ${toneClass}`} data-testid={testId}>
          {value}
        </div>
        {note ? (
          <div className={`mt-0.5 flex items-start gap-1 text-[10px] font-medium ${toneClass}`}>
            {highlight ? <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden="true" /> : null}
            <span>{note}</span>
          </div>
        ) : null}
      </div>
      {copyable ? (
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`${label} 복사`}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-slate-100 hover:text-foreground"
        >
          <Copy className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * 카드 헤더 — 순번·절차명·서식명·제출처·기한 D-day·완료 체크(스펙 「B. 정산 페이지」
 * 「원천징수 탭 — 절차 3카드」).
 *
 * 색은 심각도 축에만 쓴다 — 제출처(홈택스/위택스)는 **범주**이고 심각도가 아니므로
 * 색을 받지 않는다(design-system.md §4 「범주는 색을 받지 않는다」·§1 「축을 섞지
 * 말 것」). 위택스가 다른 사이트라는 사실은 카드 3의 호출부가 라벨 문자열
 * 자체("위택스(홈택스 아님)")로 표현한다 — 색이 아니라 평문 강조다.
 *
 * 대신 심각도 축을 **정당하게** 가진 것은 기한 근접도(D-day)다. 카드 3개가 구조적으로
 * 동일해서(같은 헤더 모양) D-day 를 무채색으로 두면 오너가 세 문자열을 읽고 직접
 * 비교해야만 "어느 절차가 급한지"를 알 수 있다 — 이 화면이 답해야 할 질문 자체다.
 * 임계값(`getDDayLevel`)은 지나거나 오늘(urgent) · 3일 이하 남음(caution) · 그 외(무채색)
 * 세 단계 — 근거는 tax-filing-log.ts 참조.
 */
function CardHeader({
  order,
  title,
  formName,
  submitTo,
  dueDate,
  completed,
  pending,
  onToggle,
}: {
  order: number;
  title: string;
  formName: string;
  submitTo: string;
  dueDate: string;
  completed: boolean;
  pending: boolean;
  onToggle: () => void;
}) {
  const dDayLevel = getDDayLevel(dueDate);
  const dDayToneClass =
    dDayLevel === "urgent"
      ? "font-semibold text-status-urgent-text"
      : dDayLevel === "caution"
        ? "font-medium text-status-caution-text"
        : "text-muted-foreground";
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border pb-2">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          <span className="text-muted-foreground">{order}.</span> {title}
        </h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {formName} · <span className="font-medium text-foreground">{submitTo}</span> · 기한 {dueDate} (
          <span className={dDayToneClass}>{formatDDay(dueDate)}</span>)
        </p>
      </div>
      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs font-medium text-foreground">
        <input
          type="checkbox"
          checked={completed}
          disabled={pending}
          onChange={onToggle}
          aria-label={`${title} 완료`}
          className="size-4 rounded border-input accent-primary"
        />
        완료
      </label>
    </div>
  );
}

export function WithholdingFilingCards({ month }: { month: string }) {
  const [report, setReport] = useState<WithholdingReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completedKinds, setCompletedKinds] = useState<Set<TaxFilingKind>>(new Set());
  const [pendingKind, setPendingKind] = useState<TaxFilingKind | null>(null);
  const [revealedSellerIds, setRevealedSellerIds] = useState<Set<string>>(new Set());

  const fetchAll = useCallback(async (targetMonth: string) => {
    setLoading(true);
    setError(null);
    try {
      const [reportRes, logRes] = await Promise.all([
        fetch(`/api/settlement/withholding?month=${targetMonth}`),
        fetch(`/api/settlement/tax-filing-log?month=${targetMonth}`),
      ]);
      if (!reportRes.ok) {
        const body = await reportRes.json().catch(() => null);
        throw new Error(body?.error ?? `조회 실패 (HTTP ${reportRes.status})`);
      }
      setReport((await reportRes.json()) as WithholdingReport);
      setRevealedSellerIds(new Set());

      if (logRes.ok) {
        const logData = (await logRes.json()) as FilingLogResponse;
        setCompletedKinds(new Set(logData.completed.map((c) => c.kind).filter(isTaxFilingKind)));
      } else {
        setCompletedKinds(new Set());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 실패");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll(month);
  }, [month, fetchAll]);

  const toggleReveal = (sellerId: string) => {
    setRevealedSellerIds((prev) => {
      const next = new Set(prev);
      if (next.has(sellerId)) next.delete(sellerId);
      else next.add(sellerId);
      return next;
    });
  };

  const toggleComplete = async (kind: TaxFilingKind) => {
    const isCompleted = completedKinds.has(kind);
    setPendingKind(kind);
    try {
      const res = await fetch("/api/settlement/tax-filing-log", {
        method: isCompleted ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, kind }),
      });
      if (!res.ok) throw new Error("처리 실패");
      setCompletedKinds((prev) => {
        const next = new Set(prev);
        if (isCompleted) next.delete(kind);
        else next.add(kind);
        return next;
      });
      toast.success(isCompleted ? "완료를 해제했습니다." : "완료로 표시했습니다.");
    } catch {
      toast.error("처리에 실패했습니다.");
    } finally {
      setPendingKind(null);
    }
  };

  if (loading && !report) {
    return (
      <p className="flex h-full min-h-[280px] items-center justify-center text-xs text-muted-foreground">
        불러오는 중…
      </p>
    );
  }
  if (error) {
    return (
      <p className="flex h-full min-h-[280px] items-center justify-center text-xs text-status-urgent-text">
        {error}
      </p>
    );
  }
  if (!report) return null;

  if (report.rows.length === 0) {
    return (
      <p className="flex h-full min-h-[280px] items-center justify-center text-xs text-muted-foreground">
        {report.month} 지급완료된 개인 셀러 지급 건이 없습니다. 신고 대상 없음.
      </p>
    );
  }

  const withholdingDue = withholdingDueDate(report.month);
  const statementDue = simplifiedStatementDueDate(report.month);
  const [year, mm] = report.month.split("-");

  return (
    <div className="flex flex-col gap-4">
      {report.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-lg bg-status-caution-bg px-3 py-2">
          {report.warnings.map((warning) => (
            <li key={warning} className="text-xs text-status-caution-text">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}

      {/* 카드 1 — 원천세 신고 */}
      <section className="rounded-lg border border-border p-3">
        <CardHeader
          order={1}
          title="원천세 신고"
          formName="원천징수이행상황신고서"
          submitTo="홈택스"
          dueDate={withholdingDue}
          completed={completedKinds.has("WITHHOLDING_RETURN")}
          pending={pendingKind === "WITHHOLDING_RETURN"}
          onToggle={() => void toggleComplete("WITHHOLDING_RETURN")}
        />
        <p className="mt-2 text-[11px] text-muted-foreground">
          경로: 세금신고 → 원천세 신고 → 일반신고 → 정기신고
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <FieldRow label="귀속년월" value={report.month} />
          <FieldRow label="지급년월" value={report.month} />
          <FieldRow label="(4)인원수" value={`${report.totals.sellerCount}명`} />
          <FieldRow
            label="(5)총 지급액(세전)"
            value={formatWon(report.totals.preTaxTotal)}
            note="원천징수 전 금액입니다. 차인지급액이 아닙니다."
          />
          <FieldRow label="(6)소득세" value={formatWon(report.totals.incomeTax)} />
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          (7)농어촌 특별세 · (8)가산세는 해당 없음(빈칸). 총합계(A99)는 사업소득 입력 시 자동입력됩니다.
          지방소득세는 이 신고서에 넣지 않습니다. 3번 카드(위택스)에서 별도로 신고합니다.
        </p>
      </section>

      {/* 카드 2 — 지급명세 제출 */}
      <section className="rounded-lg border border-border p-3">
        <CardHeader
          order={2}
          title="지급명세 제출"
          formName="간이지급명세서(거주자의 사업소득)"
          submitTo="홈택스"
          dueDate={statementDue}
          completed={completedKinds.has("SIMPLIFIED_STATEMENT")}
          pending={pendingKind === "SIMPLIFIED_STATEMENT"}
          onToggle={() => void toggleComplete("SIMPLIFIED_STATEMENT")}
        />
        <p className="mt-2 text-[11px] text-muted-foreground">
          경로: [지급명세ㆍ자료ㆍ공익법인] → [(일용ㆍ간이ㆍ용역)직접작성 제출]
        </p>
        <p className="mt-2 text-[10px] font-medium text-status-caution-text">
          ⚠ 세액 칸이 없습니다. 지급액만 입력합니다. 기한이 1번 카드와 약 3주 다릅니다(말일).
          10일에 원천세만 내고 이 절차를 잊기 쉬운 구간입니다.
        </p>
        <p className="mt-2 text-[10px] text-muted-foreground">
          업종은 전 셀러 공통 <span className="font-semibold text-foreground">기타자영업</span>(940909)입니다.
          업종명을 검색해 고르는 화면이면 이름으로, 코드 칸이면 코드로 넣습니다.
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <FieldRow label="지급연도" value={year} />
          <FieldRow label="지급월" value={mm} />
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase text-muted-foreground">
                <th className="py-1.5 pr-2 font-medium">성명</th>
                <th className="py-1.5 pr-2 font-medium">주민등록번호</th>
                <th className="py-1.5 pr-2 font-medium">귀속연도</th>
                <th className="py-1.5 pr-2 font-medium">귀속월</th>
                <th className="py-1.5 pr-2 text-right font-medium">지급액(세전)</th>
                <th className="py-1.5 font-medium">업종</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.sellerId} className="border-b border-border/60 align-top">
                  <td className="py-1.5 pr-2">
                    {row.sellerRealName ? (
                      <span className="font-semibold text-foreground">{row.sellerRealName}</span>
                    ) : (
                      <>
                        <span className="font-semibold text-status-caution-text">실명 미등록</span>
                        {/* 실명으로 대신 채우지 않는다(활동명이 신고서에 실리면 안 된다) — 다만
                            "누가" 미입력인지는 알아야 경고가 실행 가능하므로 표기명(별칭)을
                            괄호로 병기한다(구 WithholdingReportDialog와 동일 원칙). */}
                        {row.sellerAlias ? (
                          <span className="ml-1 text-[10px] text-muted-foreground">({row.sellerAlias})</span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    {row.residentNumber ? (
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <span className="font-mono tabular-nums">
                          {revealedSellerIds.has(row.sellerId)
                            ? row.residentNumber
                            : maskResidentNumber(row.residentNumber)}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleReveal(row.sellerId)}
                          className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                          aria-label={
                            revealedSellerIds.has(row.sellerId) ? "주민등록번호 가리기" : "주민등록번호 보기"
                          }
                        >
                          {revealedSellerIds.has(row.sellerId) ? (
                            <EyeOff className="size-3.5" />
                          ) : (
                            <Eye className="size-3.5" />
                          )}
                        </button>
                      </span>
                    ) : (
                      <span className="text-status-caution-text">미등록</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 tabular-nums">{year}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{mm}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{formatWon(row.preTaxTotal)}</td>
                  {/* 이름과 코드를 함께 낸다 — 홈택스가 어느 쪽을 받는지 미확인이라 한쪽만
                      두면 오너가 값을 못 얻는 경우가 생긴다(tax-filing-log.ts 상수 주석). */}
                  <td className="py-1.5" data-testid={`industry-${row.sellerId}`}>
                    {SIMPLIFIED_STATEMENT_INDUSTRY_NAME}{" "}
                    <span className="font-mono text-[10px] text-muted-foreground">
                      ({SIMPLIFIED_STATEMENT_INDUSTRY_CODE})
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* 세 칸의 기준이 같다는 사실 자체가 안내 대상이다 — 카드마다 이름이 달랐을 때
            오너가 "이 지급액은 아까 그 총 지급액과 다른 건가"를 매번 다시 판단해야 했다. */}
        <p className="mt-2 text-[10px] text-muted-foreground">
          「지급액」은 1번 카드 「총 지급액(세전)」과 같은 기준(원천징수 전)이며, 이 표의 합계가 그 금액입니다.
        </p>
      </section>

      {/* 카드 3 — 지방소득세 특별징수 (위택스) */}
      <section className="rounded-lg border border-border p-3">
        <CardHeader
          order={3}
          title="지방소득세 특별징수"
          formName="특별징수분(지방소득세)"
          submitTo="위택스(홈택스 아님)"
          dueDate={withholdingDue}
          completed={completedKinds.has("LOCAL_INCOME_TAX")}
          pending={pendingKind === "LOCAL_INCOME_TAX"}
          onToggle={() => void toggleComplete("LOCAL_INCOME_TAX")}
        />
        {/* 오너가 실제로 쓰는 경로가 본문이다(오너 확인 2026-08-11). 홈택스 「지방소득세
            신고이동」은 대체 경로로 맨 아래에 둔다 — 초판은 그쪽을 "권장"으로 앞세웠는데,
            오너는 위택스에 직접 들어가 신고하므로 매달 읽고 건너뛰는 문장이 카드 머리에
            있었다. */}
        <p className="mt-2 text-[11px] text-muted-foreground">
          경로:{" "}
          <span className="font-medium text-foreground">
            위택스 → 신고 → 지방소득세 → 특별징수 → 한건신고
          </span>
        </p>
        {/* 직접 접속 경로에서는 인적사항 화면을 매번 지나야 한다. 이 값들(사업자등록번호·
            사업장번호·관할자치단체)은 CRM 이 모르는 오너 사업자 정보라 값으로 줄 수 없다 —
            대신 "무엇을 누르면 채워지는가"의 순서만 준다. */}
        <p className="mt-1 text-[10px] text-muted-foreground">
          인적사항 화면: 「신고인과 동일(주소 제외)」 체크 → 사업자등록번호 여부 「여」 → 사업장번호조회 →
          관할자치단체 선택.
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <FieldRow label="납부시기" value="월" copyable={false} />
          <FieldRow label="지급연월" value={`${year}년 ${Number(mm)}월`} copyable={false} />
          <FieldRow label="귀속연월" value={`${year}년 ${Number(mm)}월`} copyable={false} />
        </div>
        {/* 신고세액 표는 이자·배당·사업·근로 등 11개 행이다. 어느 행인지 말해주지 않으면
            오너가 매달 다시 고른다(설계 문서 「신고세액 표 사업소득 행」 — 초판 구현에서
            누락됐다). */}
        <p className="mt-2 text-[10px] text-muted-foreground">
          아래 두 값은 신고세액 표의 <span className="font-semibold text-foreground">「사업소득」 행</span>에
          넣습니다.
        </p>
        <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <FieldRow label="인원" value={`${report.totals.sellerCount}명`} />
          <div className="col-span-2">
            <FieldRow
              label="과세표준"
              value={formatWon(report.totals.incomeTax)}
              tone="urgent"
              note="1번 카드 「소득세」 금액입니다. 총 지급액이 아닙니다. 잘못 넣으면 세액이 10배가 됩니다."
              testId="local-tax-standard-value"
              highlight
            />
          </div>
        </div>
        {/* 세액은 오너 실측으로 "자동으로 채워진다"가 확인됐다(2026-08-11). 그러므로 참고값의
            용도는 **입력할 값이 아니라 검산 기준**이다 — 초판 문구("위택스 계산값을 그대로
            입력하세요")는 오너가 뭔가 타이핑해야 하는 것처럼 읽혔다. 단정하지 않음 계약은
            그대로다: 우리는 세액을 확정값으로 렌더하지 않는다. */}
        <p className="mt-2 text-[10px] text-muted-foreground">
          특별징수세액은 과세표준을 넣으면 위택스가 자동으로 채웁니다. 직접 입력하지 않습니다. 채워진 값이
          명세서상 실제 원천징수 지방소득세({formatWon(report.totals.localIncomeTax)})와 1원 이상 달라도
          정상입니다. 딜별 반올림과 위택스 원단위 절사 때문이며, 오차가 아니라 계산 기준이 다른 것입니다.
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          가감조정액(환급·추가납부)은 해당 없음이므로 전부 0으로 둡니다. 비고: 지방소득세 특별징수분.
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          홈택스 신고내역 조회에서 「지방소득세 신고이동」으로 들어오면 위 단계가 자동 입력됩니다.
        </p>
      </section>
    </div>
  );
}
