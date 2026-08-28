/**
 * 수취 세금계산서 **메일 스캔 결과**를 세무 처리 보드 행에 잇는 순수 함수.
 *
 * 엔진(`expected-receivables.ts`)은 (오너 확정 2026-08-04, 설계 문서 「✅ 정산 그룹의
 * 계산서 장수 — 확정」절 이후) 정산 그룹을 **가능하면 그룹당 1개의 기대 건**으로 합산해
 * 만든다 — 상대가 그룹 안에서 갈리는 슬롯(공급사 쪽만)만 캠페인별로 후퇴한다. 보드
 * (`tax-filing-board.ts`)는 정산 그룹을 (groupId, 의무) 단위로 접어 **한 행**만 낸다 —
 * 그룹 행의 `campaignIds`엔 멤버 전원의 id 가 들어 있고, `campaignId`는 그중 대표
 * (anchor, id 오름차순 첫 멤버)다. 이 파일이 그 둘을 잇는다.
 *
 * ## 조인 키
 *
 * 보드 행의 `sourceField`(`supplierInvoiceIssuedAt` | `sellerInvoiceIssuedAt`)를 엔진의
 * `slot`(`SUPPLIER_GOODS` | `SELLER_COMMISSION`)으로 바꾼 뒤, `${campaignId}:${slot}`
 * 키로 스캔 결과에서 찾는다. `direction`·`counterpart`로 라벨 조건을 다시 유도하지
 * 않는다 — `sourceField`가 이미 그 판정을 담고 있고(`tax-filing-board.ts` 주석 참조),
 * 여기서 다시 유도하면 세 번째 인코딩이 된다.
 *
 * ISSUE(발행) 행은 이 엔진의 대상이 아니다(엔진은 **수취**만 추적한다,
 * `expected-receivables.ts` 상단 주석) — 그런 행에는 증거를 붙이지 않고 `null`을 낸다.
 *
 * ## ⚠️ 그룹 행 — 엔진이 합쳤는지 캠페인별로 후퇴했는지를 "키의 존재"로 판별한다
 *
 * 엔진이 그룹을 합쳤을 때도, 상대 불일치로 캠페인별로 후퇴했을 때도 **대표(anchor)
 * 자신의 키 문자열은 똑같은 모양**이다(`${anchorId}:${slot}`) — 합쳐졌을 땐 그 키의
 * 값이 그룹 전체 합산액이고, 후퇴했을 땐 anchor 캠페인 한 건만의 값이다. 문자열만으론
 * 구분이 안 되므로, **대표를 제외한 나머지 멤버의 키가 이 스캔의 결과에 실재하는가**로
 * 판별한다 — 후퇴했다면 엔진이 멤버마다 개별 키를 냈을 것이고(매칭됐든 미수취든 흔적이
 * 있다), 합쳤다면 대표 외엔 아무 키도 없다(전원 `no_data`).
 *
 * - 대표 외 키가 하나도 없다(합산됨) → 대표의 키 하나가 그룹 전체를 대표한다. 「전원
 *   `VERIFIED`」 규칙은 대상이 1건(대표)뿐이라 자동으로 충족된다 — 규칙을 지우지 않고
 *   자연히 통과시킨다(스펙 「정산 그룹의 계산서 장수 — 확정」절의 경고 그대로).
 * - 대표 외 키가 하나라도 있다(캠페인별로 후퇴함) → 멤버 전원을 개별 대조한다. **전원
 *   `VERIFIED`일 때만** `verified`를 낸다 — 한 멤버만 우연히 맞아도 "그룹 전체가
 *   확인됐다"고 읽으면 나머지 멤버가 실제로는 확인되지 않았다는 사실이 조용히
 *   사라진다(이 기능이 반복적으로 낸 실패 — 부분 일치가 전체 확인으로 둔갑).
 *
 * `no_data`는 이 스캔의 조회창·대상 캠페인 목록에 애초에 포함되지 않은 경우다(보드와
 * 엔진의 조회 조건이 다르다 — 보드는 `payoutCompletedAt` 월, 엔진은 `endDate` 창) — 이
 * 경우 "미확인"도 "미수취"도 아니라 **이 스캔으로는 알 수 없다**고 정직하게 말한다.
 *
 * ## ⚠️ 알려진 불일치(2026-08-04) — 공급사 불일치로 후퇴한 그룹의 셀러 의무
 *
 * `tax-filing-board.ts`(`emitGroupRows`)는 공급사 상대가 그룹 안에서 갈리면(전 채널
 * `SUPPLIER_MISMATCH` 가드) **그룹 전체**(셀러 의무 포함)를 캠페인별 행으로 되돌린다 —
 * 판정 축이 대상 하나(행 전체)다. 반면 엔진(`expected-receivables.ts`의
 * `buildGroupExpectedReceivables`)은 스펙이 "셀러 상대는 항상 합산 가능하다"고 확정한
 * 대로 **슬롯 단위**로만 후퇴한다 — 공급사가 갈려도 셀러 의무는 여전히 그룹 1건으로
 * 합산한 채로 둔다. 그 결과 이 조합(그룹 소속·공급사 불일치로 보드가 캠페인별로 쪼갠
 * 상태·의무가 셀러 쪽)에서는, 보드의 개별 캠페인 행이 갖는
 * `${그 캠페인 id}:SELLER_COMMISSION` 키가 엔진 쪽엔 "그 캠페인 하나만의" 값이 아니라
 * **그룹 전체의 합산값**으로 대표(anchor) 밑에 존재할 수 있다.
 *
 * ⚠️ **채널 불일치로 후퇴한 경우와 혼동하면 안 된다(2026-08-04 회귀 정정).** 채널이
 * 그룹 안에서 갈리는 경우(`buildGroupExpectedReceivables`의 채널 가드)는 **양쪽 슬롯
 * 다** 캠페인별로 후퇴하므로, 이 경우엔 셀러 키도 각 멤버의 진짜 개별 값이다 — 이걸
 * 위 공급사 불일치 경우와 똑같이 취급해 무조건 `no_data`로 덮으면, 채널 불일치로
 * 정당하게 캠페인별로 나온(그리고 실제로 검증된) 셀러 의무 행의 증거를 전부 숨기게
 * 된다(회귀 실측 — 코드 리뷰에서 재현됨). 두 후퇴 경로 모두 이 조인 계층엔
 * `campaignIds` 1건뿐인 행으로 똑같이 보이므로, 행 하나만 보고는 구분할 수 없다.
 *
 * 그래서 `campaignId`(보드 행이 넘겨준 하나)와 **`groupMembers`**(이 스캔에 등장한
 * 모든 보드 행에서 `groupId`별로 재구성한 "이 그룹에서 실제로 관측된 다른 멤버
 * id" 집합, `reconstructGroupMembers`가 만든다)를 함께 받아, 그 형제들의 셀러 키가
 * 이 스캔 결과에 실재하는지로 재판별한다 — 위 「그룹 행」 절과 **같은 원리**(대표 외
 * 키의 존재 여부)를 여기서도 쓴다:
 *
 * - 형제를 하나도 재구성 못 했다(이 그룹에서 나온 행이 이 하나뿐) → 판별 근거가
 *   없으므로 보수적으로 `no_data`.
 * - 형제가 있는데 **전원 `no_data`** → 이 캠페인이 엔진의 대표이고 나머지는 흔적이
 *   없다는 뜻 — 공급사 불일치로 셀러가 그룹 합산째로 대표 밑에 남은 상태다. 그룹
 *   합산액을 이 캠페인 1건 몫으로 잘못 표시할 위험이 있으므로 `no_data`.
 * - 형제 중 하나라도 흔적이 있다(매칭됐든 미수취든) → 엔진도 이 캠페인의 셀러 키를
 *   개별적으로 냈다는 뜻(채널 불일치 후퇴) — 이 캠페인 자신의 키를 그대로 신뢰한다.
 *
 * `groupMembers`를 넘기지 않으면(호출부가 재구성할 다른 행을 갖고 있지 않을 때) 옛
 * 동작(무조건 `no_data`)으로 안전하게 후퇴한다 — 과소평가(증거를 더 숨김)는 이 조인
 * 계층의 기본 방향과 일치하는 실패이므로 인자를 안 준 경우를 막지 않는다.
 *
 * 반대 방향(공급사 슬롯이 이름 대 사업자번호 판정 기준 차이로 두 모듈이 합산·후퇴를
 * 다르게 결정하는 경우)은 이보다 드물다 — board는 `partnerName` 문자열로, 엔진은
 * `partnerBusinessNumber`로 비교한다(각자의 헤더 주석 참조). 서로 다른 두 거래처가
 * 같은 이름을 쓰거나, 같은 거래처가 오타로 다른 이름이 기록된 경우에만 갈린다. 이
 * 조인 계층은 이 경우를 별도로 방어하지 않는다 — 발생 시 anchor의 공급사 행이
 * 그룹 합산액을 캠페인 1건 몫으로 잘못 표시할 수 있다(잔여 위험, 보고서에 기록).
 */
