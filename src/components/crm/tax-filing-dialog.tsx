"use client";

/**
 * 「세무 처리」 다이얼로그 — 월별 세무 마감 처리 보드.
 *
 * 세금계산서(발행/수취) 탭이 이번 달 남은 처리를 한 화면에 모은다. 원천징수 탭은
 * `WithholdingFilingCards`(절차 3카드)를 탭 본문에 직접 그린다 — 예전엔 별도
 * `WithholdingReportDialog`를 여는 버튼 하나였으나(중첩 Dialog를 피하려던 1단계
 * 임시 조치), 2단계에서 그 다이얼로그를 없애고 카드로 교체했다.
 *
 * 기한(D-day)은 이 단계에 넣지 않는다 — 세금계산서 발행 기한은 확인되지 않았고,
 * 확인 안 된 기한을 배지로 띄우면 오너가 그 날짜를 믿고 움직인다. 배지는 건수만
 * 보여준다.
 *
 * ## 「홈택스 XLSX」 파일 생성 — 재도입(2026-08-05)
 *
 * 2026-08-04, `tax-invoice-builder.ts`의 `buildTaxInvoiceRows`가 이 보드가 계산한
 * 금액·상대와 다른 값을 낸다는 사실이 드러났다 — 셀러몰 발행은 품목을
 * `deal.actualSales`로 구성해 합계가 셀러 수수료만큼 더 큰 값이 됐고, 브랜드몰
 * 발행은 공급받는자를 셀러 회사 정보로 하드코딩해 상대 자체가 틀렸다. 그래서
 * 체크박스·전체 선택·이 버튼·400 상세 표시를 이 다이얼로그에서 뺐다(당시 판단은
 * git 이력 `98d6c6f0` 참조).
 *
 * 같은 날 그 빌더는 이 보드가 낸 ISSUE 행(`buildTaxInvoiceObligationRows`)을 그대로
 * 소비하도록 다시 쓰여 두 오류가 고쳐졌다(counterpart 분기·재계산 없음) — 화면과
 * 파일이 같은 사실을 두 곳에서 각자 계산하던 구조 자체가 사라졌다. 이 정정을
 * 리뷰한 뒤 버튼을 되살린 것이 이 파일의 지금 상태다.
 *
 * 선택 가능 여부는 `row.selectable && row.xlsxEligible` 둘 다로 가른다 —
 * `direction`을 다시 비교하지 않는다(`xlsxEligible`이 "이 방향이 발행이다"라는
 * 사실을 이미 인코딩한다, `tax-filing-board.ts` 주석 참조). RECEIVE 행은 상대가
 * 이미 발행하므로 `xlsxEligible`이 항상 false라 체크박스 자체가 생기지 않는다 —
 * 이 게이트가 깨지면 우리가 상대의 계산서를 중복 발행하게 된다.
 *
 * ⚠️ POST 본문에는 반드시 행의 `campaignIds`(복수) 전체를 보낸다 —
 * `campaignId`(단수, 체크리스트 PATCH 앵커 전용 필드)를 보내면 정산 그룹의 대표
 * 멤버 1명분만 전달돼 그룹 전체 금액의 일부만 신고하는 사고가 된다. route.ts 가
 * 그룹 전원을 재조회해 방어하지만 그건 최후 방어선이고, 이 다이얼로그가 실제로
 * 지켜야 할 계약은 "행이 뜻하는 캠페인 전체를 보낸다"이다.
 *
 * ## 수취 메일함 확인(2026-08-04 도입)
 *
 * 「수취 — 우리가 받을 세금계산서」 섹션에 `GET /api/settlement/tax-invoice-receipts`
 * 를 태우는 버튼을 붙였다. 그 라우트는 IMAP 으로 메일함을 읽으므로(네트워크 I/O·오너의
 * 실제 메일함) 다이얼로그가 열릴 때 자동으로 부르지 않는다 — 오너가 버튼을 눌러야만
 * 스캔이 돈다. 스캔 결과는 **증거로만** 보여준다 — 「완료」 체크는 여전히 오너가
 * 직접 누른다(`board-evidence.ts` 헤더 주석 — 자동 완료는 잘못 발행된 계산서를
 * 「확인됨」으로 굳히는 사고를 재현한다).
 *
 * 조회 기간은 오너가 고른다(90/180/365일, 기본 90). 지급일이 비어 어느 달에도 잡히지
 * 않는 과거 건은 기본 창 밖이라 화면에서 확인할 수단이 아예 없었다. **본문 조회 상한
 * (`maxMessages`)은 노출하지 않는다** — 그건 성능·egress 안전장치이지 오너가 판단할
 * 축이 아니다. 상한에 걸리면 「기간을 줄여 나눠 보라」가 처방이다.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WithholdingFilingCards } from "./withholding-filing-cards";
import {
  indexReceiptScan,
  reconstructGroupMembers,
  resolveRowEvidence,
  type CampaignKeyStatus,
  type ReceiptScanApiResponse,
  type RowEvidence,
} from "@/lib/tax-invoice-mail/board-evidence";
import {
  AUTO_CONFIRM_SEED_LOOKBACK_LABEL,
  type AutoConfirmedEntry,
} from "@/lib/tax-filing-auto-confirm";
import type {
  TaxInvoiceBoard,
  TaxInvoiceBoardRow,
  TaxInvoiceCounterpart,
  TaxInvoiceDirection,
} from "@/lib/tax-filing-board";
import { useHometaxIssue, type TaxInvoiceValidationDetail } from "./use-hometax-issue";
// 승인 카드는 정산 상세와 **같은 컴포넌트**를 쓴다 — 화면마다 다시 그리면 승인 요청
// 본문과 차단 조건이 갈린다(그 파일 헤더의 ⛔ 참조). 이 화면은 이번 달 전체를 다루는
// 자리라 `campaignIds` 를 주지 않는다(= 전량 표시).
import { ReceiptSuggestionCards } from "./receipt-suggestion-cards";

type BoardRow = TaxInvoiceBoardRow & { checklistItemId: string | null };
type Board = Omit<TaxInvoiceBoard, "rows"> & {
  rows: BoardRow[];
  /** 발행 자동 확정 크론이 이 달 캠페인에 찍은 건. 낡은 응답에는 없을 수 있다. */
  autoConfirmed?: AutoConfirmedEntry[];
};

function formatWon(value: number): string {
  return value.toLocaleString("ko-KR");
}

/**
 * 부가 항목이 이 행 금액에 어떻게 작용했는지 한 줄로 알린다(설계 §9).
 *
 * ## 왜 필요한가
 *
 * 금액만 보면 오너는 「왜 지난달과 다른 숫자인가」를 알 수 없다. 특히 물품대금 행은
 * 관련 부대비용이 있는데도 **일부러 안 더한** 상태라(§9-3), 근거가 안 보이면 오너가
 * 그 차액을 버그로 조사하거나 반대로 손으로 더해 이중 계상하게 된다.
 *
 * ## P8
 *
 * - **범주는 색을 받지 않는다**(§4) — 이건 좋고 나쁨이 없는 사실 설명이라 무채색이다.
 *   심각도 색(`status-urgent-text`)은 바로 위 결번 줄이 이미 쓰고 있어서, 여기에도
 *   색을 얹으면 「진짜 봐야 하는 것」이 묻힌다(§2 무채색은 랭크다).
 * - 데이터 그리드 3단 사다리의 **서브라벨 등급**(`text-[10px]`)이고, 저대비 하한인
 *   `text-slate-500` 을 지킨다(§ 데이터 그리드 텍스트).
 */
