import { getPrisma } from "@/lib/prisma";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";
import {
  campaignGroupRepository,
  type CampaignGroupRollupUpdate,
} from "@/repositories/campaignGroupRepository";
import { generateGroupName } from "@/lib/campaign-group-name";
import { monthlySettlementService } from "@/services/monthlySettlementService";
import type { CampaignGroup, Prisma } from "@prisma/client";

/**
 * CG-1 CampaignGroup 서비스 (블루프린트 §3 불변식).
 *
 * 불변식:
 * ① 멤버십 변경은 저장소 `setGroupId(campaignId, groupId|null, tx)` 단일 필드로만 —
 *    dealId/sellerId/campaignName/roundNumber는 절대 쓰지 않는다.
 * ② 멤버 ≥2. 이하로 떨어지면 그룹 자동 해체.
 * ③ 전 멤버 동일 sellerId(위반 시 HETERO_SELLER → 409).
 * ④ advisory lock `pg_advisory_xact_lock(hashtext('campaign-group'), hashtext(sellerId))`로
 *    같은 셀러의 그룹 오퍼레이션을 직렬화(recalculateCampaignRounds와 동일 패턴, tx 필수).
 * ⑤ 그룹 병합 미지원 — 이미 다른 그룹 소속이면 ALREADY_GROUPED(409). 먼저 풀고 다시 묶는다.
 * ⑥ 멤버십 변경마다 startDate/endDate 롤업(min/max) 재계산 + name(D4) 재생성.
 *
 * 차수 재계산(recalculateCampaignRounds)과 직교 — 여기서 dealId/sellerId를 건드리지 않으므로
 * 차수·캠페인명 자동화에 간섭하지 않는다(블루프린트 §5).
 */

export type CampaignGroupErrorCode =
  | "TOO_FEW_MEMBERS"
  | "HETERO_SELLER"
  | "ALREADY_GROUPED"
  | "CAMPAIGN_NOT_FOUND"
  | "GROUP_NOT_FOUND";

const ERROR_STATUS: Record<CampaignGroupErrorCode, number> = {
  TOO_FEW_MEMBERS: 400,
  HETERO_SELLER: 409,
  ALREADY_GROUPED: 409,
  CAMPAIGN_NOT_FOUND: 404,
  GROUP_NOT_FOUND: 404,
};

/** API 라우트에서 HTTP 상태로 매핑할 수 있는 타입드 에러. */
export class CampaignGroupError extends Error {
  readonly code: CampaignGroupErrorCode;
  readonly status: number;

