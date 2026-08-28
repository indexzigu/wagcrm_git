// P8 색 원칙 잔여 후보 3곳 회수 계약 (오너 결정 2026-07-30).
//
// PR #149(딜 패널 AI 어피던스) · #152/#154(badge-config CLOSED) · entity-type-badge 색 회수를
// 조사하다 남은 3건이다. 성격이 둘로 갈리므로 섞어 읽지 말 것:
//   ① **범주 색 회수(§4)** — asset-library 폴더 배지 hue 7종 + 같은 파일 카드 뷰의 단색 indigo,
//      outreach "평균 전환일" 최근30일 타일의 violet. 전부 좋고 나쁨이 없는 이름표·창(window)이라
//      색 자격이 없었다. `settlement-channel-color-reclaim`(판매채널 4색)과 같은 종류다.
//   ② **가드레일 2 정렬** — settlement-table 입금/지급 완료 배지, outreach-list 경과일 램프.
//      이쪽은 색 자격이 있다(완료 여부·지연 심각도). 회수 대상은 hue 어휘(리터럴 → StatusBadge
//      SSOT)이고, 램프 쪽은 **회수가 곧 가독성 개선**이다(리터럴 3색이 AA 미달이었다).
//
// ⚠️ **축 판정이 이 파일의 핵심 기록이다.** settlement-table 배지를 자금 방향축(money-direction)
// 으로 옮기는 안은 두 근거로 기각됐다: (1) 방향은 배지의 라벨 텍스트가 이미 말하고 색이 나르는
// 정보는 완료 여부다 — 축이 다르다. (2) `--money-out` 을 자기 /10 틴트에 얹으면 **3.93** 으로
// 10px font-semibold 의 AA(4.5) 미달이다(P8 §5, 아래 대비 게이트가 이 수치를 계속 재계산한다).
// 이 판정이 뒤집히려면 `--money-out-text` 신설이 선행돼야 한다.
//
// ⚠️ 소스 그렙은 렌더 도달을 못 본다(PR #178 이 죽은 Sheet 를 고치고 전부 green 을 받았다)
// → 색 단언과 렌더 도달 단언을 **짝으로** 둔다. 워크트리에 `.env` 가 없어 dev 서버로 픽셀을
// 못 보므로, 아래 jsdom 실렌더가 "DOM 에 실제로 나온 class 속성"까지 확인하는 대체 수단이다.
// outreach 지표 타일만 실렌더가 없다 — 라우트 페이지 컴포넌트라 서버 데이터 없이는 못 세운다.
// 그 표면은 렌더 도달 단언 + 구간 그렙 + 대비 게이트로 지킨다(무엇이 빠졌는지 명시해 둔다).

import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AssetLibrary } from "../asset-library";
import { SettlementTable } from "../settlement-table";
import { OutreachCardContent, type OutreachRow } from "../outreach-list";
import type { CampaignRow, DashboardData } from "@/lib/crm-types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/assets/archive",
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * 가상 스크롤러만 대역으로 세운다. jsdom 은 스크롤 요소의 높이가 0 이라 `useVirtualizer` 가
 * 가상 항목을 **하나도** 내주지 않는다 — 실렌더가 조용히 0건이 되어 색 단언이 전부 무의미하게
 * 통과한다(실제로 첫 프로브에서 배지 0개가 나왔다). 트리 행 렌더러·Badge 컴포넌트는 진짜다.
 */
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        start: index * estimateSize(),
        size: estimateSize(),
      })),
  }),
}));

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const ASSET_LIBRARY = read("components/crm/asset-library.tsx");
const SETTLEMENT_TABLE = read("components/crm/settlement-table.tsx");
const OUTREACH_PAGE = read("app/outreach/page.tsx");
const OUTREACH_LIST = read("components/crm/outreach-list.tsx");
const MOBILE_OUTREACH = read("components/mobile/mobile-outreach-view.tsx");
const CANONICAL = read("components/crm/status-badge.tsx");
const BADGE = read("components/ui/badge.tsx");
const GLOBALS = read("app/globals.css");

/**
 * 주석을 같은 길이의 공백으로 치환한다(줄 수 보존). 이 파일이 지키는 세 소스는 회수 **근거**를
 * 주석에 열거한다(삭제한 hue 이름·기각한 토큰 이름) — 주석을 남기면 단언이 전부 자기 근거에
 * 오탐한다. `entity-type-badge-color-reclaim`·`css-token-idiom-contract` 와 같은 수법.
 */
