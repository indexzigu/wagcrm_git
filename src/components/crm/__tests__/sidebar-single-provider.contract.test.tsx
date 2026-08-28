import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * **앱 트리에 `SidebarProvider` 는 정확히 하나다.**
 *
 * 2026-08-25 실측 결함: 루트 레이아웃에 두 번째 `SidebarProvider` 가 있었다
 * (`SidebarPersistentProvider`). 상태는 아무도 안 읽었지만 — `useSidebar` 소비자는
 * 안쪽 provider 안의 `CrmSidebar` 뿐이다 — provider 는 **Cmd+B 키보드 핸들러를 등록하고
 * 그 핸들러가 쿠키를 쓴다.** 그래서:
 *   ① Cmd+B 한 번에 쿠키가 **두 번** 쓰였다. 두 provider 의 초기 상태가 서로 달라
 *      (바깥=리터럴 기본값 / 안쪽=쿠키값) 값이 정반대였고, 최종 결과가 맞았던 것은
 *      안쪽 리스너가 나중에 등록돼 덮어썼기 때문 — **등록 순서에 기댄 우연**이다.
 *   ② 사이드바가 없는 페이지(`/login`·`/auth`·`/privacy`·`/p/*`·셀러 포털)에는 안쪽
 *      provider 가 없어 **바깥쪽 것만 썼다** → 접어 둔 상태가 조용히 뒤집혔다
 *      (`/privacy` 에서 Cmd+B → `sidebar_state` false→true, 실측 재현).
 *
 * ⚠️ **위 ①②는 2026-08-25 당시의 증상이고, 그 증상은 이제 성립하지 않는다** —
 * 2026-08-28 호버 오버레이 전환으로 Cmd+B 단축키도 쿠키 쓰기도 사라졌다(설계서 §4).
 * ⛔ **그렇다고 이 계약을 지우지 말 것.** 지금 지키는 이유는 더 직접적이다:
 * provider 가 둘이면 `open` 상태가 **둘로 갈리고**, `Sidebar` 는 가장 가까운 provider 를
 * 읽으므로 **호버 훅(`useSidebarPeek`)이 켠 상태와 빈 칸·패널이 읽는 상태가 어긋난다.**
 * 같은 부류의 드리프트가 그대로 성립한다.
 *
 * 종전 이 파일에는 「왜 하나여야 하는가」 describe 가 있어 Cmd+B 로 쿠키 쓰기를
 * 실증했는데, 실행 대상(단축키·쿠키)이 사라져 삭제했다.
 */

const SRC = join(__dirname, "..", "..", "..");
/** 프리미티브 정의 파일 자신은 제외한다 — 거기 있는 `SidebarProvider` 는 선언이다. */
const PRIMITIVE = join(SRC, "components", "ui", "sidebar.tsx");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      collectSourceFiles(path, out);
    } else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) && path !== PRIMITIVE) {
      out.push(path);
    }
  }
  return out;
}

/** `<SidebarProvider …>` 를 **렌더하는** 자리만 센다(import·타입 참조는 제외). */
function providerRenderSites(path: string): number {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let count = 0;
  const walk = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText() === "SidebarProvider"
    ) {
      count += 1;
    }
    node.forEachChild(walk);
  };
  walk(source);
  return count;
}

describe("SidebarProvider 단일 계약 — 두 개면 호버 상태가 둘로 갈린다", () => {
  const files = collectSourceFiles(join(SRC, "app")).concat(
    collectSourceFiles(join(SRC, "components")),
  );

  it("스캔 대상 파일을 실제로 모았다 (스캐너 양성 대조군)", () => {
    // 수집이 0건이면 아래 계약이 조용히 통과한다.
    expect(files.length).toBeGreaterThan(50);
  });

  it("앱 트리 전체에서 SidebarProvider 렌더 자리는 정확히 하나다", () => {
    const sites = files
      .map((path) => ({ path, count: providerRenderSites(path) }))
      .filter((entry) => entry.count > 0);

    expect(sites.map((entry) => `${entry.path.replace(SRC, "src")} ×${entry.count}`)).toEqual([
      "src/components/crm/persistent-sidebar-layout.tsx ×1",
    ]);
  });
});

