// 딜 패널 AI 어피던스 색 회수 계약 (오너 결정 2026-07-30, A안).
//
// 회수 대상: 딜 패널의 "AI 기능 = purple" 언어 3곳 — 키워드 추출 버튼 · 콘텐츠 가이드 버튼 ·
// 가이드 결과 카드. 셋은 한 덩어리다(버튼 두 개가 결과 카드를 띄운다). 한쪽만 바꾸면
// 버튼↔결과의 시각 연결이 끊기므로 이 파일도 셋을 함께 지킨다.
//
// **판정 근거는 가드레일 2가 아니다.** 가드레일 2는 "상태 배지" 스킴에 걸린 조항이고 여기 purple 은
// 버튼·컨테이너였다. 걸리는 조항은 P8 색 원칙 §4(범주는 색을 받지 않는다) — "AI 기능"은 좋고
// 나쁨이 없는 범주라 hue 를 받을 자리가 아니다. 짝 선례: `settlement-channel-color-reclaim.test.ts`
// (회차·파일 형식·판매채널에서 인디고·퍼플·스카이 회수, 오너 지시 2026-07-16) ·
// `category-color-reclaim.test.ts`(셀러 화면).
//
// 대체는 §4 가 이름으로 허용한 **브랜드 네이비 틴트(중립 태그 캐리어)** 다. 신규 토큰 0개.
// 실측 대비(실제 표면 = 섹션 `bg-white/90` on 페이지 `#F8FAFC` → `#FEFFFF`):
//   text-primary on bg-primary/10 = 9.43:1 · on bg-primary/5 = 10.32:1 · 본문 foreground = 16.29:1
//   (하네스는 P8 §5 기지값 #BF5050/흰 4.69 · #E7A567/흰 2.11 로 검증)
//
// ⚠️ **이 파일은 소스 그렙이다 — 그렙은 그 코드가 렌더에 도달하는지 못 본다.**
// 선례 파일들이 겪은 함정(`<Sheet open={false}>` 안의 죽은 코드를 고치고 전부 green)을 피하려고
// 색 단언과 **렌더 도달 단언을 짝으로** 둔다. 새 표면을 추가할 때도 이 규약을 유지할 것.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const DEALS = read("components/crm/deals-panel.tsx");
const DEALS_PAGE = read("app/deals/deals-page-client.tsx");
const DEAL_ASSET = read("components/crm/deal-asset-section.tsx");
const DEAL_SUPP = read("components/crm/deal-supplementary-info.tsx");
// 결과 카드의 **본문**은 2026-08-01 에 표시 계층으로 분리됐다(마크다운 기호를 걷어내고
// 섹션 구조를 살리기 위해). 색 계약은 카드와 본문이 한 덩어리라 이 파일이 둘 다 지킨다 —
// 본문만 다른 파일로 옮기면 그쪽에서 조용히 hue 가 되살아난다.
const GUIDE_VIEW = read("components/crm/content-guide-view.tsx");
// 레퍼런스 스트립도 같은 카드의 일부다(2026-08-01) — 사진 타일이 들어오는 자리라
// 범주 hue 가 되살아나기 쉽다. 매체 유형·좋아요는 좋고 나쁨이 없는 범주다.
const GUIDE_REFS = read("components/crm/content-guide-references.tsx");

