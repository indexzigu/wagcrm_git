// claimSource 재계산 백필 — 반품/교환 카드 구매자 정보(#118) 소급용.
//
// 배경: #118 이 claimSource 프로젝션에 주문자명·연락처·배송지(이름·연락처1)를 추가했지만,
// 봉투 버전(v1)을 올리지 않았으므로(올리면 전 행이 블롭 폴백 읽기로 떨어진다) 이미 저장된 행은
// 새 필드 없이 남는다. 진행 중 클레임은 CHANGED 동기화가 그 날짜를 다시 쓸 때 채워지지만
// 종결된 클레임은 다시 쓰일 계기가 없어 카드에 이름·연락처가 계속 '—' 로 보인다.
// 이 스크립트는 최근 N일 행의 claimSource 를 각 행의 orders 블롭으로 다시 계산한다.
//
// 판정 정본을 복제하지 않는다: 계산은 쓰기 경로와 같은 buildClaimSourceValue
// (naverOrderSnapshotRepository.rebuildClaimSource) 다. orders 블롭·다른 컬럼은 건드리지 않는다.
// 읽은 뒤 동기화가 같은 행을 고쳤으면(updatedAt 불일치) 덮지 않고 건너뛴다.
//
// 안전 규칙:
//   - 기본 dry-run. 실제 쓰기는 --apply 가 있을 때만. prod 대상 --apply 는 소유자 게이트다.
//   - 출력은 날짜별 건수뿐 — 이름·연락처 등 개인정보 값은 찍지 않는다.
//   - DATABASE_URL 을 그대로 쓴다(dotenv/config 가 .env 를 읽는다).
//     ⚠️ 셀프호스트 운영 체크아웃(~/selfhost/wagcrm)에는 루트 .env 가 없다 — 운영 설정은
//     infra/selfhost/.env 이며 deploy.sh·run-app.sh 처럼 먼저 로드해야 한다(아래 운영 실행).
//
// 실행:
//   npx tsx scripts/backfill-claim-source.ts                (dry-run, 최근 30일)
//   npx tsx scripts/backfill-claim-source.ts --days 45      (dry-run, 기간 지정)
//   npx tsx scripts/backfill-claim-source.ts --apply        (실제 쓰기 — 게이트)
// 운영 실행(셀프호스트):
//   cd ~/selfhost/wagcrm && (set -a; . infra/selfhost/.env; set +a; npx tsx scripts/backfill-claim-source.ts)

import 'dotenv/config';
import { prisma } from '../src/lib/order-converter/prisma';
import { naverOrderSnapshotRepository } from '../src/repositories/naverOrderSnapshotRepository';
import { toDateKeyKst } from '../src/lib/order-converter/naver-order-sync';
import { extractClaimSourceOrders, parseSnapshotClaimSource } from '../src/lib/order-converter/claim-derive';

function parseArgs(argv: string[]) {
  const apply = argv.includes('--apply');
  const daysIdx = argv.indexOf('--days');
  const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : 30;
  if (!Number.isInteger(days) || days <= 0) throw new Error(`--days 는 양의 정수여야 합니다: ${argv[daysIdx + 1]}`);
  return { apply, days };
}

/** 구매자명·연락처 중 하나라도 있는 클레임 주문 수. 값은 세기만 하고 내보내지 않는다. */
function countWithBuyer(orders: ReturnType<typeof extractClaimSourceOrders>): number {
  return orders.filter((o) => o.ordererName || o.ordererTel || o.shippingAddress?.name || o.shippingAddress?.tel1).length;
}

async function main() {
  const { apply, days } = parseArgs(process.argv.slice(2));
  const now = new Date();
  const start = toDateKeyKst(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
  const end = toDateKeyKst(now);
  console.log(`[backfill-claim-source] ${apply ? 'APPLY' : 'DRY-RUN'} · 범위 ${start} ~ ${end}`);

  const metas = await naverOrderSnapshotRepository.findRangeMeta(start, end);
  const dates = metas.map((m) => m.snapshotDate).sort();
  const currentByDate = new Map(
    (await naverOrderSnapshotRepository.findRangeClaimSources(start, end)).map((r) => [r.snapshotDate, r.claimSource]),
  );

  let changed = 0;
  let written = 0;
  let skipped = 0;
  for (const date of dates) {
    // 한 날짜씩 블롭을 읽는다(전 기간을 한 번에 올리지 않는다).
    const [row] = await naverOrderSnapshotRepository.findByDates([date]);
    if (!row) continue;
    const orders = naverOrderSnapshotRepository.parseOrders(row);
    const next = extractClaimSourceOrders(Array.isArray(orders) ? orders : []);
    const prev = parseSnapshotClaimSource(currentByDate.get(date)) ?? [];
    const before = countWithBuyer(prev);
    const after = countWithBuyer(next);
    const line = `${date}: 클레임 주문 ${next.length}건 · 구매자 정보 있음 ${before} → ${after}`;
    // 건너뛰기는 저장될 프로젝션 전체가 같을 때만 — 요약 건수만 보면 연락처만 달라진 행을 놓친다.
    if (JSON.stringify(prev) === JSON.stringify(next)) {
      console.log(`${line} (변화 없음)`);
      continue;
    }
    changed += 1;
    if (!apply) {
      console.log(`${line} (갱신 예정)`);
      continue;
    }
    const count = await naverOrderSnapshotRepository.rebuildClaimSource(date, row.updatedAt, orders);
    if (count === 1) {
      written += 1;
      console.log(`${line} (갱신함)`);
    } else {
      skipped += 1;
      console.log(`${line} (건너뜀 — 읽은 뒤 동기화가 이 날짜를 이미 다시 썼다)`);
    }
  }

  console.log(
    apply
      ? `[backfill-claim-source] 완료 · 대상 ${changed}일 · 갱신 ${written}일 · 건너뜀 ${skipped}일`
      : `[backfill-claim-source] dry-run 완료 · 갱신 예정 ${changed}일 — 실제 쓰기는 --apply`,
  );
}

main()
  .catch((err) => {
    console.error('[backfill-claim-source] 실패:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
