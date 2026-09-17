import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 주문 관리 화면의 **뷰포트 높이 계약** — 카드 접힘/펼침 폭 흔들림 회귀 가드.
 *
 * 앱 셸(`AppShellFrame` · `ui/sidebar.tsx`)은 `min-h-svh`(최소 높이)만 준다 = 높이가
 * `auto` 다. 그러면 내용이 화면보다 길어질 때 셸이 늘어나고, `CrmShell` 의 `h-full` 이
 * 기댈 확정 높이가 없어 셸 안쪽 스크롤러가 스크롤하지 않는다 — 대신 **문서(브라우저 창)가
 * 스크롤한다.** 창 스크롤바가 나타나는 순간 뷰포트 폭이 그만큼 줄어 **카드 너비가 함께 준다.**
 * 실측(2026-09-18, 1440x900): 접힘 1263px → 펼침 1248px, 창 스크롤바 15px.
 *
 * 🪤 **`flex-1` 이 이 계약의 함정이다.** flex 아이템의 주축 크기는 `flex-basis`(`flex-1` =
 * `0%`)가 정하므로 `height` 가 쓰이지 않는다. 실측: `flex-1 h-svh` 는 computed height 가
 * 900px 로 **고쳐진 것처럼 보이는데도** 문서가 197px 넘쳐 흔들림이 그대로였다. 그래서 이
 * 계약은 `h-svh` 존재만 보지 않고 **`flex-1` 부재까지** 함께 본다.
 *
 * ⛔ 전역 셸의 `min-h-svh` 를 `h-svh` 로 바꿔 고치지 말 것 — 그 래퍼는 문서 스크롤에 기대는
 * 화면들도 함께 쓴다. 높이를 전역에서 자르면 그쪽 아래가 스크롤 수단 없이 잘린다(실측).
 *
 * jsdom 은 svh·레이아웃을 모르므로 렌더 테스트로는 못 잡는다 — 소스 계약으로 고정한다
 * (`pipeline-loading-height-contract` 와 같은 형태).
 */

const PAGE_RAW = readFileSync(join(process.cwd(), "src/app/order-converter/page.tsx"), "utf8");
// 주석 제거 — 이 파일도 본문 주석이 `flex-1` 을 금지 사유로 **인용**하므로, 원문을 그대로
// 검사하면 가드가 자기 경고문에 걸려 오탐한다. `[^:]` 는 `https://` 를 지키기 위한 것.
const PAGE = PAGE_RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** className 문자열만 남긴다 — 주석을 걷어낸 뒤에도 남는 식별자·문구를 배제한다. */
const CLASS_ATTRS = [...PAGE.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);

describe("주문 관리 화면 뷰포트 높이 계약", () => {
  it("바깥 래퍼가 뷰포트 높이를 확정한다(h-svh)", () => {
    expect(
      CLASS_ATTRS.some((c) => c.split(/\s+/).includes("h-svh")),
      "h-svh 가 없다 — 셸 높이가 auto 가 되어 문서가 스크롤하고, 창 스크롤바 등장으로 카드 폭이 흔들린다",
    ).toBe(true);
  });

  it("그 래퍼에 flex-1 을 함께 쓰지 않는다 — flex-basis 가 height 를 이긴다", () => {
    const offender = CLASS_ATTRS.find(
      (c) => c.split(/\s+/).includes("h-svh") && c.split(/\s+/).includes("flex-1"),
    );
    expect(
      offender,
      `flex-1 과 h-svh 가 같은 요소에 있다("${offender}") — 높이가 무시돼 흔들림이 그대로다`,
    ).toBeUndefined();
  });

  it("안쪽 래퍼가 그 높이를 물려받는다(h-full)", () => {
    // 여기서 끊기면 CrmShell 이 다시 auto 높이가 되어 바깥 h-svh 가 무의미해진다.
    expect(
      CLASS_ATTRS.some((c) => c.split(/\s+/).includes("h-full")),
      "안쪽 래퍼의 h-full 이 없다 — 확정한 높이가 CrmShell 까지 내려가지 않는다",
    ).toBe(true);
  });
});
