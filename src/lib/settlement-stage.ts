/**
 * 정산 **단계 축**의 공통 판정 SSOT — client-safe 순수 로직(Prisma 무의존).
 *
 * 여기 모인 것은 세 가지다: ①대금 표면이 보는 모집단(상태 집합) ②「늦었다」의 날짜
 * 경계 ③판매가 끝났는데 정산을 시작하지 않은 상태(= 「정산 착수 지연」).
 *
 * ## 왜 모았는가 — T-062 실측 (2026-08-27, 프로덕션)
 *
 * 대금 지연을 보여주는 두 표면(모바일 홈 자금 카드가 여는 대기 목록 ·
 * 데스크톱 대시보드 아젠다)이 **같은 질문에 세 군데서 다른 답**을 갖고 있었다:
 *
 * 1. **상태 집합이 3곳에 손으로 박혀 있었다** — `api/agenda/route.ts` ·
 *    `mobile-settlement-data.ts` · `mobile-settlement-pending-sheet.tsx`. 값이 같았을
 *    뿐 계약이 아니어서, 한 곳만 넓히면 두 화면이 다른 모집단을 보게 된다.
 * 2. **「오늘」의 경계가 달랐다** — 아젠다는 `date <= now`(예정일이 오늘이면 이미 지연),
 *    모바일은 `ymd < today`(어제까지만 지연). 예정일은 전부 UTC 자정(=KST 09:00)으로
 *    저장되므로 아젠다 쪽 식은 **오늘 예정인 건을 아침부터 지연으로** 본다. 실측 당시
 *    해당 건이 0건이라 눈에 띄지 않았을 뿐 구조적 불일치다. 도메인상 맞는 쪽은
 *    "오늘 중에 처리하면 된다"이므로 **KST 날짜 비교**로 통일한다.
 * 3. **조합 캠페인 접기가 달랐다** — 아젠다는 묶음당 1행, 모바일은 딜마다 1행.
 *    실측: 멤버 4건짜리 묶음 2개가 모바일에서 같은 정산을 4줄씩 차지하고 홈 칩의
 *    「입금 대기 N건」도 4로 셌다.
 *
 * ## 「정산 착수 지연」이 왜 별도 판정인가
 *
 * 원래 티켓(T-062)의 발단은 *"예정일을 미리 잡아둔 캠페인이 아직 진행중·마감이면
 * 지연 목록에 안 뜬다"* 였다. 그런데 실측 결과 **정산 단계 밖에는 예정일이 한 건도
 * 없었다**(제안 10 · 세팅대기 14 · 마감 4 = 28건 전부 null. 대조군인 정산 완료
 * 68건 중 31건은 보유). 이력으로도 예정일을 처음 입력한 31개 캠페인 중 **30개가
 * 판매 종료일 이후**(중앙값 종료 +17일)였다 — 예정일을 입력하는 화면이
 * `SettlementSection` 하나뿐이고 그 화면은 정산 페이지에서만 열리기 때문이다.
 *
 * 즉 **상태 필터만 넓히면 추가로 들어오는 건이 0건**이다(실측). 그래서 오너 결정
 * (2026-08-27)은 "예정일 대신 경과일로 잡는다"였다: 판매도 반품기간도 끝났는데
 * 아직 정산 단계로 넘어오지 않았다면 그 자체가 사람이 손봐야 하는 신호다.
 *
 * ⛔ **이 판정을 대금 지연(`buildOverdueSettlementItems`)과 합치지 말 것.** 축이
 * 다르다 — 저쪽은 "돈이 예정일에 안 오갔다"(액션 = 입금 확인·지급 완료)이고 이쪽은
 * "절차를 시작하지 않았다"(액션 = 캠페인을 정산 단계로 넘김)다. 합치면 금액도
 * 대금 칸(`CampaignMoneySlot`)도 없는 줄이 모달을 여는 목록에 섞인다. 노출 자리도
 * 그래서 다르다 — 착수 지연은 「데이터 점검」·「리스크 신호」 카드가 소유한다
 * (오너 확정 2026-08-27, `data-integrity.ts` 의 `SETTLEMENT_NOT_STARTED`).
 */

