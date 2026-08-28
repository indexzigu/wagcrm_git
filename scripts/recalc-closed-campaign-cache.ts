/**
 * 마감(비활성) 캠페인 통계 캐시 재계산 백필.
 *
 * 배경: cachedTotalQuantity/cachedTotalRevenue/cachedDistinctOrderCount 등은 마감 시점에
 *   INVALID_ORDER_STATUSES로 계산돼 굳는다. 과거 'PAY_WAITING'(오타)·'CANCELED_BY_NOPAYMENT'
 *   (누락) 버그(2026-07-10 수정)로 결제대기·미결제취소 주문이 판매로 오집계된 값이 남아 있어,
 *   상수만 고쳐선 자동 교정되지 않는다. 이 스크립트가 마감 라우트와 동일한 공유 로직
 *   (closed-campaign-cache SSOT)으로 재계산해 캐시를 교정한다.
 *
 * 사용:
 *   source .env && npx tsx scripts/recalc-closed-campaign-cache.ts                 # dry-run(기본, 쓰기 없음)
 *   source .env && npx tsx scripts/recalc-closed-campaign-cache.ts --name=보바      # 이름 부분일치 필터
 *   source .env && npx tsx scripts/recalc-closed-campaign-cache.ts --limit=5        # 앞 N건만
 *   source .env && npx tsx scripts/recalc-closed-campaign-cache.ts --apply          # 실제 DB 반영
 *
 * 네이버 상품주문 API를 캠페인 판매기간 구간만큼 재조회한다(campEnd 이후는 어차피 집계에서
 * 필터되므로 fetch 종료를 campEnd+1일로 캡해 과호출을 줄인다). 실주문 데이터라 --apply 전에는
 * 반드시 dry-run diff로 변화량을 확인할 것.
 */
import { getPrisma } from "../src/lib/prisma";
import { apiRequest } from "../src/lib/order-converter/naver-commerce-client";
import { orderFulfillmentRepository } from "../src/repositories/orderFulfillmentRepository";
import { computeClosedCampaignCache, fetchClosedCampaignOrders, resolveClosedCampaignPeriod } from "../src/lib/order-converter/closed-campaign-cache";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALLOW_ZERO = args.includes("--allow-zero"); // 이전 비영(非零) 캐시를 0으로 덮는 것을 명시 허용
const nameArg = args.find((a) => a.startsWith("--name="))?.slice("--name=".length) ?? "";
const idArg = args.find((a) => a.startsWith("--id="))?.slice("--id=".length) ?? "";
const limitArg = Number(args.find((a) => a.startsWith("--limit="))?.slice("--limit=".length) ?? "0");

const won = (n: number | null | undefined) => (n ?? 0).toLocaleString();
const delta = (oldV: number, newV: number) => {
  const d = newV - oldV;
  return d === 0 ? "±0" : d > 0 ? `+${won(d)}` : won(d);
};

