/**
 * 계약: **자금 방향 아이콘은 `money-direction.ts` 한 곳에서만 꺼낸다.**
 *
 * ## 왜 필요한가 (2026-08-28 오너 지적)
 * 이 레포는 방향의 **색**을 SSOT 로 묶으면서 *"방향은 아이콘 + 색 한 쌍으로만 말한다"* 고
 * 선언했지만, **아이콘은 화면마다 각자 import 하게 두었다.** 그래서 색은 같은데 모양이
 * 갈렸다 — 모바일 4곳은 원 안 화살표, 데스크톱 2곳(정산 헤더 · 선택 바)은 선 끝 화살표.
 * 오너가 화면에서 그 어긋남을 발견했고, 원 안 화살표로 통일했다.
 *
 * 색 상수들이 「주석만 남기면 드리프트를 못 잡는다」는 이유로 **실제 소비되는 상수**가 된
 * 것과 같은 처방이다. 이번에는 그 처방이 아이콘에 적용되지 않아 실제로 갈라졌다.
 *
 * 판정은 **AST** 로 한다 — 문자열 grep 은 위 설명 주석이 금지 이름을 인용하기만 해도
 * 자기 자신을 위반으로 잡는다(이 레포가 소스 스캔 계약에서 반복해서 밟은 함정).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** 방향 짝으로 쓰이는 이름 — lucide 의 은퇴 별칭까지 함께 막는다(우회 통로가 된다). */
const DIRECTION_ICON_NAMES = new Set([
  "CircleArrowUp",
  "CircleArrowDown",
  "ArrowUpCircle",
  "ArrowDownCircle",
  "ArrowUpCircleIcon",
  "ArrowDownCircleIcon",
]);

/** 유일한 소유자. 여기서만 lucide 를 직접 부른다. */
const OWNER = "lib/money-direction.ts";

/**
 * 예외 — 값은 **왜 허용되는가**다. 이유 없이 늘어나면 게이트가 무의미해진다.
 * ⚠️ 파일 단위 면제이므로, 등재된 파일에서도 **방향을 뜻하는 자리**는 SSOT 를 쓴다
 * (여기 있는 파일의 방향 사용 4곳은 실제로 전부 `MONEY_DIRECTION_ICON` 을 거친다).
 */
const ALLOWED: Record<string, string> = {
  "components/crm/calendar-view.tsx":
    "범례의 「지연」 마커 1곳 — 심각도축이라 방향을 말하지 않는다(모양만 빌려 쓴다). 같은 파일의 방향 사용 4곳은 SSOT 경유",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "generated") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** `lucide-react` 에서 직접 가져온 이름만 모은다(주석·문자열은 AST 에 없어 자연히 빠진다). */
function lucideNamedImports(filePath: string): string[] {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const names: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "lucide-react") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      names.push((element.propertyName ?? element.name).text);
    }
  }
  return names;
}

describe("자금 방향 아이콘 — SSOT 경계", () => {
  const files = walk(SRC).map((file) => ({
    path: relative(SRC, file).split("\\").join("/"),
    names: lucideNamedImports(file),
  }));

  it("소유자 밖에서는 방향 아이콘을 직접 import 하지 않는다", () => {
    const offenders = files
      .filter((file) => file.path !== OWNER && !(file.path in ALLOWED))
      .filter((file) => file.names.some((name) => DIRECTION_ICON_NAMES.has(name)))
      .map((file) => file.path);

    expect(
      offenders,
      `방향 아이콘은 MONEY_DIRECTION_ICON 으로 꺼낸다(색과 짝이다): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("소유자는 실제로 그 아이콘을 들고 있다(양성 프로브)", () => {
    // 이 단언이 없으면 walk() 나 파서가 고장 나 **아무것도 못 읽을 때**도 위 테스트가 초록이다.
    const owner = files.find((file) => file.path === OWNER);
    expect(owner, "소유자 파일을 못 찾았다 — 스캐너가 고장났다").toBeDefined();
    expect(owner!.names).toEqual(
      expect.arrayContaining(["CircleArrowUp", "CircleArrowDown"]),
    );
  });

  it("스캐너가 lucide 아닌 import 는 세지 않는다(음성 대조군)", () => {
    // 같은 이름을 다른 모듈에서 가져오는 것은 이 계약의 대상이 아니다 — 판정이 모듈까지
    // 보는지 확인한다. 안 보면 `@/lib/money-direction` 의 소비처가 전부 위반으로 잡힌다.
    const consumers = files.filter((file) => file.path.startsWith("components/mobile/"));
    expect(consumers.length).toBeGreaterThan(0);
    expect(consumers.every((file) => !file.names.includes("MONEY_DIRECTION_ICON"))).toBe(true);
  });
});