function stripComments(source: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank) // JSX 주석 — 중괄호까지 함께 지운다
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank);
}

/** 앵커 구간. 앵커가 사라지면 테스트가 조용히 무력해지므로 항상 존재를 단언한다. */
function slice(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + 1);
  expect(a, `앵커 "${start}" 를 못 찾음 — 테스트가 무력해졌다`).toBeGreaterThan(-1);
  expect(b, `앵커 "${end}" 를 못 찾음 — 테스트가 무력해졌다`).toBeGreaterThan(a);
  return source.slice(a, b);
}

const CODE = {
  assets: stripComments(ASSET_LIBRARY),
  settlement: stripComments(SETTLEMENT_TABLE),
  outreach: stripComments(OUTREACH_PAGE),
  outreachList: stripComments(OUTREACH_LIST),
};

/** 회수 대상 hue 전부 — 전부 globals.css 에 없는 리터럴이다. */
const RECLAIMED_HUES = [
  "emerald", "sky", "indigo", "amber", "pink", "violet", "purple", "blue", "rose", "teal",
];

// ─────────────────────────────────────────────────────────────────────────────
describe("렌더 도달 (그렙이 못 보는 것 — 색 단언의 전제)", () => {
  it("AssetLibrary 를 /assets/archive 라우트가 렌더하고, /assets 허브가 그 경로를 건다", () => {
    expect(read("app/assets/archive/page.tsx")).toContain("<AssetLibrary");
    expect(read("app/assets/page.tsx")).toContain('href: "/assets/archive"');
  });

  it("SettlementTable 을 정산 라우트가 렌더한다", () => {
    expect(read("app/settlement/settlement-page-client.tsx")).toContain("<SettlementTable");
  });

  it("outreach 지표 타일은 라우트 페이지 본문 안에 있다 — CrmShell 이 감싼다", () => {
    // 이 표면만 실렌더가 없다(서버 데이터 의존). 최소한 죽은 분기가 아님은 여기서 고정한다.
    expect(CODE.outreach).toContain("<CrmShell>");
    expect(slice(CODE.outreach, "<CrmShell>", "</CrmShell>")).toContain("평균 전환일");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("① 후보 1 — asset-library 폴더 배지: hue 7종 회수", () => {
  const badge = slice(
    CODE.assets,
    'node.folderType !== "SECTION"',
    "</Badge>",
  );

  it("folderColors 맵이 존재하지 않는다 — 맵의 존재 이유가 hue 뿐이었다", () => {
    expect(CODE.assets).not.toContain("folderColors");
  });

  it("배지에 hue 가 없다 — 맨 outline 이다", () => {
    expect(badge).toContain('variant="outline"');
    for (const hue of RECLAIMED_HUES) {
      expect(badge, `폴더 배지에 ${hue} 재유입`).not.toContain(hue);
    }
  });

  it("구분은 라벨이 한다 — labelMap 은 남는다", () => {
    expect(CODE.assets).toContain("const labelMap");
    expect(badge).toContain("labelMap[node.folderType]");
  });

  it("`dark:` 변형이 되돌아오지 않았다 — 이 앱엔 다크 모드 스위치가 없다", () => {
    // ThemeProvider 도 classList 토글도 없어(globals.css ".dark는 현재 미사용") 도달 불가였다.
    expect(badge).not.toContain("dark:");
  });

  it("캐리어가 테두리를 그릴 수 있다 — outline 변형이 border-border 를 얹는다", () => {
    // #152 의 SubStageBadge 는 `border-transparent` 하드코딩 때문에 테두리형 중립을 못 옮겼다.
    // 여기는 cn()=twMerge 라 outline 의 border-border 가 base 의 border-transparent 를 덮는다.
    expect(BADGE).toContain('outline:\n          "border-border text-foreground');
    expect(read("lib/utils.ts")).toContain("twMerge");
  });
});

describe("①-b 후보 1b — 같은 파일 카드 뷰 출처 배지: 단색 indigo 회수", () => {
  const originBadge = slice(
    CODE.assets,
    "const { badgeText, primaryName, secondaryName }",
    "{primaryName}",
  );

  it("indigo 가 없고 트리 배지와 같은 중립 어휘를 쓴다", () => {
    for (const hue of RECLAIMED_HUES) {
      expect(originBadge, `출처 배지에 ${hue} 재유입`).not.toContain(hue);
    }
    expect(originBadge).toContain("text-foreground");
    expect(originBadge).toContain("border-border");
  });

  it("라벨 어휘가 트리 배지와 같다 — 이것이 두 뷰를 함께 회수한 이유다", () => {
    // 어느 한쪽이 어휘를 바꾸면 "같은 범주가 두 뷰에서 갈렸다"는 전제가 사라진다.
    for (const label of ["거래처", "딜", "캠페인", "영업", "셀러"]) {
      expect(CODE.assets, `라벨 "${label}" 이 사라졌다`).toContain(`"${label}"`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("② 후보 2 — settlement-table 입금/지급: 가드레일 2 정렬", () => {
  // 시작 앵커는 테이블 헤더(전체 선택 체크박스)다. 종전 앵커("campaign.isDepositReceived"
  // 첫 등장 = getDelayWarning)는 2026-08-24 선택 합산 바가 컴포넌트 상단에 들어오며 그 바까지
  // 물게 됐다(그 `getDelayWarning` 자체는 2026-08-25 에 제거됐다 — settlement-table 의
  // 묘비 주석 참조) — 합산 바의 판매대행비 합계는 아래 판매 대행비 열과 같은 **정당한 방향축
  // 소비처**(text-money-out)라, 배지 금지 단언이 무관 표면에 오탐했다. 금지 계약 자체
  // (입금/지급 배지에 money 토큰 금지)는 불변이고 구간만 배지 렌더 블록으로 좁힌 것이다.
  // 끝 앵커는 계산서 열의 시작(`invoiceSlots.map`)이다 — #452 슬롯화로 배지가 단일
  // 템플릿(`moneySlots.map`)이 되면서 종전 앵커(`campaign.expectedPayoutDate` 직접
  // 참조)가 소스에서 사라졌다(필드 접근이 `slot.expectedField` 인덱싱으로 바뀜).
  // ⚠️ CODE.* 는 주석 스트립본이라 앵커는 코드 문자열이어야 한다.
  const region = slice(
    CODE.settlement,
    '"모든 정산 항목 선택"',
    "invoiceSlots.map",
  );

  it("blue·violet 리터럴이 없다", () => {
    for (const hue of RECLAIMED_HUES) {
      expect(region, `입금/지급 배지에 ${hue} 재유입`).not.toContain(hue);
    }
  });

  it("입금·지급이 **대칭**이다 — 전 슬롯이 한 템플릿의 같은 완료색을 공유한다", () => {
    // money-direction.ts 의 핵심 계약: 한쪽만 칠하면 "지급 = 나쁜 것"으로 오독된다.
    // #452 슬롯화 이후 대칭은 구조적이다 — 입금/지급 줄이 같은 map 템플릿 하나에서 나온다.
    //
    // 2026-08-26 아이콘화로 완료색이 **공유 컴포넌트**(`SlotIconBadge`)로 올라갔다.
    // 그래서 개수는 이 열의 구간이 아니라 그 컴포넌트에서 센다 — 대칭이 더 강해졌다
    // (이제 정산일정·계산서 **두 열**이 같은 한 곳을 쓴다).
    // ⚠️ 구간을 종전대로 두면 색 리터럴이 0개라 `.not.toContain` 류가 전부 공허하게
    // 초록이 된다 — 그래서 **긍정 단언**으로 소비 구조까지 고정한다.
    const shared = slice(CODE.settlement, "function SlotIconBadge", "interface SettlementTableProps");
    const pair = "bg-status-success-bg text-status-success";
    expect(shared.split(pair).length - 1, "완료색은 공유 템플릿 한 곳에만 있어야 한다").toBe(1);
    const neutral = "bg-slate-100 text-slate-600";
    expect(shared.split(neutral).length - 1, "미완료 중립도 공유 템플릿 한 곳에만 있어야 한다").toBe(1);
    // 이 열이 그 공유 템플릿을 실제로 쓰는지, 그리고 슬롯 파생인지까지 고정한다 —
    // 색 개수만 세면 map 을 걷어내고 두 줄을 다시 손으로 쓴 회귀를 못 잡는다.
    expect(region).toContain("SlotIconBadge");
    expect(region).toContain("moneySlots.map");
    // 소비처가 색을 다시 인라인하기 시작하면 여기서 깨진다.
    expect(region).not.toContain(pair);
  });

  it("값의 출처가 StatusBadge SSOT 에 실재한다", () => {
    // SSOT 에서 사라지면 이 정렬의 근거가 사라진 것이다 — 그때 알려주는 것이 이 단언의 목적.
    expect(CANONICAL).toContain("bg-status-success-bg text-status-success");
  });

  it("축 판정 고정 — 이 배지는 자금 방향 토큰을 쓰지 않는다", () => {
    // 방향은 라벨이 이미 말한다. 되돌리려면 아래 대비 게이트의 3.93 을 먼저 해결해야 한다.
    expect(region).not.toContain("money-out");
    expect(region).not.toContain("money-in");
  });

  it("같은 표의 방향축 소비처는 그대로다 — 회수가 축 자체를 지운 게 아니다", () => {
    expect(CODE.settlement).toContain("text-money-out"); // 판매 대행비 열
    // 영업이익 열 — 2026-08-26 부터 **밀집 강도**다(흑자 무채색·적자만 색). 표라서
    // 초점 맵을 쓰면 흑자 행마다 초록이 깔린다(P8 §3). 소비처가 SSOT 라는 사실은 그대로다.
    expect(CODE.settlement).toContain("PROFIT_TONE_TEXT_DENSE[profitTone]"); // 영업이익 열
  });

  it("기존 계약(status-literal-token-alignment)이 지키는 pill 은 건드리지 않았다", () => {
    expect(CODE.settlement).toContain("badgeSizeClassName.compact");
    expect(CODE.settlement).toContain("bg-status-success-bg");
    // ⛔ `text-status-urgent-text` 를 여기 되살리지 말 것 — 이 표에서 그 토큰의 유일한
    // 소비처였던 지연 경고가 2026-08-25 에 제거됐다(오너 결정). 그 짝을 지키던
    // status-literal-token-alignment 의 「지연 경고」 describe 도 함께 사라졌으므로
    // 이 줄은 "지키는 계약이 없는 단언"이 된다.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("③ 후보 3 — outreach 평균 전환일: 창(window)은 hue 를 받지 않는다", () => {
  // 카드 경계는 **헤더 아이콘 태그 통째로** 잡는다 — 제목 텍스트만 앵커로 쓰면 다음 카드의
  // 여는 태그(그 안의 emerald 아이콘)까지 딸려 들어와 단언이 이웃 카드에 오탐한다(실제로 깨졌다).
  const AVG_HEAD = '<Target className="size-3.5 text-status-info" />평균 전환일';
  const TOP_HEAD = '<TrendingUp className="size-3.5 text-emerald-600" />전환율 높은 딜';
  const RATE_HEAD = '<TrendingUp className="size-3.5 text-emerald-600" />전환율';

  const card = slice(CODE.outreach, AVG_HEAD, TOP_HEAD);

  /**
   * 구간이 실제로 쓰는 **유채색** 텍스트 hue 이름 집합. 셰이드(600/700/800)는 무시하고,
   * slate 는 무채색이라 세지 않는다(§4 가 권하는 바로 그 값 — 라벨 텍스트가 쓴다).
   */
  const textHues = (region: string) =>
    new Set(
      (region.match(/text-([a-z]+)-\d{2,3}\b/g) ?? [])
        .map((m) => m.split("-")[1])
        .filter((hue) => hue !== "slate"),
    );

  it("violet 이 없다", () => {
    for (const hue of RECLAIMED_HUES) {
      expect(card, `평균 전환일 카드에 ${hue} 재유입`).not.toContain(hue);
    }
    // 파일 전체로도 확인 — 이 파일에서 violet 의 유일한 집이 이 타일이었다.
    expect(CODE.outreach, "violet 이 이 화면 어딘가로 되돌아왔다").not.toContain("violet");
  });

  it("전체·최근30일 두 창이 **같은 값**을 쓴다 — 창은 라벨로만 구분된다", () => {
    expect(card.split("bg-status-info/10").length - 1).toBe(2);
    expect(card.split("text-status-info").length - 1).toBe(3); // 헤더 아이콘 + 값 2개
    expect(card).toContain("전체");
    expect(card).toContain("최근30일");
  });

  it("자매 카드 '전환율'도 두 창을 한 hue 로 그린다 — 이 통일의 근거다", () => {
    // 이 관례가 깨지면 "창은 색을 안 받는다"는 이 화면의 전제가 사라진다.
    // 셰이드 차이(emerald-700 vs 800)는 허용 — 회수 대상은 **다른 hue** 다.
    const donut = slice(CODE.outreach, RATE_HEAD, AVG_HEAD);
    expect(textHues(donut), "전환율 카드가 두 창에 서로 다른 hue 를 쓰기 시작했다").toEqual(
      new Set(["emerald"]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("④ 후보 4 — outreach-list 경과일 램프: 리터럴 4색 → --status-* 토큰", () => {
  const ramp = slice(CODE.outreachList, "function getElapsedBadge", "\n}");

  it("리터럴 hue 가 하나도 없다", () => {
    for (const hue of RECLAIMED_HUES.concat("orange")) {
      expect(ramp, `경과일 램프에 ${hue} 재유입`).not.toContain(hue);
    }
    // 이 파일에서 violet 의 유일한 집이 이 램프였다 — 파일 전체로도 확인한다.
    expect(CODE.outreachList, "violet 이 되돌아왔다").not.toContain("violet");
  });

  it("각 분기가 지정된 SSOT 토큰을 쓴다", () => {
    expect(ramp).toContain('status === "CONVERTED"');
    expect(ramp).toContain("text-status-success font-semibold");
    expect(ramp).toContain("text-status-urgent-text font-semibold");
    expect(ramp).toContain("text-status-caution font-semibold");
  });

  it("⛔ PENDING_APPROVAL 전용 분기가 없다 — 일 램프가 흡수한다 (오너 결정 2026-07-30)", () => {
    // 종전에는 이 분기가 `days >= 7`·`days >= 3` **위에** 있어서 승인대기 건이 1일째든
    // 30일째든 같은 색이었다(램프가 그 상태에서만 꺼짐). 하필 오너 자신이 병목인 상태다.
    expect(ramp, "PENDING_APPROVAL 분기가 램프에 되돌아왔다").not.toContain("PENDING_APPROVAL");
    expect(ramp, "쓰이지 않는 pending-text 가 되돌아왔다").not.toContain("status-pending-text");
  });

  it("상태 분기가 일 문턱 **위**에 얹히지 않았다 — 위 축이 아래 축을 가린다", () => {
    // 구조로 고정한다: 종결 2종(DROPPED·CONVERTED)과 `days === 0` 뒤로는 `status ===` 비교가
    // 하나도 없어야 한다. 주석이 아니라 순서가 계약이다.
    const afterLabel = ramp.slice(ramp.indexOf("const label = "));
    expect(afterLabel.length, "`const label` 앵커를 못 찾음 — 테스트가 무력해졌다").toBeGreaterThan(0);
    expect(afterLabel, "일 램프 위에 상태 분기가 다시 얹혔다").not.toContain("status ===");
  });

  it("DROPPED 는 무채색을 유지한다 — 회수 전부터 이미 2026-07-09 결정에 정합했다", () => {
    expect(ramp).toContain('status === "DROPPED"');
    expect(ramp).toContain('className: "text-muted-foreground"');
  });

  it("⚠️ CONVERTED 는 모바일과 **의도적으로** 다르다 (오너 결정 2026-07-30)", () => {
    // 모바일은 전환·드랍을 한 덩어리(isTerminalStatus)로 무채색 처리한다. 오너가 데스크톱에
    // 대해서는 무채색안(A)이 아니라 생애주기안(B)을 골랐다 — 칸반 컬럼과의 이중 인코딩을
    // 감수한 결정이다. **"모바일과 정합"을 이유로 무채색으로 되돌리지 말 것.**
    // 이 단언은 그 분기(divergence)가 살아 있음을 고정한다.
    expect(ramp).toContain("text-status-success");
    expect(stripComments(MOBILE_OUTREACH)).toContain("const isTerminalStatus");
    expect(stripComments(MOBILE_OUTREACH)).toContain('let elapsedClassName = "text-muted-foreground"');
    // 모바일은 이 PR 이 건드리지 않았다 — 전환에 생애주기색이 번지지 않았는지 확인한다.
    const mobileRamp = slice(
      stripComments(MOBILE_OUTREACH),
      "const isTerminalStatus",
      "const getMemoText",
    );
    expect(mobileRamp).not.toContain("status-success");
  });

  it("정합 대상인 모바일 토큰이 실재한다 — 사라지면 이 정렬의 근거가 사라진다", () => {
    const mobileRamp = slice(
      stripComments(MOBILE_OUTREACH),
      "const isTerminalStatus",
      "const getMemoText",
    );
    expect(mobileRamp).toContain("text-status-urgent-text font-semibold");
    expect(mobileRamp).toContain("text-status-caution font-semibold");
  });

  it("죽은 코드 2건이 되돌아오지 않았다 (오너 결정 2026-07-30)", () => {
    // ① `outreach-status-badge.tsx` — 소비처 0. ⚠️ 이 컴포넌트는 리터럴 hue 가 아니라 이미
    //    `--status-*` 토큰을 쓰고 있었다(색 부채가 아니라 **순수 죽은 코드**). 다시 필요해지면
    //    `status-badge.tsx`(SSOT)를 참조해 만들고, 리터럴로 재발명하지 말 것.
    expect(existsSync(join(SRC, "components/crm/outreach-status-badge.tsx")), "죽은 배지 컴포넌트가 되살아났다").toBe(false);
    // ② `perspective` prop — 6개 호출부가 전부 "deal" 이라 "seller" 렌더 분기가 도달 불가였다.
    //    되살리려면 호출부를 먼저 만들어야 한다(죽은 분기 재유입 방지). 레이아웃은 git 이력에 있다.
    expect(CODE.outreachList, "perspective 분기가 호출부 없이 되돌아왔다").not.toContain("perspective");
    expect(CODE.outreach, "호출부에 perspective 가 되돌아왔다").not.toContain('perspective="');
  });

  it("렌더 도달: CONVERTED 컬럼이 접힘 기본값에서도 펼쳐져 있다", () => {
    // #159 가 세운 규약 — 조건부 분기는 **기본값까지** 봐야 도달 증명이 된다.
    expect(CODE.outreach).toContain('<DroppableColumn status="CONVERTED"');
    expect(CODE.outreach).toContain('collapsedStages["CONVERTED"] ?? false');
    expect(CODE.outreach).toContain("<OutreachList");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§6 @theme 노출 — 쓰는 토큰이 유틸로 실제 생성된다", () => {
  it("노출이 빠지면 클래스는 붙고 색만 조용히 죽는다 (tsc·테스트는 전부 통과한다)", () => {
    for (const token of [
      "--color-status-info",
      "--color-status-success",
      "--color-status-success-bg",
      "--color-status-caution",
      "--color-status-urgent-text",
      "--color-border",
      "--color-foreground",
    ]) {
      expect(GLOBALS, `${token} 이 @theme 에 노출되지 않았다`).toContain(token);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 위 단언은 전부 소스 그렙이다. 아래는 **실제로 DOM 에 나온 class 속성**을 본다.
describe("실렌더 (jsdom) — 그렙이 아니라 실제 DOM class 속성", () => {
  const assetData = {
    deals: [{ id: "deal-1", dealName: "글로우 앰플", partner: { id: "p1", name: "코링코" } }],
    sellers: [{ id: "s1", sellerName: "미나", name: "미나" }],
    campaigns: [],
    apiCallLogs: [],
    assets: [
      {
        id: "a1",
        provider: "SUPABASE",
        section: "CONTRACT_SETTLEMENT",
        entityType: "DEAL",
        entityId: "deal-1",
        fileName: "계약서.pdf",
        sizeBytes: 1024,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    storage: { totalBytes: 1024, fileCount: 1 },
  } as unknown as DashboardData;

  const campaign: CampaignRow = {
    id: "camp-1",
    dealId: "deal-1",
    sellerId: "seller-1",
    campaignName: null,
    salesCode: null,
    dealName: "글로우 앰플 4차",
    partnerName: "코링코",
    sellerName: "미나",
    snsType: "INSTAGRAM",
    snsHandle: "@mina",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    salesChannel: "OWN_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: 500000,
    settlementSales: 300000,
    operatingProfit: 120000,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    netMarginRate: 20,
    status: "SETTLEMENT_IN_PROGRESS",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-01-10T00:00:00Z",
    deal: { brandName: "브랜드A", costPrice: 1000, sellingPrice: 2000 },
    followerHistory: [],
    activityHistory: [],
    notes: [],
  };

  /** viewMode 는 세션에 persist 된다 — 테스트마다 명시적으로 눌러 고정한다(순서 의존 제거). */
  async function switchView(container: HTMLElement, label: string) {
    const user = userEvent.setup();
    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes(label),
    );
    expect(button, `"${label}" 뷰 전환 버튼을 못 찾음 — 테스트가 무력해졌다`).toBeTruthy();
    await user.click(button!);
  }

  it("트리 뷰 폴더 배지가 hue 없이 중립 outline 으로 렌더된다", async () => {
    const { container } = render(<AssetLibrary initialData={assetData} />);
    await switchView(container, "폴더 트리형");

    const badges = Array.from(container.querySelectorAll('[data-slot="badge"]'));
    // 자체 점검 — 0개면 아래 루프는 무의미하게 통과한다(가상 스크롤러 대역이 죽은 경우).
    expect(badges.length, "폴더 배지가 하나도 렌더되지 않았다").toBeGreaterThan(0);
    expect(badges.map((n) => n.textContent)).toContain("거래처");

    for (const badge of badges) {
      expect(badge.className).toContain("border-border");
      expect(badge.className).toContain("text-foreground");
      expect(badge.className).not.toMatch(/emerald|sky-|indigo|amber-|pink-|violet/);
    }
  });

  it("갤러리 뷰 출처 배지도 같은 중립 어휘로 렌더된다", async () => {
    const { container } = render(<AssetLibrary initialData={assetData} />);
    await switchView(container, "갤러리형");

    const origin = Array.from(container.querySelectorAll("span")).filter(
      (n) => typeof n.className === "string" && n.className.includes("border-border"),
    );
    expect(origin.length, "출처 배지가 렌더되지 않았다").toBeGreaterThan(0);
    expect(origin.map((n) => n.textContent)).toContain("딜");
    for (const el of origin) {
      expect(el.className).toContain("text-foreground");
      expect(el.className).not.toMatch(/indigo|violet|emerald|sky-|pink-/);
    }
  });

  it("정산표: 입금·지급 **완료**가 SSOT 성공 토큰으로 대칭 렌더된다", () => {
    // #452 슬롯화 이후 배지는 「상대+방향」이다. 픽스처(자사몰)는 입금 줄이 없으므로
    // 입금·지급 대칭은 두 줄이 다 있는 브랜드몰로 고정한다(자사몰 두 지급 레그의
    // 색 분리는 settlement-table.test 가 별도로 고정한다).
    render(
      <SettlementTable
        campaigns={[{
          ...campaign,
          salesChannel: "BRAND_MALL",
          isDepositReceived: true,
          isPayoutCompleted: true,
        }]}
        onSelectCampaign={vi.fn()}
        onRefresh={vi.fn(async () => {})}
        loading={false}
        selectedIds={[]}
        onToggleRow={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    // 아이콘 배지는 보이는 글자가 없다 — 접근 가능한 이름(sr-only)으로 찾아 **부모 배지**에서
    // 색을 본다. ⛔ `getByText(label).className` 로 되돌리지 말 것: 잡히는 노드가 sr-only span
    // 이라 단언이 "sr-only" 를 검사하는 무의미한 초록이 된다.
    for (const label of ["공급사 입금", "셀러 지급"]) {
      const el = screen.getByText(`${label} 완료`).parentElement!;
      expect(el.className).toContain("bg-status-success-bg");
      expect(el.className).toContain("text-status-success");
      expect(el.className).not.toMatch(/blue|violet/);
    }
  });

  /** 경과일 램프 픽스처 — `now` 를 주입받는 컴포넌트라 결정론적으로 일수를 만든다. */
  const NOW = Date.parse("2026-07-30T00:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;
  const outreach = (status: OutreachRow["status"], daysAgo: number): OutreachRow => ({
    id: `o-${status}-${daysAgo}`,
    dealId: "deal-1",
    dealName: "글로우 앰플",
    brandName: "브랜드A",
    partnerName: "코링코",
    sellerId: "s1",
    sellerName: "미나",
    sellerFollowers: null,
    sellerCategory: null,
    snsType: null,
    snsHandle: null,
    status,
    proposedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    acceptedAt: null,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    linkedCampaignId: null,
    linkedCampaignName: null,
    updatedAt: new Date(NOW - daysAgo * DAY).toISOString(),
  });

  it.each([
    ["CONVERTED", 1, "전환완료", "text-status-success"],
    ["DROPPED", 1, "종료", "text-muted-foreground"],
    ["PENDING_APPROVAL", 1, "1일째", "text-slate-500"],
    ["PENDING_APPROVAL", 4, "4일째", "text-status-caution"],
    ["PENDING_APPROVAL", 9, "9일째", "text-status-urgent-text"],
    ["NEGOTIATION", 9, "9일째", "text-status-urgent-text"],
    ["NEGOTIATION", 4, "4일째", "text-status-caution"],
    ["NEGOTIATION", 1, "1일째", "text-slate-500"],
  ] as const)(
    "경과일 램프: %s(%s일) 배지가 %s 로 렌더되고 토큰 %s 를 쓴다",
    (status, days, label, token) => {
      render(
        <OutreachCardContent
          outreach={outreach(status as OutreachRow["status"], days)}
          now={NOW}
        />,
      );
      const el = screen.getByText(label);
      expect(el.className).toContain(token);
      expect(el.className).not.toMatch(/violet|orange-|rose-|amber-/);
    },
  );

  it("정산표: **미완료**는 중립을 유지한다 — 색은 완료에만 붙는다", () => {
    render(
      <SettlementTable
        campaigns={[{
          ...campaign,
          salesChannel: "BRAND_MALL",
          isDepositReceived: false,
          isPayoutCompleted: false,
        }]}
        onSelectCampaign={vi.fn()}
        onRefresh={vi.fn(async () => {})}
        loading={false}
        selectedIds={[]}
        onToggleRow={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    for (const label of ["공급사 입금", "셀러 지급"]) {
      const el = screen.getByText(`${label} 미완료`).parentElement!;
      expect(el.className).toContain("bg-slate-100");
      expect(el.className).not.toContain("status-success");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 값이 바뀌어도 AA 가 조용히 깨지지 않게, 대비를 테스트 안에서 다시 계산한다
// (`shared-badge-contrast`·`entity-type-badge-color-reclaim` 선례). 표면은 그 색이 실제로
// 앉는 자리다 — 페이지 셸은 CrmShell 의 #FAF9F6 이다.
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

  const SHELL = hex("#FAF9F6");                          // CrmShell 페이지 배경
  const TABLE_ROW = over(hex("#FFFFFF"), 0.5, SHELL);    // settlement-table 컨테이너 bg-white/50
  const METRIC_CARD = over(hex("#FFFFFF"), 0.7, SHELL);  // outreach 지표 카드 bg-white/70
  const TREE = hex("#FFFFFF");                           // asset-library 스크롤 컨테이너 bg-white

  /**
   * 경과일 램프가 앉는 **가장 불리한** 카드 표면. followUp 틴트 중 가장 어두운 것을 쓴다 —
   * `rose-600` 이 흰 카드(4.53)에서만 턱걸이로 통과하고 틴트에서 무너졌던 게 정확히 이 차이다.
   * ⚠️ `calculateFollowUp` 은 status 분기보다 **먼저** `nextReminderAt` 룰을 타므로 이 틴트는
   * CONVERTED 를 포함한 어떤 상태에도 붙을 수 있다 — "전환은 흰 카드 확정"은 성립하지 않는다.
   */
  const INDIGO_50 = hex("#EEF2FF");
  const RAMP_CARD = over(INDIGO_50, 0.2, hex("#FFFFFF")); // bg-indigo-50/20 over 흰 카드

  it.each([
    ["후보1 폴더 배지 (foreground on 흰 트리)", () => ratio(token("--foreground"), TREE)],
    ["후보2 완료 배지 (success on success-bg)", () => ratio(token("--status-success"), token("--status-success-bg"))],
    ["후보3 값 타일 (info on info/10 over 지표 카드)", () => ratio(token("--status-info"), over(token("--status-info"), 0.1, METRIC_CARD))],
    ["후보4 CONVERTED (success on followUp 틴트 카드)", () => ratio(token("--status-success"), RAMP_CARD)],
    ["후보4 days>=7 (urgent-text on 틴트)", () => ratio(token("--status-urgent-text"), RAMP_CARD)],
    ["후보4 days>=3 (caution on 틴트)", () => ratio(token("--status-caution"), RAMP_CARD)],
  ])("%s 가 AA(4.5:1) 이상", (_label, compute) => {
    expect(compute()).toBeGreaterThanOrEqual(4.5);
  });

  it("회수한 리터럴 3색이 여전히 AA 미달이다 — 이 회수가 가독성 개선이었다는 근거", () => {
    // Tailwind v4 팔레트 실색(oklch→sRGB). 되돌리면 다시 미달이 된다.
    const failing: Array<[string, string]> = [
      ["orange-600", "#F54900"],
      ["amber-600", "#E17100"],
      ["rose-600", "#EC003F"],
    ];
    for (const [name, value] of failing) {
      expect(ratio(hex(value), RAMP_CARD), `${name} 이 이제 AA 를 통과한다 — 근거 재확인 필요`)
        .toBeLessThan(4.5);
    }
  });

  it("기각된 방향축 안이 여전히 AA 미달이다 — 뒤집으려면 이 수치부터 해결해야 한다", () => {
    // 이 단언이 깨졌다면 `--money-out` 값이 바뀐 것이다. 그때는 축 판정을 다시 논의할 수 있다.
    const moneyOutOnTint = ratio(token("--money-out"), over(token("--money-out"), 0.1, TABLE_ROW));
    expect(moneyOutOnTint).toBeLessThan(4.5);
  });
});
