/**
 * 읽기 전용 진단: `/v1/pay-order/seller/product-orders` 의 페이지네이션 계약 확인.
 *
 * 왜: 이 엔드포인트를 부르는 5곳(execute · execute/stream · campaign-orders ·
 * closed-campaign-cache · naver-order-sync runFullSync)이 전부 `pageSize: 300` 만 주고
 * 페이징을 따라가지 않는다. 같은 파일의 변경피드는 `more/moreSequence` 를 따라가고 정산
 * 동기화도 페이징하는데 이것만 안 한다 — 하루 물량이 300을 넘으면 초과분이 조용히
 * 잘리고, 그 오염이 **스냅샷 빌더까지** 번진다(발주서 누락 = 배송 누락, P0).
 *
 * 판정 방법: 같은 창을 `pageSize=1` 과 `pageSize=300` 으로 두 번 조회한다.
 *  - 1건만 오고 응답에 페이징 메타가 있으면 → **절단 확정**, 헬퍼에 페이징 필수.
 *  - pageSize 와 무관하게 같은 수가 오면 → pageSize 는 무시되는 파라미터.
 *
 * ⚠️ 읽기 전용이다(GET). 주문 내용은 출력하지 않는다 — 응답 봉투의 키와 개수만 찍는다(P0 PII).
 *
 * 사용: set -a; . .env; set +a; npx tsx scripts/probe-product-orders-paging.ts
 */
import { getPrisma } from "../src/lib/prisma";
import { apiRequest } from "../src/lib/order-converter/naver-commerce-client";

/** 응답 봉투 구조만 얕게 요약한다(주문 내용·PII 미출력). */
function describeEnvelope(res: any): Record<string, unknown> {
  const data = res?.data ?? {};
  const out: Record<string, unknown> = {
    topLevelKeys: Object.keys(res ?? {}),
    dataKeys: Object.keys(data),
    contentsLength: Array.isArray(data.contents) ? data.contents.length : null,
  };
  // 페이징 메타 후보를 전수 노출 — 이름을 모르므로 contents 외 전 키의 타입/값을 찍는다.
  for (const [k, v] of Object.entries(data)) {
    if (k === "contents") continue;
    out[`data.${k}`] = v && typeof v === "object" ? { keys: Object.keys(v) } : v;
  }
  return out;
}

async function main() {
  const prisma = getPrisma();

  // 물량이 가장 많았던 KST 날짜를 고른다(절단 가능성이 가장 큰 창).
  const busiest = await prisma.$queryRawUnsafe<
    Array<{ snapshotDate: string; ordersCount: number }>
  >(`SELECT "snapshotDate", "ordersCount" FROM "NaverOrderSnapshot"
     ORDER BY "ordersCount" DESC LIMIT 1`);

  if (busiest.length === 0) {
    console.error("스냅샷이 없어 대상 날짜를 고를 수 없다.");
    return;
  }

  const dateKey = busiest[0].snapshotDate;
  const snapshotCount = Number(busiest[0].ordersCount);
  const from = new Date(`${dateKey}T00:00:00.000+09:00`).toISOString();
  const to = new Date(`${dateKey}T23:59:59.999+09:00`).toISOString();

  console.log(`대상 창(KST ${dateKey}): ${from} ~ ${to}`);
  console.log(`스냅샷이 기록한 그 날 라인수: ${snapshotCount}\n`);

  for (const pageSize of ["1", "300"]) {
    try {
      const res: any = await apiRequest("GET", "/v1/pay-order/seller/product-orders", undefined, {
        from,
        to,
        pageSize,
      });
      console.log(`--- pageSize=${pageSize} ---`);
      console.log(JSON.stringify(describeEnvelope(res), null, 1));
      console.log("");
    } catch (err: any) {
      console.error(`pageSize=${pageSize} 조회 실패:`, err?.message || err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("판정 기준:");
  console.log(" · pageSize=1 이 1건만 반환 → pageSize 가 실제로 먹는다 = 300 초과분은 잘린다(페이징 필수)");
  console.log(" · 두 조회의 contentsLength 가 같다 → pageSize 무시(절단 없음)");
  console.log(` · pageSize=300 결과가 스냅샷 수(${snapshotCount})와 다르면 그 차이도 단서다`);
}

main()
  .catch((err) => {
    console.error("probe 실패:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
