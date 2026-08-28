/**
 * F4 Phase 2 §7 선결: 레거시 'nutrione' 리터럴 template 캠페인을 뉴트리원 거래처 CUID로 이관.
 *
 * 배경: 뉴트리원 거래처는 slug=자기 CUID로 시드됐는데(orderExcelRules fill-template + Supabase 스냅샷),
 * template='nutrione' 리터럴을 쓰는 과거(마감) 캠페인 3건은 slug 매칭이 안 돼 resolveOrderBrand가
 * 거래처를 못 찾고 public/nutrione_template.xlsx + NUTRIONE_LEGACY_RULES 폴백에 의존한다.
 * 이 캠페인들의 template를 거래처 CUID로 바꾸면 시드된 규칙(동일 스냅샷 == 골든)으로 해석되어
 * 레거시 폴백을 안전하게 제거할 수 있다. 출력은 바이트 동일(현행 코드로도 excelRules 우선이라 무변화).
 *
 * 가역: template를 'nutrione'으로 되돌리면 원복.
 * 안전 가드: 대상 거래처가 실제로 orderExcelRules 시드됐는지 확인 후에만 이관.
 *
 * 실행:
 *   dry-run:  source .env && npx tsx scripts/migrate-nutrione-campaign-template.ts
 *   적용:     source .env && npx tsx scripts/migrate-nutrione-campaign-template.ts --apply
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const LEGACY_TEMPLATE = "nutrione";

async function main() {
  // 대상 거래처: 뉴트리원 + orderExcelRules 시드됨
  const partner = await prisma.partner.findFirst({
    where: { name: { contains: "뉴트리원" }, NOT: { orderExcelRules: { equals: null as any } } },
    select: { id: true, name: true, orderTemplateSlug: true, orderExcelRules: true },
  });
  if (!partner) {
    console.error("중단: orderExcelRules 시드된 뉴트리원 거래처를 찾지 못함. 먼저 시드 필요.");
    process.exit(1);
  }
  const rules = partner.orderExcelRules as any;
  console.log(`대상 거래처: ${partner.name}(${partner.id}) — mode=${rules?.write?.mode}, 열 ${rules?.columns?.length}`);

  const camps = await prisma.orderCampaign.findMany({
    where: { template: LEGACY_TEMPLATE },
    select: { id: true, name: true, template: true, isActive: true },
  });
  console.log(`\n이관 대상 캠페인 ${camps.length}건 (template '${LEGACY_TEMPLATE}' → '${partner.id}'):`);
  for (const c of camps) {
    console.log(`  · ${c.isActive ? "[활성]" : "[마감]"} ${c.name} (${c.id})`);
  }
  if (camps.length === 0) { console.log("대상 없음. 종료."); return; }

  if (!APPLY) {
    console.log(`\n[DRY-RUN] 쓰기 없음. 적용은 --apply. 롤백=template를 '${LEGACY_TEMPLATE}'으로 되돌리기.`);
    return;
  }

  const res = await prisma.orderCampaign.updateMany({
    where: { template: LEGACY_TEMPLATE },
    data: { template: partner.id },
  });
  console.log(`\n[완료] ${res.count}건 이관됨 → template='${partner.id}'.`);
  const remain = await prisma.orderCampaign.count({ where: { template: LEGACY_TEMPLATE } });
  console.log(`잔여 '${LEGACY_TEMPLATE}' 리터럴 캠페인: ${remain}`);
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
