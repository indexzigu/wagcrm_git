// 컷 시안 스타일 방향 비교기 — 같은 컷을 여러 프롬프트로 뽑아 **눈으로 고른다.**
//
// 왜 필요한가(오너 2026-08-02: "설명만 봐서는 각기 장단점이 있을 것 같아 못 고르겠다"):
// 시안의 화풍 방향은 문장으로 설명해 고를 수 있는 결정이 아니다. 그런데 지금까지
// 유일한 확인 경로가 "프로덕션에서 가이드를 새로 생성"이라 딜 데이터를 건드리고
// 최대 8장이 한꺼번에 나왔다.
//
// 이 스크립트는 그 사이를 연다: **DB 에 쓰지 않고**, 컷 하나를 골라 변형 프롬프트마다
// 소량 생성해 로컬 폴더에 떨군다. 판정은 사람이 보고 한다.
//
// ⚠️ 이미지 API 를 실제로 호출한다(유료). 기본 1장/변형이고, 총 생성 수를 항상
// 먼저 출력한 뒤 진행한다. seed 파라미터가 우리 API(`interactions`)에 없어
// 결정론적 A/B 가 불가능하므로, 엄밀한 비교가 필요하면 `--n` 을 올려 비율로 본다.
//
// 실행:
//   npx tsx scripts/compare-sketch-styles.ts                    (기본 컷·1장씩)
//   npx tsx scripts/compare-sketch-styles.ts --n 3              (변형당 3장)
//   npx tsx scripts/compare-sketch-styles.ts --out /tmp/xx

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSketchImage } from "../src/lib/agent/gemini-image";
import { getPrisma } from "../src/lib/prisma";
import { parseGuideSections, type GuideCut } from "../src/lib/content-guide";
import { buildSketchPrompt, cutMedium } from "../src/lib/guide-sketch";

/**
 * 비교 대상. **A 는 현행 프롬프트 그대로**여야 한다 — 기준선이 없으면 개선인지
 * 취향 차이인지 못 가린다. B·C 는 조사에서 채택한 수정(부정문 긍정 치환 · 피사체를
 * 앞으로 · 상품 컨텍스트 주입)을 **공통으로** 적용하고, 무드 강도만 다르다.
 */
const SUBJECT = "자연광 아래서 반짝이는 헤일로 쥬얼리를 착용한 손목과 목을 가까이 잡은 컷";
const PRODUCT = "halo-setting jewelry (necklace and bracelet) for a Korean group-buy campaign";

