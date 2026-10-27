import { getPrisma } from "@/lib/prisma";
import {
  getFinanceCalendarId,
  getGoogleCalendarAccessToken,
  getGoogleCalendarConnectionStatus,
  GOOGLE_CALENDAR_PROVIDER,
} from "@/lib/google-calendar";
import {
  resolveCampaignMoneySlots,
  resolveMoneySlotEffectiveDate,
  resolveMoneySlotsForChannels,
  type CampaignMoneySlot,
} from "@/lib/tax-filing-board";
import { moneySlotAmount, sumMoneySlotAmounts } from "@/lib/calendar-entities";
import { numberFromDecimal, type DecimalLike } from "@/lib/campaign-row";
import { buildMoneyNoteLines, type MoneyPayoutAccount } from "@/lib/money-event-note";

/**
 * 캠페인 → 구글 캘린더 멱등 동기화.
 *
 * 캠페인별로 생성한 구글 이벤트 id를 SalesCampaign.calendarEventIds(JSON)에 저장해두고,
 * 재동기화 시 저장된 id로 이벤트를 "수정(PATCH)"한다. 따라서 생성 시 자동 등록 → 저장 시
 * 갱신을 반복해도 일정이 중복 생성되지 않는다.
 *
 * 캘린더는 2개다(오너 확정 2026-08-25) — 캠페인 기간 이벤트는 `primary`(기존 캘린더),
 * 대금(입금·지급) 이벤트는 회계·정산 캘린더(`getFinanceCalendarId`, 미설정이면 primary 폴백).
 *
 * 대금 이벤트가 **몇 건이고 누구와의 거래인지는 채널이 정한다** — 판정은
 * `resolveCampaignMoneySlots`(슬롯 SSOT) 하나이고 여기서 채널 분기를 다시 쓰지 않는다.
 * 자사몰은 지급(공급사)+지급(셀러) 두 건이고 입금 건이 없다(오너 확정 2026-08-25).
 * 장부에는 이벤트별 소속 캘린더를 함께 기록해, 목적지가 바뀌면 다음 동기화가
 * "새 캘린더에 생성 → 옛 캘린더에서 삭제" 순서로 이사시킨다.
 *
 * 캘린더 미연결/구글 오류 시에도 예외를 던지지 않고 결과 객체로만 알린다(호출측 CRM 흐름 보호).
 */

export const PRIMARY_CALENDAR_ID = "primary";

function calendarEventsApi(calendarId: string): string {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}

// 캠페인 상태별 Google Calendar 색상 ID
const STATUS_COLOR_MAP: Record<string, string> = {
  PROPOSAL: "8", // graphite
  PREPARATION: "5", // banana
  ACTIVE: "9", // blueberry
  CLOSED: "2", // sage
  SETTLEMENT_WAIT: "6", // tangerine
  SETTLEMENT_IN_PROGRESS: "6", // tangerine
  COMPLETED: "10", // basil
  DROPPED: "11", // tomato
};

/**
 * 이벤트 종류 = 기간 이벤트 하나 + **대금 슬롯의 키**(슬롯 SSOT 파생).
 * ⛔ 여기에 문자열을 손으로 늘리지 말 것 — 대금 이벤트가 늘어나는 경로는
 * `resolveCampaignMoneySlots` 하나이고, 그 `key` 가 곧 장부 키다.
 */
type EventKind = "campaign" | CampaignMoneySlot["key"];

/** 장부 키(바깥 모듈용 이름) — [캘린더수집] 넘겨받기가 어느 칸에 적을지 고를 때 쓴다. */
export type CalendarLedgerKind = EventKind;

/** 장부 항목 — 이벤트 id 와 그 이벤트가 사는 캘린더. */
type StoredEventRef = { id: string; calendarId: string };
type StoredEventIds = Partial<Record<EventKind, StoredEventRef>>;

/**
 * 직렬화 형식은 하위호환 이중이다:
 * - 문자열 `"ev-1"` = primary 의 이벤트(2026-08-25 이전 장부 전부가 이 모양이다)
 * - 객체 `{ id: "ev-1", cal: "...@group.calendar.google.com" }` = 비-primary 캘린더
 * 쓰기 시에도 primary 는 문자열로 유지한다 — 장부를 raw 로 다루는 외부 훅
 * (`deleteCampaignCalendarEvents` 에 원문을 넘기는 삭제·해체 경로)이 형식에 무관하도록.
 */
type SerializedEventEntry = string | { id: string; cal?: string };

type CalendarEventBody = {
  summary: string;
  description?: string;
  start: { date: string };
  end: { date: string };
  colorId?: string;
  /**
   * CRM 이 만든 이벤트 표식(`wagcrm=1`) — 캘린더 수집이 이 표식으로 「CRM 이 쓴 것」을
   * 가려 되먹임 루프를 막는다. `upsertEvent` 한 곳에서 모든 생성·갱신 본문에 찍는다.
   */
  extendedProperties?: { private: { wagcrm: "1" } };
};

/** CRM 이 만든 이벤트에 찍는 표식 — 생성·갱신(PATCH) 모두 이 값을 싣는다. */
const CRM_EVENT_STAMP = { private: { wagcrm: "1" } } as const;

/**
 * 설명란 CRM 서명 — 캠페인 본문(`syncOne`·`syncGroupOne`)과 대금 본문(`syncMoneyEvents`)이
 * **모두** `셀러: <이름>` 줄을 쓴다(캠페인은 첫 줄, 대금은 둘째 줄). 표식 도입 전에 만든
 * 이벤트는 `wagcrm` 표식이 없어 이 서명이 유일한 단서다. 줄 머리 기준으로만 맞춘다
 * (오너가 본문 중간에 우연히 적은 「셀러:」 와 구분).
 */
export function hasCrmDescriptionSignature(description: string | null): boolean {
  if (!description) return false;
  return /^셀러: /m.test(description);
}

/**
 * 대금 이벤트가 읽는 날짜·플래그 묶음 — 캠페인과 그룹이 **같은 모양**이라 슬롯 루프가
 * 둘을 구분하지 않고 돌 수 있다(`resolveMoneySlotEffectiveDate` 가 이 묶음을 읽는다).
 */
type MoneyDateFields = {
  expectedDepositDate: Date | null;
  expectedPayoutDate: Date | null;
  expectedSupplierPayoutDate: Date | null;
  depositReceivedAt: Date | null;
  payoutCompletedAt: Date | null;
  supplierPayoutCompletedAt: Date | null;
  /**
   * 완료의 정본은 플래그다 — 날짜만 보고 옮기면 완료가 취소된 뒤 남은 값이 이벤트를
   * 엉뚱한 날로 끌고 간다. 캠페인·그룹 조회가 둘 다 `include` 라 스칼라가 자동으로
   * 실려 온다(select 로 바꾸면 여기 3필드를 명시할 것).
   */
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  isSupplierPayoutCompleted: boolean;
};

/**
 * 대금 이벤트 메모가 읽는 **금액·계좌 필드 묶음**. 캠페인과 그룹 멤버가 같은 모양이라
 * 계좌 수집(`payoutAccountsFor`)이 둘을 구분하지 않고 돈다.
 *
 * ⚠️ `deal.partner` 는 **딜이 소유한 공급사**다 — 조합 캠페인은 멤버마다 딜이 다를 수
 * 있어(`CampaignGroup` 의 앱 불변식은 "같은 셀러"뿐) 공급사도 여럿일 수 있다.
 */
type MoneyDetailFields = {
  // 컬럼 선택 근거는 `calendar-entities.MONEY_AMOUNT_FIELD` 주석(죽은 컬럼 이력 포함).
  settlementSales: DecimalLike;
  actualSales: DecimalLike;
  sellerExpense: DecimalLike;
  actualPayoutAmount: DecimalLike;
  /** 공급사 지급 칸의 근거(수기 물품대금, T-057). 그룹이 아니라 캠페인이 소유한다. */
  settlementGoodsCost: DecimalLike;
  deal: { dealName: string; partner: { name: string; bankAccount: string | null } | null };
};

type CampaignForSync = MoneyDateFields &
  MoneyDetailFields & {
    id: string;
    status: string;
    groupId: string | null;
    campaignName: string | null;
    /** 대금 슬롯(어느 상대에게 몇 건의 지급이 있는가)을 정하는 축. */
    salesChannel: string;
    startDate: Date;
    endDate: Date;
    calendarEventIds: string | null;
    seller: { name: string; alias: string | null; accountNumber: string | null };
  };

