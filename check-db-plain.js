 
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const sellers = await prisma.seller.findMany({
    where: {
      category: {
        not: null
      }
    },
    include: {
      categoryAssignments: true
    }
  });

  console.log("총 " + sellers.length + "명의 셀러 중 category 텍스트가 있는 셀러를 조회합니다.");
  const targets = sellers.filter(s => s.categoryAssignments.length === 0);
  console.log("매핑 데이터(assignments)가 0개여서 Auto-Sync 대상인 셀러는 " + targets.length + "명입니다.");
  for (const s of targets.slice(0, 10)) {
    console.log("[대상] ID: " + s.id + " | 셀러명: " + s.name + " | category 필드값: \"" + s.category + "\"");
  }
  
  const mapped = sellers.filter(s => s.categoryAssignments.length > 0);
  console.log("\n매핑 데이터가 이미 존재하는 셀러는 " + mapped.length + "명입니다.");
  for (const s of mapped.slice(0, 5)) {
    console.log("[완료] ID: " + s.id + " | 셀러명: " + s.name + " | category 필드값: \"" + s.category + "\" | 매핑 수: " + s.categoryAssignments.length);
  }
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