import type { MismatchReason, ReceiptVerdict } from "./receipt-match";
import type { ReceivableSlot } from "./expected-receivables";
import type { ReceiptSuggestion } from "./receipt-similarity";

/** 세무 처리 보드가 알고 있어야 하는 행의 최소 계약 — `TaxInvoiceBoardRow`의 부분집합. */
export interface BoardRowForEvidence {
  /** 그룹 행이면 대표(anchor, id 오름차순 첫 멤버) id, 아니면 그 캠페인 자신의 id. */
  campaignId: string;
  campaignIds: string[];
  /** 정산 그룹 소속이면 그 id, 아니면 null — 「알려진 불일치」 가드에 쓴다. */
  groupId: string | null;
  sourceField: "supplierInvoiceIssuedAt" | "sellerInvoiceIssuedAt";
  direction: "ISSUE" | "RECEIVE";
}

/** `/api/settlement/tax-invoice-receipts`가 돌려주는 응답 중 이 파일이 읽는 부분만. */
export interface ReceiptScanApiResponse {
  scan: {
    box: string;
    headerScanned: number;
    candidates: number;
    /** 관문에서 걸러 본문을 열지도 않은 통수. 낡은 응답에는 없을 수 있다. */
    skippedByFilter?: number;
    truncated: number;
    sinceDays: number;
  };
  summary: {
    verified: number;
    needsReview: number;
    notOurs: number;
    issuedByUs: number;
    expectedTotal: number;
    unseenExpected: number;
    passwordProtected: number;
    attachmentCensus: Record<string, number>;
    /** 승인·무관 처리로 종결된 건. 낡은 응답에는 없다. */
    decided?: number;
    /** 1클릭 승인 후보가 붙은 건. 낡은 응답에는 없다. */
    suggested?: number;
  };
  results: Array<{
    mail: {
      uid: number;
      subject: string;
      fromAddress: string;
      receivedAt: string;
      hasAttachmentEvidence: boolean;
    };
    verdict: ReceiptVerdict;
    /**
     * 유사도 보조 판정의 1클릭 승인 후보(`receipt-similarity.ts`). 낡은 응답에는 없다.
     * ⚠️ 있어도 판정은 그대로 `NEEDS_REVIEW` 다 — 이 값은 근거이지 확정이 아니다.
     */
    suggestion?: ReceiptSuggestion | null;
    /** 이미 내려진 결정. 있으면 그 건은 「확인 필요」에서 빠진다. 낡은 응답에는 없다. */
    decision?: {
      decision: string;
      matchedKeys: string[];
      amountDelta: number | null;
      decidedAt: string;
    } | null;
  }>;
  unseenExpected: Array<{
    key: string;
    campaignId: string;
    campaignLabel: string;
    channel: string;
    slot: ReceivableSlot;
    counterpartLabel: string;
    /** 상대 사업자번호 미등록 → 대조 키가 없어 영원히 매칭되지 않는다. 낡은 응답엔 없다. */
    counterpartBusinessNumberMissing?: boolean;
    expectedTotalAmount: number | null;
    amountBasis: string;
    trackingField: "supplierInvoiceIssuedAt" | "sellerInvoiceIssuedAt" | null;
    alreadyMarkedAt: string | null;
  }>;
}

