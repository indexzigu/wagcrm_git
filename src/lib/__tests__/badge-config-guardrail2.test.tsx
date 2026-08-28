// @vitest-environment jsdom
// P8 가드레일 2 + **한 축 규칙** 정렬 계약 — 상태 배지 4개 맵 (오너 결정 2026-07-30).
//
// 가드레일 2 는 이 파일을 **이름으로** 지목한다: "상태 배지 색은 StatusBadge
// (src/components/crm/status-badge.tsx) 스킴이 유일 정본 — purple 등 신규 hue 도입 금지.
// 다른 배지 설정(badge-config.ts 등)은 이 스킴에 정렬한다."
//
// ⛔ **한 축 규칙(오너 결정)**: *"테두리는 모든 배지가 동일한 값을 사용하고 채움색만 차이를
// 둔다."* P8 §3 이 캐리어를 이름으로 나열할 때 *"배지 fill · 아이콘 · 바 fill · 행 tint ·
// 도트"* 로 **테두리가 없으므로**, 이건 새 규칙이 아니라 문서를 코드에 맞춘 것이다.
// 이 파일은 그 규칙을 **살아 있는 맵 전부**에 대해 고정한다:
//   `statusClassName`(SSOT) · `SUB_STAGE_BADGE_CONFIG` · `dealStatusClassName`.
//   (`outreachStatusClassName` 은 소비처 0건이라 PR #166 이 파일째 삭제했다.)
//
// 세 번 왕복한 이력 — 다음 세션이 같은 길을 다시 돌지 않도록:
//   #152 채움 slate-200/700(캐리어 우회) → #154 중립 outline + `border` 필드(제약 제거) →
//   **이 PR** SSOT 자체가 두 축이었음을 정정(6개는 채움, 2개는 테두리로 의미를 졌다).
//   값은 #152 쪽으로 돌아왔지만 **이유가 다르다** — 우회가 아니라 축 정리다.
//
// ⚠️ 이 파일은 "이 맵들이 전부 정렬됐다"고 주장하지 않는다. `SUB_STAGE_BADGE_CONFIG` 의
// blue·amber·green 리터럴과 ACTIVE·SETTLEMENT_IN_PROGRESS 의 **의미축 차이**는 그대로다
// — 아래가 그 미정렬 사실 자체를 고정한다(고칠 것을 "이미 됐다"로 덮지 않기 위해).
//
// ⚠️ 소스 그렙이라 렌더 도달을 못 본다 → 색 단언과 렌더 도달 단언을 짝으로 둔다
// (`settlement-channel-color-reclaim` · `deals-panel-ai-affordance-color` 와 같은 규약).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { render, screen } from "@testing-library/react";

import { SUB_STAGE_BADGE_CONFIG } from "../badge-config";
import type { CampaignStatus } from "../crm-types";
import { SubStageBadge } from "@/components/crm/sub-stage-badge";

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const CONFIG = read("lib/badge-config.ts");
const SUB_STAGE_BADGE = read("components/crm/sub-stage-badge.tsx");
const STAGE_COLUMN = read("components/crm/stage-column.tsx");
const STAGE_KANBAN = read("components/crm/stage-kanban-board.tsx");
const GROUPED_TABLE = read("components/crm/grouped-table-view.tsx");
const GROUP_SECTION = read("components/crm/campaign-group-section.tsx");
const SIDE_PANEL = read("components/crm/campaign-side-panel.tsx");
const CRM_DASHBOARD = read("components/crm/crm-dashboard.tsx");
const CANONICAL = read("components/crm/status-badge.tsx");
const BADGE_PRIMITIVE = read("components/ui/badge.tsx");
const ENTITY_BADGE = read("components/crm/entity-type-badge.tsx");
const ZONE_CONFIG = read("lib/zone-config.ts");
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
 * 줄 주석 제거. 주석에 적힌 색 이름·클래스에 오탐하면 "회귀가 있다"고 거짓 실패한다
 * (이 계약이 실제로 그렇게 한 번 깨졌다 — 근거 서술에 `border-transparent` 가 들어 있었다).
 */
function code(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, "");
}

/**
 * SSOT 의 **배지** 맵에서 한 상태의 클래스를 뽑는다. 같은 파일의 `statusBarClassName`
 * (캘린더 바 — 채움강도 축이 얹힌 별개 캐리어)을 잘못 집으면 정렬 대상이 통째로 바뀐다.
 * #152 가 고른 값이 바로 그 바 맵 쪽이었다.
 */
