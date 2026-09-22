import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 데스크톱 CRM **뷰포트 높이 계약** — 카드 펼침/접힘에 따른 폭 흔들림 회귀 가드.
 *
 * 상위 셸(`AppShellFrame` · `SidebarProvider`)은 `min-h-svh`(최소 높이)만 준다. 높이를
 * 확정하는 곳이 없으면 내용이 화면보다 길어지는 순간 셸 전체가 늘어나 `CrmShell` 의 안쪽
 * 스크롤러 대신 **창이 스크롤**하고, 창 스크롤바 폭(실측 15px)만큼 카드가 좁아진다.
 * #84 는 주문관리 한 화면에만 높이를 확정했고, T-178 실측(1440x900)에서 나머지 CrmShell
 * 화면 전부가 같은 증상을 보였다 — 그래서 앵커를 `SidebarInset` 한 곳으로 옮겼다.
 *
 * ⛔ 앵커를 `AppShellFrame` 으로 올리지 말 것 — 그 래퍼는 창 스크롤에 기대는 사이드바 없는
 * 화면(`/privacy` · 로그인 등)도 감싼다. `SidebarInset` 은 그 화면들이 거치지 않는다.
 *
 * jsdom 은 svh·레이아웃을 모르므로 소스 계약으로 고정한다.
 */

// 블록 주석 제거가 JSX `{/* */}` 주석도 함께 걷는다(`{}` 만 남는다) — 주석이 `md:h-svh` 를
// 인용해도 스캔에 잡히지 않는다.
const strip = (raw: string) =>
  raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (p: string) => strip(readFileSync(join(process.cwd(), p), "utf8"));

const classAttrs = (src: string) => [...src.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
const tokens = (c: string) => c.split(/\s+/).filter(Boolean);
const hasUtility = (c: string, name: string) =>
  tokens(c).some((t) => t === name || t.endsWith(`:${name}`));

const LAYOUT = read("src/components/crm/persistent-sidebar-layout.tsx");
const INSET_CLASS = LAYOUT.match(/<SidebarInset className="([^"]*)"/)?.[1];

const PAGE_CLASSES = classAttrs(read("src/app/order-converter/page.tsx"));

describe("데스크톱 셸 뷰포트 높이 계약", () => {
  it("SidebarInset 의 className 을 실제로 읽어 왔다(음성 대조군)", () => {
    // 이 가드가 없으면 아래 단언들이 추출 0건일 때 조용히 무의미해진다 —
    // className 이 cn()·템플릿 리터럴로 바뀌면 이 계약도 그 형태에 맞게 고칠 것.
    expect(INSET_CLASS, "SidebarInset className 리터럴을 못 찾았다").toBeDefined();
    expect(PAGE_CLASSES.length, "주문관리 화면 className 리터럴을 못 읽었다").toBeGreaterThan(0);
  });

  it("SidebarInset 이 데스크톱 폭에서 뷰포트 높이를 확정한다(md:h-svh)", () => {
    const t = tokens(INSET_CLASS ?? "");
    expect(
      t.includes("md:h-svh"),
      "md:h-svh 가 없다 — 넘침이 창으로 새어 창 스크롤바 등장만큼 카드 폭이 흔들린다",
    ).toBe(true);
    // 모바일은 하단 nav 자리(`pb-20`)를 뷰포트 높이가 무시하면 셸 하단이 nav 밑에 깔린다.
    expect(t.includes("h-svh"), "접두사 없는 h-svh — 모바일에서 셸 하단이 하단 nav 에 깔린다").toBe(false);
  });

  it("주문관리 화면은 그 높이를 h-full 로 물려받고 flex-1 을 쓰지 않는다", () => {
    // 부모(SidebarInset)가 세로 flex 라 flex-1 이면 최소 높이가 내용 기준으로 풀려
    // 래퍼가 내용만큼 자란다(#84 실측: 문서 197px 넘침).
    expect(
      PAGE_CLASSES.filter((c) => hasUtility(c, "h-full")).length,
      "바깥·안쪽 래퍼 둘 다 h-full 이어야 CrmShell 까지 높이가 내려간다",
    ).toBeGreaterThanOrEqual(2);
    const offender = PAGE_CLASSES.find((c) => hasUtility(c, "flex-1"));
    expect(offender, `flex-1 이 있다("${offender}") — 높이 사슬이 끊긴다`).toBeUndefined();
  });

  // 높이가 확정되면 넘침은 창 대신 각 화면의 안쪽 스크롤러로 간다. 그 스크롤러가 자리를
  // 예약하지 않으면 흔들림이 한 층 안쪽에서 재현된다(T-178 실측: 정산 1392→1377px).
  it.each([
    ["CrmShell 안쪽 스크롤러", "src/components/crm/crm-shell.tsx", /className="[^"]*overflow-y-auto[^"]*"/],
    ["주문관리 목록 스크롤러", "src/components/crm/order-dashboard.tsx", /className="[^"]*overflow-auto bg-\[#f8fafc\][^"]*"/],
    ["정산 화면 루트", "src/app/settlement/settlement-page-client.tsx", /className="flex min-h-0 w-full flex-1 flex-col overflow-auto[^"]*"/],
  ])("%s — 스크롤바 자리를 예약한다", (_label, file, pattern) => {
    const scroller = read(file).match(pattern)?.[0];
    expect(scroller, `스크롤러를 찾지 못했다 — 클래스가 바뀌었다면 이 계약도 함께 고칠 것 (${file})`).toBeDefined();
    expect(scroller, "[scrollbar-gutter:stable] 이 없다 — 스크롤바 등장 순간 폭이 흔들린다").toContain(
      "[scrollbar-gutter:stable]",
    );
  });
});