/** 캠페인 1건(=엔진의 1 key)의 대조 상태. */
export type CampaignKeyStatus =
  | { kind: "verified"; issueId: string | null; writtenDate: string | null; totalAmount: number | null }
  | { kind: "needs_review"; reasons: MismatchReason[] }
  /** 기대 건인데 이번 스캔에서 대응하는 계산서를 못 봤다 */
  | { kind: "unseen" }
  /**
   * 상대 사업자등록번호가 CRM 에 없어 **대조 자체가 불가능**하다.
   *
   * `unseen` 과 반드시 갈라야 한다 — 둘을 합치면 "확인할 수단이 없다"가 "안 왔다"로
   * 둔갑한다. 처방도 다르다: `unseen` 은 상대에게 발행을 독촉할 일이고, 이쪽은 우리가
   * 거래처·소속사에 사업자등록번호를 등록할 일이다.
   */
  | { kind: "unmatchable" }
  /** 이번 스캔의 대상(엔진의 `expected` 목록)에 애초에 없다 — 조회창이 다르거나 대상 캠페인이 아니다 */
  | { kind: "no_data" };

/** 보드 행 1개(그룹이면 여러 캠페인)의 종합 상태. */
export type RowEvidence =
  | {
      kind: "verified";
      /** 캠페인 1건일 때만, 또는 엔진이 그룹 전체를 1건으로 합산했을 때 채운다 — 그
       *  경우 이 값은 그룹 전체를 대표하는 실제 계산서 1장의 값이다(캠페인별로
       *  후퇴한 경우는 여러 장이라 특정 불가이므로 비운다). */
      detail: { issueId: string | null; writtenDate: string | null; totalAmount: number | null } | null;
      memberCount: number;
    }
  | { kind: "partial"; verifiedCount: number; memberCount: number }
  | { kind: "needs_review"; reasons: string[]; memberCount: number }
  | { kind: "unseen"; memberCount: number }
  | { kind: "unmatchable"; memberCount: number }
  | { kind: "no_data" };

