// 홈 「오늘 처리할 일」 행 빌더 (client-safe 순수 로직).
//
// 그날 손이 가야 하는 일을 **한 목록**으로 모은다 — 주문(발주 대기·송장·배송 지연·반품·교환) ·
// 영업 팔로업 · 정산 지연 · 승인대기 · 데이터 점검. 종전에는 「오늘 처리할 주문」 카드와 「핵심 업무」
// 탭 카드(영업 팔로업|지연된 정산)가 따로 있었고, 승인대기는 사이드바 배지에만, 데이터 점검은 맨 아래
// 탭에만 있었다(애플 UI 리뉴얼 묶음 1-b, 오너 2026-10-17).
//
// 판단 순서(P2): ① 일이 있는가(0건 행은 빠지고, 전부 0 이면 카드가 한 줄로 접힌다) ② 어느 일이 몇 건
// ③ 그중 늦은 것이 있는가(색). 판정은 각 원천의 SSOT 를 그대로 쓴다 — 주문 칸은
// `buildOrderWorkBuckets`, 정산 지연은 `/api/agenda`(`buildOverdueSettlementItems`, 그룹 SoT 접기 포함),
// 승인대기는 `useApprovalInbox` 의 조건 전체 건수, 데이터 점검은 `computeDataIntegrityIssues`.
// ⛔ 여기서 건수를 다시 세지 말 것 — 같은 판정의 두 번째 인코딩이 이 레포의 반복 사고다.

import { buildOrderWorkBuckets, type Bucket } from "@/lib/order-converter/order-work-buckets";
import type { OrderSyncState } from "@/lib/order-converter/order-work-buckets";
import type { OrderWorkSummary } from "@/lib/order-converter/order-work";

export type TodayWorkKey =
  | "orders-pending"
  | "orders-delayed"
  | "orders-returns"
  | "outreach-followup"
  | "settlement-delayed"
  | "approvals-pending"
  | "data-check";

export type TodayWorkTone = "neutral" | "caution" | "urgent" | "info";

export type TodayWorkRow = {
  key: TodayWorkKey;
  label: string;
  count: number;
  tone: TodayWorkTone;
  href: string;
  /** 판단을 바꾸는 세부 한 줄(예: 「결제 후 2일 이상 5건」) — 없으면 null. */
  detail: string | null;
};

export type TodayWorkInput = {
  /** `/api/order-work` 요약. 아직 없으면(로딩·실패) 주문 행을 만들지 않는다 — 0 으로 위장하지 않는다. */
  orders: OrderWorkSummary | undefined;
  agenda: {
    tasks: number;
    settlements: number;
    /** 지연된 정산 항목 id, 오래 지연된 순(그룹은 대표 멤버 id — `agenda-settlements.ts`). 첫 항목 상세로 바로 간다. */
    overdueSettlementIds?: string[];
  };
  approvalsPending: number;
  dataCheck: number;
};

const ORDER_ROW: Record<Bucket["key"], TodayWorkKey> = {
  "awaiting-po": "orders-pending",
  delayed: "orders-delayed",
  "open-claims": "orders-returns",
};

/** 데이터 점검은 별도 화면이 없다 — 상세 목록은 홈 아래 「데이터 점검」 탭이 갖는다(그 자리로 내려간다). */
export const DATA_CHECK_ANCHOR = "data-check";

/**
 * 정산 지연 행의 목적지 — 그 캠페인 상세를 연 채로(`/settlement?campaign=<id>`). 여러 건이면
 * **가장 오래 지연된 것**(목록 첫 항목 — `buildOverdueSettlementItems` 가 지연 기준일 오름차순으로 준다)을
 * 연다. 정산 관리 표에는 지연 걸러보기가 없어서(지연 경고는 2026-08-25 오너 결정으로 그 표에서 뺐다 —
 * `settlement-table.tsx` 묘비 주석) 첫 화면으로 보내면 어느 건이 늦었는지 모른 채 도착한다.
 * id 를 모르면(응답에 없음) 정산 관리 첫 화면 — 거르는 주소를 지어내지 않는다.
 */
function settlementHref(ids: string[] | undefined): string {
  const oldest = ids?.[0];
  return oldest ? `/settlement?campaign=${encodeURIComponent(oldest)}` : "/settlement";
}

export function buildTodayWorkRows(input: TodayWorkInput): TodayWorkRow[] {
  const rows: TodayWorkRow[] = [];

  if (input.orders) {
    for (const bucket of buildOrderWorkBuckets(input.orders)) {
      rows.push({
        key: ORDER_ROW[bucket.key],
        label: bucket.label,
        count: bucket.lines,
        tone: bucket.tone ?? "neutral",
        href: "/order-converter",
        detail: bucket.detail,
      });
    }
  }

  rows.push(
    // 영업 팔로업은 리마인드 시점 도래(정보) — 종전 탭 배지 countTone="info" 승계.
    { key: "outreach-followup", label: "영업 팔로업", count: input.agenda.tasks, tone: "info", href: "/outreach", detail: null },
    // 정산 지연은 대금 기한 초과 — 종전 탭 배지 countTone="urgent" 승계.
    {
      key: "settlement-delayed",
      // 「정산 지연」 — 같은 자리의 「송장·배송 지연」과 같은 꼴(대상 + 지연)로(2026-10-18 ss-ux 문구).
      label: "정산 지연",
      count: input.agenda.settlements,
      tone: "urgent",
      href: settlementHref(input.agenda.overdueSettlementIds),
      detail: null,
    },
    // 승인대기는 오너 결정을 기다리는 일(정보) — 늦음·위험의 뜻이 없어 심각도 색을 주지 않는다.
    { key: "approvals-pending", label: "승인대기", count: input.approvalsPending, tone: "info", href: "/approvals", detail: null },
    // 데이터 점검 — 종전 탭 배지 countTone="caution" 승계.
    { key: "data-check", label: "데이터 점검", count: input.dataCheck, tone: "caution", href: `/#${DATA_CHECK_ANCHOR}`, detail: null },
  );

  return rows.filter((row) => row.count > 0);
}

const ORDER_ROW_KEYS: ReadonlySet<TodayWorkKey> = new Set(["orders-pending", "orders-delayed", "orders-returns"]);

/**
 * 주문 동기화가 낡았거나(stale) 아직 없으면(waiting) 주문 행 건수는 **마지막으로 받은 스냅샷 기준**이다 —
 * 지금 일로 보이지 않게 심각도 색을 거두고(neutral), 낡은 경우엔 세부 줄 앞에 「N일 전 기준」을 붙인다
 * (2026-10-18 ss-ux P1-1). 경과일은 헤더의 「마지막 동기화 N일 전」과 같은 값(`resolveOrderSyncState`)이다.
 * 주문 밖의 행(영업·정산·승인·점검)은 주문 동기화와 무관하므로 그대로 둔다.
 */
export function markUnverifiedOrderRows(rows: TodayWorkRow[], sync: OrderSyncState | null): TodayWorkRow[] {
  if (sync?.kind !== "stale" && sync?.kind !== "waiting") return rows;
  const prefix = sync.kind === "stale" ? `${sync.daysAgo}일 전 기준` : null;
  return rows.map((row) => {
    if (!ORDER_ROW_KEYS.has(row.key)) return row;
    const detail = prefix ? (row.detail ? `${prefix} · ${row.detail}` : prefix) : row.detail;
    return { ...row, tone: "neutral", detail };
  });
}
