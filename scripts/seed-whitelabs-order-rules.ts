/**
 * 화이트랩스(피움컴퍼니) 거래처 orderExcelRules 시드.
 *
 * 배경: 화이트랩스 발주서는 브랜드가 준 빈 양식에 행을 채우는 형태가 아니라 11열 표를
 * 새로 만드는 형태(new-workbook)라, 검수 UI(analyze = 업로드된 ORDER_TEMPLATE 자산 필요)로
 * 등록할 원본 파일이 없다 → 트리프 시드(seed-tripp-order-rules.ts)와 같은 방식으로 직접 기입한다.
 *
 * 열 매핑(오너가 준 양식 캡처 기준):
 *   이름=수취인명 · 핸드폰=수취인연락처1 · 전화=수취인연락처2 · 주소=배송지 · 품목=옵션정보(네이버 원문)
 *   특기사항=배송메시지 · 주문번호=상품주문번호 · 판매처=와이그라운드(셀러명) · 수량=수량(없으면 1)
 *   박스수·대한통운=공란(브랜드가 채워 회신). 회신 송장 열 이름이 '대한통운'이라 기본 후보에
 *   없으므로 reply.trackingHeaders 에 명시한다.
 *
 * 멱등: 이미 orderExcelRules 가 있으면 건너뜀(--force 로 덮어쓰기 — previous 슬롯에 직전 보존).
 * 되돌리기: 검수 UI 「직전 규칙으로 되돌리기」 또는 orderExcelRules 를 null 로.
 *
 * 실행:
 *   dry-run(기본):  set -a; . <운영 .env>; set +a; npx tsx scripts/seed-whitelabs-order-rules.ts
 *   실적용:         ... npx tsx scripts/seed-whitelabs-order-rules.ts --apply
 */
import { PrismaClient } from "@prisma/client";
import {
  orderExcelRulesSchema,
  withPreviousSlot,
  parseOrderExcelRules,
  type OrderExcelRulesCore,
} from "../src/lib/order-converter/excel-rules";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const NAME_KEYWORDS = ["화이트랩스", "피움"];
const prisma = new PrismaClient();

const HEADERS = ["이름", "핸드폰", "전화", "주소", "품목", "특기사항", "주문번호", "판매처", "수량", "박스수", "대한통운"];

const WHITELABS_RULES: OrderExcelRulesCore = {
  version: 1,
  sourceAssetId: null,
  templateStoragePath: null,
  analyzedAt: "",
  headerSnapshot: HEADERS,
  write: { mode: "new-workbook", sheetName: "발주서", headerRow: 1, dataStartRow: 2 },
  columns: [
    { col: 1, header: "이름", source: { type: "field", field: "수취인명" } },
    { col: 2, header: "핸드폰", source: { type: "field", field: "수취인연락처1" } },
    { col: 3, header: "전화", source: { type: "field", field: "수취인연락처2" } },
    { col: 4, header: "주소", source: { type: "field", field: "배송지" } },
    { col: 5, header: "품목", source: { type: "field", field: "옵션정보" } },
    { col: 6, header: "특기사항", source: { type: "field", field: "배송메시지" } },
    { col: 7, header: "주문번호", source: { type: "field", field: "상품주문번호" } },
    { col: 8, header: "판매처", source: { type: "template", template: "와이그라운드({{sellerName}})", fallback: "와이그라운드" } },
    { col: 9, header: "수량", source: { type: "field", field: "수량", fallbackValue: 1 } },
    { col: 10, header: "박스수", source: { type: "empty" } },
    { col: 11, header: "대한통운", source: { type: "empty" } },
  ],
  reply: {
    orderIdHeaders: ["주문번호", "상품주문번호"],
    orderIdPattern: "naver-strict",
    trackingHeaders: ["대한통운", "송장번호", "운송장번호", "운송장", "택배송장번호"],
  },
};

async function main() {
  const candidates = await prisma.partner.findMany({
    where: { OR: NAME_KEYWORDS.map((k) => ({ name: { contains: k } })) },
    select: { id: true, name: true, orderTemplateSlug: true, orderExcelRules: true },
  });

  console.log(`[대상 후보] 이름에 ${NAME_KEYWORDS.join("|")} 포함 → ${candidates.length}건`);
  for (const p of candidates) console.log(`  - ${p.name}(${p.id}) slug=${p.orderTemplateSlug ?? "없음"} 규칙=${p.orderExcelRules ? "있음" : "없음"}`);
  if (candidates.length !== 1) {
    console.log("대상이 정확히 1건이 아니라 중단한다. 거래처를 먼저 정리할 것.");
    process.exitCode = 2;
    return;
  }

  const p = candidates[0];
  const validated = orderExcelRulesSchema.parse({ ...WHITELABS_RULES, analyzedAt: new Date().toISOString() });
  const existing = parseOrderExcelRules(p.orderExcelRules ?? null);
  if (existing && !FORCE) {
    console.log(`SKIP — 이미 orderExcelRules 존재(열 ${existing.columns.length}·${existing.write.mode}). --force 로 덮어쓰기.`);
    return;
  }
  // slug 가 없으면 발주 캠페인(OrderCampaign.template)이 이 거래처를 찾지 못한다.
  // 기존 발주 브랜드(뉴트리원·명성)와 같은 규약으로 slug = 거래처 id.
  const slugPatch = p.orderTemplateSlug ? {} : { orderTemplateSlug: p.id };

  const toSave = withPreviousSlot(validated, existing ?? null);
  if (!APPLY) {
    console.log(`DRY-RUN — 시드 예정(new-workbook·${validated.columns.length}열${existing ? " · 덮어쓰기(previous 보존)" : ""}${p.orderTemplateSlug ? "" : " · slug=거래처 id 지정"}). 실적용은 --apply.`);
    return;
  }
  await prisma.partner.update({ where: { id: p.id }, data: { orderExcelRules: toSave as any, ...slugPatch } });
  console.log(`APPLIED — ${p.name} orderExcelRules 시드 완료(${validated.columns.length}열).`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