function SettlementItemNote({
  effect,
}: {
  /**
   * ⚠️ **낡은 응답에는 이 필드가 없다.** 배포 직후 열려 있던 탭이나 캐시된 응답이
   * 그렇다 — 이 파일에 이미 「낡은 응답(필드 자체가 없음)에도 깨지지 않는다」 테스트가
   * 있는 것이 그 계약이다. 타입이 필수라고 런타임도 필수인 것은 아니므로 optional 로
   * 받고 방어한다(초판은 그러지 않아 보드 전체가 흰 화면이 됐다).
   */
  effect?: TaxInvoiceBoardRow["settlementItemEffect"];
}) {
  if (!effect) return null;

  const appliedCount = effect.applied?.length ?? 0;
  const appliedTotal = (effect.applied ?? []).reduce((sum, item) => sum + item.amount, 0);
  const unappliedCount = effect.unapplied?.count ?? 0;

  if (appliedCount === 0 && unappliedCount === 0) return null;

  return (
    <div className="mt-0.5 text-[10px] text-slate-500">
      {appliedCount > 0 ? (
        <span>
          부가 항목 {appliedCount}건 · {formatWon(appliedTotal)}원 반영
        </span>
      ) : null}
      {unappliedCount > 0 ? (
        // 「반영 안 함」을 반드시 말한다 — 침묵하면 오너가 손으로 더해 이중 계상한다.
        <span>
          매입 부대비용 {unappliedCount}건 · {formatWon(effect.unapplied.total)}원 미반영
          (물품대금 계산서에 합산돼 옴)
        </span>
      ) : null}
    </div>
  );
}

/**
 * 한 캠페인이 두 의무(발행/수취)로 나오므로 무엇으로 묶어야 키가 유일한지가 중요하다.
 * ⚠️ 방향(direction)만으로는 부족하다 — 우리몰은 공급사 쪽·셀러 쪽 의무가 **둘 다**
 * RECEIVE라 `campaignId:RECEIVE`로 같은 섹션 안에서 충돌한다(React가 중복 key 로
 * throw, 리렌더마다 두 행 모두 언마운트/재마운트). 유일성 축은 의무 자체, 즉 상대
 * (counterpart)다 — `TAX_INVOICE_OBLIGATION_TABLE`의 어떤 채널도 같은 캠페인에서
 * 같은 counterpart 를 두 번 내지 않는다.
 */
const rowKey = (row: {
  campaignId: string;
  direction: TaxInvoiceDirection;
  counterpart: TaxInvoiceCounterpart;
}) => `${row.campaignId}:${row.direction}:${row.counterpart}`;