import { toKstYmd } from "./date-utils";

/**
 * 대금(입금·지급) 표면이 보는 모집단. 두 표면이 **반드시 이 상수를 쓴다** —
 * 값을 손으로 다시 적으면 위 ①번 드리프트가 그대로 되살아난다.
 */
export const SETTLEMENT_STAGE_STATUSES = [
  "SETTLEMENT_WAIT",
  "SETTLEMENT_IN_PROGRESS",
] as const;

export type SettlementStageStatus = (typeof SETTLEMENT_STAGE_STATUSES)[number];

/**
 * 「정산 착수 지연」의 모집단 — 판매가 실제로 돌았지만 아직 정산 단계 이전인 상태.
 *
 * ⛔ **`PROPOSAL`·`PREPARATION` 을 넣지 말 것.** 실측(2026-08-27): 제안 10건이 전부
 * 판매기간을 이미 지났고(경과 중앙값 386일) 그중 하나도 판매가 성사된 적이 없다 —
 * 넣으면 목록이 그 방치 건으로 채워져 신호가 무시당한다("매일 뜨는 빨강"은 이 레포가
 * 여러 번 겪은 실패 모드다). 세팅 대기는 판매 시작 전이라 애초에 착수를 물을 수 없다.
 */
export const PRE_SETTLEMENT_SALE_STATUSES = ["ACTIVE", "CLOSED"] as const;

/**
 * 반품기간 기본 일수. **새 숫자가 아니라 화면이 이미 쓰던 값**이다 —
 * `SettlementWaitPanel`(캠페인 상세 「정산 대기 기준」)의 `종료 +14일 = 정산 진행
 * 시작 가능`이 출처다. ⛔ 별도 임계를 새로 세우지 말 것: 같은 오너 진술이 두 숫자로
 * 갈리면 화면과 알림이 서로 다른 날 발화한다(`DORMANT_DAYS` 선례와 같은 판단).
 */
export const RETURN_PERIOD_DAYS = 14;

/**
 * 「정산금 확인 필요」로 넘어가는 일수 — 같은 패널의 짝 상수다(`종료 +10일`).
 * 착수 지연 판정에는 쓰지 않지만, 두 숫자가 같은 진술에서 나왔으므로 한 곳에 둔다.
 */
export const SETTLEMENT_CHECK_DAYS = 10;

type DateLike = Date | string | null | undefined;

function toDate(value: DateLike): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 「늦었다」의 경계 — **KST 달력 날짜로만 비교한다**(오늘은 아직 안 늦었다).
 *
 * ⛔ `date <= now` 로 되돌리지 말 것. 예정일은 전부 UTC 자정(=KST 09:00)으로
 * 저장되므로 그 식은 오늘 예정인 건을 **오전 9시부터** 지연으로 본다. 두 표면이
 * 정확히 그 차이로 갈려 있었다(위 ②).
 */
export function isOverdueKst(date: DateLike, now: Date): boolean {
  const d = toDate(date);
  if (d == null) return false;
  return toKstYmd(d) < toKstYmd(now);
}

/** 지연 경과일(KST 달력 기준). 지연이 아니면 0. */
export function overdueDaysKst(date: DateLike, now: Date): number {
  const d = toDate(date);
  if (d == null) return 0;
  const due = Date.parse(`${toKstYmd(d)}T00:00:00Z`);
  const today = Date.parse(`${toKstYmd(now)}T00:00:00Z`);
  return Math.max(0, Math.round((today - due) / 86_400_000));
}

