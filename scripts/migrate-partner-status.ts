import { createPrismaClient } from "../src/lib/prisma-client";

const prisma = createPrismaClient();

const STATUS_MAP: Record<string, string> = {
  "진행": "거래중",
  "미진행": "거래중단",
  "응답없음": "응답없음",
};

async function main() {
  console.log("=== 거래처 상태(status) 데이터 마이그레이션 시작 ===\n");

  // 1. 모든 파트너 조회
  const partners = await prisma.partner.findMany({
    select: {
      id: true,
      name: true,
      companyStatus: true,
      status: true,
    },
  });

  console.log(`총 거래처 수: ${partners.length}개`);
  
  let migratedCount = 0;
  let skippedCount = 0;

  for (const partner of partners) {
    const rawStatus = partner.companyStatus;
    
    // companyStatus에 값이 있고, "진행", "미진행", "응답없음" 중 하나인 경우
    if (rawStatus && rawStatus in STATUS_MAP) {
      const targetStatus = STATUS_MAP[rawStatus];
      
      console.log(`🔄 [${partner.name}] 마이그레이션 대상: "${rawStatus}" -> "${targetStatus}"`);
      
      await prisma.partner.update({
        where: { id: partner.id },
        data: {
          status: targetStatus,
          companyStatus: null, // 기존 companyStatus는 비움
        },
      });
      migratedCount++;
    } else {
      // 기존 홈택스 조회값(예:계속사업자)인 경우 status 기본값 부여 여부
      // 이미 status 값이 있으면 건너뛰고, 없으면 기본값인 "거래중"을 넣어줄 수 있으나
      // 사용자 규칙 상 기존 상태값만 이동하는 것이 목표이므로, 그 외에는 status를 비워두거나 필요에 따라 처리
      // 여기서는 status가 null이고 특별히 companyStatus가 홈택스 값(예: 계속사업자)인 경우 기본값 "거래중"을 처리해줄 수도 있음
      // 하지만 마이그레이션 안전성을 위해 명시적 대상만 이동하도록 한다.
      skippedCount++;
    }
  }

  console.log(`
=== 마이그레이션 완료 ===
  - 변경 완료: ${migratedCount}건
  - 스킵(유지): ${skippedCount}건
`);
}

main()
  .catch((e) => {
    console.error("❌ 마이그레이션 실패:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
