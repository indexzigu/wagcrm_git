/**
 * F4 Phase 2 §7 선결: 트리프((주)명성) 거래처 orderExcelRules 시드.
 *
 * 배경: 7단계 레거시 제거(LEGACY_FALLBACK·excel-generator tripp 인라인·resolveOrderGenerationRules
 * 'tripp' 분기)는 뉴트리원+트리프가 orderExcelRules로 시드된 뒤에만 안전하다. 뉴트리원은 시드 완료.
 * 트리프는 new-workbook 모드라 업로드된 ORDER_TEMPLATE 자산이 없어 검수 UI(analyze=자산 필요)로는
 * 시드할 수 없다 → 골든 검증된 TRIPP_LEGACY_RULES를 직접 기입(생성 결과 바이트 동일, parity 테스트로 증명).
 *
 * 안전: 시드값 == 현행 legacy(resolveOrderGenerationRules(formatAdapter='tripp'))이라 발주 결과 무변화.
 * 되돌리기: orderExcelRules를 다시 null로(또는 검수 UI 삭제).
 *
 * 멱등: 이미 orderExcelRules가 있으면 건너뜀(--force로 덮어쓰기 — previous 슬롯에 직전 밀어넣음).
 * 대상: orderFormatAdapter='tripp' && orderExcelRules 미설정. slug는 이미 = 거래처 id(캠페인 template와 정합)라 미변경.
 *
 * 실행:
 *   dry-run(기본):  source .env && npx tsx scripts/seed-tripp-order-rules.ts
 *   실적용(게이트):  source .env && npx tsx scripts/seed-tripp-order-rules.ts --apply
 */
import { PrismaClient } from "@prisma/client";
import {
  orderExcelRulesSchema,
  stripPreviousSlot,
  withPreviousSlot,
  parseOrderExcelRules,
} from "../src/lib/order-converter/excel-rules";
/**
 * 🪤 골든 규칙은 §7 레거시 폴백 제거 때 **테스트 픽스처로 옮겨졌다**(이름도
 * `TRIPP_LEGACY_RULES` → `TRIPP_GOLDEN_RULES`). 이 스크립트는 그 사실을 모른 채
 * 옛 이름을 옛 위치에서 계속 import 하고 있었고, `scripts/` 가 타입체크에서 빠져
 * 있어 **아무도 몰랐다** — 실행하면 import 단계에서 죽는 상태였다(2026-08-07 발견).
 *
 * ⚠️ 운영 스크립트가 `__tests__` 를 참조하는 것은 정상적인 모양이 아니다. 다만 이
 * 스크립트는 「트리프 규칙을 DB 에 한 번 심는」 1회성 도구이고 그 입력값의 정본이
 * 지금은 픽스처뿐이라, 임의로 값을 복제해 두 벌로 갈라놓는 것보다 낫다고 보고
 * 픽스처를 그대로 쓴다. 시드가 이미 끝났다면 이 스크립트째로 지우는 것이 맞다 —
 * 그 판단은 오너 몫이라 여기서는 동작만 되살린다.
 */
import { TRIPP_GOLDEN_RULES } from "../src/lib/order-converter/__tests__/golden-rules.fixture";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const prisma = new PrismaClient();

async function main() {
  const candidates = await prisma.partner.findMany({
    where: { orderFormatAdapter: "tripp" },
    select: { id: true, name: true, orderTemplateSlug: true, orderExcelRules: true },
  });

  console.log(`[대상 후보] orderFormatAdapter='tripp' → ${candidates.length}건`);
  if (candidates.length === 0) {
    console.log("대상 없음. 종료.");
    return;
  }

  // 시드값: 골든 검증된 트리프 규칙(previous 슬롯 없이) + 시드 출처 표시로 analyzedAt 스탬프
  const seedCore = stripPreviousSlot(TRIPP_GOLDEN_RULES);
  const seedStamped = { ...seedCore, analyzedAt: new Date().toISOString() };
  // zod 검증(잘못된 시드가 prod에 들어가는 것 방지)
  const validated = orderExcelRulesSchema.parse(seedStamped);

  for (const p of candidates) {
    const existing = parseOrderExcelRules(p.orderExcelRules ?? null);
    const tag = `${p.name}(${p.id}) slug=${p.orderTemplateSlug}`;

    if (existing && !FORCE) {
      console.log(`  · SKIP ${tag} — 이미 orderExcelRules 존재(열 ${existing.columns.length}·${existing.write.mode}). --force로 덮어쓰기.`);
      continue;
    }

    // 덮어쓰기 시 직전 규칙을 previous로(되돌리기 가능) — 신규면 previous 없음
    const toSave = withPreviousSlot(stripPreviousSlot(validated), existing ?? null);

    if (!APPLY) {
      console.log(`  · DRY-RUN ${tag} — 시드 예정(new-workbook·${validated.columns.length}열${existing ? " · 덮어쓰기(previous 보존)" : ""}).`);
      continue;
    }

    await prisma.partner.update({
      where: { id: p.id },
      data: { orderExcelRules: toSave as any },
    });
    console.log(`  · APPLIED ${tag} — orderExcelRules 시드 완료(new-workbook·${validated.columns.length}열).`);
  }

  console.log(APPLY ? "\n[완료] 실적용됨." : "\n[DRY-RUN] 쓰기 없음. 실적용은 --apply.");
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