  constructor(code: CampaignGroupErrorCode, message: string) {
    super(message);
    this.name = "CampaignGroupError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

type MemberRow = {
  id: string;
  dealId: string;
  sellerId: string;
  groupId: string | null;
  startDate: Date;
  endDate: Date;
  expectedDepositDate?: Date | null;
  depositReceivedAt?: Date | null;
  isDepositReceived?: boolean;
  expectedPayoutDate?: Date | null;
  payoutCompletedAt?: Date | null;
  isPayoutCompleted?: boolean;
  expectedSupplierPayoutDate?: Date | null;
  supplierPayoutCompletedAt?: Date | null;
  isSupplierPayoutCompleted?: boolean;
  deal: { dealName: string };
  seller: { name: string; alias: string | null };
};

/** 정산 이벤트 블록(입금/지급 각 1블록)의 멤버 → 그룹 승계 결과. */
export type SettlementBlockRollup = {
  expectedDate: Date | null;
  completedAt: Date | null;
  isCompleted: boolean;
};

type SettlementMemberInput = {
  expectedDate: Date | null | undefined;
  completedAt: Date | null | undefined;
  isCompleted: boolean | undefined;
};

/**
 * 멤버 정산 블록 → 그룹 승계값 계산(순수 함수 — 백필 스크립트와 공유).
 *
 * - 예정일 = 멤버 non-null 중 **max(가장 늦은 날)**. 그룹 정산은 D1(그룹당 1회
 *   합산 입금)에 따라 마지막 캠페인 이후 한 번 일어나므로, 이른 날짜를 고르면
 *   지나가는 "허수 예정일"이 된다. endDate 롤업(max)과 같은 방향.
 * - 완료 플래그 = **전 멤버 완료일 때만** true(합산 정산이 부분 완료일 수는 없다).
 *   완료 시각은 그때 멤버 완료시각의 max — 플래그와 시각을 항상 페어로 유지한다.
 */
export function rollupSettlementBlock(members: SettlementMemberInput[]): SettlementBlockRollup {
  let expectedDate: Date | null = null;
  for (const m of members) {
    if (m.expectedDate && (!expectedDate || m.expectedDate.getTime() > expectedDate.getTime())) {
      expectedDate = m.expectedDate;
    }
  }

  const allCompleted = members.length > 0 && members.every((m) => m.isCompleted === true);
  let completedAt: Date | null = null;
  if (allCompleted) {
    for (const m of members) {
      if (m.completedAt && (!completedAt || m.completedAt.getTime() > completedAt.getTime())) {
        completedAt = m.completedAt;
      }
    }
  }

  return { expectedDate, completedAt, isCompleted: allCompleted };
}

/** 같은 셀러의 그룹 오퍼레이션을 직렬화하는 트랜잭션 advisory lock. */
async function acquireGroupLock(tx: Prisma.TransactionClient, sellerId: string): Promise<void> {
  if (isSqliteDatabaseUrl()) return;
  // $executeRaw 사용 — pg_advisory_xact_lock은 void 반환이라 $queryRaw는 역직렬화에 실패한다.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('campaign-group'), hashtext(${sellerId}))`;
}

function uniqueIds(campaignIds: string[]): string[] {
  return [...new Set(campaignIds)];
}

function assertAllFound(found: MemberRow[], requestedIds: string[]): void {
  if (found.length !== requestedIds.length) {
    const foundIds = new Set(found.map((c) => c.id));
    const missing = requestedIds.filter((id) => !foundIds.has(id));
    throw new CampaignGroupError(
      "CAMPAIGN_NOT_FOUND",
      `캠페인을 찾을 수 없습니다: ${missing.join(", ")}`,
    );
  }
}

/** 전 멤버가 같은 셀러인지 검증하고 그 sellerId를 반환한다(위반 시 409). */
function assertSameSeller(campaigns: MemberRow[]): string {
  const sellerId = campaigns[0].sellerId;
  for (const c of campaigns) {
    if (c.sellerId !== sellerId) {
      throw new CampaignGroupError(
        "HETERO_SELLER",
        "그룹 멤버는 모두 같은 셀러여야 합니다.",
      );
    }
  }
  return sellerId;
}

/**
 * 그룹 기간 롤업(포락선) 산식 — `min(멤버 시작) ~ max(멤버 종료)`. 순수 함수.
 *
 * `recomputeGroup`(멤버십 변경)과 `recomputeGroupRollup`(멤버 기간 수정)이 **같은 산식**을
 * 써야 한다. 두 경로가 각자 min/max 를 쓰면 어느 쪽으로 갱신됐느냐에 따라 롤업이 갈린다.
 * 구글 캘린더의 그룹 이벤트(`syncGroupOne`)도 같은 포락선을 멤버에서 직접 계산한다.
 */
export function rollupGroupPeriod(
  members: { startDate: Date; endDate: Date }[],
): { startDate: Date; endDate: Date } {
  const startDate = members.reduce(
    (min, m) => (m.startDate.getTime() < min.getTime() ? m.startDate : min),
    members[0].startDate,
  );
  const endDate = members.reduce(
    (max, m) => (m.endDate.getTime() > max.getTime() ? m.endDate : max),
    members[0].endDate,
  );
  return { startDate, endDate };
}

/**
 * 그룹 롤업(startDate/endDate) + name(D4)을 재계산한다.
 * 멤버 ≤1이면 자동 해체(남은 멤버 언그룹 + 그룹 삭제). 반드시 락 구간 안에서 호출.
 *
 * ⚠️ 정산 블록(입금/지급) 승계는 여기서 하지 않는다 — **그룹 형성 1회**(createGroup)로
 * 한정한다(inheritGroupSettlement). 멤버십 변경(addMembers/removeMembers/renameGroup)
 * 마다 재승계하면, 오너가 그룹 예정일을 명시적으로 지운(→null) 블록을 "미설정(virgin)"
 * 으로 오판해 멤버 잔존값(그룹핑 시점에 얼어붙은 stale 스칼라)을 되살린다. read 시점엔
 * "미설정"과 "명시적 삭제"가 구분 불가하므로, 승계는 그룹이 확실히 virgin인 형성
 * 순간에만 수행한다.
 */
async function recomputeGroup(
  groupId: string,
  tx: Prisma.TransactionClient,
): Promise<{ dissolved: boolean; group: CampaignGroup | null }> {
  const members = (await campaignGroupRepository.listMembers(groupId, tx)) as MemberRow[];

  if (members.length <= 1) {
    for (const m of members) {
      await campaignGroupRepository.setGroupId(m.id, null, tx);
    }
    await campaignGroupRepository.delete(groupId, tx);
    return { dissolved: true, group: null };
  }

  const { startDate, endDate } = rollupGroupPeriod(members);

  // 대표 딜 = 시작일이 가장 이른 멤버(listMembers는 startDate asc 정렬).
  const representative = members[0];
  const sellerLabel = representative.seller.alias || representative.seller.name;
  const name = generateGroupName(representative.deal.dealName, sellerLabel, members.length);

  const group = await campaignGroupRepository.update(groupId, { startDate, endDate, name }, tx);
  return { dissolved: false, group };
}

/**
 * 멤버 **기간 수정** 후 그룹 롤업(startDate/endDate)만 다시 맞춘다.
 *
 * **왜 필요한가(실사고 2026-08-01):** 그룹 행의 `startDate`/`endDate` 는 독립 값이 아니라
 * 멤버 포락선의 **비정규화 복사본**인데, 이를 갱신하는 유일한 주체가 `recomputeGroup`
 * (멤버십 변경 전용)이었다. 그래서 판매관리에서 **멤버 기간을 고치면 복사본이 낡은 채로
 * 남았다** — prod 실측 20그룹 중 2건이 어긋나 있었고(종료 최대 11일 차), 그 값을
 * 홈 「다가올 14일 일정」(`desktop-dashboard.ts`, 그룹 값 **우선**·멤버는 폴백)과
 * 그룹 합류 후보 검색(`campaignGroupRepository.findSuggestions`, 롤업 겹침으로 조회)이
 * 읽는다. 후자는 롤업이 짧으면 **합쳐야 할 캠페인에 제안이 아예 안 뜨는** 침묵형 실패다.
 *
 * ⛔ **`recomputeGroup` 을 대신 부르지 말 것.** 그쪽은 ①멤버 ≤1 이면 **그룹을 해체**하고
 * ②그룹 **이름을 자동 재생성**한다(수동 이름도 덮는다). 기간 수정이라는 입력이 해체·개명
 * 까지 일으키면 안 된다 — 캐시 갱신은 원인이 된 입력만큼만 결과를 건드린다.
 * 그래서 이 함수는 **기간 2컬럼만** 쓰고, 멤버가 없으면 아무것도 하지 않는다.
 *
 * ℹ️ **자동 이름은 의도적으로 갱신하지 않는다(스코프 경계, 교차검증 지적 반영).** 자동 이름은
 * *대표 딜 = 시작일이 가장 이른 멤버*에서 나오므로, 기간 수정으로 대표가 바뀌면 이름이
 * 낡을 수 있다. 그래도 재생성하지 않는 이유: 이 레포에는 **수동 이름과 자동 이름을 구분하는
 * 플래그가 없어서**(`renameGroup` 이 같은 컬럼에 쓴다) 여기서 재생성하면 **날짜 한 번 고쳤다고
 * 오너가 손으로 지은 이름이 사라진다.** 낡은 라벨은 사람이 읽는 표시일 뿐이라 오독을 만들지
 * 않지만 수동 이름 소실은 되돌릴 수 없다 — 비대칭이 크므로 보수적으로 둔다. 이름은 다음
 * 멤버십 변경 때 `recomputeGroup` 이 정리한다. 이 선택은 계약 테스트가 고정한다.
 *
 * 호출자의 트랜잭션 안에서 실행한다(tx 필수). 셀러 단위 advisory 락을 잡아 동시
 * 멤버십 변경과 직렬화한다 — `pg_advisory_xact_lock` 은 같은 트랜잭션 안에서 재진입
 * 가능하므로 이미 락을 쥔 경로에서 불러도 안전하다.
 *
 * @returns 갱신했으면 그룹, 그룹이 없거나 멤버가 0이면 null.
 */
export async function recomputeGroupRollup(
  groupId: string,
  tx: Prisma.TransactionClient,
): Promise<CampaignGroup | null> {
  const group = await tx.campaignGroup.findUnique({
    where: { id: groupId },
    select: { id: true, sellerId: true },
  });
  if (!group) return null;

  await acquireGroupLock(tx, group.sellerId);

  const members = (await campaignGroupRepository.listMembers(groupId, tx)) as MemberRow[];
  if (members.length === 0) return null;

  const { startDate, endDate } = rollupGroupPeriod(members);
  return campaignGroupRepository.update(groupId, { startDate, endDate }, tx);
}

/**
 * 그룹 멤버 **일정 팬아웃** — 한 멤버의 일정 수정을 같은 그룹의 나머지 멤버에 그대로 복사한다.
 *
 * **왜 그룹 스칼라(SoT)가 아니라 팬아웃인가 (설계 확정 2026-08-04):** 정산/회계 일정 9종은
 * `CampaignGroup` 행이 SoT이고 읽을 때 `toCampaignRow` 가 멤버 값을 덮어쓴다. 그런데
 * **기간과 반품기간에는 같은 방식을 쓸 수 없다** — 이 둘은 `toCampaignRow` 를 거치지 않고
 * **멤버 컬럼을 Prisma `where` 로 직접** 읽는 소비처가 있기 때문이다:
 *
 * - `dashboard-data.ts` · `cached-crm-data.ts` — `where: { returnPeriodEndDate: { lt: now } }`
 *   ("반품기간 지난 정산대기" 카운터)
 * - `desktop-dashboard.ts` — `select: { returnPeriodEndDate: true }`
 * - 기간은 소비처가 훨씬 넓다(차수 계산·주문 조회 창·월 배분·구글 캘린더).
 *
 * 그룹 SoT로 옮기면 멤버 컬럼이 null 로 남아 **이 카운터들이 소리 없이 0으로 떨어진다** —
 * `docs/agents/codebase-map.md` 가 기록한 #196 함정("그룹 날짜만 있고 멤버 날짜가 null 인
 * 건을 프리필터가 통째로 누락")과 같은 부류다. 팬아웃은 **읽기 경로를 하나도 바꾸지 않고**
 * 모든 소비처를 정합하게 만든다.
 *
 * ⛔ 이 함수를 그룹 SoT + 읽기 오버레이로 "정리"하지 말 것. 위 세 소비처가 함께 죽는다.
 * 계약 테스트 `group-schedule-fanout.contract.test.ts` 가 소스 스캔으로 고정한다.
 *
 * 호출자의 트랜잭션 안에서 실행한다(tx 필수). `recomputeGroupRollup` **보다 먼저** 불러야
 * 롤업 포락선이 팬아웃된 값을 반영한다. 셀러 단위 advisory 락은 재진입 가능하다.
 *
 * @returns 실제로 갱신된 **형제 멤버 수**(원본 제외). 갱신할 필드가 없으면 0.
 */
export async function fanOutMemberSchedule(
  groupId: string,
  originMemberId: string,
  data: {
    startDate?: Date;
    endDate?: Date;
    returnPeriodEndDate?: Date | null;
  },
  tx: Prisma.TransactionClient,
): Promise<number> {
  const updates: Prisma.SalesCampaignUpdateManyMutationInput = {};
  if (data.startDate !== undefined) updates.startDate = data.startDate;
  if (data.endDate !== undefined) updates.endDate = data.endDate;
  if (data.returnPeriodEndDate !== undefined) {
    updates.returnPeriodEndDate = data.returnPeriodEndDate;
  }
  if (Object.keys(updates).length === 0) return 0;

  const group = await tx.campaignGroup.findUnique({
    where: { id: groupId },
    select: { id: true, sellerId: true },
  });
  if (!group) return 0;

  await acquireGroupLock(tx, group.sellerId);

  const { count } = await tx.salesCampaign.updateMany({
    where: { groupId, id: { not: originMemberId } },
    data: updates,
  });
  return count;
}

/** 전파되지 않는 상태 — 드랍은 멤버 단위다(조합에서 셀러 한 명을 빼는 행위가 조합을 죽이면 안 된다). */
export const GROUP_STATUS_NON_PROPAGATING = "DROPPED" as const;

/**
 * 그룹 상태 변경을 **따라가지 않는 형제** 상태 — 모든 경로 공통이라 이 SSOT 안에서만 거른다.
 * - DROPPED: 형제가 드랍 멤버를 되살리거나 전진시키지 않는다.
 * - PROPOSAL: 아직 제안 단계인 멤버는 그룹의 진행을 따라가지 않는다(오너 확정 2026-10-05).
 *   원본이 PROPOSAL 이어도 그 변경은 PROPOSAL·DROPPED 가 아닌 형제에게 전파된다.
 */
export const GROUP_STATUS_NON_FOLLOWING_SIBLINGS: readonly string[] = [
  GROUP_STATUS_NON_PROPAGATING,
  "PROPOSAL",
];

/**
 * 형제 선별에 쓰이는 멤버 행 조각. 일정 자동전이는 형제 **자신의** 기간으로 다시 판정하므로
 * 기간도 싣는다(그룹 멤버의 기간은 묶기·합류 시 정렬되지 않아 서로 다를 수 있다).
 */
export type GroupStatusSibling = {
  id: string;
  status: string;
  salesChannel: string;
  startDate: Date;
  endDate: Date;
};

/**
 * 그룹 상태 변경 전 **그룹 락을 먼저** 잡는다 — 원본 멤버 행을 쓰기 **전에** 호출한다.
 *
 * 🪤 락 순서가 계약이다(교차 리뷰 지적 2026-10-05). `fanOutMemberSchedule`·
 * `recomputeGroupRollup` 은 「락 → 멤버 행 쓰기」 순인데, 상태 경로가 「원본 행 쓰기 → 락」
 * 이면 두 트랜잭션이 서로의 자원을 기다려 Postgres 40P01(교착)이 난다. 그래서 상태 경로 4곳
 * (캠페인 PATCH · 정산 플래그 쓰기 · 일정 자동전이 · 정산 체크리스트)이 원본 쓰기 전에
 * 이 함수를 부른다. 락은 `pg_advisory_xact_lock`(트랜잭션 범위)이라 **같은 tx 안에서 재진입**
 * 된다 — 뒤이은 `propagateGroupStatus` 의 재획득은 즉시 통과한다.
 *
 * @returns 그룹이 존재해 락을 잡았으면 true.
 */
export async function lockCampaignGroup(
  tx: Prisma.TransactionClient,
  groupId: string,
): Promise<boolean> {
  const group = await tx.campaignGroup.findUnique({
    where: { id: groupId },
    select: { id: true, sellerId: true },
  });
  if (!group) return false;
  await acquireGroupLock(tx, group.sellerId);
  return true;
}

/**
 * 형제 상태 변경을 **원본 경로와 같은 모양으로** 기록하는 방법 — 경로마다 쓰는 이력 테이블이
 * 다르다(캠페인 PATCH·일정 자동전이 = `CampaignActivity`, 정산 토글 = `ActivityLog` CHANGE).
 * 두 종류 모두 `details`/`content` 에 「그룹 연동」 표식과 원본 캠페인 id 를 남긴다.
 */
export type GroupStatusPropagationLog =
  | { kind: "campaign-activity"; action: string; label: string }
  | { kind: "activity-change" };

export type GroupStatusPropagationInput = {
  /** 상태가 바뀐(바뀌는) 멤버 — 이 행은 호출자가 이미 썼다(또는 같은 tx 에서 쓴다). */
  originCampaignId: string;
  /** 원본의 소속 그룹. null/undefined 면 무그룹 — 즉시 no-op. */
  groupId: string | null | undefined;
  /** 원본의 변경 **이전** 상태(드랍 복귀 판정에 쓴다). */
  originPreviousStatus: string;
  /** 형제가 따라갈 상태. */
  status: string;
  /** 이력의 actor — 원본 변경과 같은 주체. */
  actor: string;
  log: GroupStatusPropagationLog;
  /**
   * 경로별 형제 선별(생략 시 DROPPED 가 아닌 전원). 자동 경로가 「그 경로가 스스로 옮길 수
   * 있는 상태」로 좁히는 데 쓴다 — 정산 자동전이는 `computeAutoStatus(형제.status)` 가 같은
   * 답을 내는 형제만, 일정 자동전이는 PREPARATION/ACTIVE 형제만.
   */
  isSiblingEligible?: (sibling: GroupStatusSibling) => boolean;
};

export type PropagatedGroupStatusSibling = { id: string; previousStatus: string };

/** 형제 이력에 남기는 「그룹 연동」 표식 — 두 이력 테이블이 같은 문구를 쓴다. */
export function describeGroupStatusPropagation(
  originCampaignId: string,
  previousStatus: string,
  status: string,
): string {
  return `그룹 연동 · ${previousStatus} → ${status} (원본 캠페인 ${originCampaignId})`;
}

/**
 * 그룹 **상태 통합 연동** SSOT — 한 멤버의 `status` 변경을 같은 그룹의 형제 멤버에 복사한다
 * (오너 확정 2026-10-05: 조합 캠페인의 상태 변경은 그룹 전체에 적용된다).
 *
 * 규칙(이 함수가 전부 소유한다 — 호출부가 다시 쓰지 말 것):
 * ① 무그룹이면 no-op.
 * ② **DROPPED 로의 변경은 전파하지 않는다** — 드랍은 멤버 단위다.
 * ③ **DROPPED·PROPOSAL 인 형제는 건드리지 않는다**(`GROUP_STATUS_NON_FOLLOWING_SIBLINGS`) —
 *    형제가 드랍 멤버를 되살리거나 전진시키지 않고, 제안 단계 멤버는 그룹을 따라가지 않는다.
 * ④ 원본이 DROPPED **에서** 복귀하는 변경도 전파하지 않는다 — ②의 대칭(복귀도 멤버 단위).
 *    ⚠️ 이 조항은 위임 지시에 명시되지 않은 보수적 선택이다 — 복귀 한 번이 완료된 형제
 *    전원을 되돌리는 쪽이 비대칭적으로 크므로 막아 둔다. 뒤집으려면 이 한 줄만 지운다.
 * ⑤ 이미 `status` 인 형제는 쓰지도 기록하지도 않는다(멱등).
 * ⑥ 재귀하지 않는다 — 형제 행은 `updateMany` 한 번으로 쓰고 이 함수를 다시 부르지 않는다.
 * ⑦ 원본이 사전 조회 이후 그룹을 떠났으면(멤버 목록에 없음) 아무것도 쓰지 않는다 — 남의
 *    그룹을 바꾸지 않는다(`writeSettlementFlags` 의 멤버십 계약과 같은 축).
 *
 * 호출자의 트랜잭션 안에서 실행한다(tx 필수) — 원본 쓰기와 같은 tx 라야 「원본만 바뀌고
 * 형제는 안 바뀐」 커밋이 없다. ⛔ 호출부는 **원본 행을 쓰기 전에** `lockCampaignGroup` 을
 * 부른다(락 순서 — 그 함수 주석). 여기서의 재획득은 재진입이다.
 *
 * 부수효과(체크리스트 생성·캘린더·캐시)는 여기서 하지 않는다 — 호출부가 반환된 형제 id 로
 * 원본과 **같은** 후처리를 돌린다(원본이 받는 것을 형제도 받는다는 규칙).
 * 계약은 `campaignGroupStatusPropagation.test.ts` · `campaign-status-group-propagation.contract.test.ts`.
 *
 * @returns 실제로 갱신된 형제(원본 제외)와 각자의 이전 상태.
 */
export async function propagateGroupStatus(
  tx: Prisma.TransactionClient,
  input: GroupStatusPropagationInput,
): Promise<PropagatedGroupStatusSibling[]> {
  const { originCampaignId, groupId, originPreviousStatus, status, actor, log } = input;
  if (!groupId) return [];
  if (status === GROUP_STATUS_NON_PROPAGATING) return [];
  if (originPreviousStatus === GROUP_STATUS_NON_PROPAGATING) return [];

  // 호출부가 원본 쓰기 전에 이미 잡았다(`lockCampaignGroup`) — 재진입이라 즉시 통과하며,
  // 직접 부르는 새 호출부를 위한 안전망이다.
  if (!(await lockCampaignGroup(tx, groupId))) return [];

  const members = await tx.salesCampaign.findMany({
    where: { groupId },
    select: { id: true, status: true, salesChannel: true, startDate: true, endDate: true },
  });
  if (!members.some((m) => m.id === originCampaignId)) return [];

  const targets = members.filter(
    (m) =>
      m.id !== originCampaignId &&
      !GROUP_STATUS_NON_FOLLOWING_SIBLINGS.includes(m.status) &&
      m.status !== status &&
      (input.isSiblingEligible ? input.isSiblingEligible(m) : true),
  );
  if (targets.length === 0) return [];
  // 월별 정산 완료 게이트(T-240) — 원본이 통과했어도 형제는 자기 월 줄로 따로 판정한다
  // (조합 캠페인의 월 줄은 멤버 단위다). 막힌 형제는 따라가지 않고 제자리에 둔다.
  const blockedIds =
    status === "COMPLETED"
      ? await monthlySettlementService.findCompletionBlockers(tx, targets.map((t) => t.id))
      : new Map<string, string>();
  const followers = targets.filter((t) => !blockedIds.has(t.id));
  if (followers.length === 0) return [];

  await tx.salesCampaign.updateMany({
    where: {
      id: { in: followers.map((t) => t.id) },
      groupId,
      status: { notIn: [...GROUP_STATUS_NON_FOLLOWING_SIBLINGS, status] },
    },
    data: { status },
  });

  if (log.kind === "campaign-activity") {
    await tx.campaignActivity.createMany({
      data: followers.map((t) => ({
        campaignId: t.id,
        action: log.action,
        label: log.label,
        details: describeGroupStatusPropagation(originCampaignId, t.status, status),
        actor,
      })),
    });
  } else {
    await tx.activityLog.createMany({
      data: followers.map((t) => ({
        entityType: "CAMPAIGN",
        entityId: t.id,
        type: "CHANGE",
        fieldName: "status",
        previousValue: t.status,
        newValue: status,
        content: describeGroupStatusPropagation(originCampaignId, t.status, status),
        actor,
      })),
    });
  }

  return followers.map((t) => ({ id: t.id, previousStatus: t.status }));
}

/**
 * 그룹 형성 시 멤버의 정산 블록(입금/지급)을 그룹으로 1회 승계한다.
 * **오직 createGroup에서만** 호출 — 그룹이 방금 생성돼 확실히 virgin일 때.
 * 블록에 이미 신호가 있으면(방어적 재검) 건너뛴다. 백필 스크립트도 이 규칙을
 * 그대로 재현한다(정본 이중구현 방지 — rollupSettlementBlock 공유).
 * @returns 승계가 있었으면 갱신된 그룹, 없으면 null.
 */
async function inheritGroupSettlement(
  groupId: string,
  tx: Prisma.TransactionClient,
): Promise<CampaignGroup | null> {
  const members = (await campaignGroupRepository.listMembers(groupId, tx)) as MemberRow[];
  const current = await tx.campaignGroup.findUnique({
    where: { id: groupId },
    select: {
      expectedDepositDate: true,
      depositReceivedAt: true,
      isDepositReceived: true,
      expectedPayoutDate: true,
      payoutCompletedAt: true,
      isPayoutCompleted: true,
      expectedSupplierPayoutDate: true,
      supplierPayoutCompletedAt: true,
      isSupplierPayoutCompleted: true,
    },
  });
  if (!current) return null;

  const inheritance: Partial<CampaignGroupRollupUpdate> = {};

  const depositVirgin =
    current.expectedDepositDate == null &&
    current.depositReceivedAt == null &&
    !current.isDepositReceived;
  if (depositVirgin) {
    const deposit = rollupSettlementBlock(
      members.map((m) => ({
        expectedDate: m.expectedDepositDate,
        completedAt: m.depositReceivedAt,
        isCompleted: m.isDepositReceived,
      })),
    );
    if (deposit.expectedDate || deposit.isCompleted) {
      inheritance.expectedDepositDate = deposit.expectedDate;
      inheritance.depositReceivedAt = deposit.completedAt;
      inheritance.isDepositReceived = deposit.isCompleted;
    }
  }

  const payoutVirgin =
    current.expectedPayoutDate == null &&
    current.payoutCompletedAt == null &&
    !current.isPayoutCompleted;
  if (payoutVirgin) {
    const payout = rollupSettlementBlock(
      members.map((m) => ({
        expectedDate: m.expectedPayoutDate,
        completedAt: m.payoutCompletedAt,
        isCompleted: m.isPayoutCompleted,
      })),
    );
    if (payout.expectedDate || payout.isCompleted) {
      inheritance.expectedPayoutDate = payout.expectedDate;
      inheritance.payoutCompletedAt = payout.completedAt;
      inheritance.isPayoutCompleted = payout.isCompleted;
    }
  }

  // 자사몰 공급사 지급 레그 — 입금/지급 블록과 같은 virgin 1회 승계 규칙.
  const supplierPayoutVirgin =
    current.expectedSupplierPayoutDate == null &&
    current.supplierPayoutCompletedAt == null &&
    !current.isSupplierPayoutCompleted;
  if (supplierPayoutVirgin) {
    const supplierPayout = rollupSettlementBlock(
      members.map((m) => ({
        expectedDate: m.expectedSupplierPayoutDate,
        completedAt: m.supplierPayoutCompletedAt,
        isCompleted: m.isSupplierPayoutCompleted,
      })),
    );
    if (supplierPayout.expectedDate || supplierPayout.isCompleted) {
      inheritance.expectedSupplierPayoutDate = supplierPayout.expectedDate;
      inheritance.supplierPayoutCompletedAt = supplierPayout.completedAt;
      inheritance.isSupplierPayoutCompleted = supplierPayout.isCompleted;
    }
  }

  if (Object.keys(inheritance).length === 0) return null;
  return campaignGroupRepository.update(groupId, inheritance, tx);
}

export const campaignGroupService = {
  /**
   * 기존 캠페인들을 새 그룹으로 묶는다(경로 ⓐ/ⓒ 공용 정본).
   * @param tx 상위 트랜잭션(bulk-combo 등 합성). 없으면 자체 트랜잭션.
   */
  async createGroup(campaignIds: string[], tx?: Prisma.TransactionClient): Promise<CampaignGroup> {
    const ids = uniqueIds(campaignIds);
    if (ids.length < 2) {
      throw new CampaignGroupError("TOO_FEW_MEMBERS", "그룹은 최소 2개 캠페인이 필요합니다.");
    }

    const run = async (txn: Prisma.TransactionClient): Promise<CampaignGroup> => {
      // 락 키(sellerId)를 얻기 위한 선행 조회.
      const pre = (await campaignGroupRepository.findCampaignsByIds(ids, txn)) as MemberRow[];
      assertAllFound(pre, ids);
      const sellerId = assertSameSeller(pre);

      await acquireGroupLock(txn, sellerId);

      // 락 획득 후 재조회 — 동시 그룹핑으로 소속이 바뀌지 않았는지 확정.
      const campaigns = (await campaignGroupRepository.findCampaignsByIds(ids, txn)) as MemberRow[];
      assertAllFound(campaigns, ids);
      assertSameSeller(campaigns);
      for (const c of campaigns) {
        if (c.groupId) {
          throw new CampaignGroupError(
            "ALREADY_GROUPED",
            `캠페인 ${c.id}은(는) 이미 다른 그룹에 속해 있습니다(병합 미지원).`,
          );
        }
      }

      const created = await campaignGroupRepository.create({ sellerId }, txn);
      for (const c of campaigns) {
        await campaignGroupRepository.setGroupId(c.id, created.id, txn);
      }

      const { group } = await recomputeGroup(created.id, txn);
      // 정산 예정일/완료 블록을 멤버 → 그룹으로 형성 시 1회 승계(virgin 그룹).
      const inherited = await inheritGroupSettlement(created.id, txn);
      // 멤버 ≥2가 보장되므로 group은 non-null. 승계가 있었으면 그 결과를 우선.
      return (inherited ?? group) as CampaignGroup;
    };

    return tx ? run(tx) : getPrisma().$transaction(run);
  },

  /**
   * 그룹 이름 변경(PATCH { name }). trim 후 비어 있으면(빈 문자열/null) 자동 이름으로
   * 복귀 — 멤버 기반 재생성(recomputeGroup). 자동 이름 규칙은 서비스 단일 소유.
   */
  async renameGroup(groupId: string, name: string | null): Promise<CampaignGroup> {
    return getPrisma().$transaction(async (txn) => {
      const group = await txn.campaignGroup.findUnique({
        where: { id: groupId },
        select: { id: true, sellerId: true },
      });
      if (!group) {
        throw new CampaignGroupError("GROUP_NOT_FOUND", `그룹을 찾을 수 없습니다: ${groupId}`);
      }

      await acquireGroupLock(txn, group.sellerId);

      const trimmed = name?.trim();
      if (trimmed) {
        return campaignGroupRepository.update(groupId, { name: trimmed }, txn);
      }

      // 빈 이름 → 자동 이름 복귀(멤버·롤업 기반 재생성). 그룹은 ≥2 유지되므로 해체되지 않는다.
      const { group: updated } = await recomputeGroup(groupId, txn);
      return updated as CampaignGroup;
    });
  },

  /** 기존 그룹에 캠페인 추가(경로 ⓑ). 이미 다른 그룹 소속이면 거부(병합 미지원). */
  async addMembers(groupId: string, campaignIds: string[]): Promise<CampaignGroup> {
    return getPrisma().$transaction(async (txn) => {
      const group = await txn.campaignGroup.findUnique({
        where: { id: groupId },
        select: { id: true, sellerId: true },
      });
      if (!group) {
        throw new CampaignGroupError("GROUP_NOT_FOUND", `그룹을 찾을 수 없습니다: ${groupId}`);
      }

      await acquireGroupLock(txn, group.sellerId);

      const ids = uniqueIds(campaignIds);
      const campaigns = (await campaignGroupRepository.findCampaignsByIds(ids, txn)) as MemberRow[];
      assertAllFound(campaigns, ids);

      for (const c of campaigns) {
        if (c.sellerId !== group.sellerId) {
          throw new CampaignGroupError(
            "HETERO_SELLER",
            "그룹 멤버는 모두 같은 셀러여야 합니다.",
          );
        }
        if (c.groupId && c.groupId !== groupId) {
          throw new CampaignGroupError(
            "ALREADY_GROUPED",
            `캠페인 ${c.id}은(는) 이미 다른 그룹에 속해 있습니다(병합 미지원).`,
          );
        }
      }

      for (const c of campaigns) {
        if (c.groupId !== groupId) {
          await campaignGroupRepository.setGroupId(c.id, groupId, txn);
        }
      }

      const { group: updated } = await recomputeGroup(groupId, txn);
      // addMembers는 기존 그룹(≥2 유지)에 추가하므로 해체되지 않는다.
      return updated as CampaignGroup;
    });
  },

  /**
   * 그룹에서 캠페인 제거. 남은 멤버가 ≤1이면 그룹 자동 해체.
   * @returns dissolved=true면 그룹이 삭제됨(group=null).
   *
   * ⚠️ **캘린더 정리는 이 함수가 하지 않는다** — 호출부(라우트)의 `after()` 훅 소관이다.
   * 자세한 계약은 아래 `dissolveGroup` 주석 참조. 스크립트에서 직접 부르면 고아가 생긴다.
   */
  async removeMembers(
    groupId: string,
    campaignIds: string[],
  ): Promise<{ dissolved: boolean; group: CampaignGroup | null }> {
    return getPrisma().$transaction(async (txn) => {
      const group = await txn.campaignGroup.findUnique({
        where: { id: groupId },
        select: { id: true, sellerId: true },
      });
      if (!group) {
        throw new CampaignGroupError("GROUP_NOT_FOUND", `그룹을 찾을 수 없습니다: ${groupId}`);
      }

      await acquireGroupLock(txn, group.sellerId);

      const removeSet = new Set(uniqueIds(campaignIds));
      const members = (await campaignGroupRepository.listMembers(groupId, txn)) as MemberRow[];
      for (const m of members) {
        if (removeSet.has(m.id)) {
          await campaignGroupRepository.setGroupId(m.id, null, txn);
        }
      }

      return recomputeGroup(groupId, txn);
    });
  },

  /**
   * 그룹 전체 해체 — 모든 멤버 언그룹 후 그룹 삭제.
   *
   * ⛔ **이 함수만 부르면 구글 캘린더에 고아 이벤트가 남는다 — 실제로 발생했다(2026-07-30).**
   * 그룹 멤버는 합류 시 개별 이벤트가 삭제되므로(`syncGroupOne`), 해체 시엔 ①그룹 장부의
   * 이벤트 삭제 ②멤버 개별 이벤트 재생성이 **둘 다** 필요하다. 그 정리는 외부 IO라
   * DB 트랜잭션 밖 `after()` 훅에 있다 —
   * `DELETE /api/campaign-groups/[id]` 의 `scheduleDissolvedCalendarCleanup`.
   * **삭제되면 장부를 못 읽으므로 해체 전에 `calendarEventIds`·멤버 id 를 확보해야 한다.**
   *
   * 따라서 스크립트·배치에서 해체할 때는 라우트를 호출하거나, 그 훅과 같은 순서를
   * 직접 재현할 것(`deleteCampaignCalendarEvents(장부)` → 멤버별 `syncCampaignToCalendar`).
   * 정리를 이 함수 안으로 옮기지 않는 이유: 구글 API 호출을 DB 트랜잭션 안에 넣게 되고,
   * 이 레포의 외부 IO 관례(라우트가 `after()` 로 소유)와 어긋난다.
   */
  async dissolveGroup(groupId: string): Promise<{ dissolved: true }> {
    return getPrisma().$transaction(async (txn) => {
      const group = await txn.campaignGroup.findUnique({
        where: { id: groupId },
        select: { id: true, sellerId: true },
      });
      if (!group) {
        throw new CampaignGroupError("GROUP_NOT_FOUND", `그룹을 찾을 수 없습니다: ${groupId}`);
      }

      await acquireGroupLock(txn, group.sellerId);

      const members = (await campaignGroupRepository.listMembers(groupId, txn)) as MemberRow[];
      for (const m of members) {
        await campaignGroupRepository.setGroupId(m.id, null, txn);
      }
      await campaignGroupRepository.delete(groupId, txn);
      return { dissolved: true };
    });
  },
};