const VARIANTS: { id: string; label: string; prompt: string }[] = [
  {
    id: "A",
    label: "현행 — 흑백 러프 스토리보드(부정문 다수, 스타일 락이 맨 앞)",
    prompt: [
      "Rough black-and-white storyboard sketch, pencil line art on white background.",
      "Composition and camera framing only — this is a shot-planning thumbnail, not a product photo.",
      "Simplify everything to loose outlines. No shading, no color, no photorealism.",
      "Do NOT render any text, letters, numbers, logos, brand marks, or packaging copy.",
      "Do NOT render identifiable faces — keep people as faceless simplified figures.",
      "Do NOT invent product details; suggest objects as generic blocked-in shapes.",
      `Scene to draw: ${SUBJECT}`,
      "This is shot 1 of a short-form vertical video, at 0~3초.",
    ].join("\n"),
  },
  {
    id: "B",
    label: "무드 선화 — 구도 스케치는 유지하되 조명·분위기를 서술",
    prompt: [
      // 피사체가 맨 앞(조사: 서두 가중치 최고). 상품 정체를 명시해 날조를 막는다.
      `A shot-planning storyboard frame for a short-form vertical video, showing ${PRODUCT}.`,
      `Scene: a close-up of a wrist and neckline wearing the jewelry, catching soft natural daylight.`,
      // 배경·공간(중간 가중치)
      "Background is a calm, uncluttered interior with a window out of frame providing the light.",
      // 스타일·조명(후반 가중치). 부정문 대신 원하는 상태를 긍정으로 서술.
      "Style: clean monochrome pencil line art with light gray shading to convey mood and lighting direction.",
      "Keep every surface completely blank and unprinted, with smooth plain areas instead of writing.",
      "Show the person cropped below the chin so only the neckline, shoulders and hands are in frame.",
      "Leave the lower third as calm open space for a caption overlay to be added later.",
    ].join("\n"),
  },
  {
    id: "C",
    label: "감성 무드 — 톤·질감까지 허용(제품사진은 아님)",
    prompt: [
      `An atmospheric concept frame for a short-form vertical video, showing ${PRODUCT}.`,
      `Scene: a close-up of a wrist and neckline wearing the jewelry, catching soft natural daylight with gentle sparkle.`,
      "Background is a serene, minimal interior in soft focus, warm morning light falling across the skin.",
      "Style: refined monochrome illustration with soft grayscale washes and delicate texture — an editorial mood frame, still clearly hand-drawn rather than a photograph.",
      "Keep every surface completely blank and unprinted, with smooth plain areas instead of writing.",
      "Show the person cropped below the chin so only the neckline, shoulders and hands are in frame.",
      "Leave the lower third as calm open space for a caption overlay to be added later.",
    ].join("\n"),
  },

  // ── 2차 회차 (오너 판정 2026-08-02: "C 가 좋은데 스케치만 조금 더 러프하게,
  //    여백 표시보다 인스타그램 UI 를 간단히 넣으면 더 스토리보드 같겠다")
  //
  // 두 변경(러프함·UI)을 한 번에 넣지 않고 갈랐다 — 한꺼번에 바꾸면 어느 쪽이
  // 효과였는지, 어느 쪽이 글자를 흘렸는지 분리되지 않는다.
  //
  // ⚠️ B 에서 `caption` 이라는 **단어를 프롬프트에 썼더니 그 단어를 그림에 글자로
  // 그렸다**("BLANK FOR CAPTION"). 아래 변형은 caption·text·label 같은 명사를
  // 일절 쓰지 않고, 원하는 것을 **형상**으로만 서술한다.
  {
    id: "D",
    label: "C + 러프하게 (UI 없음 — 러프함만 분리 검증)",
    prompt: [
      `A working storyboard sketch for a short-form vertical video, showing ${PRODUCT}.`,
      `Scene: a close-up of a wrist and neckline wearing the jewelry, catching soft natural daylight with gentle sparkle.`,
      "Background is a serene, minimal interior suggested with a few quick strokes, warm morning light falling across the skin.",
      "Style: loose hand-drawn pencil sketch with quick gestural strokes, visible construction lines and open unfinished edges, lightly softened with grayscale washes for mood and lighting — a rough shot-planning sketch rather than a finished illustration.",
      "Every surface stays plain and unmarked, with smooth empty areas.",
      "Show the person cropped below the chin so only the neckline, shoulders and hands are in frame.",
      "Keep the lower area calm and open.",
    ].join("\n"),
  },
  {
    id: "E",
    label: "D + 앱 UI 형상 (제품명 없이 형상으로만 서술)",
    prompt: [
      `A working storyboard sketch for a short-form vertical video, showing ${PRODUCT}.`,
      `Scene: a close-up of a wrist and neckline wearing the jewelry, catching soft natural daylight with gentle sparkle.`,
      "Background is a serene, minimal interior suggested with a few quick strokes, warm morning light falling across the skin.",
      "The whole frame is drawn as a phone screen for a vertical video app: a column of three small plain rounded icon outlines down the right edge, and a slim rounded bar across the bottom edge, all sketched in the same loose pencil line and left as empty outlines.",
      "Style: loose hand-drawn pencil sketch with quick gestural strokes, visible construction lines and open unfinished edges, lightly softened with grayscale washes for mood and lighting — a rough shot-planning sketch rather than a finished illustration.",
      "Every surface stays plain and unmarked, with smooth empty areas.",
      "Show the person cropped below the chin so only the neckline, shoulders and hands are in frame.",
    ].join("\n"),
  },
  {
    id: "F",
    label: "D + 인스타그램 릴스 UI 명시 (제품명을 부르는 쪽)",
    prompt: [
      `A working storyboard sketch of an Instagram Reels screen, showing ${PRODUCT}.`,
      `Scene: a close-up of a wrist and neckline wearing the jewelry, catching soft natural daylight with gentle sparkle.`,
      "Background is a serene, minimal interior suggested with a few quick strokes, warm morning light falling across the skin.",
      "The vertical video fills the whole phone screen, with the familiar interface sketched as simple empty shapes: small plain rounded icon outlines stacked down the right side, and a slim rounded bar along the bottom.",
      "Style: loose hand-drawn pencil sketch with quick gestural strokes, visible construction lines and open unfinished edges, lightly softened with grayscale washes for mood and lighting — a rough shot-planning sketch rather than a finished illustration.",
      "Every surface and every icon stays plain and unmarked, left as empty outlines.",
      "Show the person cropped below the chin so only the neckline, shoulders and hands are in frame.",
    ].join("\n"),
  },

  // ── 3차 회차: E(글자 0 · UI 양호) + D(러프함이 더 좋았음) 합본.
  //
  // 2차 실측에서 갈린 것:
  //  - D(UI 없음)·F(Instagram 명시) → **주석 글자 대량 유출**. 프롬프트에 쓴 단어가
  //    그대로 그림 속 주석이 됐다("SOFT SPARKLE" · "Necklace with halo detail" 등).
  //    "storyboard" 라는 단어가 모델에게 "주석이 달린 그림"을 뜻한다.
  //  - E(앱 이름 없이 형상으로만 서술) → **글자 0**. 서비스명을 부르지 않고 UI 를
  //    형상으로 묘사한 쪽이 안전하다.
  // 그래서 G 는 E 의 서술 방식을 유지한 채 러프함만 D 수준으로 끌어올린다.
  {
    id: "G",
    label: "E(UI·글자0) + D(러프함) 합본 — 채택 후보",
    prompt: [
      `A rough shot-planning sketch for a short-form vertical video, showing ${PRODUCT}.`,
      `Scene: a close-up of a wrist and neckline wearing the jewelry, catching soft natural daylight with gentle sparkle.`,
      "Background is a serene, minimal interior suggested with a few quick strokes, warm morning light falling across the skin.",
      "The whole frame is drawn as a phone screen for a vertical video app: a column of three small plain rounded icon outlines down the right edge, and a slim rounded bar across the bottom edge, all sketched in the same loose pencil line and left as empty outlines.",
      "Style: loose gestural pencil strokes with visible construction lines, open unfinished edges and sketchy overshooting lines, lightly softened with grayscale washes for mood and lighting — quick and unpolished, the way a shot is blocked out before filming.",
      "Every surface and every icon stays plain and unmarked, left as empty outlines.",
      "Show the person cropped below the chin so only the neckline, shoulders and hands are in frame.",
    ].join("\n"),
  },
];

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/**
 * 실물 모드 — 손으로 쓴 변형이 아니라 **파이프라인이 실제로 조립하는 프롬프트**로 뽑는다.
 *
 * 변형 실험으로 화풍을 정한 뒤에는 "그 화풍이 코드에 제대로 이식됐는가"가 다음 질문이고,
 * 그건 손으로 옮겨 적은 프롬프트로는 확인되지 않는다(옮기다 틀리면 실험이 거짓말을 한다).
 * 매체별로 1컷씩만 뽑아 비용을 묶는다.
 */