function ssotBadgeClass(status: keyof typeof SUB_STAGE_BADGE_CONFIG): string {
  const map = slice(CANONICAL, "const statusClassName", "statusBarClassName");
  const match = map.match(new RegExp(`\\b${status}:\\s*"([^"]*)"`));
  expect(match, `SSOT 배지 맵에서 ${status} 를 못 찾음`).not.toBeNull();
  return match![1];
}

/** 소비처 0건으로 확인돼 제거한 레거시 이름색(2026-07-30). */
const REMOVED_LEGACY_TOKENS = [
  "lavender-purple",
  "peach-pink",
  "light-blue",
  "mint-blue",
  "deep-blue",
  "mint-green",
  "lime-green",
  "emerald-green",
  "coral-orange",
  "neon-coral",
  "electric-teal",
  "deep-navy",
  "cloud-dancer",
];

describe("렌더 도달 (그렙이 못 보는 것)", () => {
  it("두 소비처가 실제로 이 맵을 읽는다", () => {
    expect(SUB_STAGE_BADGE).toContain("SUB_STAGE_BADGE_CONFIG");
    expect(STAGE_COLUMN).toContain("SUB_STAGE_BADGE_CONFIG");
  });

  it("SubStageBadge 는 앱이 실제로 렌더한다 — dev 서버 실렌더 검증 완료 경로", () => {
    // 이 경로에서 CLOSED 배지의 계산 스타일까지 확인했다(2026-07-30, sqlite dev.db):
    // bg rgba(0,0,0,0) · color rgb(15,23,42) · border rgba(15,23,42,0.08) 1px.
    expect(SUB_STAGE_BADGE).toContain("export function SubStageBadge");
    expect(GROUPED_TABLE).toContain("<SubStageBadge");
    expect(CRM_DASHBOARD).toContain("<GroupedTableView");
    expect(GROUP_SECTION).toContain("<SubStageBadge");
    expect(SIDE_PANEL).toContain("<CampaignGroupSection");
    expect(CRM_DASHBOARD).toContain("<CampaignSidePanel");
  });

  it("⚠️ SubGroupDivider 는 현재 도달 불가 — 되살아나면 이 테스트가 알려준다", () => {
    // 배선 자체는 있다: SubGroupDivider → StageColumn → StageKanbanBoard → CrmDashboard.
    expect(STAGE_COLUMN).toContain("<SubGroupDivider");
    expect(STAGE_KANBAN).toContain("<StageColumn");
    expect(CRM_DASHBOARD).toContain("<StageKanbanBoard");

    // 그런데 그 분기가 닫혀 있다. StageKanbanBoard 는 `useExecutionKanban` 이 거짓일 때만
    // 그려지는데(참이면 ExecutionKanbanBoard), 판정식이 `kanban && PROGRESS` 이고
    // **CrmDashboard 의 두 호출부가 전부 lockedStageFilter="PROGRESS"** 라 칸반 모드에서는
    // 항상 참이다 → StageColumn 은 오늘 렌더되지 않는다(실측 2026-07-30, dev 서버).
    // 그래도 색을 정렬해 두는 이유: 되살릴 때 purple 이 함께 되살아나면 안 되기 때문이다.
    expect(code(CRM_DASHBOARD)).toContain(
      'viewMode === "kanban" && effectiveStageFilter === "PROGRESS"',
    );
    for (const rel of ["app/pipeline/page.tsx", "app/pipeline/tasks/page.tsx"]) {
      expect(
        read(rel),
        `${rel} 의 stage 락이 풀렸다 — StageColumn/SubGroupDivider 가 살아났을 수 있다. ` +
          "칸반에서 세부상태 divider 칩의 실렌더(특히 CLOSED 의 중립 outline)를 눈으로 확인하라.",
      ).toContain('lockedStageFilter="PROGRESS"');
    }
    // 호출부가 늘어나면 위 두 개만 보는 이 가드가 조용히 샌다 — 전수로 다시 센다.
    // ⚠️ `src/app` 만 훑으면 `src/components` 등에서 여는 호출부를 놓쳐 이 가드가 막으려던
    // 누수가 그대로 재현된다(code-reviewer L1). `src/` 전체를 훑고, 경로 구분자를 POSIX 로
    // 정규화한다(Windows 에서 `pipeline\page.tsx` 로 나와 기대값과 어긋나던 문제).
    const isTest = (f: string) =>
      f.includes("__tests__") || f.includes(".test.") || f.startsWith("test/");
    const allCallSites = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .map((f) => f.split(sep).join("/"))
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => read(f).includes("<CrmDashboard"))
      .sort();

    // **앱** 호출부는 이 둘뿐이고 둘 다 락이 걸려 있다 = 프로덕션 도달 불가의 근거.
    expect(
      allCallSites.filter((f) => !isTest(f)),
      "CrmDashboard 앱 호출부가 늘었다 — 새 호출부가 stage 락 없이 열렸다면 StageColumn 이 살아난다",
    ).toEqual(["app/pipeline/page.tsx", "app/pipeline/tasks/page.tsx"]);

    // ⚠️ 다만 **테스트에서는 그려진다** — 이 통합 테스트가 락 없이 렌더하므로
    // `effectiveStageFilter` 가 URL 파라미터를 타고 PROGRESS 밖으로 갈 수 있다.
    // 그래서 `StageColumn` 은 "도달 불가"이되 "커버리지 0"은 아니다. 둘을 혼동하지 말 것
    // (code-reviewer L1 조사 중 발견 — 앱 전수만 세면 이 사실이 안 보인다).
    // 테스트 파일 목록 자체는 고정하지 않는다 — 오고 가는 게 정상이고, 이 파일도 문자열
    // `<CrmDashboard` 를 포함해 자기 자신이 잡힌다. 락 없는 렌더가 **하나라도** 있다는
    // 사실만 지킨다.
    expect(
      read("test/pipeline-kanban-remodel.test.tsx"),
      "락 없이 CrmDashboard 를 렌더하던 통합 테스트가 사라졌다 — StageColumn 커버리지 재확인 필요",
    ).toContain("<CrmDashboard initialData={data} />");
  });
});

