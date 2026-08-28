// P8 색 회수 계약 — entity-type-badge.tsx (오너 결정 2026-07-30).
//
// 두 가지를 한꺼번에 고정한다. 성격이 다르므로 섞어 읽지 말 것:
//   ① **도달 불가 hue 9개 삭제** — partnerType 5색 · snsType 3색 · dealStatus.ARCHIVED(green).
//      §4("범주는 색을 받지 않는다") 위반이었으나 호출부가 0이라 시각 변화 없이 사라졌다.
//   ② **살아있는 dealStatus 5색의 가드레일 2 정렬** — sky/amber/teal/violet/slate 리터럴을
//      StatusBadge 어휘(status-info·caution·success·active + 무채색 중립 채움)로 옮겼다.
//      dealStatus 는 §1 생애주기 축이라 **색 자격이 있다** — 회수는 hue 어휘 쪽이다.
//
// ⚠️ **레거시 @theme 이름색 13개 제거는 이 파일이 담당하지 않는다** — #154 가 같은 날
// 먼저 착지시켰고 계약도 그쪽(`src/lib/__tests__/badge-config-guardrail2.test.tsx` 의
// "죽은 레거시 이름색 정리")에 있다. 여기에 같은 단언을 두면 두 파일이 갈라진다.
//
// ⚠️ 소스 그렙이라 렌더 도달을 못 본다 → 색 단언과 렌더 도달 단언을 짝으로 둔다
// (`settlement-channel-color-reclaim` · `deals-panel-ai-affordance-color` ·
//  `badge-config-guardrail2` 와 같은 규약). 워크트리에 `.env` 가 없어 dev 서버로 픽셀을
// 못 보므로, 아래 jsdom 실렌더가 "DOM 에 실제로 나온 class 속성"까지 확인하는 대체 수단이다.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";

import { EntityTypeBadge } from "../entity-type-badge";
import { dealStatusLabels } from "@/lib/crm-types";

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const BADGE = read("components/crm/entity-type-badge.tsx");
const CANONICAL = read("components/crm/status-badge.tsx");
const GRID = read("components/crm/deals-grid.tsx");
const PAGE_CLIENT = read("app/deals/deals-page-client.tsx");
const PAGE = read("app/deals/page.tsx");
const GLOBALS = read("app/globals.css");

/** 앵커 구간. 앵커가 사라지면 테스트가 조용히 무력해지므로 항상 존재를 단언한다. */
function slice(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + 1);
  expect(a, `앵커 "${start}" 를 못 찾음 — 테스트가 무력해졌다`).toBeGreaterThan(-1);
  expect(b, `앵커 "${end}" 를 못 찾음 — 테스트가 무력해졌다`).toBeGreaterThan(a);
  return source.slice(a, b);
}

/**
 * 주석을 같은 길이의 공백으로 치환한다(줄 수 보존). 이 파일의 대상 소스는 회수 근거를
 * 주석에 열거하므로(삭제한 맵 이름·hue 이름) 주석을 남기면 단언이 전부 자기 근거에
 * 오탐한다 — 실제로 첫 실행에서 그렇게 깨졌다. `css-token-idiom-contract` 와 같은 수법.
 */
