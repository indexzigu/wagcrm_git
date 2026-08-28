import { getPrisma } from "../src/lib/prisma";

// 사용: npx tsx scripts/check-seller-dupes.ts <셀러명|핸들> [...]
// 실명은 인자로 넘긴다 — PUBLIC 레포이므로 코드에 하드코딩하지 않는다
// (AGENTS.md P0 Public Repo Data Guard).
// 중복 셀러 레코드의 흔한 원인이 한글 정규화 불일치(NFC/NFD)다 — 같은 이름처럼
// 보여도 바이트가 달라 별개 행으로 들어간다. 그래서 양형태를 모두 조회하고,
// name은 raw JSON + 형태 판정으로 찍어 어느 쪽인지 눈으로 구분하게 한다.
async function main() {
  const terms = process.argv.slice(2).filter(Boolean);
  if (terms.length === 0) {
    console.error("Usage: npx tsx scripts/check-seller-dupes.ts <셀러명|핸들> [...]");
    process.exit(1);
  }

  const variants = [...new Set(terms.flatMap((t) => [t.normalize("NFC"), t.normalize("NFD")]))];

  const prisma = getPrisma();
  console.log(`Checking duplicates for ${terms.join(", ")} in Postgres (NFC/NFD ${variants.length} variants)...`);

  const sellers = await prisma.seller.findMany({
    where: {
      OR: [
        ...variants.map((v) => ({ name: v })),
        ...variants.map((v) => ({ snsHandle: v })),
      ]
    },
    include: {
      histories: true
    }
  });

  console.log(`Found ${sellers.length} seller records:`);
  for (const s of sellers) {
    console.log(`- ID: ${s.id}`);
    // raw string + 정규화 형태 — 중복의 원인이 NFC/NFD 불일치인지 판별한다
    console.log(`  Name: ${JSON.stringify(s.name)} (${s.name === s.name.normalize("NFC") ? "NFC" : "NFD"})`);
    console.log(`  Handle: ${s.snsHandle}`);
    console.log(`  Followers: ${s.currentFollowers}`);
    console.log(`  Histories Count: ${s.histories.length}`);
    for (const h of s.histories) {
      console.log(`    - Date: ${h.snapshotDate.toISOString()}, Followers: ${h.followersCount}`);
    }
  }
}

main().catch(console.error);
