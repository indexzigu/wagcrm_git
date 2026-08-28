// 발주요청 배송대기 스탬프 소급 백필 — 스탬프 누락분(예: 2026-07-10 [김본명 X 보바] 배치) 복구용.
//
// 배경(버그 2026-07-10): send-email 라우트가 클라이언트가 넘긴 상품주문번호(productOrderIds)가
// 비면 OrderFulfillmentState.poRequestedAt을 하나도 찍지 않았다. 그 결과 발주요청된 주문이
// 파이프라인상 '주문확인'(newAfter)에 남아 대시보드 배송대기가 과소 집계됐다. 라우트는
// 서버측 폴백으로 수정됐고(모든 발송 경로 스탬프 보장), 이 스크립트는 "이미 발생한 과거 누락분"만
// 소급 스탬프한다.
//
// 판정 정본을 복제하지 않는다:
//   - 캠페인 귀속 주문 집합: resolveCampaignExpectedOrderIds (execute/validate와 동일 규칙, 라이브 재조회)
//   - 스탬프 쓰기: orderFulfillmentRepository.stampPoRequested (멱등 upsert)
//   - 기발송 판정: orderFulfillmentRepository.getPoRequestedSet
//
// 대상 선정(둘 중 하나):
//   (A) --ids <csv>       실제 발주서 파일에 실린 상품주문번호를 직접 지정(가장 정확 — 권장).
//   (B) --campaign <idOrName>  캠페인의 유효 주문(PAYED/PRODUCT_ORDERED) 중 아직 발주요청되지
//                              않은 건 전체를 대상으로 삼는다(라이브 재조회). (A)를 모를 때의 근사.
//   두 옵션을 함께 주면 --ids ∩ (해당 캠페인 귀속 집합)으로 교차 검증한다.
//
// 시각(--at):
//   poRequestedAt에 찍을 시각. 과거 발송의 감사 정확성을 위해 실제 발송 시각(KST)을 주는 것을 권장.
//   예: 2026-07-10 11:57 KST → --at 2026-07-10T02:57:00.000Z (UTC). 생략 시 현재 시각.
//   ⚠️ 이미 poRequestedAt이 있는 건은 건드리지 않는다(원 시각 보존) — 순수 누락분만 채운다.
//
// 안전 규칙(memory: wag-crm-migration-direct-execute — 멱등, migrate deploy 금지):
//   - 기본 dry-run. 실제 쓰기는 --apply 플래그가 있을 때만.
//   - ⚠️ 원격/prod DB 대상 --apply는 소유자 게이트다. 이 스크립트는 임의로 원격에 쓰지 않는다.
//   - DATABASE_URL을 그대로 사용(로컬 sqlite/원격 postgres 양쪽). 단독 실행 시 .env 로드 필요
//     (memory: wag-crm-script-env-loading) — dotenv/config가 .env를 읽는다.
//
// 실행:
//   npx tsx scripts/backfill-po-requested-stamps.ts --campaign "<캠페인id 또는 이름>"                 (dry-run)
//   npx tsx scripts/backfill-po-requested-stamps.ts --ids "2024...,2024..." --campaign "<id>"          (dry-run, 교차검증)
//   npx tsx scripts/backfill-po-requested-stamps.ts --campaign "<id>" --at 2026-07-10T02:57:00.000Z     (dry-run, 시각지정)
//   npx tsx scripts/backfill-po-requested-stamps.ts --campaign "<id>" --at 2026-07-10T02:57:00.000Z --apply   (실제 쓰기 — 게이트)

import 'dotenv/config';
import { prisma } from '../src/lib/order-converter/prisma';
import { orderFulfillmentRepository } from '../src/repositories/orderFulfillmentRepository';
import { resolveCampaignExpectedOrderIds } from '../src/lib/order-converter/campaign-orders';

type Args = {
  apply: boolean;
  campaign: string | null;
  ids: string[];
  at: Date | null;
};

function parseArgs(argv: string[]): Args {
  const apply = argv.includes('--apply');

  const campIdx = argv.indexOf('--campaign');
  const campaign = campIdx >= 0 ? argv[campIdx + 1] ?? null : null;

  const idsIdx = argv.indexOf('--ids');
  const idsRaw = idsIdx >= 0 ? argv[idsIdx + 1] ?? '' : '';
  const ids = idsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const atIdx = argv.indexOf('--at');
  let at: Date | null = null;
  if (atIdx >= 0 && argv[atIdx + 1]) {
    const d = new Date(argv[atIdx + 1]);
    if (isNaN(d.getTime())) throw new Error(`--at 시각 파싱 실패: "${argv[atIdx + 1]}" (ISO 8601 필요)`);
    at = d;
  }

  return { apply, campaign, ids, at };
}

