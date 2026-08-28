/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  console.log("셀러 카테고리 다대다 매핑 일괄 마이그레이션을 시작합니다...");

  // 1. 카테고리 필드가 있고, 매핑 정보가 없는 셀러들을 조회
  const sellers = await prisma.seller.findMany({
    where: {
      category: {
        not: null,
      },
    },
    include: {
      categoryAssignments: true,
    },
  });

  const targets = sellers.filter((s) => s.categoryAssignments.length === 0);
  console.log(`대상 셀러 수: ${targets.length}명 / 전체 category 필드 보유 셀러: ${sellers.length}명`);

  if (targets.length === 0) {
    console.log("마이그레이션할 대상이 없습니다. 모든 셀러가 이미 동기화되어 있습니다.");
    return;
  }

  let successCount = 0;
  for (const seller of targets) {
    const categoryNames = seller.category
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    if (categoryNames.length === 0) continue;

    console.log(`[진행] 셀러: ${seller.name} (ID: ${seller.id}) | 카테고리: "${seller.category}"`);

    // 카테고리 upsert 및 매핑 생성
    try {
      const categories = await Promise.all(
        categoryNames.map(async (name) => {
          return prisma.sellerCategory.upsert({
            where: { name },
            update: {},
            create: { name },
          });
        })
      );

      // 트랜잭션으로 매핑 테이블에 업서트
      await prisma.$transaction(
        categories.map((cat) =>
          prisma.sellerCategoryAssignment.upsert({
            where: {
              sellerId_categoryId: {
                sellerId: seller.id,
                categoryId: cat.id,
              },
            },
            update: {},
            create: {
              sellerId: seller.id,
              categoryId: cat.id,
            },
          })
        )
      );
      successCount++;
    } catch (err) {
      console.error(`[에러] 셀러 ${seller.name} 마이그레이션 실패:`, err);
    }
  }

  console.log(`마이그레이션 완료! 성공: ${successCount}명`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