describe("가드레일 2 — CLOSED purple 회수", () => {
  it("맵 어디에도 purple 이 없다", () => {
    // 값 기반 — 주석에 적힌 "purple 회수"(회수 근거 서술)에 오탐하지 않는다.
    for (const [status, cfg] of Object.entries(SUB_STAGE_BADGE_CONFIG)) {
      expect(`${cfg.bg} ${cfg.text}`, `${status} 에 purple 재유입`).not.toMatch(
        /purple|violet/,
      );
    }
    // 맵 **본문** 그렙도 함께 — 값이 아닌 자리(헬퍼·조건부 클래스)로 되돌아오는 것도 막는다.
    const body = slice(CONFIG, "export const SUB_STAGE_BADGE_CONFIG", "\n};");
    expect(code(body)).not.toMatch(/purple|violet/);
  });

  it("CLOSED 는 SSOT 배지 맵의 중립 채움과 문자 그대로 같다", () => {
    const cfg = SUB_STAGE_BADGE_CONFIG.CLOSED;
    const ssot = ssotBadgeClass("CLOSED");
    // SSOT 는 한 문자열, 여기는 필드로 쪼개져 있다 — 테두리는 상수라 소비처 몫이므로
    // 채움·글자 두 토큰만 대조한다.
    expect(ssot.split(/\s+/)).toContain(cfg.bg);
    expect(ssot.split(/\s+/)).toContain(cfg.text);
    // 회귀 시 무엇이 정답이었는지 바로 읽히도록 값도 함께 고정한다.
    expect(ssot).toBe("border-transparent bg-slate-200 text-slate-800");
  });

  it("PREPARATION 도 SSOT 와 같다 — 두 중립이 함께 움직여야 2단이 유지된다", () => {
    expect(ssotBadgeClass("PREPARATION")).toBe(
      "border-transparent bg-slate-100 text-slate-700",
    );
    expect(SUB_STAGE_BADGE_CONFIG.PREPARATION.bg).toBe("bg-slate-100");
    expect(SUB_STAGE_BADGE_CONFIG.PREPARATION.text).toBe("text-slate-700");
  });

  it("두 중립이 채움으로 갈린다 — 같은 컬럼에 인접하기 때문", () => {
    // 테두리가 상수가 됐으므로 구분은 **채움만** 진다. 여기가 같아지면 두 상태가
    // 눈으로 구분되지 않는다(라벨만 남는다).
    expect(SUB_STAGE_BADGE_CONFIG.CLOSED.bg).not.toBe(
      SUB_STAGE_BADGE_CONFIG.PREPARATION.bg,
    );
    // 인접이 전제다. 컬럼 구성이 바뀌면 이 단언이 깨져서 알려준다.
    expect(ZONE_CONFIG).toContain(
      '["PREPARATION", "ACTIVE", "CLOSED", "SETTLEMENT_WAIT"]',
    );
  });
});