/**
 * 정산 필드 → 엔진 슬롯. **조인 키를 만드는 유일한 자리다** — 화면이
 * `` `${id}:${field === "supplier…" ? "SUPPLIER_GOODS" : …}` `` 를 손으로 조립하면
 * 이 매핑이 두 벌이 되고, 슬롯 이름이 바뀌는 날 한쪽만 따라간다.
 */
export function receivableSlotForField(
  sourceField: "supplierInvoiceIssuedAt" | "sellerInvoiceIssuedAt",
): ReceivableSlot {
  return sourceField === "supplierInvoiceIssuedAt" ? "SUPPLIER_GOODS" : "SELLER_COMMISSION";
}

const resolveSlot = receivableSlotForField;

/**
 * 스캔 응답을 `${campaignId}:${slot}` 키 → 상태 맵으로 편다. 매번 배열을 순회하지 않도록
 * 다이얼로그가 스캔 결과를 받을 때 한 번만 호출해 재사용한다.
 */
export function indexReceiptScan(scan: ReceiptScanApiResponse): Map<string, CampaignKeyStatus> {
  const byKey = new Map<string, CampaignKeyStatus>();

  for (const item of scan.unseenExpected) {
    byKey.set(item.key, item.counterpartBusinessNumberMissing ? { kind: "unmatchable" } : { kind: "unseen" });
  }

  for (const row of scan.results) {
    // 오너가 승인한 건은 승인 대상 key 로 붙인다 — 판정이 특정하지 못한 건(`matchedKey`
    // 가 null 인 모호·미매칭)도 승인으로 귀속이 정해지기 때문이다.
    const approvedKeys =
      row.decision?.decision === "APPROVED" ? row.decision.matchedKeys : [];
    const key = row.verdict.matchedKey;
    if (!key && approvedKeys.length === 0) continue; // ISSUED_BY_US·NOT_OURS·특정 실패는 어느 기대 건에도 붙지 않는다.

    /**
     * ⚠️ **오너 승인은 `VERIFIED` 와 같은 칸에 둔다.**
     *
     * 승인은 자동 판정이 아니라 사람이 근거를 보고 내린 결정이고, 그 순간 수취일시가
     * 실제로 기록된다(`taxInvoiceReceiptDecisionService`). 그런데 `verdict` 는 그대로
     * `NEEDS_REVIEW` 라, 이 분기를 두지 않으면 **계산서 열은 초록인데 근거 오버레이는
     * 「확인 필요 · 금액이 다릅니다」**라고 말한다. 두 표면이 같은 건에 다른 말을 하면
     * 오너는 둘 다 안 믿게 된다(이 레포가 보드·엔진 이중 기준에서 이미 겪은 부류).
     */
    const status: CampaignKeyStatus =
      row.verdict.status === "VERIFIED" || row.decision?.decision === "APPROVED"
        ? {
            kind: "verified",
            issueId: row.verdict.observed.issueId,
            writtenDate: row.verdict.observed.writtenDate,
            totalAmount: row.verdict.observed.totalAmount,
          }
        : { kind: "needs_review", reasons: row.verdict.reasons };

    for (const approvedKey of approvedKeys) {
      const existingApproved = byKey.get(approvedKey);
      if (!existingApproved || existingApproved.kind !== "verified") {
        byKey.set(approvedKey, status);
      }
    }
    if (!key) continue;

    // 같은 키에 메일이 여럿 매칭될 수 있다(중복 발행 의심 등). VERIFIED 가 있으면
    // 그 사실이 더 중요하므로 우선한다 — NEEDS_REVIEW 로 덮어써 확인된 사실을 지우지 않는다.
    const existing = byKey.get(key);
    if (!existing || existing.kind !== "verified") {
      byKey.set(key, status);
    }
  }

  return byKey;
}