/**
 * 정산을 시작해야 하는 날 = 반품기간 종료일. 입력값이 있으면 그것이 정본이고,
 * 없으면 판매 종료 + {@link RETURN_PERIOD_DAYS} 로 떨어진다.
 *
 * ⚠️ 폴백이 필요한 이유는 실데이터다 — 실측(2026-08-27) `returnPeriodEndDate` 는
 * 마감 4건 중 1건, 세팅 대기 14건 중 2건에만 채워져 있다. 폴백 없이 컬럼만 보면
 * 판정 대상이 거의 전부 조용히 빠진다.
 */
export function resolveSettlementStartDueDate(campaign: {
  endDate: DateLike;
  returnPeriodEndDate?: DateLike;
}): Date | null {
  const explicit = toDate(campaign.returnPeriodEndDate);
  if (explicit) return explicit;
  const end = toDate(campaign.endDate);
  if (!end) return null;
  const due = new Date(end);
  due.setUTCDate(due.getUTCDate() + RETURN_PERIOD_DAYS);
  return due;
}

/**
 * 조합 캠페인(CG-1) **접기 규칙 SSOT** — 그룹당 1묶음, 미그룹은 자기 혼자인 묶음.
 * 입력 순서를 보존하므로 호출부가 안정된 정렬(예: id·갱신순)로 넘기면 표시가 흔들리지 않는다.
 *
 * ⛔ 표면마다 `Map<groupId, members>` 를 손으로 다시 쓰지 말 것 — 실측(2026-08-27)에서
 * 데스크톱 아젠다는 접고 모바일 대기 목록은 안 접어, 멤버 4건짜리 묶음 하나가 모바일에서만
 * 4줄·4건으로 세어졌다. 접기는 표시 규칙이 아니라 **"실캠페인이 몇 개인가"** 라는 판정이다.
 */
export function foldByGroup<T extends { groupId?: string | null }>(rows: readonly T[]): T[][] {
  const units: T[][] = [];
  const byGroup = new Map<string, T[]>();
  for (const row of rows) {
    const groupId = row.groupId ?? null;
    if (groupId == null) {
      units.push([row]);
      continue;
    }
    const existing = byGroup.get(groupId);
    if (existing) {
      existing.push(row);
      continue;
    }
    const created = [row];
    byGroup.set(groupId, created);
    units.push(created);
  }
  return units;
}

/**
 * 접힌 묶음의 이름 — 저장된 묶음 이름이 있으면 그것, 없으면 대표 멤버 + 「외 N건」.
 * 두 표면이 같은 문법을 쓰게 하려고 여기 둔다(한쪽만 폴백을 쓰면 같은 행이 다른 이름으로 뜬다).
 */
export function foldedUnitLabel(
  memberNames: readonly string[],
  groupName: string | null | undefined,
): string {
  if (groupName && groupName.trim() !== "") return groupName;
  return memberNames.length > 1
    ? `${memberNames[0]} 외 ${memberNames.length - 1}건`
    : memberNames[0];
}

export type SettlementStartVerdict =
  | { overdue: false }
  | { overdue: true; dueDate: Date; daysOverdue: number };

/**
 * 「판매도 반품기간도 끝났는데 아직 정산 단계로 안 넘어왔다」 판정.
 *
 * 상태가 모집단 밖이거나 기준일을 계산할 수 없으면 **지연이 아니다**(모르는 것을
 * 지연으로 세지 않는다 — 오탐 제로가 이 게이트의 원칙, `data-integrity.ts` 헤더).
 */
export function resolveSettlementStartOverdue(
  campaign: { status: string; endDate: DateLike; returnPeriodEndDate?: DateLike },
  now: Date,
): SettlementStartVerdict {
  if (!(PRE_SETTLEMENT_SALE_STATUSES as readonly string[]).includes(campaign.status)) {
    return { overdue: false };
  }
  const dueDate = resolveSettlementStartDueDate(campaign);
  if (dueDate == null || !isOverdueKst(dueDate, now)) return { overdue: false };
  return { overdue: true, dueDate, daysOverdue: overdueDaysKst(dueDate, now) };
}
