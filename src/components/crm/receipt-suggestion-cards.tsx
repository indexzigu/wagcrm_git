"use client";

/**
 * 수취 계산서 **유사도 승인 카드** — 세무 처리 다이얼로그와 정산 상세가 공유한다.
 *
 * 설계 정본은 `docs/private/specs/2026-08-12-group-invoice-similarity-approval-design.md`.
 *
 * ⚠️ 이 카드는 **판정이 아니라 제안**이다. 자동 확정은 하지 않으므로 유사도 건의 문구는
 * 단정하지 않게 「추정」을 유지한다 — 화면이 확신하면 오너가 근거를 안 보고 누른다.
 * (`VERIFIED` 건은 판정이 상대·금액을 이미 맞춘 경우라 그 문구를 쓰지 않는다. 그래도
 * 자동 반영은 하지 않는다 — 아래 `resolveApprovalKey` 주석.)
 *
 * ## 표기 규약 (ss-copy · 2026-08-15)
 *
 * - **버튼은 단어다** — `[동사]`(+목적어), 주 CTA 최대 3단어. 「승인하여 수취 처리」 같은
 *   문장을 버튼에 넣지 않는다(이 레포의 다른 버튼도 전부 「첨부」·「조회」·「완료」다).
 * - **본문 아래에 남는 버튼은 결정뿐이다** — 닫는 길은 헤더의 ✕ 와 Esc 로 충분하고,
 *   「닫기」를 본문 아래에 또 두면 닫는 방법만 셋이 된다(오너 방향 2026-08-15: 표기는
 *   심플하게). ⛔ **기본(우상단 절대위치) ✕ 는 쓰지 않는다** — `campaign-side-panel.tsx`·
 *   `market-price-monitor.tsx` 와 같은 레포 관례대로 `showCloseButton={false}` + 헤더
 *   안에 직접 배치한다(오너 지적 2026-08-15: 레포 다른 곳과 다르게 보인다).
 * - **본문은 문장이 아니라 key-value(detail-card 패턴)** — 상대·금액·수취일처럼 대조해야
 *   하는 값을 문장에 녹이면 오너가 두 숫자를 짝지어 읽지 못한다.
 *
 * ## ⛔ 화면마다 다시 만들지 말 것
 *
 * 두 표면이 같은 스캔 응답을 읽고 같은 결정 라우트를 부른다. 한쪽에 손으로 다시 그리면
 * 승인 요청 본문(어떤 key 를 보내는가)·차단 조건(작성일자 없음)이 곧바로 갈린다 — 이 레포가
 * 정산 명세서에서 세 번 겪은 「정본 함수는 있는데 호출부가 한 조각을 손으로 다시 만든다」와
 * 같은 부류다(`settlement-statement.ts` 주석).
 */

import { useState } from "react";
import { Ban, Check, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ReceiptScanApiResponse } from "@/lib/tax-invoice-mail/board-evidence";

/** 신호 한 줄의 표시 기호. 판정 불가는 X 가 아니라 `-` 다 — 불일치와 같은 칸에 두지 않는다. */
const SIGNAL_MARK: Record<string, string> = { MATCH: "O", MISS: "X", UNKNOWN: "-" };
const SIGNAL_LABEL: Record<string, string> = {
  WRITTEN_DATE: "일정",
  CAMPAIGN_NAME: "캠페인명",
  COUNTERPART_NAME: "셀러명",
};

/**
 * 승인 카드의 금액 표기 — **단위를 붙인다.**
 *
 * 이 카드는 서로 다른 출처의 두 금액(기대 vs 수취)과 그 차이를 한 문장에 나란히 놓는
 * 자리라, 단위 없는 숫자만 늘어놓으면 어느 것이 금액이고 어느 것이 건수인지 흐려진다.
 * 표 안에서 열 머리글이 단위를 말해 주는 자리와는 맥락이 다르다.
 */
function formatWonWithUnit(value: number): string {
  return `${value.toLocaleString("ko-KR")}원`;
}

type ScanResultRow = NonNullable<ReceiptScanApiResponse["results"]>[number];