function campaignKeyStatus(
  byKey: Map<string, CampaignKeyStatus>,
  campaignId: string,
  slot: ReceivableSlot,
): CampaignKeyStatus {
  return byKey.get(`${campaignId}:${slot}`) ?? { kind: "no_data" };
}

/**
 * 보드가 이미 캠페인별로 쪼갠 행들만 봐도, `groupId`별로 등장한 `campaignIds`를 모으면
 * "이 스캔에 실제로 보인 그 그룹의 멤버 목록"을 재구성할 수 있다 — 쪼개지기 전
 * 원본 그룹 전체 멤버는 아닐 수 있으나(이미 완료돼 행 자체가 안 뜨는 멤버는 빠진다),
 * 「알려진 불일치」 가드가 형제의 실재 여부를 물을 때는 이 정도로 충분하다.
 *
 * 다이얼로그가 렌더링 대상 행 전체(발행 포함, 무관하지 않다 — 같은 groupId 를 공유하는
 * 어떤 슬롯의 행이든 그 캠페인이 그 그룹의 멤버라는 사실은 같다)에 대해 **한 번만**
 * 호출해 재사용한다.
 */
export function reconstructGroupMembers(rows: readonly BoardRowForEvidence[]): Map<string, Set<string>> {
  const byGroup = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.groupId === null) continue;
    const set = byGroup.get(row.groupId) ?? new Set<string>();
    for (const id of row.campaignIds) set.add(id);
    byGroup.set(row.groupId, set);
  }
  return byGroup;
}

function singleStatusToRowEvidence(status: CampaignKeyStatus, memberCount: number): RowEvidence {
  switch (status.kind) {
    case "verified":
      return {
        kind: "verified",
        detail: { issueId: status.issueId, writtenDate: status.writtenDate, totalAmount: status.totalAmount },
        memberCount,
      };
    case "needs_review":
      return { kind: "needs_review", reasons: [...new Set(status.reasons.map((r) => r.message))], memberCount };
    case "unseen":
      return { kind: "unseen", memberCount };
    case "unmatchable":
      return { kind: "unmatchable", memberCount };
    case "no_data":
      return { kind: "no_data" };
  }
}

/** 캠페인별로 후퇴한 그룹(또는 개별 대조가 필요한 경우)의 「전원 VERIFIED」 집계. */
function aggregateStatuses(statuses: CampaignKeyStatus[]): RowEvidence {
  const verified = statuses.filter(
    (s): s is Extract<CampaignKeyStatus, { kind: "verified" }> => s.kind === "verified",
  );
  const needsReview = statuses.filter(
    (s): s is Extract<CampaignKeyStatus, { kind: "needs_review" }> => s.kind === "needs_review",
  );
  const hasUnseen = statuses.some((s) => s.kind === "unseen");
  const hasUnmatchable = statuses.some((s) => s.kind === "unmatchable");
  const allNoData = statuses.every((s) => s.kind === "no_data");

  if (allNoData) return { kind: "no_data" };

  if (verified.length === statuses.length) {
    // 이 분기는 캠페인별 후퇴 경로에서만 호출된다(길이 1은 호출부가 이미
    // `singleStatusToRowEvidence`로 처리) — 실제 계산서가 멤버마다 별도라 특정 값을
    // 대표시킬 수 없으므로 detail 은 항상 비운다.
    return { kind: "verified", detail: null, memberCount: statuses.length };
  }

  if (verified.length > 0) {
    return { kind: "partial", verifiedCount: verified.length, memberCount: statuses.length };
  }

  if (needsReview.length > 0) {
    const reasons = [...new Set(needsReview.flatMap((s) => s.reasons.map((r) => r.message)))];
    return { kind: "needs_review", reasons, memberCount: statuses.length };
  }

  // 「대조 불가」가 하나라도 섞이면 그 행 전체를 미수취로 단정할 수 없다 — 못 본 것이
  // 아니라 볼 수단이 없는 멤버가 있다는 뜻이므로 약한 주장 쪽으로 내린다.
  if (hasUnmatchable) return { kind: "unmatchable", memberCount: statuses.length };

  if (hasUnseen) return { kind: "unseen", memberCount: statuses.length };

  return { kind: "no_data" };
}

