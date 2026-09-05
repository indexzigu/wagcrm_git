"use client";

import { useCallback, useState, useMemo, useEffect, useRef } from "react";
import { CalendarDays, X, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { patchCampaign } from "@/lib/campaign-patch";
import { InlineDateField } from "./inline-date-field";
import type { CampaignRow } from "@/lib/crm-types";
import { refreshCampaignRows } from "@/lib/campaign-row-refresh";
import {
  resolveCampaignInvoiceSlots,
  resolveCampaignMoneySlots,
  type CampaignInvoiceSlotView,
} from "@/lib/tax-filing-board";
import { useHometaxIssue } from "./use-hometax-issue";
import { fetchGroupDetail } from "@/lib/campaign-group-client";
import {
  indexReceiptScan,
  receivableSlotForField,
  resolveRowEvidence,
  type ReceiptScanApiResponse,
  type RowEvidence,
} from "@/lib/tax-invoice-mail/board-evidence";
import { resolveCampaignWithholdingStatus } from "@/lib/tax-filing-log";
// 승인 카드는 세무 처리 다이얼로그와 **같은 컴포넌트**를 쓴다(그 파일 헤더의 ⛔).
import { ReceiptDecisionDialog, ReceiptSuggestionCards, resolveDecisionScopeKeys } from "./receipt-suggestion-cards";

/**
 * 수취 판정 문구 — 엔진의 어휘를 그대로 옮긴다. 새 어휘를 만들지 않는다.
 * ⛔ `unseen` 을 「미수취」로 쓰지 말 것 — 메일 커버리지가 100% 가 아님이 실측됐다
 *    (발행처가 메일을 안 보냈거나 다른 주소로 갔을 수 있다). 「메일 미발견」이 사실이다.
 * ⛔ `unmatchable` 은 「안 왔다」가 아니라 「확인할 수단이 없다」다 — 처방이 다르다
 *    (독촉이 아니라 상대 사업자번호 등록).
 */
const RECEIPT_EVIDENCE_LABEL: Record<RowEvidence["kind"], string> = {
  // ⚠️ `verified` 는 이 화면에서 **그리지 않는다**(`shouldShowEvidenceBadge`). 어휘는 엔진과
  //    세무 처리 보드가 공유하므로 지우지 않고 남긴다 — 표시 여부는 표면이 정한다.
  verified: "확인됨",
  partial: "일부만 확인됨",
  needs_review: "확인 필요",
  unseen: "메일 미발견",
  unmatchable: "대조 불가(상대 사업자번호 미등록)",
  no_data: "조회 범위 밖",
};

/**
 * 판정을 **도트 + 라벨**로 읽힌다(P8 §3 「색은 캐리어에 탄다」 — 텍스트 색 하나로는 안
 * 보인다). 선례는 모바일 리스크 카드의 심각도 도트(`INTEGRITY_META.dot`, 오너가 칭찬한
 * 용법)라 새 표현을 발명하지 않는다.
 *
 * ⛔ **다 칠하지 않는다(P8 §2).** 색을 받는 것은 **오너가 지금 손댈 수 있는 상태**뿐이다 —
 * 「확인됨」과 「조회 범위 밖」은 볼 것이 없다는 등급이라 무채색이다. 전부 색을 주면 매번
 * 뜨는 경고가 되어 습관화로 신호를 잃는다. 축은 **심각도** 하나이고 2단이다(범주 아님).
 */
const RECEIPT_EVIDENCE_TONE: Record<RowEvidence["kind"], { dot: string; text: string }> = {
  verified: { dot: "bg-slate-400", text: "text-slate-500" },
  no_data: { dot: "bg-slate-300", text: "text-slate-500" },
  partial: { dot: "bg-status-caution", text: "text-status-caution-text" },
  needs_review: { dot: "bg-status-caution", text: "text-status-caution-text" },
  unseen: { dot: "bg-status-caution", text: "text-status-caution-text" },
  unmatchable: { dot: "bg-status-caution", text: "text-status-caution-text" },
};

/**
 * 이 판정을 칸에 **배지로 남길 것인가.**
 *
 * ⛔ 「확인됨」은 그리지 않는다(오너 지시 2026-08-15). 그 칸은 체크박스와 수취일이 이미
 * 「받았다」를 말하고, 그 근거(발행자·사업자번호·기대/수취 금액·작성일자·판정 근거)는
 * 「조회」가 여는 모달이 통째로 보여준다 — 배지는 같은 사실의 **세 번째 사본**이라
 * 읽을 것이 없는 자리를 차지한다.
 *
 * ⛔ 「배지가 없다 = 판정이 없다」로 되돌리지 말 것. 남기는 것은 **오너가 아직 할 일이
 * 있는 판정**(확인 필요·일부만 확인됨·메일 미발견·대조 불가)과 「조회 범위 밖」이다 —
 * 뒤쪽은 "괜찮다"가 아니라 **무엇을 못 봤는지**를 말하므로 침묵시키면 안 된다.
 */
function shouldShowEvidenceBadge(evidence: RowEvidence | null | undefined): evidence is RowEvidence {
  return evidence != null && evidence.kind !== "verified";
}

/**
 * `/api/settlement/tax-invoice-receipts` 응답 경계 가드.
 *
 * `indexReceiptScan`은 `useMemo` 안에서 돈다 — try/catch 밖이다. `res.ok`가
 * `true`인데도 몸통이 계약과 다르면(낡은 배포·프록시가 끼운 HTML 등)
 * `scan.unseenExpected`를 순회하다 렌더 중 `TypeError`가 터져 카드 전체가
 * 죽는다. 여기서 한 번 걸러 `setReceiptScan`을 아예 안 부르는 것이 유일한
 * 방어선이다 — 사용처마다 `?? []`를 흩뿌리면 이 함수가 왜 있는지가 사라진다.
 * `indexReceiptScan`이 실제로 읽는 두 컨테이너(배열)만 확인한다 — 항목 내부
 * 필드까지 깊이 검증하지 않는다(그건 이 가드의 책임이 아니다).
 */
function isReceiptScanShape(value: unknown): value is ReceiptScanApiResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.unseenExpected) && Array.isArray(record.results);
}

/**
 * 승인 카드를 붙일 수 있는 칸인가. **한 곳에서만 판정한다** — 렌더 조건과 「잔여 건」
 * 계산이 이 술어를 각자 쓰면, 한쪽만 손대는 순간 그 칸의 승인 경로가 화면에서 사라지거나
 * 잔여 그물에 조용히 흘러든다(이 레포가 반복해 겪은 「호출부가 판정을 다시 만든다」 부류).
 */
