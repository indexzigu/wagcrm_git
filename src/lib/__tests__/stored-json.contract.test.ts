// 저장된 Json 읽기 계약 + **재발 방지 소스 스캔**.
//
// 🪤 배경: 이 레포의 리포지토리들은 Json 컬럼을 "Postgres 는 객체, SQLite 는 문자열"로
// 이원화해 저장하고, 역직렬화는 리포지토리 쪽에만 있다. raw Prisma 로 읽고 캐스팅하면
// **Postgres 에서는 통하고 SQLite 에서만 조용히 빈 값**이 된다. 타입도 테스트도 못 잡는다
// — 픽스처를 객체(프로덕션 모양)로만 만들면 초록이기 때문이다.
//
// 실제로 두 번 났다: ①기안 dedup 이 로컬에서 통째로 뚫려 중복 기안이 생겼다 ②가격표
// 「반영 결과」 카드가 성공한 반영을 "생성 0건"으로 그렸다. 아래 소스 스캔은 세 번째를 막는다.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseStoredJson, parseStoredJsonObject } from "../stored-json";

describe("parseStoredJson", () => {
  it("문자열과 객체가 같은 값을 낸다 (프로바이더 이원화 흡수)", () => {
    const value = { reason: "X", nested: { n: 1 }, list: [1, 2] };
    expect(parseStoredJson(JSON.stringify(value))).toEqual(parseStoredJson(value));
    expect(parseStoredJson(JSON.stringify(value))).toEqual(value);
  });

  it("배열도 그대로 되돌린다", () => {
    expect(parseStoredJson<number[]>(JSON.stringify([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it("null·undefined 는 null 이다", () => {
    expect(parseStoredJson(null)).toBeNull();
    expect(parseStoredJson(undefined)).toBeNull();
  });

  it("깨진 문자열은 판정을 흔들지 않고 null 이다", () => {
    expect(parseStoredJson("{not json")).toBeNull();
  });
});

describe("parseStoredJsonObject", () => {
  it("객체가 아닌 값은 빈 객체로 접는다", () => {
    expect(parseStoredJsonObject(null)).toEqual({});
    expect(parseStoredJsonObject("{not json")).toEqual({});
    expect(parseStoredJsonObject(JSON.stringify([1, 2]))).toEqual({});
    expect(parseStoredJsonObject(JSON.stringify("scalar"))).toEqual({});
  });

  it("객체·문자열 객체는 같게 읽는다", () => {
    expect(parseStoredJsonObject(JSON.stringify({ a: 1 }))).toEqual({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// 소스 스캔 — Json 컬럼을 raw 로 select 하는 파일은 역직렬화 경로를 갖고 있어야 한다
// ---------------------------------------------------------------------------

/** 리포지토리가 이원화 직렬화로 저장하는 Json 컬럼들. */
const DUAL_MODE_JSON_FIELDS = [
  "structuredResult",
  "executionResult",
  "payload",
  "dataSources",
  "assumptions",
  "risks",
  "nextActions",
  "columnMapping",
  "rawCells",
  "flags",
  "rawResults",
  "toolCalls",
] as const;

/**
 * 역직렬화를 소유한 함수들. **그 필드를 인자로 받는 호출**이 있어야 통과다.
 *
 * ⚠️ 파일 단위로 "아무 역직렬화나 있으면 통과"로 하면 안 된다 — 같은 파일이 시트는 제대로
 * 정규화하면서 `executionResult` 만 캐스팅하던 것이 이번에 발견된 실제 결함이고, 파일 단위
 * 판정은 그 프로브를 **놓쳤다**. 필드 단위로 조인다.
 */
const DESERIALIZERS = [
  "parseStoredJson",
  "parseStoredJsonObject",
  "deserializeJsonField",
  "parseJsonField",
  "deserializeToolCalls",
];

/**
 * 필드를 직접 넘기지 않고 **행 통째로** 역직렬화 함수에 넘기는 자리 — 그래서 위 정규식으로는
 * 잡히지 않는다. 면제를 **눈에 보이게** 열거해 둔다: 새 소비처는 필드를 직접 파싱하거나,
 * 여기에 이름을 올리며 왜 안전한지 함께 적어야 한다.
 */
const ROW_LEVEL_HANDLED: Array<{ file: string; field: string; why: string }> = [
  {
    file: "src/app/api/deals/[id]/seller-candidates/route.ts",
    field: "structuredResult",
    why: "readProposalDedupeKey 가 행을 받아 내부에서 parseStoredJsonObject 로 흡수",
  },
  {
    file: "src/app/api/sellers/[id]/deal-candidates/route.ts",
    field: "structuredResult",
    why: "같음",
  },
  {
    file: "src/app/api/recampaign-alerts/route.ts",
    field: "structuredResult",
    why: "같음",
  },
  {
    file: "src/app/api/recampaign-proposals/route.ts",
    field: "structuredResult",
    why: "같음",
  },
  {
    file: "src/lib/price-sheet/serialize-response.ts",
    field: "rawCells",
    why: "이 파일이 역직렬화 소유자다(행·시트 정규화의 정본)",
  },
  {
    file: "src/app/api/cron/recampaign-auto-propose/route.ts",
    field: "structuredResult",
    why: "readProposalDedupeKey 가 행을 받아 내부에서 parseStoredJsonObject 로 흡수",
  },
];

const ROOT = join(__dirname, "..", "..", "..");
const SCAN_DIRS = [join(ROOT, "src", "app"), join(ROOT, "src", "lib"), join(ROOT, "scripts")];
/** 직렬화 계약을 소유한 쪽 — 스캔 대상이 아니다. */
const EXEMPT = ["/repositories/", "/__tests__/", ".test.", "/stored-json.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("소스 스캔 — raw Json select 는 역직렬화를 동반해야 한다", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(d)).filter(
    (f) => !EXEMPT.some((e) => f.replace(/\\/g, "/").includes(e)),
  );

  it("스캔 대상 파일을 실제로 찾는다 (스캐너 고장 감지)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  const scan = () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
      const src = readFileSync(file, "utf8");
      for (const field of DUAL_MODE_JSON_FIELDS) {
        // `field: true` 형태 = Prisma select 절에서 그 컬럼을 가져온다는 뜻.
        if (!new RegExp(`\\b${field}\\s*:\\s*true\\b`).test(src)) continue;
        if (ROW_LEVEL_HANDLED.some((e) => e.file === rel && e.field === field)) continue;
        // 그 필드를 인자로 받는 역직렬화 호출이 있는가(제네릭 인자 허용).
        const parsed = new RegExp(
          `(${DESERIALIZERS.join("|")})\\s*(<[^>]*>)?\\s*\\([^)]*\\b${field}\\b`,
        ).test(src);
        if (!parsed) offenders.push(`${rel} → ${field}`);
      }
    }
    return offenders;
  };

  it("Json 컬럼을 select 하면 그 필드를 역직렬화한다", () => {
    expect(scan()).toEqual([]);
  });

  it("면제 목록은 실재하는 파일만 가리킨다 (낡은 면제가 가드를 갉지 않게)", () => {
    for (const entry of ROW_LEVEL_HANDLED) {
      const full = join(ROOT, entry.file);
      expect(() => statSync(full), `면제 항목이 가리키는 파일이 없다: ${entry.file}`).not.toThrow();
      expect(readFileSync(full, "utf8")).toMatch(new RegExp(`\\b${entry.field}\\b`));
    }
  });
});
