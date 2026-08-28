/**
 * 배포 전 DB 게이트: 커밋 트리의 마이그레이션이 실 DB(Supabase)에 적용됐는지 읽기 전용 확인.
 * (vercel-safe-deploy 스킬 §DB 게이트 — 미적용 마이그레이션이 있으면 배포 금지)
 *
 * 실행: npx tsx scripts/check-migrations-applied.ts   (.env의 DATABASE_URL 사용)
 */
import { PrismaClient } from "@prisma/client";

const EXPECTED_TABLES = [
  "SellerAiProfile", // 20260710000000_add_seller_ai_profile (타 세션)
  "AssistantConversation", // 20260711000000_add_assistant_conversations
  "AssistantChatMessage", // 20260711000000_add_assistant_conversations
];

const db = new PrismaClient();

async function main() {
  const rows = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN (${EXPECTED_TABLES[0]}, ${EXPECTED_TABLES[1]}, ${EXPECTED_TABLES[2]})`;

  const found = new Set(rows.map((r) => r.table_name));
  let missing = 0;
  for (const t of EXPECTED_TABLES) {
    if (found.has(t)) {
      console.log(`  ✅ ${t} — 적용됨`);
    } else {
      missing += 1;
      console.log(`  ❌ ${t} — 미적용 (해당 migration.sql을 Supabase SQL Editor에서 실행 필요)`);
    }
  }
  console.log(missing === 0 ? "\n게이트 통과 — 배포 가능" : `\n게이트 실패 — ${missing}건 적용 후 재확인`);
  await db.$disconnect();
  process.exit(missing === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("확인 실패:", err);
  await db.$disconnect();
  process.exit(1);
});
