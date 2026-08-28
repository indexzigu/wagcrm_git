/**
 * 「세무 처리」 보드에서 **기계가 찍은 발행 건**을 오너에게 되돌려 보여주기 위한 순수 계층.
 *
 * ## 왜 필요한가 (2026-08-06 교차 확인에서 나온 결함)
 *
 * 보드는 완료된 의무를 행으로 만들지 않는다(`tax-filing-board.ts`의
 * `if (campaign[field]) continue`). 그 규칙은 **완료의 주체가 오너 한 사람일 때** 세운
 * 것이다 — "내가 눌렀으니 사라진 게 맞다". 발행 자동 확정 크론
 * (`api/cron/tax-invoice-issue-confirm`)이 `supplierInvoiceIssuedAt`·
 * `sellerInvoiceIssuedAt`을 찍기 시작하면서 그 전제가 깨졌다: 기계가 찍은 행도 똑같이
 * 사라지므로, 오너는 **확인하지 않은 건을 확인했다고 믿게 된다.**
 *
 * 필요한 데이터는 이미 있다 — 크론이 캠페인마다 `ActivityLog` 1행을 남긴다
 * (`type: "TAX_INVOICE_AUTO_CONFIRM"` · `actor: "SYSTEM"` · `content`에 승인번호·장수·
 * 합계·대조 근거가 사람이 읽는 문장으로). 화면에 없을 뿐이다. 이 파일은 그 로그를
 * 다이얼로그가 그대로 그릴 수 있는 모양으로 접는다.
 *
 * ## ⛔ 사라진 행을 보드에 되살리지 않는다 (설계 판단, P2)
 *
 * 보드의 두 섹션(발행·수취)은 **남은 처리 목록**이다 — 행이 있다는 것은 "아직 안 했다"는
 * 뜻이고, 각 행에는 「완료」·「홈택스 발행」처럼 그 전제 위에서만 성립하는 액션이 붙는다.
 * 자동 확정된 건을 그 표에 되살리면 이미 끝난 의무가 미처리로 읽히고, 「홈택스 발행」이
 * 붙으면 **이미 발행한 계산서를 한 번 더 끊는** 경로가 열린다.
 *
 * 오너가 실제로 내리는 판단은 "이걸 아직 해야 하나"가 아니라 **"기계가 찍은 것을 내가
 * 한 번 봐야 하는가"** 다 — 그건 남은 일 목록이 아니라 **근거가 붙은 별도 묶음**이
 * 답한다. 그래서 발행 섹션 아래에 「자동 확정됨」 묶음을 따로 세운다.
 *
 * ## 접기 규칙 — 그룹 확정 1건이 캠페인 수만큼 뜨지 않게
 *
 * 크론은 그룹을 확정할 때 **멤버 전원**에게 같은 로그를 남긴다(캠페인 상세 타임라인에서
 * 각자 읽을 수 있어야 하므로 — 그쪽이 정본 소비처다). 그 로그를 그대로 나열하면 계산서
 * 1장이 3건으로 보인다. `content`는 op 당 한 번 계산되고 승인번호를 포함하므로
 * `(fieldName, newValue, content)`가 같으면 같은 op 다 — 그 축으로 접는다.
 *
 * ⚠️ 잔여 위험(표시 한정): 승인번호가 비어 있고 필드·작성일자·문장이 완전히 같은 **서로
 * 다른** 두 op 는 한 줄로 합쳐진다. 이 경우 캠페인 라벨은 양쪽 것이 모두 실리므로 사실이
 * 사라지지는 않고 줄 수만 준다. 접기를 없애면 흔한 경우(그룹)가 항상 부풀어 오르므로
 * 드문 경우의 줄 수 손실을 택했다.
 */

/**
 * 크론이 남기는 `ActivityLog.type` 의 **접두사**.
 *
 * ⚠️ **정확히 이 문자열로만 조회하지 말 것.** 크론(PR #304)이 type 을 둘로 가른다:
 * - `TAX_INVOICE_AUTO_CONFIRM` — 금액이 완전히 일치해 확정
 * - `TAX_INVOICE_AUTO_CONFIRM_TOLERATED` — **허용오차(최대 99원)를 흡수**해 확정
 *
 * 「자동 확정 전체」는 이 접두사로 잡는다. 정확 일치로 조회하면 **흡수 확정 건이 화면에서
 * 통째로 사라진다** — 하필 그쪽이 오너가 더 봐야 하는 건이다.
 *
 * ⛔ **흡수 여부를 `content`(한국어 문장) 파싱으로 세지 말 것.** 문구를 다듬는 순간 조용히
 * 0건이 된다(이 트랙이 반복해 밟은 함정). 판정 축은 `type` 하나다.
 */