type GroupMemberForSync = MoneyDetailFields & {
  id: string;
  status: string;
  /** 그룹에는 채널 컬럼이 없다 — 슬롯은 멤버 채널에서 모은다(`resolveGroupMoneySlots`). */
  salesChannel: string;
  startDate: Date;
  endDate: Date;
  calendarEventIds: string | null;
};

type GroupForSync = MoneyDateFields & {
  id: string;
  name: string | null;
  calendarEventIds: string | null;
  seller: { name: string; alias: string | null; accountNumber: string | null };
  members: GroupMemberForSync[];
};

export type CampaignSyncResult = {
  ok: boolean;
  skipped?: "not_connected" | "not_found" | "dropped";
  error?: string;
};

/**
 * 딜 + **그 딜의 공급사**. 공급사 지급 슬롯의 계좌 원천이라 캠페인·그룹 멤버가 함께 쓴다.
 * ⚠️ `partner` 를 빼면 이벤트 메모의 공급사 계좌가 조용히 「미등록」이 된다(크래시 없음).
 */
const DEAL_WITH_PARTNER_SELECT = {
  select: { dealName: true, partner: { select: { name: true, bankAccount: true } } },
} as const;

const CAMPAIGN_SYNC_INCLUDE = {
  deal: DEAL_WITH_PARTNER_SELECT,
  seller: { select: { name: true, alias: true, accountNumber: true } },
} as const;

/**
 * 그룹의 대금 슬롯 — 멤버 채널의 **합집합**(판정은 슬롯 SSOT `resolveMoneySlotsForChannels`).
 *
 * ⛔ 합집합 로직을 여기에 다시 쓰지 말 것 — 종전엔 이 파일이 사본을 들고 있었고, 그 사이
 * 모바일 그룹 집계는 「대표 멤버 한 명의 채널」로 판정해 **같은 버그를 반대편에서 재현**했다
 * (2026-08-25 교차검증에서 발견). 판정이 한 곳에 있어야 두 표면이 안 갈린다.
 *
 * 멤버를 id 오름차순으로 넘기는 것은 라벨 안정성 때문이다(SSOT 주석의 ⚠️ 참조).
 *
 * ⚠️ **채널 혼재 그룹은 운영에 없다**(오너 확정 2026-08-25 — 조합은 딜만 여러 개이고
 * 판매채널은 하나다). 그래서 아래 한계는 코드상으로만 가능하다: 섞이면 같은 키의 슬롯이
 * **먼저 온 채널의 상대**로 고정되는데(`resolveMoneySlotsForChannels` 의 키 dedup),
 * 2026-08-25 이후로는 그 슬롯 하나에 금액 합산과 **계좌 나열**까지 걸린다 — 즉 결과가
 * 「라벨이 어긋난다」에서 「엉뚱한 상대의 계좌가 실린다」로 무거워졌다. 혼재를 여기서
 * 방어하지 않는 것은 그 조합이 존재하지 않기 때문이지 안전해서가 아니다. 혼재가 실제로
 * 생기면 슬롯 판정부터 다시 정의해야 한다(이 함수에 분기를 더하는 것으로는 못 고친다).
 */
function resolveGroupMoneySlots(members: { id: string; salesChannel: string }[]): CampaignMoneySlot[] {
  const anchorOrder = [...members].sort((a, b) => a.id.localeCompare(b.id));
  return resolveMoneySlotsForChannels(anchorOrder.map((m) => m.salesChannel));
}

const GROUP_SYNC_INCLUDE = {
  seller: { select: { name: true, alias: true, accountNumber: true } },
  members: {
    select: {
      id: true,
      status: true,
      // 그룹 슬롯의 유일한 채널 출처 — 빼면 `resolveGroupMoneySlots` 가 전 멤버를
      // `undefined` 채널로 보고 기본(셀러몰) 슬롯으로 접는다.
      salesChannel: true,
      startDate: true,
      endDate: true,
      calendarEventIds: true,
      // 그룹의 대금 금액은 컬럼이 아니라 **멤버 합산**이다(`sumMoneySlotAmounts`) —
      // `CampaignGroup` 에는 정산 금액 컬럼이 없다.
      settlementSales: true,
      actualSales: true,
      sellerExpense: true,
      actualPayoutAmount: true,
      settlementGoodsCost: true,
      deal: DEAL_WITH_PARTNER_SELECT,
    },
  },
} as const;

// 그룹 대표 상태 = 가장 덜 진행된 멤버(status 는 멤버 행에 살고 2026-10-05 부터 그룹 연동으로
// 전파되지만, 드랍 멤버·연동 이전 데이터로 섞일 수 있다) — 전원이 끝나기
// 전까지 캘린더에서 완료 색으로 보이지 않게 하는 보수적 선택.
const STATUS_PRECEDENCE = [
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
] as const;

function leastAdvancedStatus(statuses: string[]): string {
  let minIndex = Number.POSITIVE_INFINITY;
  for (const status of statuses) {
    const index = STATUS_PRECEDENCE.indexOf(
      status as (typeof STATUS_PRECEDENCE)[number],
    );
    if (index !== -1 && index < minIndex) minIndex = index;
  }
  return Number.isFinite(minIndex)
    ? STATUS_PRECEDENCE[minIndex]
    : statuses[0] ?? "PROPOSAL";
}

function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseStoredIds(raw: string | null | undefined): StoredEventIds {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const normalized: StoredEventIds = {};
    for (const [kind, entry] of Object.entries(
      parsed as Record<string, SerializedEventEntry | null | undefined>,
    )) {
      if (typeof entry === "string" && entry) {
        normalized[kind as EventKind] = { id: entry, calendarId: PRIMARY_CALENDAR_ID };
      } else if (
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        entry.id
      ) {
        normalized[kind as EventKind] = {
          id: entry.id,
          calendarId:
            typeof entry.cal === "string" && entry.cal
              ? entry.cal
              : PRIMARY_CALENDAR_ID,
        };
      }
    }
    return normalized;
  } catch {
    // 손상된 값이면 새로 만든다
  }
  return {};
}

/** 장부 직렬화 — primary 는 하위호환 문자열, 그 외 캘린더는 `{id, cal}`. 비면 null. */
function serializeStoredIds(next: StoredEventIds): string | null {
  const entries = Object.entries(next).filter(([, ref]) => ref?.id);
  if (entries.length === 0) return null;
  const out: Record<string, SerializedEventEntry> = {};
  for (const [kind, ref] of entries) {
    out[kind] =
      ref!.calendarId === PRIMARY_CALENDAR_ID
        ? ref!.id
        : { id: ref!.id, cal: ref!.calendarId };
  }
  return JSON.stringify(out);
}