function stripComments(source: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/** 색 맵 **본문**만 — 헤더 주석이 회수 근거로 열거한 색 이름에 오탐하지 않는다. */
const MAP_BODY = slice(stripComments(BADGE), "const dealStatusClassName", "\n};");

/** 코드(주석 제외)만 — 삭제된 심볼 이름이 주석에 남아 있는 것은 위반이 아니다. */
const BADGE_CODE = stripComments(BADGE);

/**
 * 맵이 실제로 배지에 얹는 **클래스 문자열**만 모은다. hue 이름을 소스 전체에
 * `toContain` 으로 찾으면 무관한 식별자에 걸린다 — `"red"` 가 `Rende·red·DealStatus`
 * 에 매칭돼 첫 실행에서 깨졌다. 값만 보면 그 오탐 계열이 원천 차단된다.
 */
const MAP_CLASSES = (MAP_BODY.match(/"[^"]*"/g) ?? []).join(" ");

describe("렌더 도달 (그렙이 못 보는 것 — 색 단언의 전제)", () => {
  it("앱이 실제로 이 배지를 렌더한다: DealsPage → DealsGrid → EntityTypeBadge", () => {
    expect(GRID).toContain('<EntityTypeBadge type="deal"');
    expect(GRID).toContain('from "./entity-type-badge"');
    expect(PAGE_CLIENT).toContain("<DealsGrid");
  });

  // ⚠️ 파일에 `<Component` 가 있다는 것은 **렌더 도달 증명이 아니다.** 이 레포에는
  // `<Sheet open={false}>` 안의 죽은 코드를 고치고 tsc·eslint·vitest 전부 green 을 받은
  // 실사고(#178)가 있고, 같은 날 인접 세션이 `SubGroupDivider` 를 "마운트된다"고 잘못
  // 보고했다(호출부 2곳이 전부 `lockedStageFilter="PROGRESS"` 라 그 분기는 도달 불가였다).
  // 그래서 조건부 분기의 **기본값까지** 고정한다.
  it("`/deals` 진입 경로가 조건 없이 이 배지 쪽 분기로 떨어진다", () => {
    // ① 라우트가 클라이언트 셸을 무조건 렌더한다(분기·게이트 없음).
    expect(PAGE).toContain("<DealsPageClient");
    expect(PAGE).not.toMatch(/\?\s*<DealsPageClient|&&\s*<DealsPageClient/);

    // ② DealsGrid 는 `activeTab === "deals"` 조건부인데 그 **기본값이 "deals"** 다 —
    //    즉 페이지 기본 뷰가 이 배지다. 기본값이 바뀌면 배지가 조용히 기본 뷰에서
    //    사라지므로(도달 자체는 남아도 "기본 뷰"라는 전제가 깨진다) 여기서 잡는다.
    expect(PAGE_CLIENT).toContain('filters.tab || "deals"');
    expect(PAGE_CLIENT).toContain('activeTab === "deals" ? (');

    // ③ 잠긴 필터로 다른 분기가 강제되고 있지 않다(SubGroupDivider 를 죽인 그 패턴).
    expect(PAGE_CLIENT).not.toContain("lockedTab");
  });

  it("소비처가 여전히 이 한 곳뿐이다 — 늘어나면 이 계약의 범위를 다시 봐야 한다", () => {
    // partner/seller 변형을 되살리려면 호출부를 먼저 만들어야 한다(죽은 색 재유입 방지).
    expect(BADGE_CODE).not.toMatch(/type:\s*"partner"|type:\s*"seller"/);
  });
});

describe("① 도달 불가 hue 9개 — 삭제 상태 유지", () => {
  it("partnerTypeClassName · snsTypeClassName 이 없다", () => {
    expect(BADGE_CODE).not.toContain("partnerTypeClassName");
    expect(BADGE_CODE).not.toContain("snsTypeClassName");
    // 라벨 맵은 다른 화면들이 쓰므로 import 도 사라져야 한다(죽은 import 회귀 방지).
    expect(BADGE_CODE).not.toContain("partnerTypeLabels");
    expect(BADGE_CODE).not.toContain("snsTypeLabels");
  });

  it("ARCHIVED 에 색을 주는 것이 **타입 에러**가 되도록 맵 키가 좁혀져 있다", () => {
    // 주석이 아니라 구조로 막는다 — Exclude 가 사라지면 green 이 조용히 돌아올 수 있다.
    expect(BADGE_CODE).toContain('Exclude<DealStatus, "ARCHIVED">');
    expect(MAP_BODY).not.toContain("ARCHIVED");
  });

  it("삭제된 hue 가 맵의 클래스 값으로 되돌아오지 않았다", () => {
    // 자체 점검 — 값을 하나도 못 걷었으면 아래 루프는 무의미하게 통과한다.
    expect(MAP_CLASSES).toContain("bg-status-");
    for (const hue of [
      "purple", "violet", "pink", "sky", "teal", "green", "emerald", "orange", "blue", "red",
      // ⛔ "slate" 는 이 목록에서 뺐다(한 축 규칙, 오너 결정 2026-07-30) — 중립이 outline 에서
      // **무채색 채움**(slate-100/700)으로 바뀌어 이제 정본 어휘다. 대신 아래 짝 단언이
      // 그 값이 SSOT 와 같은지를 지킨다. 회수 전 slate-500(4.34 AA 미달) 재유입은 jsdom 이 막는다.
    ]) {
      expect(MAP_CLASSES, `맵 클래스 값에 ${hue} 재유입`).not.toContain(hue);
    }
  });
});

describe("② 가드레일 2 정렬 — 값의 출처가 StatusBadge SSOT 에 실재한다", () => {
  // SSOT 에서 사라지면 이 정렬의 근거가 사라진 것이다 — 그때 알려주는 것이 이 단언의 목적.
  it.each([
    ["status-info", "bg-status-info/10 text-status-info"],
    ["status-caution", "bg-status-caution-bg text-status-caution"],
    ["status-success", "bg-status-success-bg text-status-success"],
    ["status-active", "bg-status-active/10 text-status-active"],
    ["중립 채움", "border-transparent bg-slate-100 text-slate-700"],
  ])("%s 짝이 status-badge.tsx 에 실재한다", (_label, pair) => {
    expect(CANONICAL).toContain(pair);
    expect(MAP_BODY).toContain(pair);
  });

  it("tint 2-tier 가 지켜진다 — caution·success 는 /10 이 아니라 전용 -bg", () => {
    // /10 으로 깔면 대비가 얕아져 AA 가 무너진다(StatusBadge 헤더 주석의 설계 의도).
    expect(MAP_BODY).not.toContain("bg-status-caution/10");
    expect(MAP_BODY).not.toContain("bg-status-success/10");
  });

  it("§6 @theme 노출 — 쓰는 토큰이 유틸로 실제 생성된다", () => {
    // 노출이 없으면 클래스는 붙고 색만 조용히 죽는다(tsc·테스트 전부 통과한다).
    for (const token of [
      "--color-status-info", "--color-status-caution", "--color-status-caution-bg",
      "--color-status-success", "--color-status-success-bg", "--color-status-active",
      "--color-border", "--color-foreground",
    ]) {
      expect(GLOBALS, `${token} 이 @theme 에 노출되지 않았다`).toContain(token);
    }
  });
});

// 위 단언은 전부 소스 그렙이다. 아래는 **실제로 DOM 에 나온 class 속성**을 본다.
describe("실렌더 (jsdom) — 그렙이 아니라 실제 DOM class 속성", () => {
  const cases: Array<[Parameters<typeof EntityTypeBadge>[0]["value"], string, string]> = [
    ["SOURCING", "bg-status-info/10", "text-status-info"],
    ["NEGOTIATING", "bg-status-caution-bg", "text-status-caution"],
    ["CONFIRMED", "bg-status-success-bg", "text-status-success"],
    ["SAMPLE_TESTING", "bg-status-active/10", "text-status-active"],
    ["DROPPED", "bg-slate-100", "text-slate-700"],
  ];

  it.each(cases)("%s 배지가 SSOT 토큰으로 렌더된다", (status, bg, text) => {
    render(<EntityTypeBadge type="deal" value={status} />);
    const el = screen.getByText(dealStatusLabels[status]);
    expect(el.className).toContain(bg);
    expect(el.className).toContain(text);
    expect(el.className).not.toMatch(/purple|violet|sky-|teal-|pink-/);
  });

  it("테두리는 5개가 전부 같다 — 의미는 채움만 진다(한 축 규칙)", () => {
    // ⛔ 종전 "DROPPED 만 테두리를 그린다"는 **SUPERSEDED**(오너 결정 2026-07-30).
    // 테두리로 중립을 표현하면 한 의미축을 두 캐리어가 나눠 지게 된다 — P8 §3 의
    // 캐리어 목록에 테두리가 없다. 색이 안 변하는 회귀라 눈으로는 못 잡는다.
    const { container } = render(
      <>
        <EntityTypeBadge type="deal" value="SOURCING" />
        <EntityTypeBadge type="deal" value="NEGOTIATING" />
        <EntityTypeBadge type="deal" value="CONFIRMED" />
        <EntityTypeBadge type="deal" value="SAMPLE_TESTING" />
        <EntityTypeBadge type="deal" value="DROPPED" />
      </>,
    );
    const badges = Array.from(container.querySelectorAll("span")).filter((n) =>
      Object.values(dealStatusLabels).includes(n.textContent ?? ""),
    );
    expect(badges).toHaveLength(5);
    for (const b of badges) {
      expect(b.className, `"${b.textContent}" 테두리가 상수가 아니다`).toContain(
        "border-transparent",
      );
      expect(b.className, `"${b.textContent}" 가 테두리로 의미를 싣는다`).not.toContain(
        "border-border",
      );
    }
    // 회수 전 slate-500/slate-100(4.34 — AA 미달)로 되돌아오지 않았다.
    const dropped = badges.find((b) => b.textContent === dealStatusLabels.DROPPED)!;
    expect(dropped.className).not.toContain("text-slate-500");
  });

  it("ARCHIVED 는 CONFIRMED 로 흡수된다 — 라벨·색 모두", () => {
    render(<EntityTypeBadge type="deal" value="ARCHIVED" />);
    // 리맵이 라벨까지 바꾸므로 "완료"가 아니라 "확정"이 나온다(회수 이전과 같은 동작).
    expect(screen.queryByText(dealStatusLabels.ARCHIVED)).toBeNull();
    const el = screen.getByText(dealStatusLabels.CONFIRMED);
    expect(el.className).toContain("bg-status-success-bg");
  });
});

// 값이 바뀌어도 AA 가 조용히 깨지지 않게, 대비를 테스트 안에서 다시 계산한다
// (`shared-badge-contrast` 선례). 표면은 배지가 실제로 앉는 자리다 —
// InlineDataGrid 행 배경 `bg-white/60` over 페이지 `#F8FAFC`.
describe("대비 게이트 (P8 §5 — 그 표면에서 직접 계산)", () => {
  type Rgb = [number, number, number];
  const hex = (h: string): Rgb => {
    const c = h.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)) as Rgb;
  };
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = (c: Rgb) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a: Rgb, b: Rgb) => {
    const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
    return (hi + 0.05) / (lo + 0.05);
  };
  const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb =>
    fg.map((c, i) => Math.round(alpha * c + (1 - alpha) * bg[i])) as Rgb;

  /** globals.css 의 :root 정의에서 hex 를 읽는다 — 하드코딩하면 토큰 변경을 놓친다. */
  const token = (name: string): Rgb => {
    const found = GLOBALS.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`));
    expect(found, `${name} 의 :root hex 정의를 못 찾음 — 테스트가 무력해졌다`).not.toBeNull();
    return hex(found![1]);
  };

  const ROW = over(hex("#FFFFFF"), 0.6, hex("#F8FAFC"));

  it.each([
    ["SOURCING (info on info/10)", () => ratio(token("--status-info"), over(token("--status-info"), 0.1, ROW))],
    ["NEGOTIATING (caution on caution-bg)", () => ratio(token("--status-caution"), token("--status-caution-bg"))],
    ["CONFIRMED (success on success-bg)", () => ratio(token("--status-success"), token("--status-success-bg"))],
    ["SAMPLE_TESTING (active on active/10)", () => ratio(token("--status-active"), over(token("--status-active"), 0.1, ROW))],
    ["DROPPED (foreground on 행 배경)", () => ratio(token("--foreground"), ROW)],
  ])("%s 가 AA(4.5:1) 이상", (_label, compute) => {
    expect(compute()).toBeGreaterThanOrEqual(4.5);
  });
});