export const TAX_INVOICE_AUTO_CONFIRM_TYPE_PREFIX = "TAX_INVOICE_AUTO_CONFIRM";

/** 완전 일치 확정. */
export const TAX_INVOICE_AUTO_CONFIRM_TYPE = "TAX_INVOICE_AUTO_CONFIRM";

/** 허용오차를 흡수해 확정 — 오너가 한 번 더 봐야 하는 쪽이다. */
export const TAX_INVOICE_AUTO_CONFIRM_TOLERATED_TYPE = "TAX_INVOICE_AUTO_CONFIRM_TOLERATED";

/**
 * 「자동 확정됨」 seed 조회의 기간 컷(일). `ActivityLog.createdAt` 기준.
 *
 * ⛔ **기간 컷이 없으면 이 카운터는 영구 누적이 된다.** 2026-08-09 축 분리로 seed 조회의
 * 스코프가 「이 달 캠페인」에서 「보드 캠페인 전체(정산 진행 + 정산 완료)」로 바뀌었는데,
 * 그 집합은 **단조 증가**한다(완료 캠페인은 빠지지 않는다). 그러면 「자동 확정됨 N건」이
 * 전 기간 누적치가 되어 매달 커지기만 하고, 배지가 영구히 고정돼 신호가 죽는다 — 설계가
 * `pendingCount` 에서 명시적으로 막았던 실패 형태 그대로다.
 *
 * **왜 90인가:** 같은 다이얼로그의 수취 메일 스캔 기본 창이 90일이다
 * (`RECEIPT_SCAN_PERIODS` 의 `{ days: 90, label: "최근 90일" }`, tax-filing-dialog.tsx).
 * 한 화면에 있는 두 조회 창을 맞춰 두면 오너가 두 숫자를 같은 기준으로 읽는다. 다른 근거로
 * 이 값을 바꾸려거든 그쪽 기본값도 함께 봐야 한다.
 *
 * ⚠️ **2단계(op 키로 멤버 복원) 조회에는 이 컷을 걸지 않는다.** 그쪽 목적은 「한 확정에
 * 걸린 멤버 전원을 복원한다」이므로 좁히면 개수가 조용히 줄어든다 — 이 화면이 막으려는
 * 오해(기계가 건드린 범위) 그 자체다.
 */
export const AUTO_CONFIRM_SEED_LOOKBACK_DAYS = 90;

/** 위 기간 컷을 화면 문구로 쓸 때의 라벨 — 숫자와 문구가 갈리지 않게 한곳에서 만든다. */
export const AUTO_CONFIRM_SEED_LOOKBACK_LABEL = `최근 ${AUTO_CONFIRM_SEED_LOOKBACK_DAYS}일`;

/** 자동 확정이 찍을 수 있는 필드 — 크론의 `op.field`와 같은 집합이다. */
export type AutoConfirmField = "supplierInvoiceIssuedAt" | "sellerInvoiceIssuedAt";

/**
 * 자동 확정 크론이 찍는 두 필드의 사람이 읽는 라벨.
 *
 * 이 크론은 **ISSUE(발행) 의무만** 확정한다(파일 헤더 참조) — `supplierInvoiceIssuedAt`
 * 이 ISSUE 인 채널은 브랜드몰(상대: 공급사)뿐이고, `sellerInvoiceIssuedAt` 이 ISSUE 인
 * 채널은 셀러몰(상대: 셀러)뿐이다(`TAX_INVOICE_OBLIGATION_TABLE`, 2026-08-07 정정).
 * ⛔ 옛 라벨 "공급사/셀러몰 계산서 발행일"은 정정 전 모델(셀러몰의 셀러 발행이
 * `supplierInvoiceIssuedAt` 슬롯에 살던 시절)의 흔적이다 — 정정 후 이 필드가 셀러몰
 * 발행인 경우는 없다(셀러몰 발행은 이제 seller 슬롯이다). 남겨 두면 「자동 확정됨」
 * 묶음과 캠페인 타임라인 문장에 잘못된 방향이 노출된다.
 *
 * `api/cron/tax-invoice-issue-confirm/route.ts` 가 같은 맵을 사본으로 들고 있었다 —
 * 여기서 export 하고 그쪽이 import 한다(route 가 lib 를 import 하는 방향이 자연스럽고,
 * 이 파일이 이미 `api/settlement/tax-filing-board/route.ts` 가 소비하는 정본이다).
 */
export const FIELD_LABEL: Record<AutoConfirmField, string> = {
  supplierInvoiceIssuedAt: "공급사 계산서 발행일",
  sellerInvoiceIssuedAt: "셀러 계산서 발행일",
};

export function isAutoConfirmField(value: string | null): value is AutoConfirmField {
  return value === "supplierInvoiceIssuedAt" || value === "sellerInvoiceIssuedAt";
}