/**
 * 조회 모달 **결과 슬롯의 고정 높이**(단일 값 — 스켈레톤·결과·못 찾음이 전부 이 안에 산다).
 *
 * 값의 근거는 실측이다(1280×720 · 모달 448px, 2026-08-15): 결정 대기 1건 = 234px,
 * 이미 처리한 1건(「상태」 줄이 하나 더 붙는다) = 254px. **한 건짜리 결과는 스크롤 없이
 * 들어가야** 한다 — 판정 근거와 승인 버튼이 반쯤 잘리면 조회 한 번으로 끝내라는 이 모달의
 * 목적이 깨진다. 그래서 그 최댓값에 라벨이 한 줄 접힐 여지(+16px)를 더한 값이다.
 * ⛔ 눈대중으로 줄이지 말 것 — 줄이면 흔들림 대신 잘림이 온다.
 */
const RESULT_SLOT_HEIGHT = "h-[17rem]";

/**
 * 스켈레톤 한 줄 — 결과의 key-value 한 줄이 들어올 자리다.
 *
 * ⚠️ 바깥 높이는 **결과 행과 같은 16px**(`h-4` = text-xs 한 줄)이고 색 띠만 12px 다.
 * 띠 높이로 줄을 세우면 줄마다 4px 씩 짧아져 스켈레톤이 결과보다 34px 낮게 앉는다
 * (실측) — 고정 슬롯 안에서 그만큼 아래가 비어 "로드되다 만 자리"로 읽힌다.
 */
function SkeletonLine({ width }: { width: string }) {
  return (
    <div className="flex h-4 items-center">
      <div className="h-3 animate-pulse rounded bg-slate-100" style={{ width }} />
    </div>
  );
}

/** 모달 본문의 key-value 한 줄. 값이 없으면 줄 자체를 만들지 않는다(빈 칸은 사실 주장이다). */
interface DetailRow {
  label: string;
  value: string;
  /** 주의를 끌어야 하는 값(금액 차이)만 색을 받는다 — P8 §1 심각도 축. */
  caution?: boolean;
  /** 「이 계산서가 누구 것인가」 vs 「얼마인가」 — 서로 다른 판단이라 묶어서 보여준다. */
  group: "identity" | "amount";
}

function buildDetailRows(row: ScanResultRow): DetailRow[] {
  const suggestion = row.suggestion;
  const observed = row.verdict.observed;
  const expected = suggestion?.expectedTotalAmount ?? observed.expectedTotalAmount;
  const received = suggestion?.observedTotalAmount ?? observed.totalAmount;
  const delta = suggestion?.amountDelta ?? row.decision?.amountDelta ?? observed.amountDelta;

  const rows: DetailRow[] = [];
  // 이미 결정된 건은 **무엇으로 끝났는지**가 첫 줄이다 — 그다음이 그 근거다.
  if (row.decision) {
    rows.push({
      label: "상태",
      value: row.decision.decision === "APPROVED" ? "승인됨" : "무관 처리됨",
      group: "identity",
    });
  }
  if (suggestion) {
    rows.push({ label: "상대", value: suggestion.counterpartLabel, group: "identity" });
    rows.push({ label: "캠페인", value: suggestion.campaignLabel, group: "identity" });
  } else {
    // ⛔ `suggestion` 유무로 「누구 것인가」를 가르지 말 것. 유사도 제안은 `NEEDS_REVIEW`
    //    에만 붙으므로 **판정이 정확히 맞은 `VERIFIED` 건일수록 상대·캠페인이 통째로
    //    빠진다.** 정산 상세는 칸이 맥락을 주지만, 같은 컴포넌트를 쓰는 세무 처리
    //    다이얼로그는 이번 달 전량을 한 목록에 섞으므로 그 행이 누구 것인지 알 방법이
    //    없어진다. 라벨이 없으면 메일 발신자·사업자번호로라도 반드시 식별을 남긴다.
    if (row.mail.fromAddress) rows.push({ label: "발행자", value: row.mail.fromAddress, group: "identity" });
    if (observed.counterpartBusinessNumber) {
      rows.push({ label: "사업자번호", value: observed.counterpartBusinessNumber, group: "identity" });
    }
  }
  if (expected != null) rows.push({ label: "기대", value: formatWonWithUnit(expected), group: "amount" });
  if (received != null) rows.push({ label: "수취", value: formatWonWithUnit(received), group: "amount" });
  // 차이는 0 이면 줄을 만들지 않는다 — 「0원」은 읽을 것이 없는데 자리만 차지한다.
  if (delta != null && delta !== 0) {
    rows.push({ label: "차이", value: formatWonWithUnit(delta), caution: true, group: "amount" });
  }
  // ⚠️ 승인이 실제로 적는 값이다(오늘 날짜가 아니라 계산서 작성일자) — 반드시 보여준다.
  rows.push({
    label: "수취일",
    value: observed.writtenDate ?? "읽지 못함",
    caution: observed.writtenDate === null,
    group: "amount",
  });
  // ⛔ 승인번호는 이 표에 두지 않는다 — 24자리라 줄을 통째로 먹는데, 「이 계산서가 이 칸의
  //    것인가」를 판단하는 데는 쓰이지 않는다(홈택스 대조용이라 접힌 근거로 내린다).
  return rows;
}

