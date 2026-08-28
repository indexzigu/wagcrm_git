import { getPrisma } from "../src/lib/prisma";

// 사용: npx tsx scripts/check-import-records.ts <검색어> [검색어...]
// 검색어는 rawPayload 부분일치로 OR 매칭한다. 셀러명·핸들 등 실명은 인자로 넘긴다
// (PUBLIC 레포이므로 코드에 하드코딩하지 않는다 — AGENTS.md P0 Public Repo Data Guard).
// 한글은 NFC/NFD가 시각적으로 같지만 바이트가 다르다 — 양쪽을 모두 조회한다.
async function main() {
  const terms = process.argv.slice(2).filter(Boolean);
  if (terms.length === 0) {
    console.error("Usage: npx tsx scripts/check-import-records.ts <검색어> [검색어...]");
    process.exit(1);
  }

  const variants = [...new Set(terms.flatMap((t) => [t.normalize("NFC"), t.normalize("NFD")]))];

  const prisma = getPrisma();
  console.log(`Checking ImportSourceRecord for ${terms.join(", ")} (NFC/NFD ${variants.length} variants)...`);

  const records = await prisma.importSourceRecord.findMany({
    where: {
      OR: variants.map((v) => ({ rawPayload: { contains: v } })),
    },
  });

  console.log(`Found ${records.length} import source records.`);
  for (const r of records) {
    console.log(`- ID: ${r.id}, Table: ${r.sourceTable}, Key: ${r.sourceKey}, Action: ${r.action}`);
    try {
      const payload = JSON.parse(r.rawPayload);
      console.log(`  Payload Keys:`, Object.keys(payload));
      if (payload.properties) {
        // Log properties related to followers or history
        const props = payload.properties;
        console.log(`  Properties:`, Object.keys(props));
        // print keys containing follower or history or post
        const followerKeys = Object.keys(props).filter(k => k.toLowerCase().includes("follower") || k.toLowerCase().includes("팔로워") || k.toLowerCase().includes("게시물") || k.toLowerCase().includes("post"));
        console.log(`  Follower/History properties:`, followerKeys.map(k => ({ [k]: props[k] })));
      }
    } catch {
      console.log(`  Payload (raw):`, r.rawPayload.slice(0, 200));
    }
  }
}

main().catch(console.error);