describe("한 축 규칙 — 테두리는 상수, 의미는 채움만 (4개 맵 전수)", () => {
  /** `STATE: "..."` 형태의 맵 본문에서 클래스 문자열을 전부 뽑는다. */
  function mapValues(source: string, start: string): string[] {
    const body = slice(source, start, "\n};");
    return Array.from(body.matchAll(/^\s+[A-Z_]+:\s*"([^"]*)"/gm)).map((m) => m[1]);
  }

  const MAPS: Array<[string, string[]]> = [
    ["statusClassName (SSOT)", mapValues(CANONICAL, "const statusClassName")],
    ["dealStatusClassName", mapValues(ENTITY_BADGE, "const dealStatusClassName")],
  ];

  it.each(MAPS)("%s — 모든 항목이 border-transparent 다", (_name, values) => {
    expect(values.length).toBeGreaterThan(3); // 앵커가 무너져 빈 배열이면 공허 통과한다
    for (const v of values) {
      expect(v, `테두리가 상수가 아니다: "${v}"`).toContain("border-transparent");
      expect(v, `테두리로 의미를 싣고 있다: "${v}"`).not.toContain("border-border");
    }
  });

  it("SUB_STAGE_BADGE_CONFIG 에는 border 값 자체가 없다", () => {
    // 타입에서 뺐으므로 tsc 가 1차 방어지만, 맵 본문에 문자열로 되살아나는 것도 막는다.
    const body = code(slice(CONFIG, "export const SUB_STAGE_BADGE_CONFIG", "\n};"));
    expect(body).not.toMatch(/border:/);
    expect(body).not.toMatch(/border-/);
  });

  it("OutreachStatusBadge 는 삭제됐다 — 되살아나면 한 축 규칙부터 적용할 것", () => {
    // 이 세션이 "두 export 전부 소비처 0건"으로 지목했고, 같은 결론에 도달한 PR #166 이
    // 오너 결정으로 파일을 삭제했다(#158 의 도달 불가 hue 9개 제거와 같은 선례).
    // 되살릴 일이 있으면 옛 어휘(`border-border bg-transparent text-foreground`)가 함께
    // 살아나지 않게 할 것 — 그래서 부재 자체를 계약으로 둔다.
    const revived = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .map((f) => f.split(sep).join("/"))
      .filter((f) => /outreach-status-badge/.test(f));
    expect(revived, "OutreachStatusBadge 가 되살아났다 — 한 축 규칙 적용 여부를 확인할 것").toEqual([]);
  });

  it("중립 채움값이 두 맵에서 같다 — 어휘가 갈라지면 알려준다", () => {
    // SSOT 의 중립 1단(slate-100/700)을 딜 배지가 그대로 쓴다.
    const NEUTRAL = "bg-slate-100 text-slate-700";
    expect(ssotBadgeClass("PREPARATION")).toContain(NEUTRAL);
    expect(mapValues(ENTITY_BADGE, "const dealStatusClassName")).toContain(
      `border-transparent ${NEUTRAL}`,
    );
  });
});

// 색이 안 변하는 회귀는 눈에 안 띈다 — 테두리가 상수라는 건 **소비처가 한 번 고정**한다는
// 뜻이고, 그 고정이 풀리면 8개 전부에 헤어라인이 생기면서 tsc·색 단언은 전부 통과한다.
describe("테두리 상수의 실제 고정 지점 (소비처)", () => {
  it("SubStageBadge 베이스가 border-transparent 로 한 번 고정한다", () => {
    const badge = code(
      slice(SUB_STAGE_BADGE, "export function SubStageBadge", "</Badge>"),
    );
    expect(badge).toContain("border-transparent");
    // config 가 테두리를 되가져가면 한 축 규칙이 깨진다.
    expect(badge).not.toContain("config.border");
  });

  it('SubStageBadge 가 `variant="outline"` 이라는 전제 — 고정이 필요한 이유', () => {
    // variant 가 `border-border` 를 주므로 베이스가 눌러야 투명해진다.
    // variant 를 떼면 이 고정은 불필요해지고 위 단언의 의미도 바뀐다 — 그때 다시 쓸 것.
    expect(code(SUB_STAGE_BADGE)).toContain('variant="outline"');
    expect(BADGE_PRIMITIVE).toContain('"border-border text-foreground');
  });

  it("SubGroupDivider 칩에는 테두리 유틸이 없다", () => {
    const chip = code(slice(STAGE_COLUMN, "function SubGroupDivider", "{count}"));
    expect(chip).toContain("rounded-full px-2");
    // `border` 만 붙으면 Tailwind v4 기본 border-color(currentColor)로 글자색 테두리가 그려진다.
    expect(chip).not.toMatch(/\bborder\b/);
    expect(chip).not.toContain("config.border");
  });
});