/**
 * 이 건을 승인했을 때 **완료를 적을 기대 건 key**. 없으면 승인이 성립하지 않는다.
 *
 * ⚠️ **`VERIFIED` 도 승인 대상이다(2026-08-14).** 종전에는 `suggestion` 이 있는 행만
 * 승인 버튼을 얻었는데, `suggestReceiptMatch` 는 `NEEDS_REVIEW` 에만 제안을 붙인다
 * (유사도는 판정을 뒤집지 않는다는 설계 원칙). 그래서 **금액·상대가 정확히 맞은 건일수록
 * 승인 경로가 없었다** — 화면은 「확인됨」이라고 말하는데 수취일은 영영 비어 있고,
 * 체크박스를 손으로 누르면 계산서 작성일자가 아니라 **오늘 날짜**가 찍혔다(오너 신고).
 *
 * ⛔ 그렇다고 자동 반영으로 바꾸지 말 것 — 「자동 확정하지 않는다, 항상 1클릭 승인 대기」는
 * 오너 확정(2026-08-12)이고, 잘못 발행된 계산서가 「확인됨」으로 굳는 것을 막는 장치다.
 * 여기서 여는 것은 **버튼이지 자동화가 아니다.**
 */
export function resolveApprovalKey(row: ScanResultRow): string | null {
  if (row.suggestion) return row.suggestion.key;
  if (row.verdict.status === "VERIFIED") return row.verdict.matchedKey ?? null;
  return null;
}

/**
 * 이 행이 **어느 기대 건에 귀속되는가** — 범위 필터(`keys`)가 쓰는 축.
 *
 * 결정이 이미 내려진 행은 그 결정의 대상 key 로 귀속한다(판정이 특정하지 못한 건도
 * 승인으로 귀속이 정해지기 때문 — `board-evidence.ts` 의 `indexReceiptScan` 과 같은 규칙).
 */
export function resolveDecisionScopeKeys(row: ScanResultRow): string[] {
  if (row.decision) return row.decision.matchedKeys;
  const key = resolveApprovalKey(row);
  return key ? [key] : [];
}

/**
 * 결정 버튼 — **아이콘 전용**(오너 방향 2026-08-15: 표기는 심플하게).
 *
 * ⛔ 손으로 클래스를 다시 짓지 않는다 — `ui/button.tsx` 의 `variant="outline" size="icon"`
 * 이 이 레포의 정본이고, 같은 파일(`tax-filing-dialog.tsx` 월 이동 버튼)에 이미 그 정확한
 * 패턴(`Button` + `outline` + `icon` + `sr-only` 라벨)이 있다. 손으로 만들면 radius
 * (`rounded-lg` 아닌 값)·시맨틱 토큰(`border-border`/`bg-background` 대신 리터럴
 * `slate-*`)·press 상태(`active:scale-[0.98]`)가 하나씩 갈린다(오너 지적 2026-08-15).
 *
 * ⚠️ 승인·무관·되돌리기는 같은 `outline` variant를 쓴다(색 위계 없음, 오너 방향
 * 2026-08-15) — 이 셋은 "주 액션 vs 보조 액션"이 아니라 검토의 대등한 결과다. 구분은
 * 아이콘 모양(Check ↔ Ban ↔ RotateCcw)과 `sr-only` 라벨만으로 한다.
 */

/**
 * 결정 행 목록 — 조회 결과 1건이 한 블록이다. 세무 처리 다이얼로그(넓은 자리)와 정산
 * 상세의 모달이 **같은 것**을 쓴다.
 */