/** 기본 조회 월 = 지난달 — 세무 처리 대상은 신고 시점 기준 "지난달 지급완료분"이다. */
export function previousMonth(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth(); // 0-기반 → 그대로 쓰면 "지난달"의 1-기반 값
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * 스캔 증거 1건을 셀 하나로 그린다. `VERIFIED`만 "확인됨"으로 읽혀야 하므로 그 상태에는
 * 색을 쓰지 않는다(매칭 여부 자체는 심각도 축이 아니다) — 색은 심각도 축인
 * `NEEDS_REVIEW`(urgent)·`unseen`/`partial`(caution)에만 쓴다.
 */
export function EvidenceCell({ evidence }: { evidence: RowEvidence | null }) {
  if (!evidence) return null;
  switch (evidence.kind) {
    case "verified":
      return (
        <div>
          <span className="font-medium text-foreground">확인됨</span>
          {evidence.detail ? (
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              승인번호 {evidence.detail.issueId ?? "-"} · 작성일자 {evidence.detail.writtenDate ?? "-"} ·{" "}
              {evidence.detail.totalAmount != null ? formatWon(evidence.detail.totalAmount) : "-"}
            </div>
          ) : evidence.memberCount > 1 ? (
            <div className="mt-0.5 text-[10px] text-muted-foreground">그룹 {evidence.memberCount}건 전원 확인</div>
          ) : null}
        </div>
      );
    case "partial":
      return (
        <span className="text-status-caution-text">
          일부만 확인 {evidence.verifiedCount}/{evidence.memberCount}건
        </span>
      );
    case "needs_review":
      return (
        <div className="text-status-urgent-text">
          <span className="font-medium">확인 필요</span>
          <ul className="mt-0.5 list-inside list-disc text-[10px]">
            {evidence.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      );
    case "unseen":
      // ⛔ 「미수취」로 단정하지 않는다 — 메일 커버리지가 100% 가 아님이 실측됐다(2026-08-06).
      // 오너가 실물 매입 계산서를 제시한 건에 대해, 그 국세청 메일이 편지함 **15개 폴더 전수**
      // 대조에서 발견되지 않았다(발행처가 이메일을 안 보냈거나 다른 주소로 갔거나 삭제됨).
      // 즉 스캔이 확인할 수 있는 사실은 「메일에 없다」까지이고, 「안 받았다」는 추론이다.
      // 세무 신고 판단에 쓰는 화면에서 그 둘을 같은 말로 쓰면 안 된다.
      return (
        <div className="text-status-caution-text">
          <span>메일 없음</span>
          <div className="mt-0.5 text-[10px] text-muted-foreground">미수취 단정 아님</div>
        </div>
      );
    case "unmatchable":
      // ⛔ 「미수취」라고 쓰지 않는다 — 상대 사업자번호가 없으면 계산서가 와 있어도
      // 영원히 매칭되지 않는다. 오너가 할 일도 다르다(독촉이 아니라 번호 등록).
      return (
        <div className="text-status-caution-text">
          <span>대조 불가</span>
          <div className="mt-0.5 text-[10px] text-muted-foreground">상대 사업자번호 미등록</div>
        </div>
      );
    case "no_data":
      return <span className="text-muted-foreground">스캔 대상 아님</span>;
  }
}

function DirectionBlock({
  title,
  rows,
  headerExtra,
  evidenceByKey,
  groupMembers,
  showSelection = false,
  selectedKeys,
  onToggleRow,
  rejectedCampaignIds,
  onComplete,
  onHometax,
  hometaxSendingKey,
}: {
  title: string;
  rows: BoardRow[];
  /** 제목 옆에 붙는 액션(수취 섹션의 메일함 확인 버튼). */
  headerExtra?: React.ReactNode;
  /**
   * 캠페인 키(`${campaignId}:${slot}`) → 상태 맵. 제공되면 각 행에 「수취 확인」 열을
   * 덧붙인다 — 발행 섹션은 이 엔진의 대상이 아니므로 호출부가 넘기지 않는다.
   */
  evidenceByKey?: Map<string, CampaignKeyStatus> | null;
  /** `groupId` → 이 스캔에 등장한 형제 캠페인 id 집합(board-evidence.ts 「알려진 불일치」
   *  가드가 씀) — 렌더 대상 행 전체에서 한 번만 만들어 재사용한다. */
  groupMembers?: Map<string, Set<string>>;
  /**
   * 체크박스 열 자체를 그릴지 여부. RECEIVE 섹션은 모든 행이 `xlsxEligible: false`라
   * 체크박스가 영원히 비어 있는 열이 된다 — 빈 셀은 "선택 가능한데 아직 안 골랐다"가
   * 아니라 "아직 안 불러왔다"로 오독되기 쉽다(P8 리뷰 지적). ISSUE 섹션만 이 열을
   * 그린다.
   */
  showSelection?: boolean;
  /**
   * 선택 상태(홈택스 XLSX 대상). `showSelection` 이 true 인 섹션만 실제로 쓴다 —
   * 체크박스는 `row.selectable && row.xlsxEligible`인 행에만 렌더한다.
   */
  selectedKeys?: Set<string>;
  onToggleRow?: (key: string) => void;
  /**
   * 방금 400 응답에서 결번이 아니라 "일시적으로 거부"된 캠페인 id 집합. 결번
   * (selectable: false, 데이터 자체가 없음)과 거부(selectable: true, 서버가 방금
   * 반려함)는 다른 사실이라 같은 색으로 뭉개면 안 된다(P8 리뷰 지적) — 결번은
   * 배경 틴트, 거부는 좌측 보더로 구분한다.
   */
  rejectedCampaignIds?: Set<string>;
  onComplete: (row: BoardRow) => void;
  /**
   * 「홈택스 발행」 — 로컬 헬퍼로 이 행 1건을 보내 건별발급 폼을 채운다. XLSX
   * 체크박스와 같은 게이트(`row.selectable && row.xlsxEligible`)를 쓴다 — RECEIVE
   * 행에 이 버튼이 생기면 상대가 이미 발행한 계산서를 우리가 중복 발행하게 되므로,
   * 호출부는 ISSUE 섹션에만 이 prop 을 넘긴다(체크박스의 showSelection 과 동일 규약).
   */
  onHometax?: (row: BoardRow) => void;
  /** 전송 중인 행의 rowKey — 그 행의 버튼만 비활성·라벨 교체한다. */
  hometaxSendingKey?: string | null;
}) {
  if (rows.length === 0) return null;

  // 결번(체크박스 없는) 행을 위로 올린다 — 스크롤 없이도 "이건 아직 못 낸다"가 바로
  // 보여야 한다(ss-ux 검토 지적). 정렬은 표시 순서만 바꾸고 원본 배열은 건드리지 않음.
  const sortedRows = [...rows].sort((a, b) => Number(!a.selectable) - Number(!b.selectable));
  const blockedCount = rows.filter((row) => !row.selectable).length;
  const showEvidence = evidenceByKey != null;

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">
          {title}
          {blockedCount > 0 ? (
            <span className="ml-1.5 text-status-urgent-text">· 결번 {blockedCount}건</span>
          ) : null}
        </h3>
        {headerExtra}
      </div>
      <table className="mt-2 w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border text-left text-[10px] uppercase text-muted-foreground">
            {showSelection ? <th className="w-6 py-1.5" /> : null}
            <th className="py-1.5 pr-2 font-medium">상대</th>
            <th className="py-1.5 pr-2 font-medium">캠페인</th>
            <th className="py-1.5 pr-2 text-right font-medium">공급가액</th>
            <th className="py-1.5 pr-2 text-right font-medium">세액</th>
            {showEvidence ? <th className="py-1.5 pr-2 font-medium">수취 확인</th> : null}
            <th className="w-16 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const key = rowKey(row);
            const blocked = !row.selectable;
            const rejected =
              !blocked && !!rejectedCampaignIds && row.campaignIds.some((id) => rejectedCampaignIds.has(id));
            const evidence = evidenceByKey ? resolveRowEvidence(row, evidenceByKey, groupMembers) : null;
            const rowTint = blocked
              ? "bg-status-urgent/10"
              : rejected
                ? "border-l-2 border-status-urgent"
                : "";
            return (
              <tr key={key} className={`border-b border-border/60 align-top ${rowTint}`}>
                {showSelection ? (
                  <td className="py-2 pr-1">
                    {/* 파일 생성 선택은 xlsxEligible(ISSUE) 행에만 붙는다 — RECEIVE 는 상대가
                        발행하므로 일괄 대상 자체가 아니다. direction 을 다시 비교하지 않고
                        이 필드를 그대로 믿는다(계약이 강제하는 지점). 결번(selectable: false)
                        행도 같은 이유로 체크박스가 없다 — 결번 하나가 섞이면 홈택스가 업로드를
                        통째로 반려한다. */}
                    {row.selectable && row.xlsxEligible ? (
                      <input
                        type="checkbox"
                        // counterpartName 만으로는 유일하지 않다 — 그룹핑은 상대가 아니라
                        // 정산 그룹 단위라, 같은 셀러가 같은 달에 별개 캠페인 두 건을 돌리면
                        // counterpartName 이 같은 체크박스 두 개가 생긴다. campaignLabel 을
                        // 더해 접근성 이름을 유일하게 만든다.
                        aria-label={`${row.counterpartName} · ${row.campaignLabel} 선택`}
                        checked={selectedKeys?.has(key) ?? false}
                        onChange={() => onToggleRow?.(key)}
                      />
                    ) : null}
                  </td>
                ) : null}
                <td className="py-2 pr-2">
                  <span className="text-[13px] font-semibold text-foreground">{row.counterpartName}</span>
                  {blocked && row.blockingReasons.length > 0 ? (
                    <div className="mt-0.5 text-[10px] text-status-urgent-text">
                      결번: {row.blockingReasons.join(", ")}
                    </div>
                  ) : null}
                </td>
                <td className="py-2 pr-2 text-muted-foreground">
                  {row.campaignLabel}
                  <SettlementItemNote effect={row.settlementItemEffect} />
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatWon(row.amount.supplyAmount)}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatWon(row.amount.taxAmount)}</td>
                {showEvidence ? (
                  <td className="py-2 pr-2">
                    <EvidenceCell evidence={evidence} />
                  </td>
                ) : null}
                <td className="py-2 text-right">
                  <div className="flex flex-col items-end gap-1">
                    {/* 홈택스 발행(로컬 헬퍼)은 XLSX 체크박스와 정확히 같은 게이트다 —
                        결번 행은 홈택스가 반려할 데이터라 보내지 않고, RECEIVE 행은
                        onHometax 자체가 안 내려온다(ISSUE 섹션 전용 prop). */}
                    {onHometax && row.selectable && row.xlsxEligible ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={hometaxSendingKey === key}
                        onClick={() => onHometax(row)}
                      >
                        {hometaxSendingKey === key ? "전송 중…" : "홈택스 발행"}
                      </Button>
                    ) : null}
                    {row.checklistItemId ? (
                      <Button size="sm" variant="outline" onClick={() => onComplete(row)}>
                        완료
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/**
 * 「밀린 정리」 구역 — 기본 접힘.
 *
 * ⛔ 이 구역을 없애고 한 목록으로 합치지 말 것: 정산 완료로 표시됐는데 계산서 의무가
 * 남은 건은 지워지지 않는 행이다. 「진행 중」 목록과 섞으면 그 행이 상단에 계속 깔려
 * 오너가 목록 전체를 습관적으로 무시하게 되고, 그때 진짜 진행 건도 함께 묻힌다(설계
 * §2). 접힌 상태에서도 건수·결번 수를 머리글에 적어, 열지 않아도 규모를 알 수 있게
 * 한다.
 *
 * ## P8
 *
 * - `<button>` + `aria-expanded` 조합은 shadcn `Collapsible` 트리거와 같은 접근성
 *   계약이다 — 새 위젯을 들여오지 않고 원시 요소로 같은 계약을 재현한다.
 * - 결번 수는 방향 축이 아니라 심각도 축이라 `DirectionBlock`과 같은 색
 *   (`text-status-urgent-text`)을 그대로 쓴다(§5 토큰은 표면 종속 — 흰 카드이므로
 *   대비가 유효한 조합).
 * - **클릭 어포던스(리뷰 지적, 2026-08-09):** Tailwind v4 preflight 는 버튼 커서를
 *   복구하지 않아 `cursor-pointer` 를 직접 못박지 않으면 화면 폭 전체 막대가 정적
 *   헤더처럼 보인다. `<details>/<summary>` 로 통일하지 않고 `<button>` 을 유지한
 *   이유는 이 구역이 이미 `role="button"` + 명시적 `aria-expanded` 계약(브리프·
 *   테스트가 이 형태를 그대로 검증)이라 시맨틱 전환은 별도 회귀 리스크이기
 *   때문이다 — 형제 위젯 `AutoConfirmedSection`(`<summary>`)과 같은 시각 신호
 *   (`cursor-pointer`·hover·포커스 링)만 값으로 맞춘다.
 */
function BacklogSection({
  count,
  blockedCount,
  children,
}: {
  count: number;
  blockedCount: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <section className="rounded-lg border border-border/70">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <span className="text-sm font-semibold text-foreground">
          밀린 정리 {count}건
          {blockedCount > 0 ? (
            <span className="ml-1.5 text-status-urgent-text">· 결번 {blockedCount}건</span>
          ) : null}
        </span>
        <span className="text-xs text-muted-foreground">{open ? "접기" : "펼치기"}</span>
      </button>
      {open ? <div className="space-y-4 px-3 pb-3">{children}</div> : null}
    </section>
  );
}

/** 확정 시각을 KST 로 읽는다 — 서버 ISO 를 그대로 보여주면 오너가 UTC 를 KST 로 읽는다. */
function formatConfirmedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 「자동 확정됨」 — 크론이 찍어서 **보드 목록에서 사라진** 발행 건.
 *
 * ## 형태는 오너가 골랐다 (2026-08-06, 크론 트랙 세션이 올린 선택지)
 *
 * ①**상단 요약 한 줄 + 펼치면 목록** ← 채택 / ②행을 남기고 배지 ← **기각**(보드 행 수가
 * 늘어 「이번 달 남은 것」의 체감이 달라진다). 그래서 이 컴포넌트는 접힌 상태에서 정확히
 * 한 줄이고, 0건이면 아예 렌더하지 않는다(P2 Decision-Value Priority — 장식적 요약 금지).
 *
 * ## ⛔ 보드 표에 행으로 되살리지 않는다
 *
 * 두 `DirectionBlock` 은 「남은 처리」다 — 행이 있으면 아직 안 한 일이고 「완료」·「홈택스
 * 발행」이 그 전제 위에 붙는다. 되살리면 「홈택스 발행」이 따라붙어 **이미 끊은 계산서를
 * 한 번 더 끊는** 경로가 열린다. 오너의 판단은 "이걸 아직 해야 하나"가 아니라 **"기계가
 * 찍은 것을 내가 봐야 하는가"** 이고, 그 답은 근거가 붙은 사후 고지가 낸다.
 *
 * ## 색 (P8 §4)
 *
 * 「자동 확정」 자체는 심각도가 아니라 **출처**라 무채색 + 중립 태그 캐리어(브랜드 네이비
 * 틴트)를 쓴다 — 정상 동작에 경고색을 칠하면 매달 뜨는 빨강이 되어 습관화로 신호를 잃는다.
 * **예외는 「허용오차 흡수」 하나뿐**이다: 그건 최대 99원을 봐주고 찍었다는 뜻이라 오너가
 * 볼 이유가 실제로 크고, 여기서 뭉개면 #303 이 `AMOUNT_TOLERATED` 로 표면화한 사실을 화면이
 * 다시 지우는 셈이 된다(조용한 완화). 흰 카드 표면이라 `--status-caution-text` 가 맞다(§5).
 */
function AutoConfirmedSection({ entries }: { entries: AutoConfirmedEntry[] }) {
  if (entries.length === 0) return null;

  const toleratedCount = entries.filter((entry) => entry.tolerated).length;

  return (
    <details className="group shrink-0 rounded-lg border border-border px-3 py-2">
      {/* 접힌 상태 = 정확히 한 줄(오너 채택안 ①). 「근거 보기」가 펼침을 예고한다 —
          그게 없으면 한 줄 요약이 막다른 고지로 읽힌다.
          ⚠️ 네이티브 마커(삼각형)는 **남긴다** — `order-dashboard.tsx` 의 강한 패턴은 마커를
          지우고 밑줄로 대체하지만, 그건 목록 안에 묻힌 트리거였다. 이건 탭 최상단이라
          "열렸나 닫혔나"가 한눈에 보여야 하므로 마커(상태) + 밑줄(행동)을 **둘 다** 쓴다.
          문구도 열림 상태에 따라 바뀐다.
          ⚠️ 밑줄은 **행동 조각에만** 건다 — 앞의 두 조각은 사실 요약이라 같은 `·` 로 이으면
          「근거 보기」가 세 번째 통계로 읽힌다(ss-ux 지적). 구분자 없이 공백으로 띄운다. */}
      <summary className="cursor-pointer select-none rounded text-xs text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring focus:outline-none">
        {/* 기간을 문구로 밝힌다 — 라우트가 seed 조회에 기간 컷을 걸고 있으므로(그게 없으면
            이 숫자가 영구 누적이 된다), 창을 말하지 않으면 오너는 이 N 이 무엇의 개수인지
            알 수 없다. 라벨은 컷과 같은 상수에서 나온다(숫자·문구 드리프트 방지). */}
        {AUTO_CONFIRM_SEED_LOOKBACK_LABEL} 자동 확정됨 {entries.length}건
        {toleratedCount > 0 ? (
          <span className="text-status-caution-text"> · 허용오차 흡수 {toleratedCount}건</span>
        ) : null}{" "}
        <span className="text-muted-foreground underline decoration-slate-300 underline-offset-2 hover:text-slate-600 hover:decoration-slate-400">
          <span className="group-open:hidden">근거 보기</span>
          <span className="hidden group-open:inline">접기</span>
        </span>
      </summary>
      {/* 이 두 문장이 이 묶음의 존재 이유다. ①왜 위 목록에 없는지 ②무엇을 할 수 있는지.
          되돌리기 경로는 실물 확인함 — `settlement-section.tsx` 「회계 일정」의 발행 완료
          체크박스가 해제 시 날짜를 null 로 PATCH 한다(그룹이면 그룹 필드에 쓴다). */}
      {/* 데이터 그리드 3단 사다리(13/12/10) — `text-[11px]`은 사다리 밖 이탈값이다(P8). */}
      <p className="mt-1.5 text-xs text-muted-foreground">
        메일 대조로 기계가 발행일을 기록한 건입니다. 「발행」 목록에는 남지 않습니다.
        되돌리려면 캠페인 상세의 「회계 일정」에서 발행 완료 체크를 해제하세요.
      </p>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {entries.map((entry) => (
          <li key={entry.key} className="border-t border-border/60 pt-1.5">
            <div className="flex flex-wrap items-baseline gap-1.5">
              <span className="text-[13px] font-semibold text-foreground">
                {entry.campaignLabels[0] ?? "캠페인 미상"}
                {entry.campaignLabels.length > 1 ? ` 외 ${entry.campaignLabels.length - 1}건` : ""}
              </span>
              <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                자동 확정
              </span>
              {/* 흡수 건만 심각도 축을 탄다 — 판정은 `type` 하나로 이미 끝났고 여기선
                  그 사실을 그대로 표시할 뿐이다(문장 파싱 금지). */}
              {entry.tolerated ? (
                <span className="rounded-md bg-status-caution-bg px-1.5 py-0.5 text-[10px] font-medium text-status-caution-text">
                  허용오차 흡수
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {entry.fieldLabel} {entry.writtenDate ?? "날짜 미기록"}
              </span>
            </div>
            {/* 근거 문장은 크론이 만든 그대로 쓴다 — 승인번호·장수·합계·대조 근거를
                화면에서 다시 조립하면 크론과 갈린다. */}
            {entry.detail ? (
              <p className="mt-0.5 text-[10px] text-muted-foreground">{entry.detail}</p>
            ) : null}
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              확정 시각 {formatConfirmedAt(entry.confirmedAt)}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * 조회 기간 선택지.
 *
 * ⛔ **상한 365 는 서버 클램프다**(`api/settlement/tax-invoice-receipts` 가
 * `Math.min(365, …)`). UI 가 그보다 큰 값을 보내면 **조용히 잘려** 화면은 보내지도 않은
 * 기간을 봤다고 착각한다 — 그래서 선택지를 상한 안에 두고, 최대치임을 라벨로 못박는다.
 * 「그 이전은 이 도구로 확인할 수 없다」는 사실은 아래 커버리지 패널이 말한다.
 */
const RECEIPT_SCAN_MAX_DAYS = 365;
const RECEIPT_SCAN_PERIODS = [
  { days: 90, label: "최근 90일" },
  { days: 180, label: "최근 180일" },
  { days: RECEIPT_SCAN_MAX_DAYS, label: "최근 365일(최대)" },
] as const;
const RECEIPT_SCAN_DEFAULT_DAYS = 90;

/**
 * 스캔이 "전부 봤다"고 오독되면 안 되는 부분을 모아 보여준다 — 본 범위(기간·편지함),
 * 상한에 걸려 못 본 메일, 관문에서 걸러진 메일, 비밀번호를 못 연 메일, 기대 건인데 아직
 * 못 본 것(미수취), 첨부 형식 분포. 이것들이 없으면 오너가 "이번 달 수취는 다 확인했다"고
 * 오판할 수 있다(설계 문서 「범위 밖」·「후속」 절 — 첨부 형식 census 가 특히 이 시점 가장
 * 큰 값어치라고 명시함).
 *
 * ⚠️ **기간·편지함은 응답의 `scan.scan` 값을 쓴다 — 선택 상태를 쓰지 않는다.** 서버가
 * 클램프하고 편지함도 서버가 자동 선택하므로, 화면이 "무엇을 보냈는가"를 말하면
 * "무엇을 실제로 봤는가"와 어긋난다. 선택값과 결과가 다를 때는 아래 `pendingDays`
 * 안내로 **결과가 낡았다는 사실만** 알린다.
 */
function ReceiptScanCoverage({
  scan,
  error,
  pendingDays,
}: {
  scan: ReceiptScanApiResponse | null;
  error: string | null;
  /** 현재 선택된 조회 기간 — 결과의 기간과 다르면 "다시 확인" 안내를 띄운다. */
  pendingDays: number;
}) {
  if (error) {
    return <p className="text-xs text-status-urgent-text">{error}</p>;
  }
  if (!scan) return null;

  const attachmentEntries = Object.entries(scan.summary.attachmentCensus);
  const skipped = scan.scan.skippedByFilter;
  /**
   * 관문이 남긴 것보다 버린 것이 많으면 색을 준다 — 전용 폴더에서 이 값이 크다는 건
   * 관문이 무언가를 계속 놓치고 있다는 신호다(`mail-scan.ts` 의 `skippedByFilter` 주석).
   * 기간을 늘릴수록 이 수치가 커지므로, 묻힌 채로 두면 늘린 기간이 오히려 신뢰를 준다.
   */
  const skipDominates = typeof skipped === "number" && skipped > scan.scan.candidates;

  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2 text-[11px]">
      {/* 「무엇을 봤는가」를 먼저 못박는다 — 그 계정엔 편지함이 여럿이고 스캔은 한 곳만
          연다. 이 문장이 없으면 「메일함을 확인했다」가 「받은 편지함 전부를 봤다」로
          읽힌다(폴더 하나만 보는 것은 오탐·egress 양쪽에서 유리하다는 판단이 서 있고,
          다른 폴더로 들어온다면 처방은 메일 규칙 수정이다 — 전체 스캔 옵션이 아니다). */}
      <p className="text-foreground">
        최근 {scan.scan.sinceDays}일 · 「{scan.scan.box}」 편지함 <span className="font-semibold">한 곳만</span>{" "}
        확인했습니다. 다른 편지함은 보지 않습니다.
      </p>
      <p className="text-muted-foreground">
        확인됨 {scan.summary.verified}건 · 확인 필요 {scan.summary.needsReview}건 · 캠페인 무관{" "}
        {scan.summary.notOurs}건
      </p>

      {/* 걸러진 통수는 따로 세운다 — 이 수치가 없어서 「필터가 먼저 버렸다」와 「폴더에
          없다」를 구분할 수 없었다(2026-08-05 실사고). 요약 문장 끝에 붙여 두면 기간을
          늘려 수치가 커져도 눈에 띄지 않는다. */}
      {typeof skipped === "number" ? (
        <p className={skipDominates ? "text-status-caution-text" : "text-muted-foreground"}>
          관문에서 걸러 본문을 열지도 않은 메일 {skipped}건 · 후보 {scan.scan.candidates}건
          {skipDominates ? ": 걸러낸 쪽이 더 많습니다. 이 폴더의 메일이 관문에 안 걸리는지 확인이 필요합니다." : ""}
        </p>
      ) : null}

      {scan.scan.truncated > 0 ? (
        <p className="text-status-caution-text">
          메일 {scan.scan.truncated}건은 본문 조회 상한에 걸려 이번 스캔에서 못 봤습니다. 전체를 다 본
          것이 아닙니다. 기간을 줄여 나눠 확인하세요.
        </p>
      ) : null}

      {scan.scan.sinceDays >= RECEIPT_SCAN_MAX_DAYS ? (
        <p className="text-muted-foreground">
          {RECEIPT_SCAN_MAX_DAYS}일이 이 도구의 상한입니다. 그보다 과거에 받은 계산서는 여기서 확인할 수
          없습니다(메일함에서 직접 확인해야 합니다).
        </p>
      ) : null}

      {pendingDays !== scan.scan.sinceDays ? (
        <p className="text-status-caution-text">
          이 결과는 {scan.scan.sinceDays}일 조회분입니다. 선택한 {pendingDays}일로 보려면 「다시 확인」을
          누르세요.
        </p>
      ) : null}

      {scan.summary.passwordProtected > 0 ? (
        <p className="text-status-caution-text">
          비밀번호로 열지 못한 메일 {scan.summary.passwordProtected}건: 이 건들은 확인되지 않았습니다.
        </p>
      ) : null}

      {scan.unseenExpected.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-foreground">
            미수취 목록 · 아직 계산서를 못 본 기대 건 {scan.unseenExpected.length}건
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 pl-3 text-muted-foreground">
            {scan.unseenExpected.map((item) => (
              <li key={item.key}>
                {item.counterpartLabel} · {item.campaignLabel}
                {item.expectedTotalAmount != null ? ` · ${formatWon(item.expectedTotalAmount)}` : " · 금액 모름"}
                {item.trackingField === null ? " · 추적 슬롯 없음(체크리스트에 항목 자체가 없음)" : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {attachmentEntries.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-foreground">첨부 형식 분포(형식 미확인 대비 관측치)</summary>
          <ul className="mt-1 flex flex-col gap-0.5 pl-3 text-muted-foreground">
            {attachmentEntries.map(([kind, count]) => (
              <li key={kind}>
                {kind}: {count}건
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export function TaxFilingDialog({
  open,
  onOpenChange,
  month,
  onMonthChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  month: string;
  onMonthChange: (month: string) => void;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [invoiceErrors, setInvoiceErrors] = useState<TaxInvoiceValidationDetail[] | null>(null);
  /**
   * 세금계산서 탭은 이제 캠페인 상태 축(월 무관)이고, 원천징수만 지급월 축이라
   * (route.ts 헤더 주석) 대상월 선택기를 두 탭이 공유하면 안 된다 — 세금계산서
   * 탭에서 월을 바꿔도 목록이 그대로라 "안 바뀐다"는 버그 신고로 이어진다. 탭을
   * 제어 컴포넌트로 바꿔 이 값으로 선택기 노출을 가른다(아래 렌더 트리 참조).
   */
  const [activeTab, setActiveTab] = useState<"invoice" | "withholding">("invoice");

  // 수취 메일함 확인 — IMAP 조회라 오너가 버튼을 눌러야만 돈다(다이얼로그 open 트리거에
  // 절대 묶지 않는다). 결과는 증거로만 쓴다 — 「완료」는 여전히 오너가 직접 누른다.
  const [receiptScan, setReceiptScan] = useState<ReceiptScanApiResponse | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const handleMoveMonth = useCallback(
    (diff: number) => {
      if (!month || month.length !== 7) return;
      const [yearStr, monthStr] = month.split("-");
      let y = parseInt(yearStr, 10);
      let m = parseInt(monthStr, 10);

      m += diff;
      while (m < 1) {
        m += 12;
        y -= 1;
      }
      while (m > 12) {
        m -= 12;
        y += 1;
      }
      onMonthChange(`${y}-${String(m).padStart(2, "0")}`);
    },
    [month, onMonthChange]
  );
  /**
   * 조회 기간. 지급일이 비어 어느 달에도 안 잡히는 과거 건은 기본 90일 창 밖이라
   * 화면에서 확인할 방법이 없었다 — 오너가 창을 넓힐 수 있어야 한다.
   * 다이얼로그를 닫아도 유지한다(결과와 달리 이건 데이터가 아니라 조회 의도다).
   */
  const [scanSinceDays, setScanSinceDays] = useState<number>(RECEIPT_SCAN_DEFAULT_DAYS);

  const fetchBoard = useCallback(async (targetMonth: string) => {
    setLoading(true);
    setError(null);
    // 이전 조회(다른 월 또는 이전 시도)의 400 상세를 들고 있지 않는다 — 대상월
    // Input 은 다이얼로그를 닫지 않고도 바꿀 수 있어서, 지우지 않으면 방금 새로
    // 불러온 월의 보드 위에 이전 월의 결번 상세가 남아 오독을 일으킨다.
    setInvoiceErrors(null);
    try {
      const res = await fetch(`/api/settlement/tax-filing-board?month=${targetMonth}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `조회 실패 (HTTP ${res.status})`);
      }
      const data = (await res.json()) as Board;
      setBoard(data);
      // 보드 조회가 성공할 때마다 선택 가능한 행 전체로 초기화한다 — 마감 동선상
      // 대부분 전량 처리하며, 결번 행의 키는 절대 넣지 않는다. xlsxEligible 이 아닌
      // (RECEIVE) 행도 넣지 않는다 — 이 선택 집합은 오직 홈택스 XLSX 생성 대상이다.
      setSelectedKeys(
        new Set(data.rows.filter((row) => row.selectable && row.xlsxEligible).map(rowKey)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회 실패");
      setBoard(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void fetchBoard(month);
  }, [open, month, fetchBoard]);

  // 다이얼로그를 닫으면 스캔 결과를 비운다 — 다음에 열었을 때 오래된 스캔이 최신인
  // 것처럼 남아 있으면 오너가 그새 도착한 계산서를 놓친다.
  useEffect(() => {
    if (!open) {
      setReceiptScan(null);
      setScanError(null);
    }
  }, [open]);

  const runReceiptScan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      const res = await fetch(`/api/settlement/tax-invoice-receipts?sinceDays=${scanSinceDays}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `메일함 확인 실패 (HTTP ${res.status})`);
      }
      const data = (await res.json()) as ReceiptScanApiResponse;
      setReceiptScan(data);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "메일함 확인에 실패했습니다.");
      setReceiptScan(null);
    } finally {
      setScanning(false);
    }
  }, [scanSinceDays]);

  const toggleRow = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 전체 선택/해제도 xlsxEligible 행에만 적용된다 — RECEIVE 행은 체크박스 자체가 없다.
  const selectableRows = board?.rows.filter((row) => row.selectable && row.xlsxEligible) ?? [];
  const allSelected = selectableRows.length > 0 && selectedKeys.size === selectableRows.length;
  /**
   * 「전체 선택」 분모에 섞여 있는 밀린 건 수.
   *
   * ⛔ 이 값은 **표시 전용**이다 — 선택 동작·XLSX 본문은 여전히 `board.rows` 전체를 본다
   * (「구역은 표시 축이지 기능 축이 아니다」, 설계 하드 제약). 여기서 고치는 것은 행위가
   * 아니라 **화면의 정직성**이다: 같은 푸터 바에 나란히 서는 두 숫자가 서로 다른 모집단을
   * 세기 때문이다. 「전체 선택」은 진행 중 + 밀린 정리를 함께 세고, 바로 아래 「발행·수취
   * 합계」는 진행 중 전용이다(`totalsByDirection`, tax-filing-board.ts). 병기가 없으면
   * 오너는 두 줄을 같은 모집단으로 읽고 "선택은 3건인데 합계가 2건어치"라는 차이를 오류로
   * 신고하거나, 더 나쁘게는 합계를 그대로 홈택스 대사에 쓴다.
   */
  const backlogSelectableCount = selectableRows.filter((row) => row.section === "BACKLOG").length;

  const toggleAll = () => {
    if (allSelected) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(selectableRows.map(rowKey)));
    }
  };

  const downloadXlsx = async () => {
    const rows = board?.rows ?? [];
    // selectedKeys 는 이미 xlsxEligible 행으로만 채워지지만(체크박스가 그 외 행에는
    // 없다), 방어적으로 여기서도 다시 걸러 RECEIVE 행이 절대 요청 본문에 들어가지
    // 않게 한다 — 이 필터가 깨지면 상대가 이미 발행한 계산서를 우리가 중복 발행하게
    // 된다.
    //
    // ⚠️ row.campaignId(단수)가 아니라 row.campaignIds(복수) 를 편다 — 정산 그룹
    // 행의 campaignId 는 체크리스트 PATCH 앵커(대표 멤버 1명)일 뿐이고, 이 행이
    // 실제로 뜻하는 캠페인 전체는 campaignIds 다. 단수를 보내면 route 가 재조회로
    // 그룹을 다시 채워 금액은 결국 맞게 나오지만(방어선), 그 방어선에 기대지 않고
    // 행이 뜻하는 전체 집합을 그대로 보낸다.
    const campaignIds = [
      ...new Set(
        rows
          .filter((row) => row.selectable && row.xlsxEligible && selectedKeys.has(rowKey(row)))
          .flatMap((row) => row.campaignIds),
      ),
    ];
    if (campaignIds.length === 0) {
      toast.error("선택된 건이 없습니다.");
      return;
    }
    setInvoiceErrors(null);
    try {
      const res = await fetch("/api/settlement/tax-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignIds }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (Array.isArray(body?.details) && body.details.length > 0) {
          // 캠페인 단위 검증은 통과했지만(모든 행이 선택 가능으로 표시됨) 서버가
          // 요청 시점에 재확인한 결번(예: 그룹 재조회로 새로 드러난 멤버 결번)처럼
          // "선택 조합" 수준에서만 걸리는 사유가 있다 — 토스트 한 줄로는 오너가 뭘
          // 빼야 할지 알 수 없으므로 상세를 화면에 남긴다.
          setInvoiceErrors(body.details as TaxInvoiceValidationDetail[]);
          toast.error("파일 생성에 실패했습니다. 아래 상세를 확인하세요.");
        } else {
          toast.error(body?.error ?? "파일 생성에 실패했습니다.");
        }
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `hometax-tax-invoice-${month}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success(`${campaignIds.length}건을 내려받았습니다.`);
    } catch {
      toast.error("파일 생성에 실패했습니다.");
    }
  };

  const { sendingKey: hometaxSendingKey, sendToHometax } = useHometaxIssue({
    onValidationDetails: setInvoiceErrors,
  });

  const handleSendToHometax = (row: BoardRow) =>
    void sendToHometax({
      key: rowKey(row),
      campaignIds: row.campaignIds,
      counterpartName: row.counterpartName,
    });

  // 400 상세에 이름이 오른 캠페인 id 집합 — 결번(selectable: false)과는 다른 사실
  // (서버가 방금 반려한 것뿐, 데이터 자체가 없는 게 아니다)이라 DirectionBlock 이
  // 별도 시각 신호로 구분한다.
  const rejectedCampaignIds = invoiceErrors
    ? new Set(invoiceErrors.map((detail) => detail.campaignId))
    : undefined;

  // 400 상세의 「선택 해제」 — 에러가 가리키는 campaignId 를 담은 행을 찾아 그 행의
  // 선택만 해제한다. campaignId(단수, 체크리스트 앵커)가 아니라 campaignIds(복수)에
  // 포함되는지로 찾는다 — 그룹 행이면 route 가 반환하는 id 가 앵커일 수도, 멤버일
  // 수도 있어 campaignIds 전체를 뒤져야 정확히 찾는다.
  const deselectByCampaignId = (campaignId: string) => {
    const row = board?.rows.find((r) => r.campaignIds.includes(campaignId));
    if (!row) return;
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      next.delete(rowKey(row));
      return next;
    });
  };

  const evidenceByKey = receiptScan ? indexReceiptScan(receiptScan) : null;
  // 보드 행 전체(발행 포함)에서 groupId 별 형제 캠페인 id 를 재구성한다 — 공급사
  // 불일치로 캠페인별로 쪼개진 셀러 의무 행과, 채널 불일치로 쪼개진 행을 구분하는 데
  // 쓴다(board-evidence.ts 「알려진 불일치」 가드). 스캔이 없으면(evidenceByKey null)
  // 어차피 안 쓰이지만, board 가 바뀔 때만 다시 만들면 되므로 렌더마다 새로 만들어도
  // 비용이 작다(행 수가 월 단위 처리 건수라 수십 건 규모).
  const groupMembers = board ? reconstructGroupMembers(board.rows) : undefined;

  const handleComplete = async (row: BoardRow) => {
    if (!row.checklistItemId) return;
    try {
      const res = await fetch(`/api/campaign-checklist/items/${row.checklistItemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isChecked: true }),
      });
      if (!res.ok) throw new Error("처리 실패");
      toast.success(`${row.counterpartName} 처리를 완료했습니다.`);
      await fetchBoard(month);
    } catch {
      toast.error("처리에 실패했습니다.");
    }
  };

  // 표시 축은 캠페인 상태에서 파생된 section(진행 중/밀린 정리)이다 — selectableRows·
  // downloadXlsx 는 아래에서 board.rows 전체를 그대로 보므로 이 구분에 영향받지 않는다
  // (구역은 표시 축이지 기능 축이 아니다, 위 selectableRows 주석 참조).
  const inProgressRows = board?.rows.filter((row) => row.section === "IN_PROGRESS") ?? [];
  const backlogRows = board?.rows.filter((row) => row.section === "BACKLOG") ?? [];
  const issueRows = inProgressRows.filter((row) => row.direction === "ISSUE");
  const receiveRows = inProgressRows.filter((row) => row.direction === "RECEIVE");
  const backlogIssueRows = backlogRows.filter((row) => row.direction === "ISSUE");
  const backlogReceiveRows = backlogRows.filter((row) => row.direction === "RECEIVE");

  // 합계는 선택 가능한 행 기준(체크 여부와 무관) — API 가 이미 그렇게 집계해 내려준다.
  // 발행·수취는 반대 현금흐름이라 하나로 합치면 이중 계상이 된다(tax-filing-board.ts
  // 헤더 주석 참조) — 반드시 방향별로 따로 보여준다. 공급가액과 세액도 홈택스에 각각
  // 별도로 입력하는 법정 별개 항목이라(세금계산서 필수 기재 사항), 하나로 합쳐 보이면
  // 오너가 검산할 값 자체가 사라진다 — 둘도 반드시 따로 보여준다.
  const totalsByDirection =
    board?.totalsByDirection ?? {
      ISSUE: { supplyAmount: 0, taxAmount: 0 },
      RECEIVE: { supplyAmount: 0, taxAmount: 0 },
    };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] flex-col sm:max-w-3xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>세무 처리</DialogTitle>
            {/* 축 표현은 탭마다 다르다 — 세금계산서 탭은 캠페인 상태 축(월 무관)으로
                옮겨졌고 원천징수 탭만 지급월 축을 유지한다(route.ts 헤더 주석). 기본
                탭이 세금계산서인데 여기서 「지급완료일 기준」이라고 말하면, 오너가 창을
                열고 가장 먼저 읽는 문장이 바로 아래 「월 무관 · 미처리 전체」와 정면으로
                어긋난다. ⚠️ 금액 계산 근거(셀러 정산 명세서와 동일)는 축과 무관하게 두
                탭 모두에 유효하므로 그대로 둔다 — 축 표현만 가른다. */}
            <DialogDescription>
              {activeTab === "withholding"
                ? "지급완료일 기준: 금액은 셀러 정산 명세서와 동일한 계산입니다"
                : "금액은 셀러 정산 명세서와 동일한 계산입니다"}
            </DialogDescription>
          </DialogHeader>

          {/* 세금계산서는 캠페인 상태 축(월 무관)이고 원천징수만 지급월 축이라(route.ts
              헤더 주석), 이 선택기는 원천징수 탭에서만 의미가 있다. 세금계산서 탭에서
              그대로 뒀다면 오너가 월을 바꿔도 목록이 안 바뀌는 것을 "안 바뀐다"는
              버그로 신고했을 것이다. ⚠️ 선택된 월 상태(`month` prop) 자체는 탭 전환과
              무관하게 유지한다 — 원천징수 탭으로 돌아왔을 때 다시 고르게 하지 않는다. */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {activeTab === "withholding" ? (
              <>
                <label htmlFor="tax-filing-month" className="text-xs font-medium text-foreground">
                  대상월
                </label>
                <div className="flex items-center">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 rounded-r-none border-r-0 text-muted-foreground"
                    onClick={() => handleMoveMonth(-1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span className="sr-only">이전 달</span>
                  </Button>
                  <Input
                    id="tax-filing-month"
                    type="month"
                    value={month}
                    onChange={(e) => e.target.value && onMonthChange(e.target.value)}
                    className="h-8 w-32 rounded-none focus:z-10"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 rounded-l-none border-l-0 text-muted-foreground"
                    onClick={() => handleMoveMonth(1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                    <span className="sr-only">다음 달</span>
                  </Button>
                </div>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">월 무관 · 미처리 전체</span>
            )}
          </div>

          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as "invoice" | "withholding")}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsList className="shrink-0">
              <TabsTrigger value="invoice">세금계산서</TabsTrigger>
              <TabsTrigger value="withholding">원천징수</TabsTrigger>
            </TabsList>

            <TabsContent value="invoice" className="flex min-h-0 flex-1 flex-col gap-3">
              {board && board.warnings.length > 0 ? (
                <ul className="flex shrink-0 flex-col gap-1 rounded-lg bg-status-caution-bg px-3 py-2">
                  {board.warnings.map((warning) => (
                    <li key={warning} className="text-xs text-status-caution-text">
                      {warning}
                    </li>
                  ))}
                </ul>
              ) : null}

              {invoiceErrors && invoiceErrors.length > 0 ? (
                <ul
                  data-testid="tax-invoice-errors"
                  className="flex shrink-0 flex-col gap-1 rounded-lg bg-status-urgent-bg px-3 py-2"
                >
                  {invoiceErrors.map((detail, index) => (
                    <li
                      key={`${detail.campaignId || detail.campaignName}-${index}`}
                      className="flex items-center justify-between gap-2 text-xs text-status-urgent-text"
                    >
                      <span>
                        <span className="font-semibold">{detail.campaignName || "알 수 없는 캠페인"}</span>
                        {": "}
                        {detail.missingFields.join(" / ")}
                      </span>
                      {/* 상세를 읽고 나서 다시 표를 훑어 같은 행을 찾아 체크를 풀어야 하면
                          이 목록의 존재 의미가 사라진다(P8 리뷰 지적) — 행을 여기서 바로
                          찾아 선택만 해제한다. */}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => deselectByCampaignId(detail.campaignId)}
                      >
                        선택 해제
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="min-h-[320px] grow overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                {error ? (
                  <p className="flex h-full min-h-[280px] items-center justify-center text-xs text-status-urgent-text">
                    {error}
                  </p>
                ) : !board ? (
                  <p className="flex h-full min-h-[280px] items-center justify-center text-xs text-muted-foreground">
                    {loading ? "불러오는 중…" : "표시할 항목이 없습니다."}
                  </p>
                ) : (
                  <div className="flex flex-col gap-4">
                    {/* 상대는 채널마다 다르다(공급사·셀러·셀러몰) — "우리가 셀러에게"처럼
                        상대를 못박지 않고, 오너에게 의미 있는 축인 "우리가 낼 것 / 우리가
                        받을 것"으로만 구분한다. 실제 상대는 각 행의 counterpartName 이
                        보여준다. */}
                    {/* 오너 채택안 ① — 목록보다 **위**의 요약 한 줄이다. 두 표 사이에
                        두면 「발행」과 「수취」 사이에 세 번째 목록이 낀 것으로 읽힌다. */}
                    <AutoConfirmedSection entries={board.autoConfirmed ?? []} />
                    <DirectionBlock
                      title="진행 중 · 발행: 우리가 낼 세금계산서"
                      rows={issueRows}
                      showSelection
                      selectedKeys={selectedKeys}
                      onToggleRow={toggleRow}
                      rejectedCampaignIds={rejectedCampaignIds}
                      onComplete={handleComplete}
                      onHometax={handleSendToHometax}
                      hometaxSendingKey={hometaxSendingKey}
                    />
                    <DirectionBlock
                      title="진행 중 · 수취: 우리가 받을 세금계산서"
                      rows={receiveRows}
                      evidenceByKey={evidenceByKey}
                      groupMembers={groupMembers}
                      headerExtra={
                        <div className="flex items-center gap-1.5">
                          {/* 기간은 버튼 왼쪽에 둔다 — 「무엇을」 고르고 「확인」을 누르는
                              읽기 순서. 선택만으로는 스캔이 돌지 않는다(IMAP 조회라 오너가
                              버튼을 눌러야만 나간다는 이 화면의 계약을 유지한다). */}
                          <Select
                            value={String(scanSinceDays)}
                            onValueChange={(value) => setScanSinceDays(Number(value))}
                            disabled={scanning}
                          >
                            {/* 「(최대)」까지 잘리지 않는 폭 — 상한을 알리는 라벨이 말줄임되면
                                선택지가 상한 안이라는 사실 자체가 화면에서 사라진다. */}
                            <SelectTrigger className="w-[148px]" aria-label="메일함 조회 기간">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {RECEIPT_SCAN_PERIODS.map((period) => (
                                <SelectItem key={period.days} value={String(period.days)}>
                                  {period.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button size="sm" variant="outline" onClick={runReceiptScan} disabled={scanning}>
                            {scanning ? "확인 중…" : receiptScan ? "다시 확인" : "메일함에서 확인"}
                          </Button>
                        </div>
                      }
                      onComplete={handleComplete}
                    />
                    <ReceiptScanCoverage
                      scan={receiptScan}
                      error={scanError}
                      pendingDays={scanSinceDays}
                    />
                    {/* 승인 카드는 커버리지 요약 **바로 아래** 둔다 — 「무엇을 봤는가」를
                        읽은 직후가 「그래서 무엇을 누를 것인가」의 자리다. */}
                    <ReceiptSuggestionCards scan={receiptScan} onDecided={runReceiptScan} />
                    {/* 밀린 정리는 「진행 중」 아래에 접힌 채로 둔다 — 두 표 사이에 끼면
                        발행·수취 사이에 세 번째 목록이 낀 것으로 읽힌다(위 자동 확정
                        묶음과 같은 배치 원칙). */}
                    <BacklogSection
                      count={backlogRows.length}
                      blockedCount={backlogRows.filter((r) => !r.selectable).length}
                    >
                      {/* 「밀린 정리」는 바깥 버튼 머리글이 이미 말하므로 안쪽 제목에
                          다시 붙이지 않는다(중복 라벨 방지) — 「진행 중 ·」 접두는
                          바깥에 그런 표식이 없는 두 표에서만 필요했다. */}
                      <DirectionBlock
                        title="발행: 우리가 낼 세금계산서"
                        rows={backlogIssueRows}
                        showSelection
                        selectedKeys={selectedKeys}
                        onToggleRow={toggleRow}
                        rejectedCampaignIds={rejectedCampaignIds}
                        onComplete={handleComplete}
                        onHometax={handleSendToHometax}
                        hometaxSendingKey={hometaxSendingKey}
                      />
                      {/* evidenceByKey·groupMembers 는 board.rows 전체(스캔 결과·그룹
                          재구성 둘 다)에서 이미 파생돼 있다 — 밀린 건도 스캔 대상에
                          들어 있었으므로 여기서 흘려보내지 않으면 "이미 확인된 계산서"를
                          화면이 숨기는 셈이 된다(리뷰 지적, 2026-08-09). 스캔 트리거
                          버튼(headerExtra)은 하나만 있어야 하므로 복제하지 않는다 —
                          「진행 중 · 수취」 블록에서 이미 누른 스캔 결과를 그대로
                          재사용한다. */}
                      <DirectionBlock
                        title="수취: 우리가 받을 세금계산서"
                        rows={backlogReceiveRows}
                        evidenceByKey={evidenceByKey}
                        groupMembers={groupMembers}
                        onComplete={handleComplete}
                      />
                    </BacklogSection>
                    {/* board.rows 전체(진행 중 + 밀린 정리) 기준 — 진행 중만 비어 있고
                        밀린 정리에 건이 남아 있다면 "처리할 항목이 없다"는 문구는
                        거짓이다(위 BacklogSection이 그 항목을 이미 보여주고 있다). */}
                    {board.rows.length === 0 ? (
                      <p className="text-xs text-muted-foreground">처리할 항목이 없습니다.</p>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="flex shrink-0 flex-col gap-1.5 border-t border-border pt-2 text-xs">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      aria-label="전체 선택"
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={selectableRows.length === 0}
                    />
                    {/* 밀린 건이 분모에 섞여 있을 때만 내역을 병기한다 — 0건일 때도
                        괄호를 늘리면 상시 노이즈가 되고, 정작 다를 때의 신호가 죽는다. */}
                    전체 선택(발행 · {selectableRows.length}건
                    {backlogSelectableCount > 0 ? `, 밀린 정리 ${backlogSelectableCount}건 포함` : ""})
                  </label>
                  <span className="text-muted-foreground">선택 {selectedKeys.size}건</span>
                  <div className="grow" />
                  <Button size="sm" variant="outline" disabled={selectedKeys.size === 0} onClick={downloadXlsx}>
                    홈택스 XLSX
                  </Button>
                </div>
                {/* 방향별로 분리해서 보여준다 — 합치면 이중 계상으로 보인다(위 주석).
                    ⚠️ 「진행 중」을 라벨에 박는다 — 이 합계는 IN_PROGRESS 전용이고(설계가
                    못박은 것: 오너가 이 숫자로 홈택스를 대사한다) 바로 위 「전체 선택」은
                    밀린 건까지 센다. 스코프를 안 적으면 같은 바에 선 두 숫자가 같은
                    모집단으로 읽힌다. */}
                <div className="flex flex-wrap gap-4 text-muted-foreground">
                  <span data-testid="tax-filing-totals-issue">
                    발행 합계(진행 중) · 공급가액{" "}
                    <span data-testid="tax-filing-total-issue-supply">
                      {formatWon(totalsByDirection.ISSUE.supplyAmount)}
                    </span>{" "}
                    · 세액{" "}
                    <span data-testid="tax-filing-total-issue-tax">
                      {formatWon(totalsByDirection.ISSUE.taxAmount)}
                    </span>
                  </span>
                  <span data-testid="tax-filing-totals-receive">
                    수취 합계(진행 중) · 공급가액{" "}
                    <span data-testid="tax-filing-total-receive-supply">
                      {formatWon(totalsByDirection.RECEIVE.supplyAmount)}
                    </span>{" "}
                    · 세액{" "}
                    <span data-testid="tax-filing-total-receive-tax">
                      {formatWon(totalsByDirection.RECEIVE.taxAmount)}
                    </span>
                  </span>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="withholding" className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
              <WithholdingFilingCards month={month} />
            </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