// 위 단언들은 전부 소스 그렙·객체 검사다. 아래는 **실제로 DOM 에 나온 class 속성**을 본다.
describe("실렌더 (jsdom) — 그렙이 아니라 실제 DOM class 속성", () => {
  it("CLOSED 배지가 중립 채움으로 렌더되고 purple 이 없다", () => {
    render(<SubStageBadge status="CLOSED" />);
    const el = screen.getByText("판매 마감");
    expect(el.className).toContain("bg-slate-200");
    expect(el.className).toContain("text-slate-800");
    expect(el.className).not.toMatch(/purple/);
  });

  it("8개 전부 border-transparent 로 렌더된다 — 한 축 규칙의 DOM 증거", () => {
    // variant="outline" 이 `border-border` 를 주므로, 베이스 고정이 풀리면 여기가 깨진다.
    // 색이 그대로라 눈으로는 못 잡는 회귀다.
    const statuses = Object.keys(SUB_STAGE_BADGE_CONFIG) as CampaignStatus[];
    expect(statuses).toHaveLength(8);
    for (const status of statuses) {
      const { container, unmount } = render(<SubStageBadge status={status} />);
      const el = container.firstElementChild;
      expect(el, `${status} 렌더 실패`).not.toBeNull();
      expect(el!.className, `${status} 가 border-transparent 가 아니다`).toContain(
        "border-transparent",
      );
      expect(el!.className, `${status} 에 border-border 유입`).not.toContain(
        "border-border",
      );
      unmount();
    }
  });

  it("같은 컬럼에 인접하는 PREPARATION 과 채움으로 갈린다", () => {
    const { container } = render(
      <>
        <SubStageBadge status="PREPARATION" />
        <SubStageBadge status="CLOSED" />
      </>,
    );
    const [prep, closed] = Array.from(container.querySelectorAll("span,div"))
      .filter((n) => /세팅 대기|판매 마감/.test(n.textContent ?? ""))
      .slice(-2);
    expect(prep.className).toContain("bg-slate-100");
    expect(closed.className).toContain("bg-slate-200");
    expect(prep.className).not.toBe(closed.className);
  });
});

describe("죽은 레거시 이름색 정리 (소비처 0건 확인 후 제거)", () => {
  it.each(REMOVED_LEGACY_TOKENS)("--color-%s 가 globals.css 에 없다", (token) => {
    expect(GLOBALS).not.toContain(`--color-${token}:`);
  });

  it("음성 대조군 — neon-gold 는 소비처가 실재하므로 남아 있다", () => {
    // 이 단언이 없으면 위 13건은 "정의를 지웠다"만 말할 뿐, 이 테스트가 토큰 정의를
    // 실제로 보고 있는지(= 하네스가 살아 있는지) 증명하지 못한다.
    expect(GLOBALS).toContain("--color-neon-gold:");
    expect(read("components/crm/inline-data-grid.tsx")).toContain("hover:bg-neon-gold/5");
  });
});

describe("아직 정렬되지 않은 것 (오너 결정 대기 — '됐다'고 덮지 않는다)", () => {
  it("blue/amber/green 리터럴이 남아 있다", () => {
    expect(SUB_STAGE_BADGE_CONFIG.PROPOSAL.bg).toBe("bg-blue-100");
    expect(SUB_STAGE_BADGE_CONFIG.SETTLEMENT_WAIT.bg).toBe("bg-amber-100");
    expect(SUB_STAGE_BADGE_CONFIG.COMPLETED.bg).toBe("bg-green-100");
  });

  it("ACTIVE·SETTLEMENT_IN_PROGRESS 는 StatusBadge 와 의미축이 다르다", () => {
    // 여기: ACTIVE=success(초록) · SETTLEMENT_IN_PROGRESS=caution(주황)
    expect(SUB_STAGE_BADGE_CONFIG.ACTIVE.text).toContain("--status-success");
    expect(SUB_STAGE_BADGE_CONFIG.SETTLEMENT_IN_PROGRESS.text).toContain(
      "--status-caution",
    );
    // SSOT: ACTIVE=active(네이비) · SETTLEMENT_IN_PROGRESS=info
    expect(CANONICAL).toContain(
      "ACTIVE: \"border-transparent bg-status-active/10 text-status-active\"",
    );
    expect(CANONICAL).toContain(
      "SETTLEMENT_IN_PROGRESS: \"border-transparent bg-status-info/10 text-status-info\"",
    );
    // 이 불일치는 리터럴 hue 정리가 아니라 **의미 결정**이라 이번 PR 범위 밖이다.
  });
});
