// [읽기 전용 진단] 셀러 분석 이식 §12-0 — 자사 성과 앵커 조인 카디널리티 실측.
// "SalesCampaign 실적을 가진 유효 셀러" 풀의 규모·분포를 측정해, 예상 판매 밴드 앵커가
// "유사 n명"급 정밀 앵커인지 "카테고리 평균"급인지 판정한다. 쓰기·PII 조회 없음.
// 실행: set -a; source .env; set +a; npx -y tsx scripts/check-anchor-cardinality.ts
import { getPrisma } from "../src/lib/prisma";

function band(f: number): string {
  if (f <= 0) return "0/미상";
  if (f < 10_000) return "나노 <1만";
  if (f < 50_000) return "마이크로 1~5만";
  if (f < 100_000) return "미드 5~10만";
  if (f < 500_000) return "미드+ 10~50만";
  return "메가 50만+";
}

function tally(rows: { key: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.key] = (out[r.key] ?? 0) + 1;
  return out;
}

async function main() {
  const prisma = getPrisma();
  const line = (s = "") => console.log(s);

  const totalSellers = await prisma.seller.count();
  const withAnyCampaign = await prisma.seller.count({
    where: { campaigns: { some: {} } },
  });
  const withRealSales = await prisma.seller.count({
    where: { campaigns: { some: { actualSales: { gt: 0 } } } },
  });

  line("===== 셀러 풀 규모 =====");
  line(`전체 셀러: ${totalSellers}`);
  line(`캠페인 이력 ≥1 (유효, 넓은 정의): ${withAnyCampaign}`);
  line(`실매출(actualSales>0) 캠페인 ≥1 (유효, 엄격/앵커 근거): ${withRealSales}`);
  line("");

  // 실적 보유 유효 셀러 — 스크래핑 가능성(snsType)·카테고리·팔로워·캠페인 횟수 분포
  const validSellers = await prisma.seller.findMany({
    where: { campaigns: { some: { actualSales: { gt: 0 } } } },
    select: {
      snsType: true,
      category: true,
      currentFollowers: true,
      _count: { select: { campaigns: true } },
    },
  });

  line("===== 실적 보유 유효 셀러의 SNS 유형 (스크래핑 가능성) =====");
  const bySns = tally(validSellers.map((s) => ({ key: s.snsType || "미상" })));
  for (const [k, v] of Object.entries(bySns).sort((a, b) => b[1] - a[1])) line(`  ${k}: ${v}`);
  line("");

  const igValid = validSellers.filter((s) => (s.snsType || "").toUpperCase() === "INSTAGRAM");
  line(`===== 유효 ∩ INSTAGRAM = ${igValid.length}명 (앵커 실질 모수) =====`);

  line("-- 카테고리 분포 (카테고리별 '유사 n명' 앵커 가능성) --");
  const byCat = tally(igValid.map((s) => ({ key: s.category || "미분류" })));
  for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) line(`  ${k}: ${v}`);
  line("");

  line("-- 팔로워 구간 분포 --");
  const byBand = tally(igValid.map((s) => ({ key: band(s.currentFollowers ?? 0) })));
  for (const [k, v] of Object.entries(byBand).sort((a, b) => b[1] - a[1])) line(`  ${k}: ${v}`);
  line("");

  line("-- 캠페인 횟수 분포 (반복 셀러 = 강한 그라운드트루스) --");
  const byRounds = tally(
    igValid.map((s) => {
      const n = s._count.campaigns;
      return { key: n >= 5 ? "5회+" : `${n}회` };
    })
  );
  for (const [k, v] of Object.entries(byRounds).sort((a, b) => Number(a[0][0]) - Number(b[0][0]))) line(`  ${k}: ${v}`);
  line("");

  // 실매출 캠페인 규모 감각 (앵커 학습 표본 수)
  const realSalesCampaigns = await prisma.salesCampaign.count({ where: { actualSales: { gt: 0 } } });
  const statusGroups = await prisma.salesCampaign.groupBy({ by: ["status"], _count: { _all: true } });
  line("===== SalesCampaign 표본 =====");
  line(`실매출>0 캠페인 총: ${realSalesCampaigns}`);
  line("상태 분포:");
  for (const g of statusGroups.sort((a, b) => b._count._all - a._count._all)) line(`  ${g.status}: ${g._count._all}`);
  line("");

  // 앵커 판정 요약
  line("===== 앵커 판정 (§12-0) =====");
  const perCatMin = Object.values(byCat);
  const median = perCatMin.length ? perCatMin.sort((a, b) => a - b)[Math.floor(perCatMin.length / 2)] : 0;
  line(`유효 ∩ IG 모수 ${igValid.length}명 · 주요 카테고리 중앙 표본 ~${median}명`);
  line(
    igValid.length >= 40 && median >= 5
      ? "→ '유사 n명' 카테고리별 앵커 가능성 있음 (표본 검토 후 확정)"
      : "→ 표본 부족 — 초기엔 '카테고리 평균' 또는 '풀 전체 상대순위'로 시작 권장"
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("측정 실패:", e?.message || e);
  process.exit(1);
});
