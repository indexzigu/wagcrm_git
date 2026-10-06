// 반품·교환·취소 클레임의 **읽기 경로** SSOT(서버 전용 · 네이버 호출 없음).
//
// 주문 관리 「반품/교환」 목록(`order-converter/api/naver/claims`)과 홈 「오늘 처리할 주문」 요약
// (`order-work-summary.ts`)이 같은 창·같은 소스·같은 캠페인 후보로 클레임을 파생한다 — 한쪽만
// 고치면 두 화면의 「진행 중 클레임」 숫자가 조용히 갈린다.
//
// 소스는 동기화가 쓰기 시점에 저장한 `claimSource`(클레임 보유 주문 최소 프로젝션)이고, 미가용 행
// (레거시 null·{v:0}·버전 불일치)만 그 날짜 블롭을 폴백으로 읽어 동일 SSOT
// (`extractClaimSourceOrders` → `deriveClaims`)로 파생한다(P7 Claims Read = claimSource Column Only).
// ⛔ 30일 orders 블롭 전량을 읽어 파생하지 말 것 — 과거 egress 초과의 최대 지분이었다.

import { naverOrderSnapshotRepository } from '@/repositories/naverOrderSnapshotRepository';
import { toDateKeyKst } from '@/lib/order-converter/naver-order-sync';
import {
  extractClaimSourceOrders,
  parseSnapshotClaimSource,
  type CampaignMatchInfo,
} from '@/lib/order-converter/claim-derive';

/** 클레임 조회 창(일) — 주문 관리 「반품/교환」 목록과 같은 값. */
export const CLAIM_WINDOW_DAYS = 30;

export function resolveClaimWindowKeys(now: Date): { startDateKey: string; endDateKey: string } {
  const start = new Date(now.getTime() - CLAIM_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { startDateKey: toDateKeyKst(start), endDateKey: toDateKeyKst(now) };
}

/** egress 계측용 근사 바이트 — DB에서 받은 값을 JSON 직렬화한 utf8 길이. */
function approxJsonBytes(value: unknown): number {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.byteLength(text ?? '', 'utf8');
}

/**
 * 창 안의 클레임 보유 주문(프로젝션) — `deriveClaims` 입력. 실패는 던진다.
 * `logTag` 는 egress 계측 줄의 접두어다(어느 표면이 당겼는지 구분).
 */
export async function loadClaimSourceOrders(
  startDateKey: string,
  endDateKey: string,
  logTag: string,
): Promise<any[]> {
  const sourceRows = await naverOrderSnapshotRepository.findRangeClaimSources(startDateKey, endDateKey);

  const claimOrders: any[] = [];
  const fallbackDates: string[] = [];
  let sourceBytes = 0;
  for (const row of sourceRows) {
    sourceBytes += approxJsonBytes(row.claimSource);
    const projected = parseSnapshotClaimSource(row.claimSource);
    if (projected) claimOrders.push(...projected);
    else fallbackDates.push(row.snapshotDate);
  }

  let fallbackBytes = 0;
  if (fallbackDates.length > 0) {
    const blobRows = await naverOrderSnapshotRepository.findByDates(fallbackDates);
    for (const snapshot of blobRows) {
      fallbackBytes += approxJsonBytes(snapshot.orders);
      const orders = naverOrderSnapshotRepository.parseOrders(snapshot);
      if (Array.isArray(orders)) claimOrders.push(...extractClaimSourceOrders(orders));
    }
  }

  // L3 계측 — 이 경로가 DB에서 실제로 당긴 근사 바이트.
  console.log(
    `[egress] ${logTag}: rows=${sourceRows.length} sourceBytes=${sourceBytes} fallbackRows=${fallbackDates.length} fallbackBytes=${fallbackBytes}`,
  );
  return claimOrders;
}

/**
 * 활성 주문캠페인 → 클레임 캠페인 귀속 후보. productId + 판매기간으로 귀속한다(상품명 fuzzy 는
 * productId 없는 캠페인/주문 폴백). 기간은 **저장된** startDate/endDate 다.
 */
export function toClaimCampaignCandidates(
  campaigns: Array<{ name: string | null; productId?: string | null; startDate?: Date | string | null; endDate?: Date | string | null }>,
): CampaignMatchInfo[] {
  return campaigns
    .filter((c): c is typeof c & { name: string } => !!c.name)
    .map((c) => ({ name: c.name, productId: c.productId, startDate: c.startDate, endDate: c.endDate }));
}
