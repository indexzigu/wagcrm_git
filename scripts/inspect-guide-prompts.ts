// 콘텐츠 가이드 프롬프트 실물 검사기 — **API 를 호출하지 않는다**(비용 0).
//
// 왜 필요한가(오너 지적 2026-08-02): 프롬프트에 문장을 얹는 것과 그 문장이 실제로
// 모델을 움직이는 것은 다르다. 지금까지 프롬프트 변경의 유일한 검증 수단이
// "프로덕션에서 가이드를 한 번 더 생성해 보기"였는데, 그건 텍스트 2발 + 이미지
// 최대 5발이라 손이 무겁고 결과도 비결정적이라 무엇이 효과였는지 분리되지 않는다.
//
// 이 스크립트는 그 앞단을 연다: **모델이 실제로 받는 문자열을 그대로 눈으로 본다.**
// 생성 없이 잡을 수 있는 결함이 생각보다 많다 — 지시 충돌, 중복, 뒤에 묻힌 핵심
// 규칙, 변수 자리에 아무것도 안 들어간 구획, 이미지 프롬프트에 전달되지 않는 정보.
//
// 검사 대상 3면:
//   1) 텍스트 SYSTEM 프롬프트 — 섹션별 지시량과 순서
//   2) 이미지 프롬프트 — 컷마다 실제로 조립되는 문자열(저장 초안의 실제 컷 사용)
//   3) 직전 구조 반복 금지 구획 — 무엇이 추출돼 들어가는지
//
// 안전: 읽기 전용이다. DB 는 `select` 조회만, 외부 API 호출 없음.
//
// 실행:
//   npx tsx scripts/inspect-guide-prompts.ts                 (셀러형 SYSTEM 프롬프트만)
//   npx tsx scripts/inspect-guide-prompts.ts --all-kinds      (셀러형·브랜드형 나란히)
//   npx tsx scripts/inspect-guide-prompts.ts --kind BRAND_CONTENT_GUIDE
//   npx tsx scripts/inspect-guide-prompts.ts --deal <dealId> (그 딜의 실제 컷으로 전부)
//   npx tsx scripts/inspect-guide-prompts.ts --deal <id> --sketch-only

import "dotenv/config";
import { getPrisma } from "../src/lib/prisma";
import {
  buildContentGuidePrompt,
  buildPreviousStructureBlock,
  parseGuideSections,
  DEFAULT_GUIDE_KIND,
  GUIDE_KINDS,
  isGuideKind,
  type GuideCut,
  type GuideKind,
} from "../src/lib/content-guide";
import { buildSketchPrompt, cutMedium, MAX_SKETCHES_PER_GUIDE } from "../src/lib/guide-sketch";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function rule(title: string) {
  console.log(`\n${"═".repeat(72)}\n${title}\n${"═".repeat(72)}`);
}