async function main() {
  const prisma = getPrisma();
  console.log(`\n=== 마감 캠페인 캐시 재계산 (${APPLY ? "APPLY — DB 반영" : "DRY-RUN — 쓰기 없음"}) ===`);
  if (nameArg) console.log(`  이름 필터: "${nameArg}"`);
  if (idArg) console.log(`  id 필터: ${idArg}`);
  if (limitArg) console.log(`  최대 ${limitArg}건`);

  let campaigns = await prisma.orderCampaign.findMany({
    where: { isActive: false },
    include: { mappings: true },
    orderBy: { updatedAt: "desc" },
  });
  if (idArg) campaigns = campaigns.filter((c: any) => c.id === idArg);
  if (nameArg) campaigns = campaigns.filter((c: any) => (c.name || "").includes(nameArg));
  if (limitArg > 0) campaigns = campaigns.slice(0, limitArg);

  // 교차 귀속 가드용 peer — 필터(id/name/limit)와 무관하게 전 캠페인. 대상만 넘기면
  // `--id` 로 한 건만 돌릴 때와 전량 돌릴 때 결과가 달라지는 비결정성이 생긴다.
  const peerCampaigns = await prisma.orderCampaign.findMany({ select: { id: true, name: true, startDate: true, endDate: true, salePeriod: true } });

  console.log(`  대상 마감 캠페인: ${campaigns.length}건\n`);
  if (campaigns.length === 0) { await (prisma as any).$disconnect?.(); return; }

  const now = new Date();
  let changed = 0, skipped = 0, applied = 0;

  for (const camp of campaigns as any[]) {
    const { start, end } = resolveClosedCampaignPeriod(camp);
    if (!start) { console.log(`  ⏭  "${camp.name}" — 판매기간(start) 불명, 스킵`); skipped++; continue; }

    // campEnd 이후 주문은 compute의 window.end 필터로 어차피 제외되므로 fetch 종료를 캡(과호출 감소).
    const fetchNow = end ? new Date(Math.min(now.getTime(), end.getTime() + 86400000)) : now;

    let recentOrders: any[] = [];
    try {
      recentOrders = await fetchClosedCampaignOrders(start, apiRequest, { now: fetchNow });
    } catch (e: any) {
      console.log(`  ⚠️  "${camp.name}" — 주문 조회 실패: ${e?.message || e}, 스킵`); skipped++; continue;
    }

    let poRequestedSet = new Set<string>();
    try {
      poRequestedSet = await orderFulfillmentRepository.getPoRequestedSet(
        recentOrders.map((o: any) => o?.productOrderId).filter(Boolean),
      );
    } catch { /* 빈 집합 폴백 — 배송대기 보수적 0 */ }

    const next = computeClosedCampaignCache(camp, recentOrders, poRequestedSet, { start, end }, peerCampaigns);

    const oldQ = camp.cachedTotalQuantity ?? 0, newQ = next.cachedTotalQuantity;
    const oldR = camp.cachedTotalRevenue ?? 0, newR = next.cachedTotalRevenue;
    const oldO = camp.cachedTotalOrders ?? 0, newO = next.cachedTotalOrders;
    const oldD = camp.cachedDistinctOrderCount ?? 0, newD = next.cachedDistinctOrderCount;
    // 인사이트 스냅샷 백필: 숫자 무변화라도 cachedInsights가 비어있던 과거 마감 캠페인은 이번에 채운다
    // (주문을 실제로 가져온 경우에만 — 빈 스냅샷 덮어쓰기 방지).
    const insightsBackfill = (camp as any).cachedInsights == null && recentOrders.length > 0;
    const diff = oldQ !== newQ || oldR !== newR || oldO !== newO || oldD !== newD || insightsBackfill;

    const tag = diff ? "🔧" : "  ";
    console.log(`  ${tag} "${camp.name}"  (주문 ${recentOrders.length}건 조회)`);
    console.log(`       주문(distinct) ${oldD} → ${newD} (${delta(oldD, newD)}) · 상품 ${oldO} → ${newO} (${delta(oldO, newO)})`);
    console.log(`       수량 ${oldQ} → ${newQ} (${delta(oldQ, newQ)}) · 매출 ${won(oldR)} → ${won(newR)} (${delta(oldR, newR)})`);

    // 안전 가드: 이전에 값이 있던 캐시가 전부 0으로 바뀌는 건 십중팔구 조회 누락(네이버 데이터 보존기간
    // 초과·부분 실패)이다. 정상적 판매 0은 드물다 → --allow-zero 없이는 이 케이스를 쓰지 않는다.
    const wouldZeroOut = (oldQ > 0 || oldR > 0 || oldO > 0) && newQ === 0 && newR === 0 && newO === 0;
    if (wouldZeroOut && !ALLOW_ZERO) {
      console.log(`       ⚠️  이전 비영 캐시 → 전부 0. 조회 누락 의심으로 쓰기 보류(강제하려면 --allow-zero).`);
      skipped++;
      continue;
    }

    if (diff) changed++;
    if (APPLY && diff) {
      await prisma.orderCampaign.update({ where: { id: camp.id }, data: next as any });
      applied++;
      console.log(`       ✅ DB 반영됨`);
    }
  }

  console.log(`\n=== 요약 ===`);
  console.log(`  변화 있음: ${changed}건 · 변화 없음: ${campaigns.length - changed - skipped}건 · 스킵: ${skipped}건`);
  if (APPLY) console.log(`  DB 반영: ${applied}건`);
  else if (changed > 0) console.log(`  (dry-run) 반영하려면 --apply 를 붙여 다시 실행하세요.`);

  await (prisma as any).$disconnect?.();
}

main().catch((e) => { console.error(e); process.exit(1); });