/** 캠페인 id 또는 이름으로 캠페인을 찾는다. 이름은 부분일치 허용(유일해야 함). */
async function resolveCampaignId(idOrName: string): Promise<{ id: string; name: string }> {
  const byId = await prisma.orderCampaign.findUnique({ where: { id: idOrName }, select: { id: true, name: true } });
  if (byId) return byId;

  const byName = await prisma.orderCampaign.findMany({
    where: { name: { contains: idOrName } },
    select: { id: true, name: true },
  });
  if (byName.length === 1) return byName[0];
  if (byName.length === 0) throw new Error(`캠페인을 찾지 못했습니다: "${idOrName}"`);
  throw new Error(
    `캠페인 이름이 여러 개 일치합니다("${idOrName}") — id로 지정하세요:\n` +
      byName.map((c) => `  - ${c.id}  ${c.name}`).join('\n'),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.campaign && args.ids.length === 0) {
    throw new Error('대상이 없습니다 — --campaign <idOrName> 또는 --ids <csv> 중 하나는 필수입니다.');
  }

  const stampAt = args.at ?? new Date();
  console.log('─'.repeat(72));
  console.log('발주요청 배송대기 스탬프 백필');
  console.log(`  모드      : ${args.apply ? '⚠️  APPLY (실제 쓰기)' : 'dry-run (미리보기만)'}`);
  console.log(`  스탬프시각: ${stampAt.toISOString()}  (${args.at ? '지정' : '현재시각 폴백'})`);
  console.log('─'.repeat(72));

  // 1) 대상 후보 집합 산출
  let campaignId: string | null = null;
  let candidateIds: string[] = [];

  if (args.campaign) {
    const camp = await resolveCampaignId(args.campaign);
    campaignId = camp.id;
    console.log(`캠페인: ${camp.id}  ${camp.name}`);
    console.log('캠페인 귀속 주문 라이브 재조회 중(execute/validate와 동일 규칙)…');
    const { orderIds, count } = await resolveCampaignExpectedOrderIds(camp.id);
    console.log(`  유효 주문(PAYED/PRODUCT_ORDERED) ${count}건 조회됨.`);
    const campaignSet = orderIds;

    if (args.ids.length > 0) {
      // 교차검증: --ids 중 이 캠페인에 실제 귀속된 것만. 외부 ID는 경고 후 제외.
      const inSet = args.ids.filter((id) => campaignSet.has(id));
      const foreign = args.ids.filter((id) => !campaignSet.has(id));
      if (foreign.length > 0) {
        console.warn(`  ⚠️ --ids 중 이 캠페인에 귀속되지 않는 ${foreign.length}건은 제외: ${foreign.slice(0, 10).join(', ')}`);
      }
      candidateIds = inSet;
    } else {
      candidateIds = Array.from(campaignSet);
    }
  } else {
    // 캠페인 없이 --ids만: 캠페인 대조 없이 지정 ID 그대로(교차검증 불가 — 신중히).
    candidateIds = args.ids;
    console.warn('⚠️ --campaign 없이 --ids만 지정됨 — 캠페인 귀속 대조 없이 지정 ID를 그대로 스탬프합니다.');
  }

  if (candidateIds.length === 0) {
    console.log('대상 후보가 0건입니다. 종료.');
    return;
  }

  // 2) 이미 발주요청된 건 제외(원 시각 보존) — 순수 누락분만.
  const already = await orderFulfillmentRepository.getPoRequestedSet(candidateIds);
  const toStamp = candidateIds.filter((id) => !already.has(id));

  console.log('');
  console.log(`후보          : ${candidateIds.length}건`);
  console.log(`이미 발주요청  : ${already.size}건 (건드리지 않음 — 원 시각 보존)`);
  console.log(`스탬프 대상    : ${toStamp.length}건 (누락분)`);
  if (toStamp.length > 0) {
    console.log('  대상 상품주문번호:');
    console.log('   ' + toStamp.join(', '));
  }

  if (toStamp.length === 0) {
    console.log('\n누락분이 없습니다 — 이미 모두 스탬프됨. 종료.');
    return;
  }

  if (!args.apply) {
    console.log('\n[dry-run] 실제 쓰기는 하지 않았습니다. 위 대상이 맞으면 --apply 를 붙여 다시 실행하세요.');
    console.log('⚠️ 원격/prod --apply 는 소유자 승인 게이트입니다.');
    return;
  }

  // 3) APPLY — 멱등 upsert. 지정 시각으로 poRequestedAt을 찍는다.
  //    stampPoRequested는 now()로 찍으므로, 과거 시각 지정 시 여기서 명시적으로 upsert한다.
  console.log('\n⚠️ APPLY — 스탬프 쓰기 시작…');
  const cid = campaignId ?? null;
  let stamped = 0;
  for (const productOrderId of toStamp) {
    await prisma.orderFulfillmentState.upsert({
      where: { productOrderId },
      update: { poRequestedAt: stampAt, ...(cid ? { campaignId: cid } : {}) },
      create: { productOrderId, campaignId: cid, poRequestedAt: stampAt },
    });
    stamped++;
  }
  console.log(`완료: ${stamped}건 스탬프됨 (poRequestedAt=${stampAt.toISOString()}).`);
  console.log('대시보드 배송대기 카운트에 반영되려면 캐시/스냅샷 갱신이 필요할 수 있습니다.');
}

main()
  .catch((err) => {
    console.error('백필 실패:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