async function createEvent(
  accessToken: string,
  calendarId: string,
  body: CalendarEventBody,
): Promise<string | null> {
  const res = await fetch(calendarEventsApi(calendarId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { id?: string };
  return data.id ?? null;
}

async function patchEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  body: CalendarEventBody,
): Promise<"ok" | "gone" | "error"> {
  const res = await fetch(
    `${calendarEventsApi(calendarId)}/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (res.ok) return "ok";
  // 사용자가 캘린더에서 직접 지웠거나 만료 → 재생성 대상
  if (res.status === 404 || res.status === 410) return "gone";
  return "error";
}

async function deleteEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  try {
    await fetch(`${calendarEventsApi(calendarId)}/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    // best-effort — 삭제 실패는 무시
  }
}

/**
 * 저장된 id가 있으면 PATCH, 없거나 사라졌으면 새로 생성. 최종 유효 참조를 반환.
 *
 * 저장된 캘린더 ≠ 목표 캘린더면 **이사**시킨다 — 새 캘린더에 먼저 생성하고,
 * 성공했을 때만 옛 캘린더의 이벤트를 지운다(생성이 실패하면 옛 이벤트·장부를
 * 유지해 다음 동기화가 재시도할 수 있게 한다. 순서를 뒤집으면 실패 시 이벤트가
 * 양쪽 어디에도 없는 구멍이 생긴다).
 */
async function upsertEvent(
  accessToken: string,
  existing: StoredEventRef | undefined,
  targetCalendarId: string,
  rawBody: CalendarEventBody,
): Promise<StoredEventRef | null> {
  const body: CalendarEventBody = { ...rawBody, extendedProperties: CRM_EVENT_STAMP };
  if (existing && existing.calendarId !== targetCalendarId) {
    const createdId = await createEvent(accessToken, targetCalendarId, body);
    if (createdId) {
      await deleteEvent(accessToken, existing.calendarId, existing.id);
      return { id: createdId, calendarId: targetCalendarId };
    }
    return existing; // 이사 실패 → 기존 이벤트 유지(best-effort)
  }
  if (existing) {
    const result = await patchEvent(accessToken, existing.calendarId, existing.id, body);
    if (result === "ok") return existing;
    if (result === "gone") {
      const createdId = await createEvent(accessToken, targetCalendarId, body);
      return createdId ? { id: createdId, calendarId: targetCalendarId } : null;
    }
    return existing; // error → 기존 참조 유지(best-effort)
  }
  const createdId = await createEvent(accessToken, targetCalendarId, body);
  return createdId ? { id: createdId, calendarId: targetCalendarId } : null;
}

/**
 * 이 슬롯이 돈을 보낼 **상대의 계좌들**.
 *
 * ⛔ 채널 분기를 쓰지 말 것 — 상대가 셀러인지 공급사인지는 `slot.counterpart`(슬롯 SSOT)
 * 가 이미 들고 있다. 입금 슬롯은 우리가 받는 쪽이라 빈 배열이다(메모 빌더도 같은 이유로
 * 계좌 줄을 만들지 않지만, 여기서 먼저 걸러 셀러 계좌를 쓸데없이 실어 나르지 않는다).
 *
 * 공급사는 **딜이 소유**하므로 조합 캠페인에서는 멤버 수만큼 나올 수 있다. 하나를 골라
 * 접지 않고 전부 넘긴다(중복 접기는 메모 빌더가 한다).
 */
/** Decimal 컬럼을 숫자로 — **null 은 null 로 남긴다**(0 으로 접으면 미입력이 확정 0원이 된다). */
function decimalOrNull(value: DecimalLike): number | null {
  return value == null ? null : numberFromDecimal(value);
}

function payoutAccountsFor(
  slot: CampaignMoneySlot,
  source: {
    sellerAccountNumber: string | null;
    deals: readonly { partner: { name: string; bankAccount: string | null } | null }[];
  },
): MoneyPayoutAccount[] {
  if (slot.kind !== "PAYOUT") return [];
  if (slot.counterpart === "SELLER") {
    // 셀러명은 메모 위쪽 「셀러:」 줄이 이미 말한다 — 예금주를 다시 적지 않는다.
    return [{ holder: null, account: source.sellerAccountNumber ?? "" }];
  }
  if (slot.counterpart === "SUPPLIER") {
    return source.deals
      .map((deal) => deal.partner)
      .filter((partner): partner is { name: string; bankAccount: string | null } => partner != null)
      .map((partner) => ({ holder: partner.name, account: partner.bankAccount ?? "" }));
  }
  return [];
}

/**
 * 자금 **방향**이 색을 정한다(`money-direction.ts` 와 같은 축). 자사몰의 두 지급은
 * 상대만 다르고 방향은 같으므로 **같은 색**이고, 구분은 제목의 상대 라벨이 맡는다.
 */
const MONEY_COLOR_ID: Record<CampaignMoneySlot["kind"], string> = {
  DEPOSIT: "10", // basil (초록)
  PAYOUT: "6", // tangerine (주황)
};

/**
 * 이번 동기화에서 **이벤트를 갖는 대금 슬롯**(실효 날짜가 있는 슬롯)과 그 날짜.
 * 동기화 루프(`syncMoneyEvents`)와 넘겨받기 사전 판정(`plannedEventKinds`)이 이 함수 하나를 쓴다 —
 * 두 곳이 다른 판정을 들면 넘겨받은 원본을 다음 동기화가 「낡은 종류」로 보고 지운다.
 */
function datedMoneySlots(
  slots: CampaignMoneySlot[],
  source: MoneyDateFields,
): { slot: CampaignMoneySlot; date: Date; isActual: boolean }[] {
  const out: { slot: CampaignMoneySlot; date: Date; isActual: boolean }[] = [];
  for (const slot of slots) {
    // ⛔ `완료일 ?? 예정일` 사본을 여기에 다시 쓰지 말 것 — 앱 캘린더 4표면이 같은 판정을
    // 쓰므로(#481 통합) 규칙은 슬롯 SSOT 한 곳에서만 바뀐다.
    const { date, isActual } = resolveMoneySlotEffectiveDate(slot, source);
    if (date) out.push({ slot, date, isActual });
  }
  return out;
}

/**
 * 대금 슬롯 → 회계·정산 캘린더의 하루짜리 종일 이벤트. 슬롯마다 **완료일 우선, 없으면
 * 예정일**로 그린다(종전 `depositReceivedAt ?? expectedDepositDate` 규칙 그대로).
 *
 * ⛔ 채널 분기를 여기서 다시 쓰지 말 것 — 어느 상대에게 몇 건의 대금 일정이 있는지는
 * 전부 `slots` 가 들고 온다. 자사몰이면 지급 슬롯이 둘이고 입금 슬롯이 없다.
 *
 * 반환값은 **이번 동기화가 장부에 남기려는 kind 집합**이다(날짜가 없어 건너뛴 슬롯은
 * 빠진다). 호출부는 이걸 `deleteStaleEvents` 에 넘겨 나머지를 정리한다.
 */
async function syncMoneyEvents(
  accessToken: string,
  slots: CampaignMoneySlot[],
  source: MoneyDateFields,
  stored: StoredEventIds,
  next: StoredEventIds,
  financeTarget: string,
  subject: { label: string; title: string; sellerName: string },
  /**
   * 슬롯별 금액·계좌. 캠페인은 자기 컬럼, 그룹은 멤버 합산·합집합이라 **호출부가**
   * 판정해 넘긴다(이 함수가 캠페인/그룹을 구분하지 않게 하려는 것이 목적이다).
   */
  resolveDetail: (slot: CampaignMoneySlot) => {
    amount: number | null;
    accounts: MoneyPayoutAccount[];
  },
): Promise<Set<EventKind>> {
  const activeKinds = new Set<EventKind>();
  for (const { slot, date, isActual: completedAt } of datedMoneySlots(slots, source)) {
    activeKinds.add(slot.key);
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    // 자사몰은 지급 이벤트가 두 건이라 상대 라벨이 없으면 구글 캘린더에서 두 이벤트가
    // 글자 하나 다르지 않다 — 상대 병기는 장식이 아니라 **식별 수단**이다.
    const ref = await upsertEvent(accessToken, stored[slot.key], financeTarget, {
      summary: `${slot.verb}(${slot.counterpartLabel}) ${subject.title}`,
      description: [
        `${subject.label}: ${subject.title}`,
        `셀러: ${subject.sellerName}`,
        // 금액·계좌는 오너가 이 이벤트만 열고 이체할 수 있게 하는 줄이다(메모 빌더 SSOT).
        ...buildMoneyNoteLines({ slot, ...resolveDetail(slot) }),
        completedAt
          ? `(실제 ${slot.verb} 완료 · ${slot.counterpartLabel})`
          : `(예상 ${slot.verb}일 · ${slot.counterpartLabel})`,
      ].join("\n"),
      start: { date: toDateStr(date) },
      end: { date: toDateStr(nextDay) },
      colorId: MONEY_COLOR_ID[slot.kind],
    });
    if (ref) next[slot.key] = ref;
  }
  return activeKinds;
}

/**
 * 이번 동기화가 **남기지 않는 kind** 의 기존 이벤트를 지운다.
 *
 * ⚠️ 이 스윕이 없으면 kind 가 사라질 때 — 채널이 바뀌어 입금 슬롯이 없어지거나, 예정일이
 * 지워지거나 — 장부에서만 사라지고 구글 이벤트는 남아 **코드로 영원히 못 찾는 고아**가
 * 된다(`next` 는 매 동기화마다 빈 객체에서 다시 조립되기 때문). 종전에는 kind 가 3종
 * 고정이고 블록마다 자기 `else if` 로만 지워서 이 구멍이 드러나지 않았다 — 슬롯 파생으로
 * kind 가 가변이 된 순간 실경로가 된다.
 */
async function deleteStaleEvents(
  accessToken: string,
  stored: StoredEventIds,
  activeKinds: Set<EventKind>,
): Promise<void> {
  for (const [kind, ref] of Object.entries(stored)) {
    if (!ref?.id || activeKinds.has(kind as EventKind)) continue;
    await deleteEvent(accessToken, ref.calendarId, ref.id);
  }
}

/** 이미 로드된 캠페인 + 액세스 토큰으로 실제 upsert 수행 (전체 동기화에서 토큰 재사용). */
/**
 * 캘린더에 올리지 않는 상태 — **단일 정본**(개별·그룹 동기화가 함께 읽는다).
 *
 * - `DROPPED`: 무산된 캠페인.
 * - `PROPOSAL`: **영업 존**(`zone-config.ts` 의 `ZONE_STATUSES.SALES` 는 이 상태 하나다).
 *   아직 성사되지 않은 제안이라 실제 일정이 아니고, 캘린더는 "실제로 도는 캠페인"을
 *   보는 화면이라는 오너 확정(2026-07-31)에 따른다. 실사고: 제안 단계 캠페인 8건과
 *   전원 제안인 그룹 1건이 캘린더를 채웠고, 조합 그룹에 섞인 제안 멤버가 **그룹 이벤트
 *   기간까지 늘렸다**(1일짜리 제안이 4일 캠페인을 6일로 보이게 함).
 *
 * ⚠️ 이 목록을 늘릴 때는 **동기화 대상 쿼리에서 그 상태를 빼지 말 것** —
 * `syncAllCampaignsToCalendar` 가 이 상태의 캠페인도 계속 조회해야 `syncOne` 이
 * **기존 이벤트를 지우는 경로**를 탈 수 있다. 쿼리에서 빼면 이미 올라간 이벤트가
 * 영원히 남는다(`COMPLETED` 가 쿼리에서 빠져 있는 것은 "이벤트를 유지한다"는 뜻이라
 * 성격이 다르다).
 */
const CALENDAR_EXCLUDED_STATUSES = new Set(["DROPPED", "PROPOSAL"]);

/** 그룹에서 캘린더에 올릴 자격이 있는 멤버 — 그룹 동기화와 넘겨받기 사전 판정이 함께 쓴다. */
function calendarActiveMembers<T extends { status: string }>(members: T[]): T[] {
  return members.filter((m) => !CALENDAR_EXCLUDED_STATUSES.has(m.status));
}

/**
 * 다음 동기화가 **남길** 이벤트 종류 — 개별 캠페인(`syncOne`)·그룹(`syncGroupOne`)과 같은 판정이다.
 * 비노출 상태(그룹이면 자격 있는 멤버 0명)면 빈 집합(동기화가 장부 전체를 지운다), 아니면 기간 이벤트 +
 * 실효 날짜가 있는 대금 슬롯. 여기 없는 종류를 장부에 적으면 다음 동기화의 `deleteStaleEvents` 가 지운다.
 */
function plannedEventKinds(
  target:
    | { type: "campaign"; status: string; salesChannel: string; source: MoneyDateFields }
    | { type: "group"; members: { id: string; status: string; salesChannel: string }[]; source: MoneyDateFields },
): Set<EventKind> {
  let slots: CampaignMoneySlot[];
  if (target.type === "campaign") {
    if (CALENDAR_EXCLUDED_STATUSES.has(target.status)) return new Set();
    slots = resolveCampaignMoneySlots(target.salesChannel);
  } else {
    const activeMembers = calendarActiveMembers(target.members);
    if (activeMembers.length === 0) return new Set();
    slots = resolveGroupMoneySlots(activeMembers);
  }
  const kinds = new Set<EventKind>(["campaign"]);
  for (const { slot } of datedMoneySlots(slots, target.source)) kinds.add(slot.key);
  return kinds;
}

async function syncOne(
  prisma: ReturnType<typeof getPrisma>,
  accessToken: string,
  campaign: CampaignForSync,
  financeCalendarId: string | null,
): Promise<CampaignSyncResult> {
  const stored = parseStoredIds(campaign.calendarEventIds);

  // 드랍·제안 캠페인은 등록했던 이벤트를 제거하고 저장 id를 비운다.
  if (CALENDAR_EXCLUDED_STATUSES.has(campaign.status)) {
    const storedRefs = Object.values(stored).filter(
      (ref): ref is StoredEventRef => Boolean(ref?.id),
    );
    for (const ref of storedRefs) {
      await deleteEvent(accessToken, ref.calendarId, ref.id);
    }
    // 지울 게 없으면 DB 를 건드리지 않는다 — 제안 캠페인은 드랍과 달리 **전체 재동기화
    // 조회 대상에 남아 있어서**(위 쿼리 주석), 무조건 update 하면 재동기화마다 그 행들의
    // `updatedAt` 이 갱신돼 "최근 수정" 신호가 오염된다.
    if (storedRefs.length > 0) {
      await prisma.salesCampaign.update({
        where: { id: campaign.id },
        data: { calendarEventIds: null },
      });
    }
    return { ok: true, skipped: "dropped" };
  }

  const financeTarget = financeCalendarId ?? PRIMARY_CALENDAR_ID;
  const title = campaign.campaignName || campaign.deal.dealName;
  const sellerName = campaign.seller.alias || campaign.seller.name;
  const next: StoredEventIds = {};
  // 대금 일정의 개수·상대·필드는 전부 채널이 정한다(슬롯 SSOT). 자사몰이면
  // 지급(공급사)+지급(셀러) 두 건이고 입금 건이 없다.
  const moneySlots = resolveCampaignMoneySlots(campaign.salesChannel);

  // 1) 캠페인 기간 이벤트 (항상) — 캠페인 일정 캘린더(primary)
  const endExclusive = new Date(campaign.endDate);
  endExclusive.setDate(endExclusive.getDate() + 1);
  const campaignEvent = await upsertEvent(accessToken, stored.campaign, PRIMARY_CALENDAR_ID, {
    summary: title,
    description: [
      `셀러: ${sellerName}`,
      `판매 조건: ${campaign.deal.dealName}`,
      `상태: ${campaign.status}`,
      // 완료된 칸은 실제일을 말한다 — 이 줄이 예정일에 머물면 같은 캘린더 안에서 대금
      // 이벤트와 캠페인 본문이 서로 다른 날을 가리킨다(판정은 슬롯 SSOT).
      ...moneySlots.map((slot) => {
        const { date, isActual } = resolveMoneySlotEffectiveDate(slot, campaign);
        if (!date) return null;
        const label = isActual ? `${slot.verb}일` : `예상 ${slot.verb}일`;
        return `${label}(${slot.counterpartLabel}): ${toDateStr(date)}`;
      }),
    ]
      .filter(Boolean)
      .join("\n"),
    start: { date: toDateStr(campaign.startDate) },
    end: { date: toDateStr(endExclusive) },
    colorId: STATUS_COLOR_MAP[campaign.status] ?? "1",
  });
  if (campaignEvent) next.campaign = campaignEvent;

  // 2) 대금 일정 이벤트 — 회계·정산 캘린더
  const activeKinds = await syncMoneyEvents(
    accessToken,
    moneySlots,
    campaign,
    stored,
    next,
    financeTarget,
    { label: "캠페인", title, sellerName },
    (slot) => ({
      // ⛔ `numberFromDecimal` 을 바로 태우지 말 것 — 그 함수는 null 을 0 으로 접는데,
      // 여기서 0 은 「확인된 0원」으로 읽혀 미입력과 구분이 사라진다.
      amount: moneySlotAmount(
        {
          settlementSales: decimalOrNull(campaign.settlementSales),
          actualSales: decimalOrNull(campaign.actualSales),
          sellerExpense: decimalOrNull(campaign.sellerExpense),
          actualPayoutAmount: decimalOrNull(campaign.actualPayoutAmount),
          settlementGoodsCost: decimalOrNull(campaign.settlementGoodsCost),
        },
        slot,
      ),
      accounts: payoutAccountsFor(slot, {
        sellerAccountNumber: campaign.seller.accountNumber,
        deals: [campaign.deal],
      }),
    }),
  );
  // 기간 이벤트는 항상 유지 대상이다(위에서 이미 upsert 했다).
  activeKinds.add("campaign");
  await deleteStaleEvents(accessToken, stored, activeKinds);

  await prisma.salesCampaign.update({
    where: { id: campaign.id },
    data: { calendarEventIds: serializeStoredIds(next) },
  });

  return { ok: true };
}

/**
 * CG-3: 그룹 단위 동기화. 조합 캠페인은 멤버별 이벤트 대신 **그룹당 한 세트**
 * (기간 롤업 1개 + 대금 슬롯 수만큼) 이벤트를 만들고, 장부는
 * CampaignGroup.calendarEventIds가 소유한다. 멤버가 그룹 합류 전 개별로 만들었던
 * 이벤트는 여기서 정리한다.
 */
async function syncGroupOne(
  prisma: ReturnType<typeof getPrisma>,
  accessToken: string,
  group: GroupForSync,
  financeCalendarId: string | null,
): Promise<CampaignSyncResult> {
  // 멤버 개별 장부 정리 — 그룹 합류 이후의 정본 장부는 그룹 하나뿐이다.
  for (const member of group.members) {
    if (member.calendarEventIds == null) continue;
    const memberStored = parseStoredIds(member.calendarEventIds);
    for (const ref of Object.values(memberStored)) {
      if (ref?.id) await deleteEvent(accessToken, ref.calendarId, ref.id);
    }
    await prisma.salesCampaign.update({
      where: { id: member.id },
      data: { calendarEventIds: null },
    });
  }

  const financeTarget = financeCalendarId ?? PRIMARY_CALENDAR_ID;
  const stored = parseStoredIds(group.calendarEventIds);
  // 제목·기간 롤업의 근거는 **캘린더에 올릴 자격이 있는 멤버**뿐이다. 제안 멤버를 넣으면
  // 성사되지도 않은 딜이 그룹 이벤트 기간을 늘린다(실사고 — 위 상수 주석 참조).
  const activeMembers = calendarActiveMembers(group.members);

  // 올릴 멤버가 없으면(전원 드랍·제안) 그룹 이벤트를 제거하고 장부를 비운다.
  if (activeMembers.length === 0) {
    for (const ref of Object.values(stored)) {
      if (ref?.id) await deleteEvent(accessToken, ref.calendarId, ref.id);
    }
    await prisma.campaignGroup.update({
      where: { id: group.id },
      data: { calendarEventIds: null },
    });
    return { ok: true, skipped: "dropped" };
  }

  const sellerName = group.seller.alias || group.seller.name;
  const title =
    group.name ||
    (activeMembers.length > 1
      ? `${sellerName} ${activeMembers[0].deal.dealName} 외 ${activeMembers.length - 1}건`
      : `${sellerName} ${activeMembers[0].deal.dealName}`);
  const next: StoredEventIds = {};
  // 그룹에는 채널 컬럼이 없다 — 슬롯은 **캘린더에 올릴 자격이 있는 멤버**에서 모은다
  // (제안·드랍 멤버의 채널이 그룹 대금 일정 구성을 바꾸지 않게 한다).
  const moneySlots = resolveGroupMoneySlots(activeMembers);

  // 1) 그룹 기간 이벤트 — 멤버 min(startDate) ~ max(endDate) 롤업(기간 SoT는 캠페인)
  const startDate = new Date(
    Math.min(...activeMembers.map((m) => m.startDate.getTime())),
  );
  const endExclusive = new Date(
    Math.max(...activeMembers.map((m) => m.endDate.getTime())),
  );
  endExclusive.setDate(endExclusive.getDate() + 1);
  const representativeStatus = leastAdvancedStatus(
    activeMembers.map((m) => m.status),
  );
  const campaignEvent = await upsertEvent(accessToken, stored.campaign, PRIMARY_CALENDAR_ID, {
    summary: title,
    description: [
      `셀러: ${sellerName}`,
      `조합 캠페인 ${activeMembers.length}건:`,
      ...activeMembers.map((m) => `- ${m.deal.dealName} (${m.status})`),
      ...moneySlots.map((slot) => {
        const { date, isActual } = resolveMoneySlotEffectiveDate(slot, group);
        if (!date) return null;
        const label = isActual ? `${slot.verb}일` : `예상 ${slot.verb}일`;
        return `${label}(${slot.counterpartLabel}): ${toDateStr(date)}`;
      }),
    ]
      .filter(Boolean)
      .join("\n"),
    start: { date: toDateStr(startDate) },
    end: { date: toDateStr(endExclusive) },
    colorId: STATUS_COLOR_MAP[representativeStatus] ?? "1",
  });
  if (campaignEvent) next.campaign = campaignEvent;

  // 2) 대금 일정 이벤트 — 그룹 공유 일정(그룹 스칼라가 SoT) — 회계·정산 캘린더
  const activeKinds = await syncMoneyEvents(
    accessToken,
    moneySlots,
    group,
    stored,
    next,
    financeTarget,
    { label: "조합", title, sellerName },
    (slot) => ({
      // 그룹에는 정산 금액 컬럼이 없다 — 대금 한 건은 **캘린더에 올릴 자격이 있는 멤버**의
      // 합이다(제안·드랍 멤버의 금액이 그룹 지급액을 부풀리지 않게 `activeMembers` 를 쓴다).
      amount: sumMoneySlotAmounts(
        activeMembers.map((member) => ({
          settlementSales: decimalOrNull(member.settlementSales),
          actualSales: decimalOrNull(member.actualSales),
          sellerExpense: decimalOrNull(member.sellerExpense),
          actualPayoutAmount: decimalOrNull(member.actualPayoutAmount),
          settlementGoodsCost: decimalOrNull(member.settlementGoodsCost),
        })),
        slot,
      ),
      // 멤버마다 딜이 달라 공급사가 여럿일 수 있다 — 전부 넘기고 메모가 나열한다.
      accounts: payoutAccountsFor(slot, {
        sellerAccountNumber: group.seller.accountNumber,
        deals: activeMembers.map((member) => member.deal),
      }),
    }),
  );
  activeKinds.add("campaign");
  await deleteStaleEvents(accessToken, stored, activeKinds);

  await prisma.campaignGroup.update({
    where: { id: group.id },
    data: { calendarEventIds: serializeStoredIds(next) },
  });

  return { ok: true };
}

/** 그룹 단위 멱등 동기화 (그룹 생성/멤버십 변경/공유 일정 수정 훅에서 사용). */
export async function syncGroupToCalendar(
  groupId: string,
): Promise<CampaignSyncResult> {
  const prisma = getPrisma();

  const group = (await prisma.campaignGroup.findUnique({
    where: { id: groupId },
    include: GROUP_SYNC_INCLUDE,
  })) as GroupForSync | null;
  if (!group) return { ok: false, skipped: "not_found" };

  const status = await getGoogleCalendarConnectionStatus();
  if (!status.connected) return { ok: false, skipped: "not_connected" };

  let accessToken: string;
  try {
    accessToken = await getGoogleCalendarAccessToken();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return syncGroupOne(prisma, accessToken, group, await getFinanceCalendarId());
}

/** 단일 캠페인을 구글 캘린더에 멱등 동기화 (생성/수정 훅에서 사용). */
export async function syncCampaignToCalendar(
  campaignId: string,
): Promise<CampaignSyncResult> {
  const prisma = getPrisma();

  const campaign = (await prisma.salesCampaign.findUnique({
    where: { id: campaignId },
    include: CAMPAIGN_SYNC_INCLUDE,
  })) as CampaignForSync | null;
  if (!campaign) return { ok: false, skipped: "not_found" };

  // CG-3: 그룹 캠페인은 그룹 단위로 위임 — 개별 이벤트를 만들지 않는다.
  if (campaign.groupId) return syncGroupToCalendar(campaign.groupId);

  const status = await getGoogleCalendarConnectionStatus();
  if (!status.connected) return { ok: false, skipped: "not_connected" };

  let accessToken: string;
  try {
    accessToken = await getGoogleCalendarAccessToken();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return syncOne(prisma, accessToken, campaign, await getFinanceCalendarId());
}

/**
 * 넘겨받기 결과 — 호출부(`approveProposal`)가 수집 행 표기(`skipReason`)를 고른다.
 * - `adopted` · `already_adopted`: 장부에 그 이벤트가 있다(새로 적었거나 이미 적혀 있었다).
 * - `already_referenced`: 다른 칸·다른 캠페인·그룹 장부가 이미 그 이벤트를 가리킨다 — 두 장부가 같은 이벤트를
 *   잡으면 두 동기화가 번갈아 덮고, 어느 한쪽 캠페인을 지우면 오너 원본이 함께 지워진다.
 * - `conflict`: 그 칸에 다른 이벤트가 이미 있다 — 덮으면 그 CRM 이벤트가 고아가 된다.
 * - `not_active`: 다음 동기화가 그 칸을 남기지 않는다(비노출 상태 · 채널에 없는 대금 칸 · 날짜 빈 칸) —
 *   적으면 동기화가 「낡은 종류」로 보고 오너 원본을 **지운다**.
 * - `not_found`: 캠페인(또는 그 그룹)이 없다.
 */
export type AdoptLedgerOutcome =
  | "adopted"
  | "already_adopted"
  | "already_referenced"
  | "conflict"
  | "not_active"
  | "not_found";

/** 조건부 쓰기가 다른 쓰기에 밀렸을 때 다시 읽는 횟수 — 동기화 한 번과 겹치는 정도만 견디면 된다. */
const ADOPT_LEDGER_ATTEMPTS = 3;

/** 대금 날짜·완료 플래그 — `plannedEventKinds` 가 동기화와 같은 판정을 하려고 읽는 칸(`MoneyDateFields`). */
const MONEY_DATE_SELECT = {
  expectedDepositDate: true,
  expectedPayoutDate: true,
  expectedSupplierPayoutDate: true,
  depositReceivedAt: true,
  payoutCompletedAt: true,
  supplierPayoutCompletedAt: true,
  isDepositReceived: true,
  isPayoutCompleted: true,
  isSupplierPayoutCompleted: true,
} as const;

/**
 * [캘린더수집] 오너가 손으로 만든 구글 이벤트를 캠페인 장부에 **넘겨받는다**(오너 확정 ①, 2026-10-21).
 * 장부 칸에 그 이벤트 id 를 적어 두면 다음 `syncCampaignToCalendar` 가 새로 만들지 않고 그 이벤트를
 * 갱신한다(제목·날짜를 CRM 형식으로 덮는다 — 일정은 하나로 남는다).
 *
 * - **제자리 갱신이 아닐 수 있다(의도):** 장부에 적힌 캘린더가 그 칸의 목적지와 다르면(예: 오너가 대금 일정을
 *   primary 에 적었고 회계·정산 캘린더가 설정돼 있다) 동기화의 이사 로직(`upsertEvent`)이 목적지 캘린더에
 *   새로 만들고 원본을 지운다 — 결과적으로 일정은 여전히 하나다(설계 §3①). 막지 않는다.
 * - **장부 주인:** 조합(그룹) 소속 캠페인이면 칸과 무관하게 **그룹 행**이다. 기간 이벤트만이 아니라
 *   대금 이벤트도 그룹 장부가 소유하고(`syncGroupOne`), 멤버 장부에 남은 이벤트는 동기화가 **지운다**.
 * - **원본을 지우게 될 쓰기는 하지 않는다** — 이미 다른 장부가 잡은 이벤트(`already_referenced`), 다음 동기화가
 *   남기지 않을 칸(`not_active`, 판정은 동기화와 같은 `plannedEventKinds`), 다른 이벤트가 있는 칸(`conflict`).
 *   이때 원본은 평범한 일정으로 남는다.
 * - **동시성:** 읽은 원문 그대로일 때만 쓰는 조건부 쓰기다. 그 사이 동기화가 장부를 바꿨으면 다시 읽는다.
 * - 커밋 **뒤** 단계라 판정은 결과로 돌려주고, DB 오류는 그대로 던진다 — 호출부가 잡아 보고한다.
 */
export async function adoptCalendarEventIntoLedger(input: {
  campaignId: string;
  kind: CalendarLedgerKind;
  eventId: string;
  calendarId: string;
}): Promise<AdoptLedgerOutcome> {
  const prisma = getPrisma();

  for (let attempt = 0; attempt < ADOPT_LEDGER_ATTEMPTS; attempt += 1) {
    const campaign = await prisma.salesCampaign.findUnique({
      where: { id: input.campaignId },
      select: {
        id: true,
        groupId: true,
        status: true,
        salesChannel: true,
        calendarEventIds: true,
        ...MONEY_DATE_SELECT,
      },
    });
    if (!campaign) return "not_found";

    let owner: { table: "campaign" | "group"; id: string; raw: string | null };
    let planned: Set<EventKind>;
    if (campaign.groupId) {
      const group = await prisma.campaignGroup.findUnique({
        where: { id: campaign.groupId },
        select: {
          id: true,
          calendarEventIds: true,
          ...MONEY_DATE_SELECT,
          members: { select: { id: true, status: true, salesChannel: true } },
        },
      });
      if (!group) return "not_found";
      owner = { table: "group", id: group.id, raw: group.calendarEventIds };
      planned = plannedEventKinds({ type: "group", members: group.members, source: group });
    } else {
      owner = { table: "campaign", id: campaign.id, raw: campaign.calendarEventIds };
      planned = plannedEventKinds({
        type: "campaign",
        status: campaign.status,
        salesChannel: campaign.salesChannel,
        source: campaign,
      });
    }

    const stored = parseStoredIds(owner.raw);
    const existing = stored[input.kind];
    if (existing?.id === input.eventId) return "already_adopted";
    // 자기 장부의 다른 칸 포함 — 어디서든 이미 가리키면 두 번째 주인을 만들지 않는다.
    if ((await collectReferencedEventIds(prisma)).has(input.eventId)) {
      console.warn(
        `[calendar-adopt] 이벤트 ${input.eventId} 는 이미 다른 장부가 가리켜 ${owner.table} ${owner.id} 에 넘겨받지 않음`,
      );
      return "already_referenced";
    }
    if (existing?.id) {
      console.warn(
        `[calendar-adopt] ${owner.table} ${owner.id} 장부 ${input.kind} 에 다른 이벤트(${existing.id})가 있어 ` +
          `넘겨받지 않음 — 원본 ${input.eventId} 는 평범한 일정으로 남는다`,
      );
      return "conflict";
    }
    if (!planned.has(input.kind)) {
      console.warn(
        `[calendar-adopt] ${owner.table} ${owner.id} 의 ${input.kind} 칸은 다음 동기화가 남기지 않아 넘겨받지 않음 ` +
          `— 원본 ${input.eventId} 는 평범한 일정으로 남는다`,
      );
      return "not_active";
    }

    const next: StoredEventIds = {
      ...stored,
      [input.kind]: { id: input.eventId, calendarId: input.calendarId },
    };
    const args = {
      where: { id: owner.id, calendarEventIds: owner.raw },
      data: { calendarEventIds: serializeStoredIds(next) },
    };
    const { count } =
      owner.table === "group"
        ? await prisma.campaignGroup.updateMany(args)
        : await prisma.salesCampaign.updateMany(args);
    if (count > 0) return "adopted";
  }

  throw new Error(
    `캠페인 ${input.campaignId} 장부가 계속 바뀌어 넘겨받기를 기록하지 못했다(${ADOPT_LEDGER_ATTEMPTS}회 시도)`,
  );
}

/**
 * 캠페인 삭제 시 저장돼 있던 구글 캘린더 이벤트를 제거 (삭제 훅에서 사용).
 *
 * 캠페인 행이 이미 삭제된 뒤 호출될 수 있으므로 campaignId 조회 대신
 * raw calendarEventIds JSON을 직접 받는다. 이벤트 삭제는 best-effort·멱등
 * (이미 지워진 이벤트의 404/410은 무시)이며 예외를 던지지 않는다.
 */
export async function deleteCampaignCalendarEvents(
  calendarEventIds: string | null,
): Promise<CampaignSyncResult> {
  const stored = parseStoredIds(calendarEventIds);
  const eventRefs = Object.values(stored).filter(
    (ref): ref is StoredEventRef => Boolean(ref?.id),
  );
  if (eventRefs.length === 0) return { ok: true };

  const status = await getGoogleCalendarConnectionStatus();
  if (!status.connected) return { ok: false, skipped: "not_connected" };

  let accessToken: string;
  try {
    accessToken = await getGoogleCalendarAccessToken();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  for (const ref of eventRefs) {
    await deleteEvent(accessToken, ref.calendarId, ref.id);
  }
  return { ok: true };
}

export type FullSyncResult = {
  synced: number;
  total: number;
  failed: number;
  skipped?: "not_connected";
};

/** 활성 캠페인 전체를 구글 캘린더에 멱등 동기화 (캘린더 화면의 "전체 동기화" 버튼). */
export async function syncAllCampaignsToCalendar(): Promise<FullSyncResult> {
  const prisma = getPrisma();

  const status = await getGoogleCalendarConnectionStatus();
  if (!status.connected) {
    return { synced: 0, total: 0, failed: 0, skipped: "not_connected" };
  }

  let accessToken: string;
  try {
    accessToken = await getGoogleCalendarAccessToken();
  } catch {
    return { synced: 0, total: 0, failed: 0, skipped: "not_connected" };
  }

  const financeCalendarId = await getFinanceCalendarId();

  // 개별(무그룹) 캠페인만 상태 필터 대상 — 완료/드랍 개별 캠페인은 히스토리
  // churn 방지로 재동기화에서 제외한다(개별 경로는 이미 생성 시점에 이벤트 보유).
  // ⛔ **`PROPOSAL` 을 이 `notIn` 에 추가하지 말 것** — 제안 캠페인은 캘린더에서
  // 빼는 게 맞지만(`CALENDAR_EXCLUDED_STATUSES`), 그 **제거를 수행하는 주체가
  // `syncOne` 이라** 여기서 조회 대상에 남아 있어야 이미 올라간 이벤트가 지워진다.
  // 빼는 순간 기존 제안 이벤트가 영구히 캘린더에 남는다.
  const ungrouped = (await prisma.salesCampaign.findMany({
    where: { groupId: null, status: { notIn: ["DROPPED", "COMPLETED"] } },
    include: CAMPAIGN_SYNC_INCLUDE,
    orderBy: { startDate: "asc" },
  })) as CampaignForSync[];

  // CG-3 FIX: 그룹은 CampaignGroup 대장에서 직접 전량 수집한다. 이전에는 위
  // 캠페인 목록(COMPLETED 제외)에서 groupId를 역산했기 때문에, 전원 정산완료된
  // 그룹이 통째로 누락됐다 — 그 결과 (1) 그룹 합류 전 만들어진 멤버 개별 이벤트가
  // 정리되지 않은 채 남고 (2) 소비될 그룹 이벤트도 생성되지 않아, 정산으로 넘어간
  // 조합 캠페인이 구글 캘린더에 개별 이벤트로 흩어져 보였다. 그룹당 1회
  // syncGroupOne이 멤버 잔여 이벤트 정리(장부 null)까지 함께 수행하므로, 이
  // 전량 수집이 기존 잘못된 상태의 reconcile 경로도 겸한다.
  const groups = (await prisma.campaignGroup.findMany({
    include: GROUP_SYNC_INCLUDE,
  })) as GroupForSync[];

  let synced = 0;
  let failed = 0;
  for (const campaign of ungrouped) {
    try {
      const result = await syncOne(prisma, accessToken, campaign, financeCalendarId);
      if (result.ok) synced++;
      else failed++;
    } catch (error) {
      console.error(
        `[google-calendar-sync] 캠페인 ${campaign.id} 동기화 실패:`,
        error,
      );
      failed++;
    }
  }
  for (const group of groups) {
    try {
      const result = await syncGroupOne(prisma, accessToken, group, financeCalendarId);
      if (result.ok) synced++;
      else failed++;
    } catch (error) {
      console.error(
        `[google-calendar-sync] 그룹 ${group.id} 동기화 실패:`,
        error,
      );
      failed++;
    }
  }

  await prisma.storageIntegration
    .update({
      where: { provider: GOOGLE_CALENDAR_PROVIDER },
      data: { lastSyncAt: new Date() },
    })
    .catch(() => {});

  return { synced, total: ungrouped.length + groups.length, failed };
}

// ---------------------------------------------------------------------------
// 고아 이벤트 정리 (reconcile) — 2026-07-31
//
// 왜 필요한가: 동기화는 **DB 장부(calendarEventIds)에 적힌 id 로만** 이벤트를 찾아
// 지운다. 장부가 끊긴 이벤트(=고아)는 코드 입장에서 존재하지 않아 재동기화를 몇 번
// 돌려도 영원히 남는다. 실측(2026-07-31): 2025-06-13 하루에만 CRM 이 만든 적 없는
// 형식의 이벤트가 20건대로 쌓여 있었고(제목이 캠페인명이 아니라 딜명 — 현행 코드가
// 만드는 형식이 아니다), 그날 기간이 걸치는 캠페인 6건은 **전부 장부가 비어 있었다**.
// 원인은 캠페인 데이터 대량 재이관(2026-05-22~23)으로 이전 장부 연결이 끊긴 것.
//
// ⚠️ 스캔 대상에 `primary`(오너 개인 기본 캘린더)가 포함된다(회계·정산 캘린더가
// 설정돼 있으면 그쪽도 함께 훑는다). 그래서 "장부에 없으면 삭제"를
// 그대로 돌리면 CRM 이 만들지 않은 일정까지 지운다. 두 겹으로 막는다:
//   ① 후보를 **종일(all-day) · 비반복** 이벤트로 제한 — CRM 은 종일 이벤트만 만들고
//      반복 일정은 만든 적이 없다. 시간대가 있는 회의·반복 일정은 애초에 후보가 아니다.
//   ② **스캔과 삭제를 분리** — 삭제는 스캔이 돌려준 id 를 호출부가 명시적으로 되보낼
//      때만 수행한다(사이에 생긴 새 이벤트가 휩쓸리는 TOCTOU 방지).
// ---------------------------------------------------------------------------

export type OrphanCalendarEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  /** 이 이벤트가 발견된 캘린더(primary 또는 회계·정산 캘린더 ID) — 삭제 시 되보낸다. */
  calendarId: string;
};

export type OrphanScanResult = {
  ok: boolean;
  skipped?: "not_connected";
  error?: string;
  /** 조회한 종일·비반복 이벤트 수 */
  scanned: number;
  /** 그중 DB 장부가 참조하는 수(= 정상 동기화 대상) */
  referenced: number;
  orphans: OrphanCalendarEvent[];
};

type RawCalendarEvent = {
  id?: string;
  summary?: string;
  description?: string;
  status?: string;
  htmlLink?: string;
  recurrence?: unknown;
  recurringEventId?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
};

/** DB 두 장부(캠페인·그룹)가 참조 중인 모든 구글 이벤트 id 집합. */
export async function collectReferencedEventIds(
  prisma: ReturnType<typeof getPrisma>,
): Promise<Set<string>> {
  const [campaigns, groups] = await Promise.all([
    prisma.salesCampaign.findMany({
      where: { calendarEventIds: { not: null } },
      select: { calendarEventIds: true },
    }),
    prisma.campaignGroup.findMany({
      where: { calendarEventIds: { not: null } },
      select: { calendarEventIds: true },
    }),
  ]);
  const referenced = new Set<string>();
  for (const row of [...campaigns, ...groups]) {
    for (const ref of Object.values(parseStoredIds(row.calendarEventIds))) {
      if (ref?.id) referenced.add(ref.id);
    }
  }
  return referenced;
}

/** 종일·비반복 후보 이벤트 한 건 — 고아 스캔과 캘린더 수집이 함께 쓴다. */
export type CandidateEvent = {
  id: string;
  calendarId: string;
  summary: string;
  description: string | null;
  /** 시작일 YYYY-MM-DD (구글 `start.date` 그대로) */
  startDate: string;
  /** CRM 포함 종료일 YYYY-MM-DD — 구글 종일 `end.date` 는 배타적이라 하루를 뺀 값. */
  endDate: string;
  htmlLink: string | null;
  /**
   * CRM 이 만든 이벤트로 보이는가(`wagcrm` 표식 또는 설명란 서명). 호출부는 장부 참조
   * (`referencedIds`)와 함께 둘 중 하나라도 해당하면 제외한다(되먹임 루프 방지).
   */
  crmSigned: boolean;
};

export type CandidateListResult = {
  ok: boolean;
  skipped?: "not_connected";
  error?: string;
  events: CandidateEvent[];
  referencedIds: Set<string>;
};

/** YYYY-MM-DD 에 일수를 더한다 — UTC 문자열 산술이라 시간대 이동이 없다. */
function shiftDateStr(dateStr: string, days: number): string {
  if (!dateStr) return dateStr;
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 후보 조회 시간 제한 — 구글이 응답 없이 멈추면 수집 회차가 단일 실행 잠금(120초,
 * `calendar-inbound/run-lock.ts`)보다 오래 붙잡혀 다음 회차와 겹칠 수 있다. 한 번의 요청(본문
 * 읽기 포함)과 전체 조회(페이지·캘린더 합산) 둘 다 묶는다. 전체 상한은 회차 예산(55초)보다 짧다.
 */
export const CANDIDATE_LIST_REQUEST_TIMEOUT_MS = 15_000;
export const CANDIDATE_LIST_DEADLINE_MS = 40_000;

/**
 * 기간 내 **종일·비반복·취소 아님** 이벤트를 모든 대상 캘린더(primary + 회계·정산)에서
 * 읽어 후보로 돌려준다. 읽기 전용. 장부 참조 집합도 함께 돌려주지만 **거르지는 않는다** —
 * 거르는 규칙(참조 id · `crmSigned`)은 호출부가 정한다.
 */
export async function listAllDayCandidateEvents(opts: {
  timeMin: string;
  timeMax: string;
}): Promise<CandidateListResult> {
  const empty = { events: [] as CandidateEvent[], referencedIds: new Set<string>() };

  const status = await getGoogleCalendarConnectionStatus();
  if (!status.connected) return { ok: false, skipped: "not_connected", ...empty };

  let accessToken: string;
  try {
    accessToken = await getGoogleCalendarAccessToken();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...empty,
    };
  }

  const referencedIds = await collectReferencedEventIds(getPrisma());

  // 회계·정산 캘린더가 설정돼 있으면 두 캘린더 모두 훑는다 — 한쪽만 보면
  // 이사 후 남은 잔재(또는 이사 전 옛 이벤트)가 스캔 사각이 된다.
  const financeCalendarId = await getFinanceCalendarId();
  const calendarIds = [
    PRIMARY_CALENDAR_ID,
    ...(financeCalendarId && financeCalendarId !== PRIMARY_CALENDAR_ID
      ? [financeCalendarId]
      : []),
  ];

  const events: CandidateEvent[] = [];
  const deadlineAt = Date.now() + CANDIDATE_LIST_DEADLINE_MS;

  for (const calendarId of calendarIds) {
    let pageToken: string | undefined;
    do {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        return { ok: false, error: "이벤트 조회 시간 초과", ...empty };
      }
      const url = new URL(calendarEventsApi(calendarId));
      url.searchParams.set("timeMin", opts.timeMin);
      url.searchParams.set("timeMax", opts.timeMax);
      url.searchParams.set("maxResults", "250");
      url.searchParams.set("showDeleted", "false");
      // singleEvents=false: 반복 일정을 인스턴스로 펼치지 않는다(어차피 후보에서 제외).
      url.searchParams.set("singleEvents", "false");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      let data: { items?: RawCalendarEvent[]; nextPageToken?: string };
      try {
        const res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` },
          // 신호가 본문 읽기까지 이어져 헤더만 오고 멈추는 경우도 끊는다.
          signal: AbortSignal.timeout(
            Math.min(CANDIDATE_LIST_REQUEST_TIMEOUT_MS, remainingMs),
          ),
        });
        if (!res.ok) {
          return { ok: false, error: `이벤트 조회 실패: ${res.status}`, ...empty };
        }
        data = (await res.json()) as typeof data;
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        return {
          ok: false,
          error: timedOut
            ? "이벤트 조회 시간 초과"
            : `이벤트 조회 실패: ${error instanceof Error ? error.message : String(error)}`,
          ...empty,
        };
      }

      for (const ev of data.items ?? []) {
        if (!ev.id || ev.status === "cancelled") continue;
        // 안전장치 ① — CRM 은 종일·비반복 이벤트만 만든다.
        const isAllDay = Boolean(ev.start?.date) && !ev.start?.dateTime;
        const isRecurring = Boolean(ev.recurrence) || Boolean(ev.recurringEventId);
        if (!isAllDay || isRecurring) continue;

        const startDate = ev.start?.date ?? "";
        const endExclusive = ev.end?.date ?? "";
        const description = ev.description ?? null;
        events.push({
          id: ev.id,
          calendarId,
          summary: ev.summary ?? "(제목 없음)",
          description,
          startDate,
          endDate: shiftDateStr(endExclusive, -1),
          htmlLink: ev.htmlLink ?? null,
          crmSigned:
            ev.extendedProperties?.private?.wagcrm === "1" ||
            hasCrmDescriptionSignature(description),
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  return { ok: true, events, referencedIds };
}

/**
 * 기간 내 종일·비반복 이벤트를 훑어 **DB 장부가 참조하지 않는 것**(고아)을 골라낸다.
 * 읽기 전용 — 아무것도 지우지 않는다. (`crmSigned` 는 여기서 쓰지 않는다 — 고아 정리는
 * 장부 참조만으로 판정하는 기존 동작을 유지한다.)
 */
export async function scanOrphanCalendarEvents(opts: {
  timeMin: string;
  timeMax: string;
}): Promise<OrphanScanResult> {
  const listed = await listAllDayCandidateEvents(opts);
  if (!listed.ok) {
    return {
      ok: false,
      ...(listed.skipped ? { skipped: listed.skipped } : {}),
      ...(listed.error ? { error: listed.error } : {}),
      scanned: 0,
      referenced: 0,
      orphans: [],
    };
  }

  const orphans: OrphanCalendarEvent[] = [];
  let referencedSeen = 0;
  for (const ev of listed.events) {
    if (listed.referencedIds.has(ev.id)) {
      referencedSeen++;
      continue;
    }
    orphans.push({
      id: ev.id,
      summary: ev.summary,
      // 고아 정리 화면은 구글 원형(배타적 종료일)을 그대로 쓴다 — 동작 불변.
      start: ev.startDate,
      end: shiftDateStr(ev.endDate, 1),
      calendarId: ev.calendarId,
    });
  }

  orphans.sort((a, b) => a.start.localeCompare(b.start));
  return { ok: true, scanned: listed.events.length, referenced: referencedSeen, orphans };
}

/**
 * 명시적으로 지정된 이벤트 id 만 삭제한다(스캔 결과를 되돌려 받는 용도).
 *
 * ⛔ 여기서 다시 스캔해서 지우지 말 것 — 스캔과 삭제 사이에 생긴 새 이벤트가
 * 확인 없이 휩쓸린다. 지울 대상은 언제나 **사람이 목록을 본 그 id** 여야 한다.
 * 참조 중인 id 가 섞여 들어오면 방어적으로 건너뛴다(장부가 가리키는 정상 이벤트 보호).
 */
export async function deleteCalendarEventsByIds(
  events: Array<string | { id: string; calendarId?: string }>,
): Promise<{ ok: boolean; skipped?: "not_connected"; error?: string; deleted: number; protected: number }> {
  // 문자열 항목은 primary 로 해석한다(회계 캘린더 도입 전 호출부 하위호환).
  const normalized = new Map<string, string>();
  for (const entry of events) {
    if (typeof entry === "string") {
      if (entry) normalized.set(entry, PRIMARY_CALENDAR_ID);
    } else if (entry?.id) {
      normalized.set(entry.id, entry.calendarId || PRIMARY_CALENDAR_ID);
    }
  }
  if (normalized.size === 0) return { ok: true, deleted: 0, protected: 0 };

  const status = await getGoogleCalendarConnectionStatus();
  if (!status.connected) {
    return { ok: false, skipped: "not_connected", deleted: 0, protected: 0 };
  }

  let accessToken: string;
  try {
    accessToken = await getGoogleCalendarAccessToken();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      deleted: 0,
      protected: 0,
    };
  }

  const referenced = await collectReferencedEventIds(getPrisma());
  let deleted = 0;
  let protectedCount = 0;
  for (const [id, calendarId] of normalized) {
    if (referenced.has(id)) {
      protectedCount++;
      continue;
    }
    await deleteEvent(accessToken, calendarId, id);
    deleted++;
  }
  return { ok: true, deleted, protected: protectedCount };
}