function isApprovableReceiveSlot(slot: CampaignInvoiceSlotView): boolean {
  return slot.applicable && slot.direction === "RECEIVE";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SettlementSectionProps = {
  campaign: CampaignRow;
  onCampaignUpdated: (campaign: CampaignRow) => void;
  title?: string;
};

interface InvoiceInfo {
  approvalNumber?: string;
  documentLink?: string;
  supplierInvoiceLink?: string;
  sellerInvoiceLink?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDateString(value: string | null | undefined): string {
  if (!value) return "";
  const dateOnly = value.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return dateOnly;
  return "";
}

/**
 * 원천징수 신고 기록 조회 상태.
 *
 * ⛔ `error`를 「미신고」로 뭉개지 말 것 — 없는 것과 못 읽은 것은 다르다(P9 검증 판정
 * 위생). 조회 실패를 미신고로 표시하면 오너가 이미 끝낸 신고를 다시 하러 홈택스를 연다.
 */
type FilingLogState =
  /** 조회 대상이 아니다(개인 셀러 칸이 없거나 지급 미완료). */
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; completed: { kind: string; completedAt: string }[] }
  | { status: "error" };

function parseInvoiceInfo(notesFromImport: string | null | undefined): InvoiceInfo {
  if (!notesFromImport) return {};
  try {
    const parsed = JSON.parse(notesFromImport);
    return {
      approvalNumber: parsed.approvalNumber || "",
      documentLink: parsed.documentLink || "",
      supplierInvoiceLink: parsed.supplierInvoiceLink || "",
      sellerInvoiceLink: parsed.sellerInvoiceLink || "",
    };
  } catch {
    return {};
  }
}

async function saveSettlementDate(
  campaignId: string,
  field: "depositReceivedAt" | "payoutCompletedAt" | "supplierPayoutCompletedAt" | "returnPeriodEndDate" | "supplierInvoiceIssuedAt" | "sellerInvoiceIssuedAt" | "expectedDepositDate" | "expectedPayoutDate" | "expectedSupplierPayoutDate" | "accountingCompletedAt",
  value: string | null,
): Promise<{ success: boolean; data?: CampaignRow; error?: string }> {
  const result = await patchCampaign<CampaignRow>(campaignId, { [field]: value }, { preferServerError: true });
  if (!result.ok) {
    return { success: false, error: result.error };
  }
  return { success: true, data: result.data };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettlementSection({
  campaign,
  onCampaignUpdated,
  title = "정산 및 회계 일정",
}: SettlementSectionProps) {
  const [uploadingType, setUploadingType] = useState<"supplier" | "seller" | null>(null);

  // notesFromImport에서 초기값 파생
  const persistedInvoiceInfo = useMemo(
    () => parseInvoiceInfo(campaign.notesFromImport),
    [campaign.notesFromImport],
  );

  // 사용자 입력 draft 상태
  const [invoiceDraft, setInvoiceDraft] = useState<InvoiceInfo>(persistedInvoiceInfo);

  // 캠페인 변경 시 draft 동기화
  useEffect(() => {
    setInvoiceDraft(persistedInvoiceInfo);
  }, [persistedInvoiceInfo]);

  // 두 칸의 상대·방향·적용 여부는 판정표가 정한다(P0 도메인 SSOT) — 여기서 채널
  // 분기를 다시 쓰면 이 레포가 세 번 반복한 사고가 네 번째로 재발한다.
  const invoiceSlots = useMemo(() => resolveCampaignInvoiceSlots(campaign), [campaign]);
  // 대금 결제 칸도 같은 이유로 채널에서 파생한 **슬롯 배열**을 그대로 그린다 — 자사몰은
  // 지급(공급사)+지급(셀러) 두 칸이고 입금 칸이 없다. 개인 셀러 가드는 절대 태우지
  // 않는다(계산서는 없어도 지급은 받는다, resolveCampaignMoneySlots 주석 참조).
  const moneySlots = useMemo(() => resolveCampaignMoneySlots(campaign.salesChannel), [campaign.salesChannel]);
  // 입금 칸이 없는 채널(자사몰)에서 과거 입금 기록이 남아 있으면 숨기지 않고 읽기
  // 전용으로 보여준다 — 레거시 값 보존 규약(WithholdingSlotBox 의 수취일 기록과 동일).
  const hasDepositSlot = moneySlots.some((slot) => slot.kind === "DEPOSIT");
  const legacyDepositValue =
    campaign.isDepositReceived || campaign.depositReceivedAt || campaign.expectedDepositDate;

  // 개인 셀러는 계산서 대신 원천징수 신고가 증빙이다 — 그 칸은 계산서 칸이 아니라 신고
  // 상태 표시로 갈아끼운다. 판정은 **사유 코드**로 한다: `inapplicableReason` 문구를
  // 비교하면 문구를 다듬는 순간 조용히 깨진다.
  const hasWithholdingSlot = useMemo(
    () => invoiceSlots.some((slot) => slot.inapplicableCause === "INDIVIDUAL_SELLER"),
    [invoiceSlots],
  );
  // 귀속월 = 지급월(오너 확정 2026-08-04). `buildWithholdingReport`가 신고 대상을 모으는
  // 축과 같다. 지급 미완료면 귀속월 자체가 없으므로 조회하지 않는다.
  const payoutMonth = useMemo(() => {
    const month = toDateString(campaign.payoutCompletedAt).slice(0, 7);
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
  }, [campaign.payoutCompletedAt]);

  const [filingLog, setFilingLog] = useState<FilingLogState>({ status: "idle" });
  /** 조회 모달이 열려 있는 칸. 「조회」 한 번으로 조회부터 승인까지 이 모달에서 끝난다. */
  const [openReceiptSlot, setOpenReceiptSlot] = useState<CampaignInvoiceSlotView["field"] | null>(null);

  // 개인 셀러 칸이 있고 귀속월이 정해졌을 때만 1회 조회한다. 캠페인 목록 응답에 얹지
  // 않는 이유는 월 단위 조인이 목록 전 행에 붙는데 소비처가 이 패널 하나이기 때문이다.
  useEffect(() => {
    if (!hasWithholdingSlot || !payoutMonth) {
      setFilingLog({ status: "idle" });
      return;
    }
    let cancelled = false;
    setFilingLog({ status: "loading" });
    void (async () => {
      try {
        const res = await fetch(`/api/settlement/tax-filing-log?month=${payoutMonth}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: unknown = await res.json();
        const completed = (body as { completed?: unknown } | null)?.completed;
        // 경계 가드 — `res.ok`여도 몸통이 계약과 다르면(낡은 배포·프록시 개입) 렌더 중에
        // 터지느니 여기서 실패로 떨어뜨린다.
        if (!Array.isArray(completed)) throw new Error("응답 형태가 계약과 다릅니다");
        if (!cancelled) setFilingLog({ status: "loaded", completed });
      } catch (error) {
        // ⛔ 삼키지 않는다(P0) — 조회 실패는 화면에서도 「미신고」가 아니라 실패로 보인다.
        console.warn("[settlement-section] 원천징수 신고 기록 조회 실패", error);
        if (!cancelled) setFilingLog({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasWithholdingSlot, payoutMonth]);

  const { sendToHometax } = useHometaxIssue();
  const [receiptScan, setReceiptScan] = useState<ReceiptScanApiResponse | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);
  // 클릭~완료 전 구간(그룹 조회 GET 포함) 내내 버튼을 잠그는 동기 가드. `useHometaxIssue`의
  // `sendingKey`는 `sendToHometax` 내부에서만 서므로, 그 앞의 `resolveMemberIds()` await
  // 동안은 무방비였다 — 두 번 빠르게 누르면 둘 다 그 틈을 통과해 발행이 두 번 나간다
  // (2026-08-07 리뷰 실사고). ref 는 렌더 사이에도 즉시 갱신되므로 첫 await 이전에 이미
  // 잠근다 — state 만으로는 같은 이벤트 루프 틱 안의 두 번째 클릭이 아직 리렌더 전의
  // 값을 볼 수 있어 부족하다.
  const issuingKeyRef = useRef<string | null>(null);
  const [issuingKey, setIssuingKey] = useState<string | null>(null);
  // 수취 확인도 같은 결함이 있었다 — `if (receiptLoading) return`은 클로저에 갇힌 값을
  // 읽어 같은 틱의 두 번째 클릭이 여전히 `false`를 본다. IMAP 전량 스캔은 수 초가 걸려
  // 두 번째 클릭이 스캔을 중복으로 띄우기 쉽다. 같은 ref 가드를 쓴다.
  const receiptLoadingRef = useRef(false);

  const [groupMemberIds, setGroupMemberIds] = useState<string[] | null>(null);

  /**
   * 계산서는 **정산 그룹당 한 장**이라 발행 페이로드의 campaignIds 는 멤버 전원이어야
   * 한다. 패널 진입 시점엔 형제 id 를 모르므로 버튼을 누를 때만 조회한다(GET 하나).
   * 조회 실패해도 캠페인 단독으로 진행한다 — 서버가 그룹을 다시 채우는 방어선이 있다
   * (그 방어선에 기대는 것이 아니라, 실패로 발행 자체를 막지 않기 위한 fail-safe).
   *
   * ⚠️ 정렬해서 돌려준다 — 수취 판정(`resolveRowEvidence`)의 대표(anchor)는 「id
   * 오름차순 첫 멤버」라는 계약이라, 순서가 흔들리면 대표가 바뀌어 판정이 갈린다.
   *
   * ⛔ 실패를 조용히 삼키지 않는다(P0) — bare catch 로 `[campaign.id]` 폴백만 돌려주면
   * `groupMemberIds` 가 계속 `null` 로 남아 `board-evidence.ts` 의 그룹 가드가 그룹 셀러
   * 슬롯을 **항상** 「조회 범위 밖」으로 떨어뜨린다(증상만 보이고 원인은 안 보이는 조합,
   * 2026-08-07 리뷰 지적). 사유는 `console.warn` 으로 남긴다. `notifyFailure` 는 발행
   * 경로와 수취 경로가 요구 수준이 다르기 때문이다 — 발행은 서버가 그룹을 재확장하므로
   * 조회 실패로 발행 자체를 막지 않고 조용히 캠페인 단독으로 진행하지만(fail-safe), 수취
   * 확인은 그 조회 결과가 판정 범위 자체를 좁히므로 오너에게 한 줄 고지한다.
   */
  const resolveMemberIds = useCallback(
    async (options?: { notifyFailure?: boolean }): Promise<string[]> => {
      const groupId = campaign.groupId ?? null;
      if (!groupId) return [campaign.id];
      if (groupMemberIds) return groupMemberIds;
      try {
        const detail = await fetchGroupDetail(groupId);
        const ids = detail.members.map((member) => member.campaignId).sort();
        const resolved = ids.length > 0 ? ids : [campaign.id];
        setGroupMemberIds(resolved);
        return resolved;
      } catch (error) {
        console.warn(
          "[settlement-section] 정산 그룹 조회 실패 — 캠페인 단독 기준으로 진행합니다.",
          error,
        );
        if (options?.notifyFailure) {
          toast.warning("정산 그룹 조회에 실패해 이 캠페인 단독 기준으로 확인합니다.");
        }
        return [campaign.id];
      }
    },
    [campaign.groupId, campaign.id, groupMemberIds],
  );

  const handleIssue = useCallback(
    async (slot: CampaignInvoiceSlotView) => {
      const key = `${campaign.id}:${slot.field}`;
      // 동기 가드 — 첫 await(그룹 조회 GET) 이전에 잠근다. 이 줄과 다음 줄 사이에는
      // await 이 없으므로 같은 틱의 두 번째 클릭도 반드시 이 값을 보고 돌아간다.
      if (issuingKeyRef.current) return;
      issuingKeyRef.current = key;
      setIssuingKey(key);
      try {
        const campaignIds = await resolveMemberIds();
        await sendToHometax({
          key,
          campaignIds,
          counterpartName: slot.counterpart === "SUPPLIER" ? campaign.partnerName : campaign.sellerName,
        });
      } finally {
        issuingKeyRef.current = null;
        setIssuingKey(null);
      }
    },
    [campaign.id, campaign.partnerName, campaign.sellerName, resolveMemberIds, sendToHometax],
  );

  /**
   * 수취 확인 — 전용 메일함을 읽기 전용으로 스캔해 이 건의 판정만 뽑는다.
   * ⛔ 아무것도 쓰지 않는다. 완료 확정은 오너의 클릭(칸 안의 「승인하여 수취 처리」 또는
   * 체크박스)이 근거다 — 자동 확정은 잘못 발행된 계산서를 「확인됨」으로 굳힌다
   * (board-evidence.ts 계약).
   * 스캔은 IMAP 전량 조회라 수 초 걸린다 — 결과를 카드 수명 동안 재사용한다.
   */
  const handleCheckReceipt = useCallback(async () => {
    if (receiptLoadingRef.current) return;
    receiptLoadingRef.current = true;
    setReceiptLoading(true);
    try {
      // 그룹이면 형제 id 가 있어야 판정이 선다 — 없으면 `resolveRowEvidence` 가 그룹
      // 셀러 슬롯을 정직하게 `no_data`(조회 범위 밖)로 돌려준다(board-evidence 가드).
      // 이 경로는 그 조회 실패를 오너에게 고지한다(notifyFailure) — 발행 경로와 달리
      // 판정 범위 자체가 좁아지므로 조용히 넘기면 안 된다.
      await resolveMemberIds({ notifyFailure: true });
      const res = await fetch("/api/settlement/tax-invoice-receipts?sinceDays=90");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "메일함 조회에 실패했습니다.");
        return;
      }
      const body: unknown = await res.json().catch(() => null);
      // 경계 가드 — `res.ok`가 true 여도 몸통이 계약과 다르면(낡은 배포·프록시 개입 등)
      // 저장하지 않는다. `indexReceiptScan`은 `useMemo` 안이라 여기서 안 거르면 렌더
      // 중에 터진다(위 `isReceiptScanShape` 주석 참조).
      if (!isReceiptScanShape(body)) {
        toast.error("메일함 조회에 실패했습니다.");
        return;
      }
      setReceiptScan(body);
    } catch {
      toast.error("메일함 조회에 실패했습니다.");
    } finally {
      receiptLoadingRef.current = false;
      setReceiptLoading(false);
    }
  }, [resolveMemberIds]);

  /**
   * 수취 결정(승인·무관 처리·되돌리기) 뒤처리.
   *
   * ⛔ **스캔만 다시 읽으면 안 된다.** 결정 라우트는 캠페인(그룹이면 그룹)의 계산서 일자를
   * **직접 쓴다** — 그런데 체크박스와 수취일 칸은 `campaign` prop 에서 값을 읽으므로,
   * 스캔만 갱신하면 카드는 「승인됨」인데 바로 위 체크박스와 바로 아래 날짜는 빈 채로
   * 남는다. 그게 정확히 오너가 신고한 화면이라, 승인 버튼을 눌러도 같은 증상이 한 번 더
   * 재현된다. 그래서 캠페인을 다시 읽어 화면에 되꽂는다.
   */
  const handleReceiptDecided = useCallback(async () => {
    const refreshCampaign = async () => {
      // 읽기·검증·전파는 SSOT 에 맡긴다(`campaign-row-refresh`). ⛔ 문구는 여기가 소유한다 —
      // 목록 배지가 낡는 것과 **이 패널의 칸이 빈 채로 남는 것**은 사용자가 취할 행동이
      // 달라서, 목록용 공통 문구(`LIST_REFRESH_FAILED_MESSAGE`)를 쓰면 한쪽이 틀려진다.
      const failed = await refreshCampaignRows([campaign.id], onCampaignUpdated);
      if (failed > 0) {
        // 삼키지 않는다 — 쓰기는 이미 끝났으므로 「실패」가 아니라 「화면이 낡았다」고 말한다.
        toast.warning("처리는 저장됐지만 화면 갱신에 실패했습니다. 새로고침해 주세요.");
      }
    };
    await Promise.all([handleCheckReceipt(), refreshCampaign()]);
  }, [campaign.id, handleCheckReceipt, onCampaignUpdated]);

  const evidenceByKey = useMemo(
    () => (receiptScan ? indexReceiptScan(receiptScan) : null),
    [receiptScan],
  );

  /** 판정용 행 좌표 — 그룹이면 멤버 전원(정렬됨)과 그중 첫 id 가 대표(anchor)다. */
  const evidenceScope = useMemo(() => {
    const groupId = campaign.groupId ?? null;
    const ids = groupMemberIds ?? [campaign.id];
    return {
      groupId,
      campaignIds: ids,
      anchorId: ids[0],
      groupMembers: groupId ? new Map([[groupId, new Set(ids)]]) : undefined,
    };
  }, [campaign.groupId, campaign.id, groupMemberIds]);

  /**
   * 계산서 칸 하나가 소유하는 **기대 건 key** — 그룹이면 멤버 전원 몫이다(대표 하나로
   * 좁히면 형제 멤버 앞으로 온 계산서의 승인 버튼이 이 칸에서 사라진다).
   * ⛔ 슬롯 이름을 여기서 다시 문자열로 유도하지 않는다 — `receivableSlotForField` 가 정본.
   */
  const slotReceiptKeys = useCallback(
    (field: CampaignInvoiceSlotView["field"]) =>
      evidenceScope.campaignIds.map((id) => `${id}:${receivableSlotForField(field)}`),
    [evidenceScope],
  );

  /**
   * 어느 계산서 칸도 집지 않은 승인 대기 건.
   *
   * ⛔ **조용히 버리지 않는다.** 승인 UI 를 칸별로 쪼갠 순간, 칸과 엔진 슬롯의 매핑이
   * 한 조합이라도 어긋나면 그 건의 승인 경로가 화면에서 통째로 사라진다 — 오너는
   * 「처리할 것이 없다」고 읽는다(P0 「삼키지 않는다」). 지금은 개인 셀러 칸(원천징수라
   * 승인 대상이 아니다)이 여기로 떨어지는 정상 경로가 있다.
   */
  const unclaimedReceiptKeys = useMemo(() => {
    if (!receiptScan) return [];
    const claimed = new Set(
      invoiceSlots
        .filter(isApprovableReceiveSlot)
        .flatMap((slot) => slotReceiptKeys(slot.field)),
    );
    const scoped = new Set(evidenceScope.campaignIds);
    return receiptScan.results
      .flatMap(resolveDecisionScopeKeys)
      .filter((key) => {
        if (claimed.has(key)) return false;
        const separator = key.lastIndexOf(":");
        return separator > 0 && scoped.has(key.slice(0, separator));
      });
  }, [receiptScan, invoiceSlots, slotReceiptKeys, evidenceScope]);

  // 세금계산서 증빙 파일 첨부 핸들러
  const handleUploadInvoice = async (e: React.ChangeEvent<HTMLInputElement>, type: "supplier" | "seller") => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingType(type);
    try {
      const ext = file.name.split('.').pop() || "png";
      const campaignName = campaign.dealName || campaign.campaignName || "캠페인";
      let newFileName = "";

      if (type === "supplier") {
        const partnerName = campaign.partnerName || "거래처";
        newFileName = `${campaignName}_${partnerName}.${ext}`;
      } else {
        const sellerName = campaign.sellerName || "셀러";
        newFileName = `${campaignName}_${sellerName}.${ext}`;
      }

      // Rename file
      const renamedFile = new File([file], newFileName, { type: file.type });
      
      const formData = new FormData();
      formData.append("file", renamedFile);
      formData.append("entityType", "CAMPAIGN");
      formData.append("entityId", campaign.id);
      formData.append("section", "CONTRACT_SETTLEMENT");

      const uploadRes = await fetch("/api/assets", {
        method: "POST",
        body: formData,
      });

      if (!uploadRes.ok) throw new Error("업로드 실패");
      const { url } = await uploadRes.json();

      const newInvoiceDraft = {
        ...invoiceDraft,
        [type === "supplier" ? "supplierInvoiceLink" : "sellerInvoiceLink"]: url,
      };

      setInvoiceDraft(newInvoiceDraft);

      // Save to database
      const result = await patchCampaign<CampaignRow>(
        campaign.id,
        { notesFromImport: JSON.stringify(newInvoiceDraft) },
        { fallbackError: "데이터 저장 실패", networkError: "데이터 저장 실패" },
      );

      if (!result.ok) throw new Error(result.error);

      onCampaignUpdated(result.data);
      toast.success("증빙 파일이 첨부되었습니다.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "업로드 오류");
    } finally {
      setUploadingType(null);
      // Reset input value to allow uploading same file again if needed
      e.target.value = "";
    }
  };

  return (
    <div className="space-y-4 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center text-sm font-semibold text-foreground">
          <CalendarDays className="mr-2 size-4 text-muted-foreground" />
          {title}
        </h3>
      </div>

      <div className="space-y-3.5 pt-2 border-t border-border/50">
        {/* 대금 결제 일정 — 칸 구성(입금/지급 × 상대)은 채널 슬롯에서 파생한다.
            자사몰: 지급(공급사)+지급(셀러), 브랜드몰: 입금(공급사)+지급(셀러),
            셀러몰: 입금(셀러)+지급(공급사). 회계 일정의 invoiceSlots 와 같은 구조다. */}
        <div>
          <h4 className="text-xs font-semibold text-slate-700 mb-2">대금 결제 일정</h4>

          <div className="grid grid-cols-2 gap-4">
            {moneySlots.map((slot) => {
              // 방향 동사는 슬롯이 소유한다 — 소비 표면이 9곳으로 늘면서 이 삼항이
              // 아홉 벌이 되는 것이 이 레포가 반복해 온 「두 번째 인코딩」의 형태다.
              const verb = slot.verb;
              const completed = Boolean(campaign[slot.flagField]);
              const completedAt = campaign[slot.completedAtField];
              return (
                <div
                  key={slot.flagField}
                  /* 완료 틴트는 **상태 캐리어**다(P8 §3) — 배지를 걷어낸 뒤 이 칸에서 완료를
                     알리는 것이 체크 표시와 9px 캡션뿐이라, 「체크했다 = 이 칸이 이제 실제
                     이체일을 편집한다」가 눈에 안 들어온다. 신규 색이 아니라 캘린더 완료
                     도트와 같은 `status-success` 계열이다.
                     ⛔ 미완료 칸까지 칠하지 말 것 — 다 칠하면 아무것도 안 튄다(P8 §2). */
                  className={cn(
                    "rounded-xl border p-3 space-y-2",
                    completed
                      ? "border-status-success/25 bg-status-success-bg/50"
                      : "border-slate-100 bg-slate-50/40",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={completed}
                        onChange={async (e) => {
                          const checked = e.target.checked;
                          const dateVal = checked ? new Date().toISOString().split("T")[0] : null;
                          const result = await saveSettlementDate(campaign.id, slot.completedAtField, dateVal);
                          if (result.success && result.data) {
                            onCampaignUpdated(result.data);
                            // 자사몰은 두 칸 모두 「지급」이라 상대를 병기해야 방금 저장한
                            // 칸이 토스트로 구분된다(InvoiceSlotBox 의 slot.title 선례).
                            toast.success(
                              checked
                                ? `${verb} 완료 처리되었습니다 (${slot.counterpartLabel}).`
                                : `${verb} 완료 취소되었습니다 (${slot.counterpartLabel}).`,
                            );
                          } else {
                            toast.error(result.error ?? "저장 실패");
                          }
                        }}
                        className="rounded border-slate-300 text-primary focus:ring-focus-ring size-3.5"
                      />
                      {completed ? `${verb} 완료` : `${verb} 예정`} ({slot.counterpartLabel})
                    </label>
                  </div>

                  {/* **한 칸이 상태에 따라 뜻을 바꾼다**(오너 결정 2026-08-26): 완료를
                      체크하면 예정일은 더 이상 쓸 일이 없고, 대신 「언제 실제로 나갔나」가
                      필요해진다 — 체크가 오늘로 자동 기록한 값을 이 칸에서 실제 이체일로
                      고친다. 그 값이 캘린더 4표면과 구글 이벤트가 서는 날짜다
                      (`resolveMoneySlotEffectiveDate`).
                      ⛔ **예정일 컬럼을 실제일로 덮어쓰지 말 것** — 지연 판정
                      (`agenda-settlements`)·정산 목록 일정 열·정산 리포트가 그 값을 읽어서,
                      덮으면 「원래 언제까지였나」가 사라지고 지연 통계가 소급으로 바뀐다.
                      바뀌는 것은 **화면에 뜨는 칸**이지 컬럼이 아니다.
                      🪤 `key` 에 필드명을 넣는 이유: `InlineDateField` 는 비제어라 외부 값
                      변경을 `key` 재마운트로만 반영한다(그 계약이 「두 번째 자릿수를 칠 수
                      없다」 사고의 처방이다). 필드가 바뀌는데 key 가 같으면 체크 직후에도
                      옛 예정일이 그대로 남는다. */}
                  <DateField
                    key={completed ? slot.completedAtField : slot.expectedField}
                    label={completed ? `${verb}일` : `${verb} 예정일`}
                    /* 자사몰은 「지급 예정일」 라벨이 두 칸에 겹친다 — 접근성 이름은 상대까지
                       병기해 스크린리더에서 구분되게 한다(InvoiceSlotBox 의 ariaLabel 선례). */
                    ariaLabel={`${completed ? `${verb}일` : `${verb} 예정일`} (${slot.counterpartLabel})`}
                    value={toDateString(completed ? completedAt : campaign[slot.expectedField])}
                    campaignId={campaign.id}
                    field={completed ? slot.completedAtField : slot.expectedField}
                    onCampaignUpdated={onCampaignUpdated}
                  />
                </div>
              );
            })}
          </div>

          {/* ⛔ 지우지 말 것 — 입금 칸이 없는 채널(자사몰)에서 과거 입금 기록이 있는 행은
              읽기 전용으로 남긴다. 숨기면 이미 입력된 값이 어디서도 보이지 않게 된다. */}
          {!hasDepositSlot && legacyDepositValue ? (
            <p className="mt-2 text-[10px] text-slate-500">
              과거 입금 기록(몰 정산금)
              {campaign.depositReceivedAt ? ` · 완료 ${toDateString(campaign.depositReceivedAt)}` : campaign.isDepositReceived ? " · 완료" : ""}
              {campaign.expectedDepositDate ? ` · 예정일 ${toDateString(campaign.expectedDepositDate)}` : ""}
            </p>
          ) : null}
        </div>

        {/* 회계 일정 — 칸 구성·방향·상대는 판정표에서 파생한다(카드가 채널 분기를 쓰지 않는다) */}
        <div className="pt-3 border-t border-border/40">
          <h4 className="text-xs font-semibold text-slate-700 mb-2">회계 일정</h4>
          <div className="grid grid-cols-2 gap-4">
            {invoiceSlots.map((slot) => {
              // 개인 셀러 칸은 계산서가 아니라 원천징수 신고가 증빙이다 — 죽은 비적용
              // 칸 대신 그 달의 신고 상태를 읽어 보여준다(읽기 전용, 설계 §1).
              if (slot.inapplicableCause === "INDIVIDUAL_SELLER") {
                return (
                  <WithholdingSlotBox
                    key={slot.field}
                    slot={slot}
                    campaign={campaign}
                    filingLog={filingLog}
                    invoiceLink={
                      slot.field === "supplierInvoiceIssuedAt"
                        ? invoiceDraft.supplierInvoiceLink
                        : invoiceDraft.sellerInvoiceLink
                    }
                    onCampaignUpdated={onCampaignUpdated}
                  />
                );
              }
              // ⛔ 이미 발행일이 찍혀 있으면 「홈택스 발행」 버튼을 렌더하지 않는다 — 남겨
              // 두면 오너가 첨부만 붙이러 카드를 열었을 때 같은 금액으로 홈택스 폼을 다시
              // 채워 넣는 중복 발행 경로가 열린다(2026-08-07 리뷰 지적, 보드가
              // `if (campaign[field]) continue;` 로 완료 행을 아예 안 내는 것과 같은 이유).
              // 판정은 `InvoiceSlotBox` 가 쓰는 것과 같은 계산(`Boolean(campaign[field])`)
              // 이다 — 채널·필드명으로 다시 유도하지 않는다.
              const isIssued = Boolean(campaign[slot.field]);
              return (
              <InvoiceSlotBox
                key={slot.field}
                slot={slot}
                campaign={campaign}
                /* 조회 결과와 그 결정은 전부 **이 모달 안**에서 일어난다(오너 지시
                   2026-08-15) — 칸에 승인 버튼을 따로 만들면 같은 결정을 세 번 누르게 된다.
                   범위는 이 칸이 소유한 기대 건 key 뿐이라 형제 칸의 계산서가 섞이지 않는다. */
                approval={
                  isApprovableReceiveSlot(slot) ? (
                    <ReceiptDecisionDialog
                      open={openReceiptSlot === slot.field}
                      onOpenChange={(next) => setOpenReceiptSlot(next ? slot.field : null)}
                      scan={receiptScan}
                      loading={receiptLoading}
                      keys={slotReceiptKeys(slot.field)}
                      title={slot.title}
                      onDecided={handleReceiptDecided}
                    />
                  ) : null
                }
                invoiceLink={
                  slot.field === "supplierInvoiceIssuedAt"
                    ? invoiceDraft.supplierInvoiceLink
                    : invoiceDraft.sellerInvoiceLink
                }
                uploadType={slot.field === "supplierInvoiceIssuedAt" ? "supplier" : "seller"}
                isUploading={uploadingType === (slot.field === "supplierInvoiceIssuedAt" ? "supplier" : "seller")}
                onUpload={handleUploadInvoice}
                onCampaignUpdated={onCampaignUpdated}
                action={
                  slot.applicable ? (
                    slot.direction === "ISSUE" ? (
                      isIssued ? (
                        <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-500">
                          발행 완료
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={issuingKey === `${campaign.id}:${slot.field}`}
                          onClick={() => void handleIssue(slot)}
                          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600 shadow-soft-sm transition-colors hover:bg-slate-50 disabled:cursor-wait disabled:opacity-50"
                        >
                          {issuingKey === `${campaign.id}:${slot.field}` ? "전송 중" : "홈택스 발행"}
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        disabled={receiptLoading}
                        onClick={() => {
                          // 모달을 먼저 열고 스캔을 건다 — 진행 상태를 모달이 그린다.
                          setOpenReceiptSlot(slot.field);
                          void handleCheckReceipt();
                        }}
                        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600 shadow-soft-sm transition-colors hover:bg-slate-50 disabled:cursor-wait disabled:opacity-50"
                      >
                        {/* ⛔ 상태마다 다른 말을 쓰지 않는다 — 첫 조회든 재조회든 같은 동작이다
                            (ss-copy 「한 액션 한 표기」). 칸 제목이 이미 대상을 말한다. */}
                        {receiptLoading ? "조회 중" : "조회"}
                      </button>
                    )
                  ) : null
                }
                evidence={
                  slot.applicable && evidenceByKey
                    ? resolveRowEvidence(
                        {
                          campaignId: evidenceScope.anchorId,
                          campaignIds: evidenceScope.campaignIds,
                          groupId: evidenceScope.groupId,
                          sourceField: slot.field,
                          direction: slot.direction,
                        },
                        evidenceByKey,
                        evidenceScope.groupMembers,
                      )
                    : null
                }
              />
              );
            })}
          </div>

          {/* 승인 카드의 자리는 **계산서 칸 안**이다(위 `approval` prop). 여기 남은 것은
              어느 칸도 집지 않은 잔여 건 전용이다 — 없으면 아무것도 그리지 않는다.
              ⛔ 이 줄을 지우지 말 것: 칸↔슬롯 매핑이 어긋나는 조합이 생겨도 승인 경로가
              화면에서 사라지지 않게 하는 마지막 그물이다. */}
          <ReceiptSuggestionCards
            scan={receiptScan}
            onDecided={handleReceiptDecided}
            keys={unclaimedReceiptKeys}
          />
        </div>


      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InvoiceSlotBox — 계산서 한 칸(공급사 / 셀러)
// ---------------------------------------------------------------------------

function InvoiceSlotBox({
  slot,
  campaign,
  invoiceLink,
  uploadType,
  isUploading,
  onUpload,
  onCampaignUpdated,
  action,
  evidence,
  approval,
}: {
  slot: CampaignInvoiceSlotView;
  campaign: CampaignRow;
  invoiceLink: string | undefined;
  uploadType: "supplier" | "seller";
  isUploading: boolean;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>, type: "supplier" | "seller") => void;
  onCampaignUpdated: (campaign: CampaignRow) => void;
  /** 방향에 맞는 액션 버튼(Task 7). 없으면 첨부만 노출한다. */
  action?: React.ReactNode;
  /** 수취 판정 배지(Task 7). ISSUE 칸은 항상 null(엔진이 발행을 추적하지 않는다). */
  evidence?: RowEvidence | null;
  /**
   * 이 칸의 **조회 모달**. 「조회」가 열고, 조회 결과와 그 결정이 전부 그 안에서 끝난다.
   * 닫혀 있을 때는 아무것도 렌더하지 않으므로 칸의 높이·밀도에 영향이 없다.
   */
  approval?: React.ReactNode;
}) {
  const value = campaign[slot.field] as string | null | undefined;
  const done = Boolean(value);

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/40 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-pointer select-none mt-1">
          <input
            type="checkbox"
            checked={done}
            disabled={!slot.applicable}
            aria-label={`${slot.title} 완료`}
            onChange={async (e) => {
              const checked = e.target.checked;
              const dateVal = checked ? new Date().toISOString().split("T")[0] : null;
              const result = await saveSettlementDate(campaign.id, slot.field, dateVal);
              if (result.success && result.data) {
                onCampaignUpdated(result.data);
                toast.success(
                  checked
                    ? `${slot.title} 완료 처리되었습니다.`
                    : `${slot.title} 완료 취소되었습니다.`,
                );
              } else {
                toast.error(result.error ?? "저장 실패");
              }
            }}
            className="rounded border-slate-300 text-primary focus:ring-focus-ring size-3.5 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {/* 제목 자체가 방향을 나른다 — 별도 색 배지를 두지 않는다(P8 §4: 범주는 색을 받지 않는다).
              「완료/예정」 문구는 붙이지 않는다 — 체크 상태와 날짜 필드가 이미 그 사실을
              나르므로 같은 정보를 세 번 쓰는 셈이고, 문구가 붙으면 라벨 문자열이 상태에
              따라 흔들려 접근성 이름도 함께 흔들린다. */}
          {slot.title}
        </label>

        <div className="flex items-center gap-1.5">
          {slot.applicable && action}
          {/* ⛔ 「확인」 링크는 `slot.applicable` 과 무관하게 렌더한다(설계 §4-2 「값이
              있으면 기록을 숨기지 않는다」의 확장 — 종전엔 날짜에만 적용되고 첨부에는
              적용되지 않아, 비적용 칸에 이미 붙여 둔 증빙으로 가는 유일한 경로가
              사라졌다). 첨부 **버튼**은 계속 비적용 칸에서 숨긴다 — 새 파일을 붙일
              자리는 아니다(아래 분기). */}
          {invoiceLink && (
            <a
              href={invoiceLink}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] font-medium text-indigo-600 hover:underline flex items-center gap-0.5"
            >
              <ExternalLink className="size-2.5" />
              확인
            </a>
          )}
          {slot.applicable ? (
            <label
              className={cn(
                "flex items-center gap-1 cursor-pointer rounded-md bg-white border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-50 transition-colors shadow-soft-sm",
                isUploading && "opacity-50 cursor-wait",
              )}
            >
              {/* 아이콘 없이 문구만 둔다(오너 지시 2026-08-15) — 진행 상태도 문구로 말한다. */}
              {isUploading ? "첨부 중" : "첨부"}
              <input
                type="file"
                accept="image/*,.pdf"
                className="hidden"
                onChange={(e) => onUpload(e, uploadType)}
                disabled={isUploading}
              />
            </label>
          ) : (
            // ⛔ 값이 있으면 칸을 숨기지 않는다 — 기록이 화면에서 사라지면 오너가 해제할
            //    경로도 없어진다. 프로덕션에 그런 레거시 행이 실재한다.
            <span className="mt-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
              {slot.inapplicableReason}
            </span>
          )}
        </div>
      </div>

      {/* 판정은 도트 + 라벨 한 줄이다. 승인 버튼은 이 줄이 아니라 **위 액션 줄**에 다른
          버튼들과 나란히 있다(오너 지시 2026-08-15) — 조작은 조작끼리 모은다.
          「확인됨」은 여기 남기지 않는다 — 판정 근거는 「조회」 모달이 소유한다
          (`shouldShowEvidenceBadge`). */}
      {shouldShowEvidenceBadge(evidence) ? (
        <div className="flex items-center gap-1.5">
          <span
            className={cn("size-1.5 shrink-0 rounded-full", RECEIPT_EVIDENCE_TONE[evidence.kind].dot)}
            aria-hidden="true"
          />
          <span className={cn("min-w-0 truncate text-[10px] font-medium", RECEIPT_EVIDENCE_TONE[evidence.kind].text)}>
            {RECEIPT_EVIDENCE_LABEL[evidence.kind]}
          </span>
        </div>
      ) : null}

      {/* 닫혀 있으면 아무것도 그리지 않는다 — 자리를 차지하지 않으므로 칸 높이에 영향이 없다. */}
      {approval}

      <DateField
        label={slot.directionLabel ? `${slot.directionLabel}일` : "일자"}
        // ⚠️ 보이는 라벨은 두 칸이 같을 수 있다(우리몰 = 「수취일」 × 2) — 접근성 이름은
        //    칸 제목으로 유일하게 만든다. 안 그러면 getByLabelText 가 두 개를 집는다.
        ariaLabel={`${slot.title} 일자`}
        value={toDateString(value)}
        campaignId={campaign.id}
        field={slot.field}
        onCampaignUpdated={onCampaignUpdated}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// WithholdingSlotBox — 개인 셀러 칸(계산서 대신 원천징수 신고)
// ---------------------------------------------------------------------------

/**
 * 개인 셀러 캠페인의 셀러 칸. 계산서를 주고받지 않는 상대이므로 증빙은 **그 지급월의
 * 원천징수 신고**다(3절차 전부 완료 = 완료, 오너 확정 2026-08-12).
 *
 * ⛔ **읽기 전용이다 — 여기서 쓰지 않는다.** SoT 는 월 단위 `TaxFilingLog` 하나이고 조작은
 * 세무 처리 다이얼로그가 소유한다. 이 칸에 체크로 쓰기를 붙이면 같은 사실을 두 곳에서
 * 조작하게 되고, 한 캠페인의 완료가 그 달 전체의 신고를 뜻하는 것처럼 보인다.
 *
 * 색을 쓰지 않는 것도 결정이다 — 기한 근접도(심각도)는 세무 처리 카드의 D-day 배지가
 * 이미 소유한다. 여기에 또 얹으면 같은 사실이 두 곳에서 경쟁하고, 매달 뜨는 경고색은
 * 습관화로 신호를 잃는다(P8 §1·§2).
 */
function WithholdingSlotBox({
  slot,
  campaign,
  filingLog,
  invoiceLink,
  onCampaignUpdated,
}: {
  slot: CampaignInvoiceSlotView;
  campaign: CampaignRow;
  filingLog: FilingLogState;
  invoiceLink: string | undefined;
  onCampaignUpdated: (campaign: CampaignRow) => void;
}) {
  const status = useMemo(
    () =>
      resolveCampaignWithholdingStatus(
        toDateString(campaign.payoutCompletedAt),
        filingLog.status === "loaded" ? filingLog.completed : [],
      ),
    [campaign.payoutCompletedAt, filingLog],
  );

  // 기록을 실제로 읽었을 때만 완료로 본다 — loading·error 구간의 빈 배열은 「미신고」가
  // 아니라 「모름」이다.
  const loaded = filingLog.status === "loaded";
  const done = loaded && status.state === "FILED";

  /** 상태 배지 문구. 완료면 없음 — 체크 상태와 신고일이 이미 그 사실을 나른다
   *  (`InvoiceSlotBox`가 「완료/예정」 문구를 붙이지 않는 것과 같은 이유). */
  const statusNote: string | null =
    status.state === "AWAITING_PAYOUT"
      ? "지급 완료 후 신고"
      : filingLog.status === "loading"
        ? "신고 기록 조회 중"
        : filingLog.status === "error"
          ? "신고 기록 조회 실패"
          : done
            ? null
            : `${status.month}분 · ${status.pendingCount}건 남음`;

  /** 신고일 칸의 표시값.
   *
   *  ⛔ 조회 중·실패 구간에 「없음」을 쓰지 말 것 — 그건 **미신고**라는 사실 주장이고,
   *  우리가 아는 것은 「아직 못 읽었다」뿐이다(P9 검증 판정 위생). 배지를 못 보고 이 줄만
   *  읽는 오너가 이미 끝낸 신고를 다시 하러 홈택스를 연다. */
  const filedAtDisplay =
    status.state !== "AWAITING_PAYOUT" && filingLog.status === "loading"
      ? "확인 중"
      : status.state !== "AWAITING_PAYOUT" && filingLog.status === "error"
        ? "확인 불가"
        : (status.filedAt ?? "없음");

  // ⛔ 레거시 값이 있으면 숨기지 않는다 — 개인 셀러인데 계산서 수취일이 찍힌 행이
  //    프로덕션에 실재한다. 화면에서 사라지면 오너가 해제할 경로도 함께 사라진다.
  const legacyInvoiceDate = toDateString(campaign[slot.field] as string | null | undefined);

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/40 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 select-none mt-1">
          <input
            type="checkbox"
            checked={done}
            // `readOnly` 는 붙이지 않는다 — HTML 명세상 체크박스에는 효과가 없는 죽은
            // 속성이고, React 의 controlled-without-onChange 경고는 `disabled` 만으로 이미
            // 억제된다. 순수 상태 표시라 포커스를 받을 이유도 없으므로 `disabled` 가 맞다.
            disabled
            // 비활성 이유를 접근성 이름에 담는다 — 화면을 봐야만 알 수 있으면 스크린리더
            // 사용자는 왜 못 누르는지 알 수 없다.
            aria-label="원천징수 신고 완료 (세무 처리에서 관리)"
            className="rounded border-slate-300 text-primary size-3.5 disabled:cursor-not-allowed disabled:opacity-50"
          />
          원천징수 신고
        </label>

        <div className="flex items-center gap-1.5">
          {/* ⛔ 비적용 칸의 「확인」 링크 규약을 그대로 승계한다 — 이미 붙여 둔 증빙으로
              가는 경로를 없애지 않는다. 첨부 **버튼**은 두지 않는다(계산서를 새로 붙일
              자리가 아니다). */}
          {invoiceLink && (
            <a
              href={invoiceLink}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] font-medium text-indigo-600 hover:underline flex items-center gap-0.5"
            >
              <ExternalLink className="size-2.5" />
              확인
            </a>
          )}
          {statusNote && (
            <span className="mt-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
              {statusNote}
            </span>
          )}
        </div>
      </div>

      {/* 신고일은 파생값이라 입력이 아니라 텍스트다 — 입력처럼 보이면 오너가 고치려다
          실패한다. 자리(높이)는 형제 칸의 날짜 행과 맞춘다. */}
      <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50/40 p-2 px-3">
        <span className="text-[10px] text-muted-foreground font-medium shrink-0">신고일</span>
        {/* ⚠️ `leading-6`(24px)은 장식이 아니라 **정렬 장치**다 — 형제 칸의 `DateField` 는
            `InlineDateField` 에 `h-6` 을 명시로 걸어 행 높이가 40px 로 고정되는데, 이 줄에
            줄높이를 안 주면 브라우저 기본값(≈16px)을 따라가 32px 가 된다. 두 칸은 같은
            `grid grid-cols-2` 행이고 카드가 `stretch` 되므로, 그 8px 차이가 이 칸 하단에
            **설명되지 않는 여백**으로 고인다(ss-ux-designer P2 지적). 지우지 말 것. */}
        <span
          className={cn(
            "px-1 text-[11px] font-medium leading-6",
            status.filedAt ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {filedAtDisplay}
        </span>
      </div>

      {legacyInvoiceDate && (
        <DateField
          label="셀러 계산서 수취일(기록)"
          ariaLabel="셀러 계산서 수취일 기록"
          value={legacyInvoiceDate}
          campaignId={campaign.id}
          field={slot.field}
          onCampaignUpdated={onCampaignUpdated}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DateField Sub-Component
// ---------------------------------------------------------------------------

type DateFieldProps = {
  label: string;
  /** 접근성 이름 — 미지정이면 `label`. 같은 카드에 라벨이 겹칠 때만 넘긴다. */
  ariaLabel?: string;
  value: string;
  campaignId: string;
  field: "depositReceivedAt" | "payoutCompletedAt" | "supplierPayoutCompletedAt" | "returnPeriodEndDate" | "supplierInvoiceIssuedAt" | "sellerInvoiceIssuedAt" | "expectedDepositDate" | "expectedPayoutDate" | "expectedSupplierPayoutDate" | "accountingCompletedAt";
  onCampaignUpdated: (campaign: CampaignRow) => void;
};

function DateField({
  label,
  ariaLabel,
  value,
  campaignId,
  field,
  onCampaignUpdated,
}: DateFieldProps) {
  const [isSaving, setIsSaving] = useState(false);

  const handleDateChange = useCallback(
    async (newValue: string) => {
      const dateToSave = newValue || null;
      if (dateToSave === (value || null)) return;

      setIsSaving(true);
      const result = await saveSettlementDate(campaignId, field, dateToSave);

      if (result.success && result.data) {
        onCampaignUpdated(result.data);
        toast.success("저장되었습니다");
      } else {
        toast.error(result.error ?? "저장 실패");
      }
      setIsSaving(false);
    },
    [campaignId, field, value, onCampaignUpdated],
  );

  const handleClear = useCallback(async () => {
    if (!value) return;
    await handleDateChange("");
  }, [value, handleDateChange]);

  return (
    <div
      className={cn(
        "group/field flex items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50/40 p-2 px-3 transition-colors",
        "hover:bg-accent/40",
      )}
    >
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] text-muted-foreground font-medium">{label}</span>
      </div>

      <div className="flex items-center gap-1 min-w-0">
        <InlineDateField
          value={value}
          onCommit={handleDateChange}
          disabled={isSaving}
          className={cn(
            "h-6 rounded border border-transparent bg-transparent px-1 text-[11px] text-foreground font-medium",
            "hover:border-slate-200 focus:border-slate-300 focus:outline-none focus:ring-0",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            !value && "text-muted-foreground",
          )}
          aria-label={ariaLabel ?? label}
        />
        {value && (
          <button
            type="button"
            onClick={handleClear}
            disabled={isSaving}
            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-slate-100 hover:text-foreground group-hover/field:opacity-100 disabled:cursor-not-allowed"
            aria-label={`${ariaLabel ?? label} 삭제`}
          >
            <X className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}