/** 섹션별 지시 분량 — 어느 지시가 어느 정도 지분을 갖는지 눈으로 본다. */
function sectionWeights(system: string) {
  const parts = system.split(/^## /m);
  const rows: { name: string; chars: number }[] = [];
  rows.push({ name: "(머리말·전략)", chars: parts[0].length });
  for (const p of parts.slice(1)) {
    const name = p.slice(0, p.indexOf("\n"));
    rows.push({ name, chars: p.length });
  }
  const total = system.length;
  for (const r of rows.sort((a, b) => b.chars - a.chars)) {
    const pct = Math.round((r.chars / total) * 100);
    console.log(`  ${String(pct).padStart(3)}%  ${String(r.chars).padStart(5)}자  ${r.name}`);
  }
  console.log(`  전체 ${total}자`);
}

async function main() {
  const dealId = arg("--deal");
  const sketchOnly = process.argv.includes("--sketch-only");
  // 유형별로 SYSTEM 프롬프트가 통째로 다르다 — 기본값은 셀러형, `--kind` 로 전환하고
  // `--all-kinds` 로 두 유형을 나란히 본다(지시 충돌은 대조할 때 가장 잘 보인다).
  const rawKind = arg("--kind");
  if (rawKind !== null && !isGuideKind(rawKind)) {
    console.error(`알 수 없는 유형: ${rawKind} (가능: ${GUIDE_KINDS.join(" | ")})`);
    process.exitCode = 1;
    return;
  }
  const kinds: GuideKind[] = process.argv.includes("--all-kinds")
    ? [...GUIDE_KINDS]
    : [rawKind ?? DEFAULT_GUIDE_KIND];
  const kind = kinds[kinds.length - 1];

  // 딜 컨텍스트는 형태 확인이 목적이라 최소 더미로 만든다 — 라우트의 조립 로직을
  // 복제하면 그쪽이 바뀔 때 조용히 갈라진다(검사기가 거짓말을 하게 된다).
  // 딜 컨텍스트에 **판매 조건을 채워 둔다** — 셀러형에서 그 값이 실제로 빠지는지
  // (오너 확정 2026-08-02) 조립 결과로 확인하려면 재료가 있어야 한다. null 로 두면
  // "안 들어갔다"가 규칙 때문인지 값이 없어서인지 구분되지 않는다.
  const sampleDeal = {
    dealName: "(샘플 딜)",
    brandName: null,
    partnerCompanyName: null,
    sourcingMemo: null,
    sellingPrice: 19900,
    listPrice: 29900,
    discountRate: 33,
    unit: "1개월분",
    unitQuantity: 2,
    searchKeyword: null,
    modelName: null,
  };

  if (!sketchOnly) {
    for (const k of kinds) {
      const { system, user } = buildContentGuidePrompt(k, sampleDeal, [], [], null, []);
      rule(`1. 텍스트 SYSTEM 프롬프트 — 지시 지분 (${k})`);
      sectionWeights(system);
      rule(`1-1. SYSTEM 프롬프트 전문 (${k})`);
      console.log(system);
      rule(`1-2. USER 프롬프트 (${k}) — 판매 조건이 어느 유형에 들어가는지`);
      console.log(user);
    }
  }

  if (!dealId) {
    console.log("\n※ `--deal <dealId>` 를 주면 그 딜의 실제 컷으로 이미지 프롬프트까지 봅니다.");
    return;
  }

  const draft = await getPrisma().dealGuideDraft.findUnique({
    where: { dealId_kind: { dealId, kind } },
    select: { body: true },
  });
  if (!draft) {
    console.log(`\n저장된 초안이 없습니다: ${dealId} (${kind})`);
    return;
  }

  const cuts = parseGuideSections(draft.body)
    .flatMap((s) => s.lines)
    .map((l) => l.cut)
    .filter((c): c is GuideCut => c !== null);

  rule(`2. 이미지 프롬프트 — 컷 ${cuts.length}건 (상한 ${MAX_SKETCHES_PER_GUIDE})`);
  console.log(
    "⚠️ 이미지 모델이 받는 것은 아래가 전부다. 여기 없는 정보(톤·무드·타깃·`하는 일`)는\n" +
      "   텍스트 가이드에 아무리 써도 그림에 반영될 길이 없다.\n",
  );
  const deal = await getPrisma().deal.findUnique({
    where: { id: dealId },
    select: { dealName: true, category: true },
  });
  const product = {
    name: deal?.dealName ?? "the product in this campaign",
    category: deal?.category ?? null,
  };
  for (const cut of cuts) {
    console.log(`── C${cut.no} · ${cut.slot} (${cutMedium(cut)}) ${"─".repeat(30)}`);
    console.log(buildSketchPrompt(cut, product));
    console.log();
  }

  rule("3. 직전 구조 반복 금지 구획 — 다음 생성에 들어갈 내용");
  console.log(buildPreviousStructureBlock(draft.body) ?? "(컷이 없어 구획을 만들지 않음)");
}

main()
  .catch((err) => {
    console.error("검사 실패:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