/** 이 폴더가 읽는 `ActivityLog` 행의 최소 계약. */
export interface AutoConfirmLogRow {
  entityId: string;
  /** 접두사가 같은 두 값 중 하나 — 흡수 확정 여부의 **유일한** 판정 축이다. */
  type: string;
  fieldName: string | null;
  newValue: string | null;
  content: string | null;
  createdAt: Date;
}

/** 화면 1줄 = 자동 확정 op 1건(= 계산서 묶음 1건). */
export interface AutoConfirmedEntry {
  /** React key 겸 안정 식별자. */
  key: string;
  sourceField: AutoConfirmField;
  /** 「공급사 계산서 발행일」·「셀러 계산서 발행일」 — 무엇이 찍혔는지. */
  fieldLabel: string;
  /** 기계가 찍은 값(계산서 작성일자, `YYYY-MM-DD`). 로그에 없으면 null. */
  writtenDate: string | null;
  /** 확정 시각(가장 이른 로그 기준) — "언제 기계가 손댔나". */
  confirmedAt: string;
  /** 이 확정에 걸린 캠페인 라벨 전부(그룹이면 멤버 전원). */
  campaignLabels: string[];
  /** 승인번호·장수·합계·대조 근거가 담긴 한 문장 — 크론이 만든 그대로 보여준다. */
  detail: string | null;
  /**
   * 허용오차(최대 99원)를 흡수해 확정된 건. 완전 일치 건보다 **오너가 볼 이유가 크다** —
   * 화면이 이 둘을 뭉개면 「조용한 완화」가 된다(#303 이 `AMOUNT_TOLERATED` 로 표면화한
   * 사실을 화면에서 다시 지우는 셈). 판정은 `type` 하나로만 한다.
   */
  tolerated: boolean;
}

/**
 * `ActivityLog` 행들을 화면 줄로 접는다.
 *
 * `labelByCampaignId`에 없는 캠페인은 **버리지 않는다** — 라벨 대신 자리표시자를 넣어
 * 개수를 보존한다. 개수를 조용히 줄이면 이 화면이 막으려는 오해("기계가 건드린 범위")가
 * 그대로 재발한다.
 *
 * ⚠️ 이 경로는 죽은 코드가 아니다 — 호출부(`api/settlement/tax-filing-board`)가 **두
 * 단계로** 조회하기 때문에 실제로 도달한다: ①이 달 캠페인의 로그로 어떤 확정이 있었나를
 * 찾고 ②그 확정의 로그를 **캠페인 제한 없이** 다시 모은다. 그래서 확정 후 그룹에서
 * 분리돼 다른 달로 옮겨간 멤버의 로그도 들어오고, 그 캠페인은 이 달 라벨 맵에 없다.
 * 1단계만 남기면 그 멤버가 통째로 빠져 "2건에 손댔다"가 "1건"으로 보고된다.
 */
export function buildAutoConfirmedEntries(
  logs: readonly AutoConfirmLogRow[],
  labelByCampaignId: ReadonlyMap<string, string>,
): AutoConfirmedEntry[] {
  const byOp = new Map<
    string,
    { field: AutoConfirmField; row: AutoConfirmLogRow; campaignIds: string[]; earliest: Date }
  >();

  for (const log of logs) {
    if (!isAutoConfirmField(log.fieldName)) continue; // 알 수 없는 필드는 라벨을 지어내지 않는다.
    // type 도 키에 넣는다 — 흡수 확정과 완전 일치 확정은 다른 사실이라 한 줄로 접으면
    // 흡수 여부가 둘 중 하나로 조용히 결정된다.
    const key = `${log.type}|${log.fieldName}|${log.newValue ?? ""}|${log.content ?? ""}`;
    const existing = byOp.get(key);
    if (existing) {
      if (!existing.campaignIds.includes(log.entityId)) existing.campaignIds.push(log.entityId);
      if (log.createdAt < existing.earliest) existing.earliest = log.createdAt;
      continue;
    }
    byOp.set(key, {
      field: log.fieldName,
      row: log,
      campaignIds: [log.entityId],
      earliest: log.createdAt,
    });
  }

  return [...byOp.entries()]
    .map(([key, op]) => ({
      key,
      sourceField: op.field,
      fieldLabel: FIELD_LABEL[op.field],
      writtenDate: op.row.newValue,
      confirmedAt: op.earliest.toISOString(),
      campaignLabels: op.campaignIds.map((id) => labelByCampaignId.get(id) ?? "이 달 목록 밖 캠페인"),
      detail: op.row.content,
      tolerated: op.row.type === TAX_INVOICE_AUTO_CONFIRM_TOLERATED_TYPE,
    }))
    // 최신순 — 오너가 마지막 크론 회차에서 무엇이 찍혔는지부터 본다.
    .sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));
}
