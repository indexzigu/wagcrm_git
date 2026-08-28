// 심각도·생애주기 축 배지의 **리터럴 → --status-* 토큰 정렬** 계약 (2026-07-16).
//
// D2(범주 색 회수)와 다른 작업이다. D2 는 "색을 **어디에** 쓰는가"(범주 vs 판단 지점)였고,
// 이 파일은 "이미 올바른 자리에 있는 색을 **무엇으로 표현**하는가"를 고정한다. 대상 배지는
// 전부 심각도/생애주기 축에 정당하게 앉아 있으므로 **색을 유지**한다 — 회수가 아니다.
//
// ⚠️ 이 파일은 소스 그렙이다 — 그렙은 그 코드가 렌더에 도달하는지 못 본다.
// PR #178 이 `<Sheet open={false}>` 안의 죽은 코드를 고치고도 tsc·eslint·vitest 전부 green 을
// 받았다. 그래서 색 단언과 **렌더 도달 단언을 짝으로** 둔다(category-color-reclaim 과 같은 규약).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const CARD = read("components/crm/campaign-card.tsx");
const SETTLEMENT = read("components/crm/settlement-table.tsx");
const CANONICAL = read("components/crm/status-badge.tsx");
const BADGE = read("components/ui/badge.tsx");

/** className="..." / className={...} 안의 문자열만 — 주석 속 색 이름에 오탐하지 않는다. */
function classText(source: string): string {
  return (source.match(/className=(?:"[^"]*"|\{[^}]*\}|`[^`]*`)/g) ?? []).join("\n");
}

/** 파일에서 `start`로 시작해 `end`로 끝나는 구간. 앵커가 사라지면 테스트가 조용히 무력해지므로 존재를 단언한다. */
function slice(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + 1);
  expect(a, `앵커 "${start}" 를 못 찾음 — 테스트가 무력해졌다`).toBeGreaterThan(-1);
  expect(b, `앵커 "${end}" 를 못 찾음 — 테스트가 무력해졌다`).toBeGreaterThan(a);
  return source.slice(a, b);
}

describe("정렬 대상이 라이브다 (렌더 도달 — 그렙 계약의 전제)", () => {
  it("CampaignCard 를 앱이 실제로 렌더한다 (테스트만 부르는 죽은 컴포넌트가 아니다)", () => {
    const boards = [
      "components/crm/stage-column.tsx",
      "components/crm/execution-kanban-board.tsx",
      "components/crm/zoned-pipeline-board.tsx",
      "components/crm/stage-kanban-board.tsx",
    ].map(read);
    expect(boards.some((b) => b.includes("<CampaignCard"))).toBe(true);
  });

  it("SettlementTable 을 정산 라우트가 렌더한다", () => {
    expect(read("app/settlement/settlement-page-client.tsx")).toContain("<SettlementTable");
  });
});

describe("campaign-card — 심각도 배지가 리터럴이 아니라 토큰을 가리킨다", () => {
  const tone = slice(CARD, "const urgencyTextClass", "function InstagramIcon");

  it("urgency/actionTone 구간을 실제로 찾았다", () => {
    expect(tone).toContain("const actionToneClass");
    expect(tone).toContain("overdue:");
  });

  it.each(["red-", "orange-", "emerald-", "amber-", "indigo-", "rose-"])(
    "톤 맵에 %s 리터럴이 없다",
    (hue) => {
      // 주석에는 구 리터럴 이름이 근거로 남아 있으므로 코드 라인만 본다.
      const code = tone
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//"))
        .join("\n");
      expect(code).not.toContain(hue);
    },
  );

  it("소형 텍스트(10px)에 원색이 아니라 어두운 -text/-caution 변형을 쓴다", () => {
    // --status-urgent(#BF5050)는 흰 배경 4.69 로 AA 경계다. 10px 에는 -text(#8F3C3C, 7.29).
    expect(tone).toContain('overdue: "text-status-urgent-text"');
    // 구 orange-500 은 흰 배경 2.80 으로 AA 미달이었다 → --status-caution 5.02.
    expect(tone).toContain('imminent: "text-status-caution"');
    expect(tone).not.toContain('overdue: "text-status-urgent"');
  });

  it("slate-50 박스 위 배지는 알파 틴트가 아니라 불투명 -bg 토큰을 쓴다 (P8 §5 표면 종속)", () => {
    // 원색/10 을 slate-50 에 합성하면 caution 이 4.47 로 AA 미달이다(흰 배경 4.65 는 통과).
    // badge.tsx 의 status-pending 변형(bg-status-pending/10)이 이 표면에 오면 안 되는 이유.
    expect(tone).toContain('today: "bg-status-caution-bg text-status-caution"');
    expect(tone).toContain('overdue: "bg-status-urgent-bg text-status-urgent-text"');
    expect(tone).not.toContain("bg-status-caution/10");
    expect(tone).not.toContain("bg-status-pending/10");
  });

  it("upcoming 은 무채색을 유지한다 — '볼 것 없음' 등급 선언이다(P8 §2)", () => {
    expect(tone).toContain('upcoming: "bg-slate-100 text-slate-700"');
  });

  it("톤 맵에 죽은 done 키가 없다 (2026-07-16 제거) — 도달 불가한 색은 근거를 오염시킨다", () => {
    // done 이 되살아나는 건 둘 중 하나다: ① 아무 생각 없이 키를 다시 채웠거나 ② campaign-actions 가
    // 정말 done+dueDate 를 낼 수 있게 바뀌었거나. ②라면 타입 좁히기가 먼저 컴파일에서 깨진다.
    expect(tone).not.toContain("done:");
    expect(tone).toContain("Exclude<CampaignActionTone, \"done\">");
  });

  it("소비처가 캐스트가 아니라 타입 좁히기로 불변식을 증명한다", () => {
    // `as RenderableActionTone` 같은 캐스트로 바꾸면 done 이 정말 렌더 가능해져도 컴파일이 안 깨진다.
    const render = slice(CARD, "actionToneClass[action.tone]", "formatCampaignActionDate(action.dueDate)");
    expect(CARD).toContain('action.dueDate && action.tone !== "done"');
    expect(render).not.toContain("as RenderableActionTone");
  });

  it("정체·실매출 미입력 배지가 토큰을 쓴다", () => {
    const badges = slice(CARD, "action.isStagnant && action.stagnantDays", "min-w-0 flex-1");
    expect(classText(badges)).toContain("bg-status-caution-bg");
    expect(classText(badges)).toContain("text-status-caution");
    // 오너 결정 2026-07-16 — indigo 는 globals.css 에 없는 hue 였다(가드레일 2 부채).
    expect(classText(badges)).toContain("bg-status-info/10");
    expect(classText(badges)).toContain("text-status-info");
    for (const hue of ["amber-", "indigo-"]) {
      expect(classText(badges), `${hue} 리터럴이 되살아났다`).not.toContain(hue);
    }
  });

  it("ACTIVE 라이브 도트의 초록은 오너 확정 예외다 — 토큰으로 '정렬'하지 말 것", () => {
    // ⚠️ 이 단언은 **바뀌지 않은 것**을 지킨다. 리터럴 정렬 PR 이 이 카드의 색을 전부 토큰으로
    // 옮겼기 때문에, 남은 emerald 2줄은 다음 사람 눈에 "빠뜨린 것"으로 보인다 — 실제로는 오너가
    // 2026-07-16 에 초록 유지를 확정했다. 도트는 생애주기 등급이 아니라 "지금 살아 움직인다"를
    // 말하고, 정본 ACTIVE(네이비)로 바꾸면 옆의 상태 배지와 같은 색이 되어 도트가 배지의 중복이 된다.
    const dot = slice(CARD, 'campaign.status === "ACTIVE" &&', "campaign.dealName");
    expect(dot).toContain("bg-emerald-400");
    expect(dot).toContain("bg-emerald-500");
    expect(dot, "라이브 도트가 status-active 로 정렬됐다 — 오너 확정(초록 유지)을 되돌린 것이다").not.toContain(
      "status-active",
    );
    // 근거 주석이 사라지면 다음 사람이 같은 판단을 다시 내릴 수 없다.
    expect(CARD).toContain("오너 확정 예외");
  });

  it("최저가 위반 배지가 모바일과 같은 변형을 쓴다 (같은 의미, 두 표면 같은 빨강)", () => {
    const violation = slice(CARD, "최저가 위반 딜", "urgencyTextClass[urgency]");
    expect(violation).toContain('variant="status-urgent"');
    expect(classText(violation)).not.toContain("red-");
    // 모바일이 먼저 끝낸 스왑 — 여기서 갈라지면 다시 두 빨강이 된다.
    expect(read("components/mobile/mobile-campaign-card.tsx")).toContain('variant="status-urgent"');
  });
});

describe("settlement-table — 계산서 열의 완료 배지가 정산일정과 같은 토큰을 쓴다", () => {
  // 두 열이 나란히 붙어 있어 한쪽만 다른 토큰을 쓰면 "같은 값 다른 색"이 된다.
  //
  // 2026-08-26 아이콘화로 두 열이 **한 컴포넌트**(`SlotIconBadge`)를 공유하게 됐다.
  // 그래서 이 계약은 "두 구간의 색이 우연히 같다"가 아니라 **"색을 정할 자리가 하나뿐이다"**
  // 를 고정한다 — 구조적으로 더 강하다. 종전처럼 `{invoiceSlots.map(` 구간을 훑으면
  // 그 안에 색 리터럴이 아예 없어 **앵커는 살아 있는데 단언만 빈 채로 초록**이 된다.
  const badge = slice(SETTLEMENT, "function SlotIconBadge", "interface SettlementTableProps");

  it("구간을 실제로 찾았다", () => {
    expect(badge).toContain("tone");
    expect(badge).toContain("sr-only");
  });

  it("⛔ 두 열이 모두 그 한 컴포넌트를 쓴다 — 한쪽만 색을 인라인으로 되돌리면 깨진다", () => {
    const money = slice(SETTLEMENT, "{moneySlots.map(", "{/* ⛔ 지연 경고를");
    const invoice = slice(SETTLEMENT, "{invoiceSlots.map(", "</td>");
    expect(money).toContain("<SlotIconBadge");
    expect(invoice).toContain("<SlotIconBadge");
    // 색은 두 소비처 어디에도 없어야 한다(있으면 사본이 생긴 것이다).
    expect(classText(money)).not.toContain("bg-status-success-bg");
    expect(classText(invoice)).not.toContain("bg-status-success-bg");
  });

  it("완료는 success 짝, 미완료·해당없음은 무채색이다", () => {
    const classes = classText(badge);
    expect(classes).toContain("bg-status-success-bg");
    expect(classes).toContain("text-status-success");
    expect(classes).toContain("bg-slate-100");
  });

  it("완료 테두리는 **불투명**이다 — 알파를 섞으면 사실상 안 보인다", () => {
    // `ring-status-success/30` 은 흰 셀 위 1.56:1 로 구 `ring-primary/45`(2.4:1)·
    // `ring-destructive/20`(1.31:1) 과 같은 실패 유형이다. 이 테두리는 완료 여부의
    // **유일한 비색채 단서**(SC 1.4.1)라 흐려지면 축이 통째로 색으로 되돌아간다.
    const classes = classText(badge);
    expect(classes).toContain("ring-status-success");
    expect(classes).not.toMatch(/ring-status-success\/\d/);
  });

  // ⚠️ 금지 hue 스캔은 **공유 템플릿과 두 소비처 셋 다**에 돌린다.
  // 종전에는 계산서 소비처 구간 하나만 훑었는데, 색이 `SlotIconBadge` 로 올라가면서 그 구간을
  // 템플릿으로 **옮기기만** 하자 두 소비처가 어떤 금지 단언도 안 받게 됐다 — 뮤테이션으로
  // 확인된 실제 구멍이다(계산서 날짜 span 에 `text-money-out`·`text-emerald-600` 을 넣어도
  // 안 잡혔다). 소비처는 색을 아예 안 써야 하므로 스캔 비용도 거의 없다.
  const moneyRegion = slice(SETTLEMENT, "{moneySlots.map(", "{/* ⛔ 지연 경고를");
  const invoiceRegion = slice(SETTLEMENT, "{invoiceSlots.map(", "</td>");

  it.each(["emerald-", "rose-", "status-caution", "status-urgent", "money-in", "money-out"])(
    "%s 가 없다 — 색은 완료 여부(생애주기 축) 하나만 탄다",
    (banned) => {
      expect(classText(badge), "공유 템플릿").not.toContain(banned);
      expect(classText(moneyRegion), "정산일정 소비처").not.toContain(banned);
      expect(classText(invoiceRegion), "계산서 소비처").not.toContain(banned);
    },
  );

  it("🪤 스캐너가 이 파일을 실제로 훑었다 — 백틱 주석이 className 매치를 삼키지 않았다", () => {
    // 이 계약 전체가 `classText()` 정규식 위에 서 있는데, 그 정규식은 백틱을 문자열 시작으로
    // 문다. 그래서 className 속성 근처 주석에 백틱이 하나 있으면 다음 백틱까지 수백 자를
    // 통째로 삼키고, **진짜 className 블록이 매치에서 빠진 채 단언은 삼켜진 덩어리를 보고
    // 통과한다**(2026-08-26 실측). 그 상태를 여기서 직접 잡는다.
    const matches = SETTLEMENT.match(/className=(?:"[^"]*"|\{[^}]*\}|`[^`]*`)/g) ?? [];
    const swallowed = matches.filter((m) => m.includes("//") || m.includes("⛔"));
    expect(swallowed, `주석을 삼킨 매치가 있다 — className 근처 백틱을 걷어낼 것: ${swallowed[0]?.slice(0, 80)}`).toHaveLength(0);
  });
});

describe("StatusBadge 정본(P8 가드레일 2)과 같은 토큰 짝을 쓴다 — 양방향", () => {
  // 정본이 hue 를 바꾸면 여기서 깨져서, "같은 의미 다른 색"이 조용히 재발하는 대신 알려준다.
  // category-color-reclaim.test.ts 가 셀러 화면에 대해 세운 것과 같은 규약이다.
  it.each([
    ["bg-status-success-bg", "text-status-success"],
    ["bg-status-caution-bg", "text-status-caution"],
    ["bg-status-urgent-bg", "text-status-urgent-text"],
  ])("정본과 카드가 %s / %s 짝을 공유한다", (bg, text) => {
    const joined = `${bg} ${text}`;
    expect(CANONICAL, `정본이 "${joined}" 를 더는 안 쓴다 — 정렬 근거가 무너졌다`).toContain(joined);
  });

  it("카드의 톤 맵이 정본의 짝을 그대로 쓴다 (도달 가능한 2개)", () => {
    const tone = slice(CARD, "const actionToneClass", "};");
    expect(tone).toContain("bg-status-urgent-bg text-status-urgent-text");
    expect(tone).toContain("bg-status-caution-bg text-status-caution");
  });

  it("success 짝은 정산 표가 쓴다 (카드에서 done 이 빠져도 정본 3짝이 전부 소비된다)", () => {
    expect(classText(SETTLEMENT)).toContain("bg-status-success-bg");
  });

  it("Badge 의 status-urgent 변형이 -text 를 쓴다 (최저가 위반 배지의 대비 근거)", () => {
    // 이 변형이 원색 텍스트로 바뀌면 최저가 위반 배지가 조용히 AA 경계(4.69)로 내려간다.
    // 들여쓰기에 묶이지 않도록 공백을 정규화해서 본다 — 포맷 변경에 깨지면 계약이 아니라 잡음이다.
    const norm = BADGE.replace(/\s+/g, " ");
    expect(norm).toContain('"status-urgent": "bg-status-urgent/10 text-status-urgent-text');
  });
});