/**
 * 보드 행 1개의 종합 증거를 계산한다. ISSUE 행은 `null`(엔진이 다루지 않는다).
 *
 * `groupMembers`는 `reconstructGroupMembers`로 미리 만든, `groupId` → 이 스캔에 등장한
 * 캠페인 id 집합 맵이다(선택) — 「알려진 불일치」 가드가 캠페인별로 쪼개진 셀러 의무
 * 행의 형제를 찾는 데만 쓴다. 안 주면 그 가드는 보수적으로(무조건 `no_data`) 후퇴한다.
 *
 * 판정 순서(위 파일 헤더 주석 참조):
 * 1. 「알려진 불일치」 가드 — `groupId` 있고 `campaignIds` 1건뿐인 **셀러** 의무 행은,
 *    `groupMembers`로 찾은 형제 중 하나라도 이 스캔에 실재하면(채널 불일치 후퇴 —
 *    엔진도 개별 키를 냈다) 그대로 조회하고, 형제가 전원 `no_data`거나 재구성이
 *    안 되면(공급사 불일치 후퇴 — 엔진은 셀러를 여전히 합산해 대표 밑에 뒀다, 또는
 *    판별 근거 없음) 정직하게 `no_data`.
 * 2. `campaignIds` 1건 — 그 키 하나로 바로 판정.
 * 3. `campaignIds` 여러 건 — 대표(anchor=`campaignId`) 외 멤버의 키가 실재하는지로
 *    "엔진이 합쳤는지·캠페인별로 후퇴했는지"를 판별한 뒤, 합쳤으면 대표 키 하나로,
 *    후퇴했으면 전원 개별 대조(「전원 VERIFIED」)로 판정.
 */
export function resolveRowEvidence(
  row: BoardRowForEvidence,
  byKey: Map<string, CampaignKeyStatus>,
  groupMembers?: Map<string, Set<string>>,
): RowEvidence | null {
  if (row.direction !== "RECEIVE") return null;
  if (row.campaignIds.length === 0) return { kind: "no_data" };

  const slot = resolveSlot(row.sourceField);

  if (row.groupId != null && row.campaignIds.length === 1 && row.sourceField === "sellerInvoiceIssuedAt") {
    const siblingIds = [...(groupMembers?.get(row.groupId) ?? [])].filter((id) => id !== row.campaignId);
    const siblingHasTrace = siblingIds.some((id) => campaignKeyStatus(byKey, id, slot).kind !== "no_data");
    if (siblingIds.length === 0 || !siblingHasTrace) {
      return { kind: "no_data" };
    }
    // 형제 중 하나라도 흔적이 있다 — 엔진도 캠페인별로 후퇴했다(채널 불일치 등). 이
    // 캠페인 자신의 키를 신뢰해도 안전하다 — 아래 length===1 분기로 그대로 흘려보낸다.
  }

  if (row.campaignIds.length === 1) {
    return singleStatusToRowEvidence(campaignKeyStatus(byKey, row.campaignIds[0], slot), 1);
  }

  const otherMemberStatuses = row.campaignIds
    .filter((id) => id !== row.campaignId)
    .map((id) => campaignKeyStatus(byKey, id, slot));
  const engineFellBackToPerCampaign = otherMemberStatuses.some((s) => s.kind !== "no_data");

  if (!engineFellBackToPerCampaign) {
    // 대표 외엔 흔적이 없다 — 엔진이 그룹 1건으로 합쳤다. 대표 키 하나가 그룹 전체를
    // 대표하므로 「전원 VERIFIED」는 대상 1건(대표)에 대해 자동으로 충족된다.
    return singleStatusToRowEvidence(campaignKeyStatus(byKey, row.campaignId, slot), row.campaignIds.length);
  }

  // 대표 외에도 키가 있다 — 엔진이 상대 불일치로 캠페인별로 후퇴했다. 멤버 전원을
  // 개별 대조한다(부분 일치를 전체 확인으로 둔갑시키지 않는다).
  const statuses = row.campaignIds.map((id) => campaignKeyStatus(byKey, id, slot));
  return aggregateStatuses(statuses);
}
