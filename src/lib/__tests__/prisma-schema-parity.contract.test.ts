// Prisma 이중 스키마 파리티 계약 (2026-08-01 실사고).
//
// 이 레포는 스키마를 **둘** 유지한다 — `prisma/schema.prisma`(postgres, 프로덕션)와
// `prisma/schema.sqlite.prisma`(로컬 dev·데모 빌드). 둘은 손으로 나란히 고친다.
//
// 🪤 **실사고**: PR #223 이 `DealGuideDraft.sketches` 를 postgres 쪽에만 추가하고
// sqlite 쪽을 빠뜨린 채 **CI 3종을 전부 통과해 prod 까지 나갔다.** 통과한 이유가
// 중요하다 — `guard` 는 postgres shadow DB, `preflight` 는 postgres 로 빌드하므로
// **어느 체크도 sqlite 스키마를 보지 않는다.** 드리프트는 그 뒤 로컬에서
// `npm test` 가 sqlite 클라이언트를 재생성하며 `npm run typecheck` 가 깨져서야
// 드러났다(prod 는 postgres 라 무영향, 깨지는 건 `dev:local` 과 `build:demo` 다).
//
// 그래서 이 계약이 **CI 에서 도는 유일한 sqlite 스키마 감시자**다.
//
// 판정 범위는 **필드 이름 집합**이다. 타입·속성(`@db.*`, 네이티브 타입)은 두 엔진에서
// 정당하게 다르므로 보지 않는다 — 넓히면 오탐으로 무시당한다. 잡으려는 것은 딱 하나,
// **"한쪽에만 컬럼을 추가하는 것"** 이다.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PG = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
const LITE = readFileSync(
  join(process.cwd(), "prisma/schema.sqlite.prisma"),
  "utf8",
);

/** `model X { ... }` 를 모델명 → 필드 이름 집합으로. 주석·블록속성(`@@`)은 뺀다. */
function modelFields(source: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const fields = new Set<string>();
    for (const raw of m[2].split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
      const f = /^(\w+)\s+\S/.exec(line);
      if (f) fields.add(f[1]);
    }
    out.set(m[1], fields);
  }
  return out;
}

const pg = modelFields(PG);
const lite = modelFields(LITE);

describe("Prisma 이중 스키마 파리티", () => {
  it("파서가 실제로 모델을 읽는다 — 0건이면 이 계약이 통째로 무력하다", () => {
    // 양성 프로브: 정규식이 깨져 빈 Map 을 돌려주면 아래 단언이 전부 공허하게 통과한다.
    expect(pg.size).toBeGreaterThan(50);
    expect(lite.size).toBeGreaterThan(50);
    expect(pg.has("DealGuideDraft")).toBe(true);
    expect(lite.has("DealGuideDraft")).toBe(true);
  });

  it("모델 집합이 같다", () => {
    const onlyPg = [...pg.keys()].filter((n) => !lite.has(n));
    const onlyLite = [...lite.keys()].filter((n) => !pg.has(n));
    expect(onlyPg, "sqlite 스키마에 없는 모델").toEqual([]);
    expect(onlyLite, "postgres 스키마에 없는 모델").toEqual([]);
  });

  it("모든 공통 모델의 필드 이름 집합이 같다 — 한쪽에만 컬럼을 추가하지 않는다", () => {
    const drift: string[] = [];
    for (const [name, pgFields] of pg) {
      const liteFields = lite.get(name);
      if (!liteFields) continue; // 위 단언이 이미 잡는다
      const missing = [...pgFields].filter((f) => !liteFields.has(f));
      const extra = [...liteFields].filter((f) => !pgFields.has(f));
      if (missing.length || extra.length) {
        drift.push(
          `${name}: sqlite 누락=[${missing.join(", ")}] 초과=[${extra.join(", ")}]`,
        );
      }
    }
    expect(
      drift,
      "두 스키마의 필드가 어긋났다 — 컬럼을 추가할 때 schema.prisma 와 " +
        "schema.sqlite.prisma 를 **함께** 고친다. CI 의 guard·preflight 는 " +
        "postgres 만 보므로 이 계약 말고는 아무도 못 잡는다.",
    ).toEqual([]);
  });
});
