// 컷 시안 캐시 키 재키잉 — 해시 교체(#232)로 고아가 된 저장분을 되살린다.
//
// 배경(실사고 2026-08-02): #232 가 클라이언트 번들에서 `node:crypto` 를 걷어내며
// `cutSketchKey` 를 sha256 절단본 → FNV-1a 로 바꿨다. 이 키는 컷↔시안을 잇는
// **유일한 끈**이고 그림은 `DealGuideDraft.sketches` 에 `{key, url}` 로 키와 함께
// 저장돼 있어서, 같은 컷이 다른 키를 내는 순간 화면이 저장분을 못 찾는다.
// 오류도 로그도 없이 프레임만 조용히 비었다 — 운영자에겐 "시안이 사라졌다"로 보인다.
//
// 왜 복구가 가능한가: **파싱은 그대로고 해시만 바뀌었다.** 그래서 지금 초안에서
// 컷을 다시 파싱해 옛 방식(sha256)으로 키를 만들면 저장된 키와 그대로 맞는다
// (실측: 대상 초안 4/4 일치). 옛 키로 찾은 URL 을 새 키에 옮겨 달면 끝이다.
//
// 이미지는 건드리지 않는다. 저장 경로(`deals/<id>/sketches/<옛키>.jpg`)에 옛 키가
// 박혀 있지만 URL 이 레코드에 **명시적으로** 들어 있어 경로 이름은 의미가 없다 —
// 오브젝트를 새 경로로 복사하는 것은 스토리지 비용만 쓰고 얻는 게 없다.
//
// 안전 규칙:
//   - 기본 dry-run. 실제 쓰기는 --apply 가 있을 때만.
//   - ⚠️ 레포 `.env` 의 DATABASE_URL 은 프로덕션이다 — --apply 는 오너 게이트다.
//   - 멱등하다. 이미 새 키인 항목은 건너뛰므로 여러 번 돌려도 같은 결과다.
//   - 옛 키로도 새 키로도 못 찾는 항목은 **손대지 않고 그대로 둔다**(정체불명의
//     레코드를 추측으로 고치지 않는다). 보고에만 남긴다.
//
// 실행:
//   npx tsx scripts/rekey-guide-sketches.ts              (dry-run — 무엇이 바뀌는지만 출력)
//   npx tsx scripts/rekey-guide-sketches.ts --apply      (실제 쓰기 — 오너 게이트)

import "dotenv/config";
import { createHash } from "node:crypto";
import { getPrisma } from "../src/lib/prisma";
import { parseGuideSections, type GuideCut } from "../src/lib/content-guide";
import { cutSketchKey, parseStoredSketches } from "../src/lib/guide-sketch";

/**
 * #232 이전의 키 산출식. **이 함수를 현행 구현과 공유하지 않는 것이 요점이다** —
 * 옛 저장분을 읽으려면 옛 규칙이 그대로 남아 있어야 한다.
 */
function legacySketchKey(cut: GuideCut): string {
  const basis = `${cut.slot.trim()}|${cut.subject.trim()}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const prisma = getPrisma();

  const drafts = await prisma.dealGuideDraft.findMany({
    where: { kind: "CONTENT_GUIDE" },
    select: { dealId: true, body: true, sketches: true },
  });

  let draftsChanged = 0;
  let keysMoved = 0;
  let orphans = 0;

  for (const draft of drafts) {
    const stored = parseStoredSketches(draft.sketches);
    if (stored.length === 0) continue;

    const cuts = parseGuideSections(draft.body)
      .flatMap((section) => section.lines)
      .map((line) => line.cut)
      .filter((cut): cut is GuideCut => cut !== null);

    // 옛 키 → 새 키 대응표. 지금 초안의 컷에서만 만든다 — 컷이 사라진 시안은
    // 어차피 화면에 걸 자리가 없다.
    const rename = new Map<string, string>();
    for (const cut of cuts) rename.set(legacySketchKey(cut), cutSketchKey(cut));
    const currentKeys = new Set(cuts.map((cut) => cutSketchKey(cut)));

    const next = stored.map((sketch) => {
      if (currentKeys.has(sketch.key)) return sketch; // 이미 새 키 — 멱등
      const moved = rename.get(sketch.key);
      if (!moved) {
        orphans++;
        return sketch; // 정체불명 — 추측하지 않는다
      }
      keysMoved++;
      return { ...sketch, url: sketch.url, key: moved };
    });

    const changed = next.some((sketch, i) => sketch.key !== stored[i]?.key);
    if (!changed) continue;
    draftsChanged++;

    console.log(`[${draft.dealId}] 컷 ${cuts.length}건 / 시안 ${stored.length}건`);
    for (const [i, sketch] of next.entries()) {
      const before = stored[i]?.key;
      if (before !== sketch.key) console.log(`   ${before} → ${sketch.key}`);
    }

    if (apply) {
      await prisma.dealGuideDraft.update({
        where: { dealId_kind: { dealId: draft.dealId, kind: "CONTENT_GUIDE" } },
        data: { sketches: JSON.stringify(next) },
      });
    }
  }

  console.log(
    `${apply ? "완료" : "dry-run"}: 초안 ${draftsChanged}건 / 키 ${keysMoved}건 이동` +
      (orphans > 0 ? ` · 대응 컷 없는 시안 ${orphans}건은 그대로 뒀다` : ""),
  );
  if (!apply && draftsChanged > 0) console.log("실제 쓰기: --apply");
}

main()
  .catch((err) => {
    console.error("재키잉 실패:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