/** className="..." / className={...} 안의 문자열만 — 주석 속 색 이름에 오탐하지 않는다. */
function classText(source: string): string {
  return (source.match(/className=(?:"[^"]*"|\{[^}]*\}|`[^`]*`)/g) ?? []).join("\n");
}

/** 앵커 구간. 앵커가 사라지면 테스트가 조용히 무력해지므로 항상 존재를 단언한다. */
function slice(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + 1);
  expect(a, `앵커 "${start}" 를 못 찾음 — 테스트가 무력해졌다`).toBeGreaterThan(-1);
  expect(b, `앵커 "${end}" 를 못 찾음 — 테스트가 무력해졌다`).toBeGreaterThan(a);
  return source.slice(a, b);
}

/** globals.css 에 없는 리터럴 hue — 범주 자리에 다시 붙으면 안 된다. */
const CATEGORY_HUES = ["purple", "violet", "indigo", "fuchsia", "pink", "sky", "teal", "orange"];

describe("렌더 도달 (그렙이 못 보는 것)", () => {
  it("DealsPanel 을 앱이 실제로 렌더한다 — 테스트만 부르는 죽은 컴포넌트가 아니다", () => {
    expect(DEALS_PAGE).toContain("<DealsPanel");
    expect(DEALS).toContain("export function DealsPanel");
    // DealsPanel 은 얇은 래퍼다 — 실제 트리는 DealsPanelContent 가 그린다.
    expect(DEALS).toContain("<DealsPanelContent");
  });

  it("색을 지키는 두 섹션이 그 트리 안에서 실제로 불린다", () => {
    expect(DEALS).toContain("<SupplementaryInfoFields");
    expect(DEALS).toContain("<DealAssetSection");
  });
});

describe("AI 어피던스 3곳 — 범주 hue 회수 (P8 색 원칙 §4)", () => {
  it("딜 패널 전체에 리터럴 범주 hue 가 없다", () => {
    const classes = classText(DEALS);
    for (const hue of CATEGORY_HUES) {
      expect(classes, `deals-panel 에 ${hue} 재유입`).not.toContain(hue);
    }
  });

  it("키워드 추출 버튼은 브랜드 네이비 틴트다", () => {
    const button = slice(DEAL_SUPP, 'label="검색 키워드 (AI)"', "void handleExtractKeyword");
    expect(button).toContain("border-primary/20 bg-primary/10 text-primary");
  });

  it("콘텐츠 가이드 버튼은 같은 틴트다 — 두 AI 버튼은 한 언어여야 한다", () => {
    const button = slice(DEAL_ASSET, ">첨부 자료</h3>", "void handleGenerateGuide");
    expect(button).toContain("border-primary/20 bg-primary/10 text-primary");
  });

  it("가이드 결과 카드는 버튼보다 옅다 — 긴 초안 본문이 얹히는 표면이기 때문", () => {
    // ⚠️ 앵커가 `{guide !== null ? (` 에서 카드 주석으로 옮겼다(2026-08-02, 유형 2원화).
    // 초안이 없어도 카드를 렌더해야 유형 탭이 보이므로(안 그러면 브랜드형으로 전환할
    // 방법 자체가 없다) 카드의 시작이 더 이상 그 조건식이 아니다. **판정 내용은
    // 그대로**이고 앵커 문자열만 옮긴 것이다 — 앵커가 사라지면 `slice` 가 실패한다.
    const card = slice(DEAL_ASSET, "── 콘텐츠 가이드 카드 ──", "<ContentGuideView");
    // 컨테이너 /5 < 버튼 /10. 원본(purple-50 버튼 vs purple-50/40 컨테이너)의 위계를 그대로 옮긴 것이다 —
    // "틴트 통일"을 이유로 컨테이너를 /10 으로 올리지 말 것. 본문 가독성이 그 위계의 이유다.
    expect(card).toContain("border border-primary/20 bg-primary/5");
    // 금지 단언은 **추출된 클래스 문자열**을 본다(64~69행과 같은 방식). 소스 원문 그렙이면
    // "이 클래스를 쓰지 말라"는 설명 주석을 다는 것만으로 실패한다 — 두 세션이 실제로 밟았고,
    // 한 세션은 근본 수정 대신 주석 표현을 우회해 넘겼다. 금지의 의도(틴트-온-틴트 5%p 는
    // 별개 요소로 안 읽힌다)는 그대로고, 판정 기준만 원문 → 렌더 결과로 옮긴 것이다.
    expect(classText(card)).not.toContain("bg-primary/10");
    // 메타 라벨은 틴트 위 text-primary (10.32:1).
    expect(card).toContain('className="text-[10px] font-medium text-primary"');
  });

  /**
   * 유형 탭(셀러형 / 브랜드형, 오너 결정 2026-08-02).
   *
   * 탭은 좋고 나쁨이 없는 **범주**라 hue 축을 타지 않는다(P8 §4). 게다가 이 카드는
   * 이미 `bg-primary/5` 라 그 위에 네이비 틴트를 얹으면 5%p 차이의 틴트-온-틴트가 되어
   * 별개 요소로 안 읽힌다 — 바로 위 테스트가 카드 안 `bg-primary/10` 을 막는 이유와
   * 같다. 그래서 활성 탭은 **색이 아니라 표면**(무채색 인셋)으로 가른다.
   */
  it("유형 탭은 색이 아니라 표면으로 활성 상태를 가른다", () => {
    const tabs = slice(DEAL_ASSET, 'role="tablist"', "</div>");
    expect(tabs).toContain("bg-background text-foreground");
    // 틴트로 되돌리는 경로를 막는다(카드 전체 금지와 별개로 이 자리에서도 못박는다).
    expect(classText(tabs)).not.toContain("bg-primary");
    for (const hue of CATEGORY_HUES) {
      expect(classText(tabs), `유형 탭에 ${hue} 유입`).not.toContain(hue);
    }
  });

  it("유형 탭은 초안이 없어도 렌더된다 — 감추면 브랜드형으로 갈 방법이 없다", () => {
    // 카드 여는 태그가 조건식 **밖**에 있어야 한다. 종전처럼 `{guide !== null ? (`
    // 안쪽에 있으면 초안이 없는 유형에서 탭째로 사라진다(전환 불가 = 기능 소실).
    const cardOpen = DEAL_ASSET.indexOf("── 콘텐츠 가이드 카드 ──");
    const tablist = DEAL_ASSET.indexOf('role="tablist"', cardOpen);
    const conditional = DEAL_ASSET.indexOf("{guide !== null ? (", cardOpen);
    expect(cardOpen).toBeGreaterThan(-1);
    expect(tablist).toBeGreaterThan(cardOpen);
    expect(conditional, "탭이 초안 조건식 안으로 들어갔다").toBeGreaterThan(tablist);
  });

  it("접근성 — 탭과 패널이 짝으로 연결된다", () => {
    expect(DEAL_ASSET).toContain('role="tablist"');
    expect(DEAL_ASSET).toContain('role="tab"');
    expect(DEAL_ASSET).toContain('role="tabpanel"');
    expect(DEAL_ASSET).toContain("aria-selected");
    expect(DEAL_ASSET).toContain("aria-controls");
    expect(DEAL_ASSET).toContain("aria-labelledby");
  });

  it("결과 카드 본문은 표시 계층에 있고, 그 계층이 실제로 렌더된다", () => {
    // 앵커 짝(18~20행 규약) — 본문을 다른 파일로 옮겼으므로 "그 파일이 불리는가"도 함께 본다.
    expect(DEAL_ASSET).toContain("<ContentGuideView");
    expect(GUIDE_VIEW).toContain("export function ContentGuideView");
  });

  it("결과 카드 본문은 색을 받지 않는다 — 초안 텍스트는 판단 지점이 아니다", () => {
    const classes = classText(GUIDE_VIEW);
    for (const hue of CATEGORY_HUES) {
      expect(classes, `content-guide-view 에 ${hue} 유입`).not.toContain(hue);
    }
    // 상태 hue 도 마찬가지다 — 섹션은 좋고 나쁨이 없는 **범주**라 심각도 축을 타지 않는다(P8 §4).
    // 지적은 이 컴포넌트 바깥의 표현 검사 strip 이 전담한다.
    for (const token of ["status-urgent", "status-caution", "money-", "goal-"]) {
      expect(classes, `본문에 상태 hue(${token}) 유입`).not.toContain(token);
    }
    // 본문은 foreground, 섹션 제목은 muted — 둘 다 무채색이다.
    expect(classes).toContain("text-foreground");
    expect(classes).toContain("text-muted-foreground");
  });

  it("레퍼런스 스트립도 색을 받지 않는다 — 매체 유형·좋아요는 범주다", () => {
    const classes = classText(GUIDE_REFS);
    for (const hue of CATEGORY_HUES) {
      expect(classes, `content-guide-references 에 ${hue} 유입`).not.toContain(hue);
    }
    for (const token of ["status-urgent", "status-caution", "money-", "goal-"]) {
      expect(classes, `레퍼런스 타일에 상태 hue(${token}) 유입`).not.toContain(token);
    }
    // 사진 위 마커는 스크림(불투명 배경) 위에 얹는다 — 저대비 고스트 금지.
    expect(classes).toContain("bg-black/55");
    // 렌더 도달 짝 — 그렙은 이 코드가 실제로 불리는지 못 본다.
    expect(DEAL_ASSET).toContain("<ContentGuideReferences");
    expect(GUIDE_REFS).toContain("export function ContentGuideReferences");
  });

  it("본문은 카드 안에 또 테두리 카드를 겹치지 않는다 — 예외는 근거 카드 하나", () => {
    // 카드 자체가 이미 `bg-primary/5` 틴트라, 섹션마다 상자를 치면 카드-인-카드가 된다.
    // 근거 카드만 표면(무채색 인셋)으로 구분한다 — 모델 생성물이 아니라 코드가 DB 값으로
    // 조립한 인용 가능 사실이라 출처가 다르기 때문. 그 인셋도 색이 아니라 표면이다.
    // `border <색>` 짝(= 테두리를 실제로 그리는 선언)만 센다. `\bborder\b` 는
    // `border-input` 안에서도 걸려 한 선언을 2회로 센다 — 이 함정에 한 번 걸렸다.
    //
    // 실선 상자는 근거 카드 하나뿐이다. 촬영 컷 프레임(`border-dashed`)은 상자가
    // 아니라 **아직 안 찍은 자리**의 표기라 이 계수에서 뺀다 — 실선으로 바꾸면
    // 완성물로 읽히고 카드-인-카드가 된다(그래서 점선 여부를 함께 단언한다).
    const solid = classText(GUIDE_VIEW)
      .split("\n")
      .filter((c) => /border border-/.test(c) && !c.includes("border-dashed"));
    expect(solid, "본문 섹션에 테두리 상자가 늘었다").toHaveLength(1);
    expect(GUIDE_VIEW).toContain("border border-input bg-background");
    expect(GUIDE_VIEW).toContain("border border-dashed border-slate-300");
  });

  it("본문 타이포는 P8 사다리 안에 머문다 — 9px·11px 이탈값 금지", () => {
    // P8 「데이터 그리드 3단 사다리」: 본문·버튼 = text-xs(12px) · 서브라벨 = text-[10px].
    // 9px·11px 은 사다리 밖이다. 촬영 컷을 3열로 좁히면 피사체 문장을 넣으려고
    // 글자를 9px 까지 내리게 되므로(실제로 초판이 그랬다) 열 수와 함께 지킨다.
    const classes = classText(GUIDE_VIEW);
    for (const off of ["text-[9px]", "text-[11px]", "text-[8px]"]) {
      expect(classes, `사다리 밖 ${off} 유입`).not.toContain(off);
    }
    expect(classes).toContain("grid-cols-2");
  });

  it("프레임 이미지는 **저장된 시안**만 건다 — 임의 URL 을 걸지 않는다", () => {
    // ⛔ 종전 단언 `expect(GUIDE_VIEW).not.toContain("<img")` 는 **SUPERSEDED**
    // (오너 결정 2026-08-01 — 컷 시안을 가이드 생성과 함께 그린다). 규칙이 막으려던
    // 것은 "이미지 태그"가 아니라 **실물과 다른 제품 사진**이었고, 그 방어선은 이제
    // 프롬프트의 스타일 락(흑백 선화·구도 전용·로고/글자/얼굴 금지)이 맡는다 —
    // 계약은 `src/lib/__tests__/guide-sketch.contract.test.ts` 가 고정한다.
    //
    // 여기서 지키는 것은 **출처**다: 화면에 걸리는 이미지가 스타일 락을 거쳐 우리
    // 스토리지에 저장된 시안(`sketchByKey`)에서만 와야 한다. 모델 출력이나 외부 URL 을
    // 그대로 `src` 에 넣는 경로가 생기면 스타일 락이 무의미해진다.
    expect(GUIDE_VIEW).toContain("sketchByKey");
    const imgSrcs = GUIDE_VIEW.match(/src=\{[^}]*\}/g) ?? [];
    expect(imgSrcs.length, "프레임 이미지 소스가 늘었다").toBe(1);
    // `src` 는 지역 변수 하나만 받는다. 그 변수의 **유일한 정의**가 `sketchByKey`
    // 조회여야 하고 재대입이 없어야 한다 — 그래야 "저장된 시안에서만 온다"가
    // 문자열 하나가 아니라 **경로**로 보장된다(2026-08-01 상태 표시 도입 때
    // `src={sketchByKey.get(...)}` 인라인이 지역 변수로 바뀌며 종전 단언이 깨졌고,
    // 그때 약화시키는 대신 이 형태로 조였다).
    expect(imgSrcs[0]).toBe("src={url}");
    const urlDefs = GUIDE_VIEW.match(/\burl\s*=[^=]/g) ?? [];
    expect(urlDefs.length, "`url` 이 여러 번 정의·재대입된다").toBe(1);
    expect(GUIDE_VIEW).toMatch(/const url = sketchByKey\?\.get\(/);
    // 배경 이미지로 우회하는 경로도 막는다(같은 이유).
    expect(GUIDE_VIEW).not.toContain("backgroundImage");
  });

  it("그림 위 글자는 스크림 위에 얹는다 — 흰 선화라 밝은 면이 많다", () => {
    // P8·styleseed: 사진 위 저대비 고스트 텍스트 금지. 스케치는 흰 배경이 지배적이라
    // 스크림 없이는 `text-white` 가 통째로 안 보인다.
    const classes = classText(GUIDE_VIEW);
    expect(classes).toContain("from-black/55");
    expect(classes).toContain("text-white");
  });
});
