/**
 * 마이그레이션 스크립트: proposalStatus → SalesTask
 *
 * 기존 셀러의 proposalStatus 값을 SalesTask 레코드로 변환합니다.
 * 딜 정보가 없는 경우 "[미지정]" 플레이스홀더 딜을 사용합니다.
 *
 * 매핑 룰:
 *   0.미발신  → 생성 안 함 (skip)
 *   0.응답없음 → DROPPED
 *   1.답변회신 → PROPOSED
 *   2.소통적극 → NEGOTIATION
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const STATUS_MAP: Record<string, string | null> = {
  "0.미발신": null,         // skip
  "0.제안발송": "PROPOSED", // 제안 발송 완료, 회신 미확인
  "0.응답없음": "DROPPED",
  "1.답변회신": "PROPOSED",
  "2.소통적극": "NEGOTIATION",
};

const PLACEHOLDER_PARTNER_NAME = "[시스템]";
const PLACEHOLDER_DEAL_NAME = "[미지정]";

async function main() {
  console.log("=== proposalStatus → SalesTask 마이그레이션 시작 ===\n");

  // 1. 플레이스홀더 파트너 확인/생성
  let partner = await prisma.partner.findFirst({
    where: { name: PLACEHOLDER_PARTNER_NAME },
  });
  if (!partner) {
    partner = await prisma.partner.create({
      data: {
        name: PLACEHOLDER_PARTNER_NAME,
        type: "VENDOR",
        notes: "proposalStatus 마이그레이션용 시스템 파트너. 수동 삭제 금지.",
      },
    });
    console.log(`✅ 플레이스홀더 파트너 생성: ${partner.id}`);
  } else {
    console.log(`ℹ️  기존 플레이스홀더 파트너 사용: ${partner.id}`);
  }

  // 2. 플레이스홀더 딜 확인/생성
  let deal = await prisma.deal.findFirst({
    where: { dealName: PLACEHOLDER_DEAL_NAME, partnerId: partner.id },
  });
  if (!deal) {
    deal = await prisma.deal.create({
      data: {
        dealName: PLACEHOLDER_DEAL_NAME,
        partnerId: partner.id,
        costPrice: 0,
        sellingPrice: 0,
        status: "ARCHIVED",
        baseMarginPolicy: JSON.stringify({ byChannel: {} }),
        sourcingMemo: "proposalStatus 마이그레이션용 딜. 수동 삭제 금지.",
      },
    });
    console.log(`✅ 플레이스홀더 딜 생성: ${deal.id}`);
  } else {
    console.log(`ℹ️  기존 플레이스홀더 딜 사용: ${deal.id}`);
  }

  // 3. proposalStatus가 있는 셀러 목록 조회
  const sellers = await prisma.seller.findMany({
    where: { proposalStatus: { not: null } },
    select: {
      id: true,
      name: true,
      proposalStatus: true,
      salesTasks: {
        where: { dealId: deal.id },
        select: { id: true },
        take: 1,
      },
    },
  });

  console.log(`\n대상 셀러: ${sellers.length}명`);

  let skipped = 0;
  let created = 0;
  let alreadyExists = 0;
  let unknownStatus = 0;

  for (const seller of sellers) {
    const raw = seller.proposalStatus!;
    const targetStatus = STATUS_MAP[raw];

    // 매핑에 없는 값
    if (!(raw in STATUS_MAP)) {
      console.log(`  ⚠️  [${seller.name}] 알 수 없는 status: "${raw}" → 건너뜀`);
      unknownStatus++;
      continue;
    }

    // 미발신: 생성 안 함
    if (targetStatus === null) {
      console.log(`  ⏭️  [${seller.name}] 미발신 → 건너뜀`);
      skipped++;
      continue;
    }

    // 이미 플레이스홀더 딜로 SalesTask가 있으면 스킵
    if (seller.salesTasks.length > 0) {
      console.log(`  ♻️  [${seller.name}] 이미 마이그레이션됨 → 건너뜀`);
      alreadyExists++;
      continue;
    }

    // SalesTask 생성
    await prisma.salesTask.create({
      data: {
        dealId: deal.id,
        sellerId: seller.id,
        status: targetStatus,
        contactChannel: "DM",
        proposalMessage: `[마이그레이션] 기존 상태: ${raw}`,
        // DROPPED인 경우 droppedAt 기록
        ...(targetStatus === "DROPPED" ? { droppedAt: new Date() } : {}),
      },
    });

    console.log(`  ✅ [${seller.name}] "${raw}" → ${targetStatus}`);
    created++;
  }

  console.log(`
=== 마이그레이션 완료 ===
  생성됨:       ${created}건
  미발신 스킵:  ${skipped}건
  이미 존재:    ${alreadyExists}건
  알 수 없음:   ${unknownStatus}건
`);
}

main()
  .catch((e) => {
    console.error("마이그레이션 실패:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