async function realVariants(dealId: string) {
  const prisma = getPrisma();
  const [draft, deal] = await Promise.all([
    prisma.dealGuideDraft.findUnique({
      where: { dealId_kind: { dealId, kind: "CONTENT_GUIDE" } },
      select: { body: true },
    }),
    prisma.deal.findUnique({ where: { id: dealId }, select: { dealName: true, category: true } }),
  ]);
  if (!draft) throw new Error(`저장된 초안이 없습니다: ${dealId}`);

  const cuts = parseGuideSections(draft.body)
    .flatMap((s) => s.lines)
    .map((l) => l.cut)
    .filter((c): c is GuideCut => c !== null);
  const product = {
    name: deal?.dealName ?? "the product in this campaign",
    category: deal?.category ?? null,
  };

  const picked: { id: string; label: string; prompt: string }[] = [];
  for (const medium of ["VIDEO", "CARD"] as const) {
    const hit = cuts.find((c) => cutMedium(c) === medium);
    if (hit) {
      picked.push({
        id: `REAL-${medium}`,
        label: `실물 파이프라인 · ${medium} · C${hit.no} ${hit.slot}`,
        prompt: buildSketchPrompt(hit, product),
      });
    }
  }
  return picked;
}

async function main() {
  const n = Number(arg("--n") ?? "1");
  const outDir = arg("--out") ?? join(process.cwd(), ".sketch-compare");
  mkdirSync(outDir, { recursive: true });

  const realDeal = arg("--real");
  if (realDeal) {
    const picked = await realVariants(realDeal);
    console.log(`실물 프롬프트 ${picked.length}종 × ${n}장 생성합니다.\n출력: ${outDir}\n`);
    for (const v of picked) {
      for (let i = 1; i <= n; i++) {
        const name = `${v.id}${n > 1 ? `-${i}` : ""}.jpg`;
        try {
          const image = await generateSketchImage(v.prompt);
          writeFileSync(join(outDir, name), Buffer.from(image.bytes));
          console.log(`  ✓ ${name}  ${v.label}`);
        } catch (err) {
          console.log(`  ✗ ${name}  실패: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    await getPrisma().$disconnect();
    return;
  }

  // 변형이 쌓이면 매번 전부 다시 그리는 것은 돈만 쓴다 — 이번 회차만 고른다.
  const only = arg("--only");
  const picked = only
    ? VARIANTS.filter((v) => only.split(",").map((s) => s.trim()).includes(v.id))
    : VARIANTS;
  if (picked.length === 0) {
    console.log(`--only "${only}" 에 해당하는 변형이 없습니다. 가능한 id: ${VARIANTS.map((v) => v.id).join(", ")}`);
    return;
  }

  const total = picked.length * n;
  console.log(`변형 ${picked.length}종 × ${n}장 = 총 ${total}장 생성합니다.`);
  console.log(`출력: ${outDir}\n`);

  for (const v of picked) {
    for (let i = 1; i <= n; i++) {
      const name = `${v.id}${n > 1 ? `-${i}` : ""}.jpg`;
      try {
        const image = await generateSketchImage(v.prompt);
        // `bytes` 는 ArrayBuffer 다 — writeFileSync 는 Buffer/TypedArray 만 받는다.
        writeFileSync(join(outDir, name), Buffer.from(image.bytes));
        console.log(`  ✓ ${name}  (${image.bytes.byteLength.toLocaleString("ko-KR")} bytes)  ${v.label}`);
      } catch (err) {
        // 한 장 실패가 나머지를 막지 않는다 — 이미 쓴 돈을 버리지 않기 위해.
        console.log(`  ✗ ${name}  실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  console.log("\n판정은 눈으로 합니다 — 위 폴더를 열어 비교하십시오.");
}

main().catch((err) => {
  console.error("비교 실패:", err);
  process.exitCode = 1;
});