function ReceiptDecisionList({
  scan,
  onDecided,
  keys,
  onSettled,
}: {
  scan: ReceiptScanApiResponse | null;
  onDecided: () => void;
  keys?: readonly string[];
  /** 결정이 성공했을 때 한 번 — 모달이 스스로 닫히는 신호. */
  onSettled?: (action: "approve" | "dismiss" | "revert") => void;
}) {
  const [busyIssueId, setBusyIssueId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const inScope = (row: ScanResultRow): boolean => {
    if (!keys) return true;
    return resolveDecisionScopeKeys(row).some((key) => keys.includes(key));
  };

  const rows = (scan?.results ?? []).filter(
    (row) => (resolveApprovalKey(row) || row.decision) && inScope(row),
  );
  if (rows.length === 0) return null;

  const decide = async (issueId: string, action: "approve" | "dismiss" | "revert", row: ScanResultRow) => {
    setBusyIssueId(issueId);
    setActionError(null);
    try {
      const res = await fetch("/api/settlement/tax-invoice-receipts/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueId,
          action,
          // ⚠️ `suggestion` 이 없는 `VERIFIED` 건은 판정이 특정한 `matchedKey` 가 대상이다
          //    (`resolveApprovalKey`). 서버가 기대 건 집합으로 다시 검증하므로 이 키를
          //    그대로 믿게 하는 것이 아니라, 승인 경로 자체를 여는 것이다.
          targetKeys: [resolveApprovalKey(row)].filter((key): key is string => key !== null),
          writtenDate: row.verdict.observed.writtenDate,
          observedTotal: row.verdict.observed.totalAmount,
          expectedTotal: row.suggestion?.expectedTotalAmount ?? row.verdict.observed.expectedTotalAmount,
          signalSummary: row.suggestion?.signals ?? null,
        }),
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        // 삼키지 않는다 — 실패를 조용히 넘기면 오너는 처리된 줄 안다(P0).
        throw new Error(errorBody?.error ?? `처리 실패 (HTTP ${res.status})`);
      }
      // 성공했을 때만 알린다 — 실패한 채로 닫으면 오너는 처리된 줄 안다(P0).
      onSettled?.(action);
      onDecided();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "처리에 실패했습니다.");
    } finally {
      setBusyIssueId(null);
    }
  };

  return (
    <div className="flex flex-col">
      {actionError ? <p className="pb-2 text-xs text-status-urgent-text">{actionError}</p> : null}
      {rows.map((row, index) => {
        const issueId = row.verdict.observed.issueId;
        if (!issueId) return null;
        const suggestion = row.suggestion;
        const decision = row.decision;
        const busy = busyIssueId === issueId;

        /**
         * 승인이 성립하려면 ①완료를 적을 자리와 ②적을 값(계산서 작성일자)이 **둘 다**
         * 있어야 한다. 작성일자가 없으면 서버가 422 로 거부하므로(그리고 오늘 날짜로 대신
         * 찍는 것은 없는 사실을 만드는 일이라 그렇게 하지 않는다) 여기서 미리 막고 이유를
         * 말한다.
         *
         * ⚠️ `suggestion` 은 낡은 응답에서 **필드 자체가 없을 수 있다**(undefined) —
         * `=== null` 로만 좁히면 그 경우가 새어 나간다.
         */
        const approvalKey = resolveApprovalKey(row);
        const blockReason = !approvalKey
          ? null
          : suggestion?.trackingField === null
            ? "이 건은 완료를 기록할 자리가 없어 승인할 수 없습니다."
            : row.verdict.observed.writtenDate === null
              ? "계산서 작성일자를 읽지 못해 자동 기록할 수 없습니다. 메일함에서 직접 확인해 처리해 주세요."
              : null;
        const approvable = blockReason === null;

        /**
         * 접어 둔 판정 근거. 신호는 기호를 앞에 붙여 **요약 줄과 상세 줄을 하나로 합친다** —
         * 종전에는 「일정 O · 캠페인명 O」 요약과 그 상세가 따로 있어 같은 사실이 두 번 나왔다.
         */
        const evidenceLines = [
          ...(suggestion?.signals ?? []).map((signal) => ({
            id: signal.kind,
            text: `${SIGNAL_LABEL[signal.kind] ?? signal.kind} ${SIGNAL_MARK[signal.result] ?? "?"} · ${signal.detail}`,
          })),
          ...row.verdict.reasons.map((reason) => ({ id: reason.code, text: reason.message })),
        ];
        // ⛔ 승인번호는 여기 넣지 않는다 — 세무 처리 보드는 같은 값을 증빙 셀에 이미
        //    그리고 있어 한 화면에 두 번 나오고, 24자리라 줄을 통째로 먹는다.

        /**
         * 본문을 **두 판단으로 가른다**(오너 지시 2026-08-15 — 레이아웃 재검토): 「이
         * 계산서가 누구 것인가」(identity)와 「얼마인가」(amount)는 서로 다른 질문이라 한
         * 목록에 섞으면 눈이 두 축을 오간다. 행 헤어라인(`border-slate-100`, P8 구분선
         * 1단)으로 나눈다 — 섹션 경계(`/60`)까지 쓰면 이 안에서만 3단이 되어 과하다.
         */
        const detailRows = buildDetailRows(row);
        const identityRows = detailRows.filter((detail) => detail.group === "identity");
        const amountRows = detailRows.filter((detail) => detail.group === "amount");
        const renderRow = (detail: DetailRow) => (
          <div key={detail.label} className="flex items-baseline gap-3 text-xs">
            <dt className="w-16 shrink-0 font-medium text-muted-foreground">{detail.label}</dt>
            <dd
              className={cn(
                "min-w-0 flex-1",
                detail.caution ? "font-medium text-status-caution-text" : "text-foreground",
              )}
            >
              {detail.value}
            </dd>
          </div>
        );

        return (
          <div
            key={issueId}
            className={cn("flex flex-col gap-3 py-3", index > 0 && "border-t border-slate-200/60")}
          >
            {/* 본문 = key-value 표(ss-pattern detail-card). 문장으로 풀면 대조해야 하는 두
                금액이 줄바꿈에 갈려 짝지어 읽히지 않는다. */}
            <div className="flex flex-col gap-2">
              {identityRows.length > 0 ? <dl className="flex flex-col gap-1">{identityRows.map(renderRow)}</dl> : null}
              <dl
                className={cn(
                  "flex flex-col gap-1",
                  identityRows.length > 0 && "border-t border-slate-100 pt-2",
                )}
              >
                {amountRows.map(renderRow)}
              </dl>
            </div>

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">판정 근거</summary>
              <ul className="mt-1 flex flex-col gap-0.5 break-all text-muted-foreground">
                {evidenceLines.map((line) => (
                  <li key={line.id}>{line.text}</li>
                ))}
              </ul>
            </details>

            {/* 승인이 왜 막혔는지 **미리** 말한다. 눌러서 실패하게 두면 오너는 도구를
                의심하고, 더 나쁘게는 실패를 성공으로 오독할 여지가 생긴다. */}
            {blockReason ? <p className="text-xs text-status-caution-text">{blockReason}</p> : null}

            {/* 액션은 본문과 헤어라인으로 갈라 자기 자리를 갖는다 — 「읽는 것」과
                「누르는 것」이 시각적으로도 다른 층이어야 실수로 스크롤 중에 누르지 않는다. */}
            <div className="flex justify-end gap-1.5 border-t border-slate-100 pt-2">
              {decision ? (
                <Button
                  variant="outline"
                  size="icon"
                  disabled={busy}
                  onClick={() => void decide(issueId, "revert", row)}
                  title="되돌리기"
                >
                  <RotateCcw className="size-4" aria-hidden="true" />
                  <span className="sr-only">되돌리기</span>
                </Button>
              ) : approvalKey ? (
                <>
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={busy}
                    onClick={() => void decide(issueId, "dismiss", row)}
                    title="무관: 이 계산서는 이 칸과 상관없습니다"
                  >
                    <Ban className="size-4" aria-hidden="true" />
                    <span className="sr-only">무관</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={busy || !approvable}
                    onClick={() => void decide(issueId, "approve", row)}
                    title="승인: 계산서 작성일자를 수취일로 기록합니다"
                  >
                    <Check className="size-4" aria-hidden="true" />
                    <span className="sr-only">승인</span>
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 세무 처리 다이얼로그(넓은 자리)의 인라인 목록. 이번 달 전체를 다루는 자리라 범위를
 * 좁히지 않는다.
 */
export function ReceiptSuggestionCards({
  scan,
  onDecided,
  keys,
}: {
  scan: ReceiptScanApiResponse | null;
  onDecided: () => void;
  keys?: readonly string[];
}) {
  // ⚠️ **섹션의 표시 판정에도 `keys` 를 건다.** 목록만 거르고 여기서 안 거르면, 이미 다른
  //    자리가 집어간 건을 두고 「승인 대기 N건」 머리글이 붙은 **빈 상자**가 뜬다(실측).
  const rows = (scan?.results ?? []).filter(
    (row) =>
      (resolveApprovalKey(row) || row.decision) &&
      (!keys || resolveDecisionScopeKeys(row).some((key) => keys.includes(key))),
  );
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-1 rounded-lg border border-border px-3 py-1">
      <p className="pt-1 text-xs font-semibold text-foreground">
        승인 대기 {rows.filter((row) => !row.decision).length}건
      </p>
      <ReceiptDecisionList scan={scan} onDecided={onDecided} keys={keys} />
    </section>
  );
}

/**
 * 계산서 칸의 **조회 모달** — 「조회」 한 번으로 조회부터 승인까지 끝낸다.
 *
 * ⛔ 칸에 승인 버튼을 따로 만들지 않는다(오너 지시 2026-08-15): 조회 → 칸에 승인 버튼
 * 생성 → 다시 클릭 → 모달 → 또 승인은 같은 결정을 세 번 누르게 하는 구조다. 칸의 버튼은
 * 「조회」 하나이고, 판정 결과와 그 결정은 전부 이 모달 안에서 일어난다.
 *
 * ⚠️ 칸에 남는 것은 **판정 배지**뿐이다 — 그건 조작이 아니라 마지막 조회가 남긴 사실이다.
 */
export function ReceiptDecisionDialog({
  open,
  onOpenChange,
  scan,
  loading,
  keys,
  title,
  onDecided,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scan: ReceiptScanApiResponse | null;
  /** 스캔이 도는 중. 결과 자리에 뼈대를 그린다(스피너 금지 — styleseed). */
  loading: boolean;
  /** 이 칸이 담당하는 기대 건 key. 다른 칸의 계산서가 섞이지 않게 한다. */
  keys: readonly string[];
  title: string;
  onDecided: () => void;
}) {
  const matched = (scan?.results ?? []).filter(
    (row) =>
      (resolveApprovalKey(row) || row.decision) &&
      resolveDecisionScopeKeys(row).some((key) => keys.includes(key)),
  );
  const hasResult = matched.length > 0;
  /** 아직 결정이 남은 건. 설명 문구와 **자동 닫기** 둘 다 이 수를 본다. */
  const pendingCount = matched.filter((row) => !row.decision && resolveApprovalKey(row)).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* ⛔ 기본 ✕(우상단 절대위치)를 쓰지 않는다 — `campaign-side-panel.tsx`·
          `market-price-monitor.tsx` 와 같은 레포 관례(`showCloseButton={false}` +
          헤더 안 직접 배치)를 따른다(오너 방향 2026-08-15). 제목·설명과 같은 헤더
          레이아웃 리듬 안에 놓이므로 절대위치가 만드는 별도 레이어가 없다. */}
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader className="flex-row items-start justify-between gap-2 space-y-0">
          <div className="flex flex-col gap-2">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {/* ⛔ 「조회 결과가 있다」만 보고 문구를 고르지 말 것 — 남은 결정이 없는데
                  「승인하면…」이라고 쓰면 지금 일어날 수 없는 일을 예고하는 셈이다. */}
              {loading
                ? "메일함을 조회하고 있습니다."
                : pendingCount > 0
                  ? "승인하면 계산서 작성일자가 수취일로 기록됩니다."
                  : hasResult
                    ? "이미 처리한 건입니다. 되돌릴 수 있습니다."
                    : "이번 조회에서는 이 칸에 맞는 계산서를 찾지 못했습니다."}
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">닫기</span>
          </Button>
        </DialogHeader>

        {/**
         * 결과 슬롯 — **높이를 고정한다**(`RESULT_SLOT_HEIGHT`, 오너 지적 2026-08-15:
         * 「조회 눌렀을 때 스켈레톤 창 크기와 조회된 뒤 창 크기가 흔들린다」).
         *
         * 중앙 정렬 다이얼로그는 내용이 h 만큼 자라면 창 전체가 **h/2 만큼 이동**하므로,
         * 조회가 끝나는 순간 모달이 눈앞에서 위로 뛴다(P8 Layout Stability ②). 실측
         * (1280×720 · 모달 448px): 스켈레톤 본문 72px → 확인됨 1건 214px → 유사도 1건
         * 234px → 못 찾음 32px, 창 전체로는 164px→306px 로 자라며 top 이 278→207 로
         * **71px 튀었다.**
         *
         * ⛔ `min-h-*` 로 되돌리지 말 것 — 그러면 하한만 생기고 그보다 큰 결과에서 다시
         * 자란다. 흔들리지 않게 하는 것은 **상·하한이 같은 값**이다. 넘치는 건(한 칸에
         * 계산서 2건 이상 = 그룹 후퇴·중복 발행 의심, 실측 449px)은 창을 키우는 대신
         * 슬롯 안에서 스크롤한다.
         * ⚠️ 스크롤바 거터를 예약한다(P8 Layout Stability ①) — 2건째가 들어오는 순간
         * 스크롤바가 생겨 내용 폭이 밀리면 결국 같은 종류의 흔들림이다.
         */}
        <div className={cn(RESULT_SLOT_HEIGHT, "overflow-y-auto [scrollbar-gutter:stable]")}>
          {loading ? (
            // 스켈레톤 — 결과가 들어올 자리와 **같은 모양**이다(스피너를 쓰지 않는 이유).
            // 줄 수·구분선·액션 자리를 결과와 맞춰 둬야, 높이가 같아도 "다른 것이 있다가
            // 사라진" 느낌이 나지 않는다.
            <div className="flex flex-col gap-3 py-3" aria-hidden="true">
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  {[0, 1].map((line) => (
                    <SkeletonLine key={line} width={line === 0 ? "78%" : "56%"} />
                  ))}
                </div>
                <div className="flex flex-col gap-1 border-t border-slate-100 pt-2">
                  {[0, 1, 2].map((line) => (
                    <SkeletonLine key={line} width={`${64 - line * 8}%`} />
                  ))}
                </div>
              </div>
              <SkeletonLine width="30%" />
              <div className="flex justify-end gap-1.5 border-t border-slate-100 pt-2">
                <div className="size-8 animate-pulse rounded-lg bg-slate-100" />
                <div className="size-8 animate-pulse rounded-lg bg-slate-100" />
              </div>
            </div>
          ) : hasResult ? (
            <ReceiptDecisionList
              scan={scan}
              keys={keys}
              onDecided={onDecided}
              /* ⛔ 결정 하나마다 닫지 않는다 — 한 칸에 계산서가 둘 이상 매칭되면(그룹이
                 멤버별로 후퇴한 경우·중복 발행 의심) 첫 승인에서 모달이 닫혀 나머지가
                 화면에서 사라진다. 「조회 한 번으로 끝낸다」는 지시가 다건에서 깨지는 지점.
                 되돌리기는 미결 건을 **늘리는** 방향이라 닫기 대상이 아니다. */
              onSettled={(action) => {
                if (action !== "revert" && pendingCount <= 1) onOpenChange(false);
              }}
            />
          ) : (
            // 슬롯이 고정 높이라 이 한 문장은 가운데 세로 정렬한다 — 위에 붙여 두면 남은
            // 여백이 "무언가 로드되다 만 자리"로 읽힌다.
            // ⛔ 「안 왔다」고 단정하지 않는다 — 메일 커버리지가 100% 가 아님이 실측됐다(P9).
            <div className="flex h-full items-center">
              <p className="text-xs text-muted-foreground">
                발행처가 다른 주소로 보냈거나 아직 도착하지 않았을 수 있습니다. 메일함을 직접 확인해 주세요.
              </p>
            </div>
          )}
        </div>

        {/* ⛔ 푸터에 「닫기」를 또 두지 않는다 — 위 헤더의 ✕ 와 Esc 가 이미 그 역할이다.
            둘을 다 두면 닫는 방법만 셋이 된다. 본문 아래에 남는 버튼은 **결정**뿐이어야
            무엇을 고르는 자리인지가 분명해진다(오너 방향 2026-08-15: 표기는 심플하게). */}
      </DialogContent>
    </Dialog>
  );
}
