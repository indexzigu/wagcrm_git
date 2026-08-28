// D2 — 범주 색 회수 계약 · 셀러 화면 (오너 승인 2026-07-16, 시안 v2 B안).
//
// 지키는 원칙: **범주는 색을 받지 않는다.** 판단이 필요 없는 이름표(SNS 플랫폼 이름)와, 라벨이
// 이미 말하고 있는 곁다리(신뢰도 "높음/보통/부족")에 hue 가 다시 붙는 것을 막는다. 색은 판단
// 지점(AI 점수 밴드)에만 탄다.
//
// ⚠️ **이 파일은 소스 그렙이다 — 그렙은 그 코드가 렌더에 도달하는지 못 본다.**
// PR #178 이 `<Sheet open={false}>` 안의 죽은 코드를 고치고도 tsc·eslint·vitest 전부 green 을
// 받았고, D2 조사 중 `PipelineMonthlyView`(테스트만 import 하는 죽은 컴포넌트)도 나왔다.
// 그래서 아래 describe 는 색 단언과 **렌더 도달 단언을 짝으로** 둔다. 새 표면을 추가할 때도 유지할 것.
//
// 범위: 이 PR 은 **셀러 화면만**이다. 정산 패널 인디고·판매채널 4색은 같은 D2 지만
// "색 이동"이 아니라 "남은 껍데기 정리"라 후속 PR 로 분리했다(오너 확정).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const SELLERS = read("components/crm/sellers-management.tsx");
const SCORE_CARD = read("components/crm/seller-analysis/ScoreCard.tsx");
const SELLERS_PAGE = read("app/sellers/page.tsx");
const DETAIL_PAGE = read("app/sellers/[id]/page.tsx");

/** className="..." / className={...} 안의 문자열만 — 주석 속 색 이름에 오탐하지 않는다. */
function classText(source: string): string {
  return (source.match(/className=(?:"[^"]*"|\{[^}]*\}|`[^`]*`)/g) ?? []).join("\n");
}

/** 파일에서 `앵커`로 시작해 `end`로 끝나는 구간. 앵커가 사라지면 테스트가 조용히 무력해지므로 항상 존재를 단언한다. */
function slice(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + 1);
  expect(a, `앵커 "${start}" 를 못 찾음 — 테스트가 무력해졌다`).toBeGreaterThan(-1);
  expect(b, `앵커 "${end}" 를 못 찾음 — 테스트가 무력해졌다`).toBeGreaterThan(a);
  return source.slice(a, b);
}

describe("D2: 셀러 화면이 라이브다 (렌더 도달 — 그렙 계약의 전제)", () => {
  it("셀러 목록이 라우트에서 렌더된다", () => {
    expect(SELLERS_PAGE).toContain("<SellersManagement");
  });

  it("ScoreCard 가 앱에서 렌더된다 (테스트만 부르는 죽은 컴포넌트가 아니다)", () => {
    // PipelineMonthlyView 함정 방지 — 소비처가 테스트뿐이면 그건 죽은 코드다.
    expect(read("app/sellers/[id]/page.tsx")).toContain("<ScoreCard");
    expect(read("components/crm/seller-analysis/SellerAiAnalysis.tsx")).toContain("<ScoreCard");
  });
});

describe("D2: 스탯바 — 플랫폼별 hue 재유입 금지", () => {
  // 끝 앵커는 스탯바 **다음** 블록(유리 박스 컨테이너)의 클래스다 — 시작 주석과 같은 줄의 단어를
  // 쓰면 구간이 즉시 끝나 빈 문자열이 되고, "hue 없음" 단언이 전부 공허하게 통과한다(실제로 겪음).
  const statBar = slice(SELLERS, "1줄 통계 요약 바", "shadow-ambient");

  it("스탯바 구간을 실제로 찾았다", () => {
    expect(statBar).toContain("Instagram:");
    expect(statBar).toContain("YouTube:");
    expect(statBar).toContain("X (Twitter):");
    expect(statBar).toContain("총 캠페인:");
  });

  it.each(["emerald", "sky", "amber", "text-red-", "indigo", "purple", "violet"])(
    "스탯바에 %s 계열이 없다",
    (hue) => {
      expect(classText(statBar)).not.toContain(hue);
    },
  );

  it("발화 불가능한 dark: 분기를 다시 저술하지 않는다", () => {
    // 이 앱의 dark 는 클래스 variant 인데 <html> 에 dark 클래스도 ThemeProvider 도 없다(검증됨).
    expect(classText(statBar)).not.toContain("dark:");
  });
});

describe("D2: 신뢰도 — 곁다리 색 재유입 금지 (목록·상세 양쪽)", () => {
  // 라벨이 이미 "높음/보통/부족"이라 색이 정보를 안 더한다. 색을 되살리면 그 행/카드가 3벌이 되어
  // 점수 밴드가 묻힌다. 강등을 명도로 하지 말 것 — slate-300 은 1.48:1 로 3:1 도 미달이다.
  it("목록 신뢰도는 텍스트 줄이 아니라 점수 숫자의 무채색 점선 밑줄로만 신호한다", () => {
    // 2026-07-16 오너 확정 2차("목록에서 보여줄 필요가 있는거야?"): 1차의 캐비앗 텍스트 줄
    // ("신뢰도 보통/부족" 9px)도 회수했다 — 신뢰도의 홈은 상세 ScoreCard·리포트다.
    // 단 완전 비가시(title만)는 ss-ux P0로 기각: medium/low는 점수 숫자에 decoration-dotted
    // (무채색) 캐리어 + title을 남긴다. '높음' 라벨과 hue 재유입을 함께 막는다.
    const cell = slice(SELLERS, "const lowConfidence", "{staleLabel && (");
    expect(cell).not.toContain('"높음"');
    // 캐리어는 점선 밑줄 + 무채색 + 호버 발견성 — 셋 중 하나라도 빠지면 "비가시 회귀"다
    expect(cell).toContain("decoration-dotted");
    expect(cell).toContain("decoration-slate-400");
    expect(cell).toContain("cursor-help");
    expect(cell).toContain("title=");
    // 신뢰도 채널에 hue 금지(D2) — 점수 밴드 색과 경쟁하면 안 된다
    expect(cell).not.toContain("decoration-emerald");
    expect(cell).not.toContain("decoration-amber");
    expect(cell).not.toContain("text-emerald-600");
    expect(cell).not.toContain("text-amber-600");
    // 구조 회귀 가드: 별도 9px 신뢰도 줄이 되살아나면 안 된다(스테일 줄은 슬라이스 밖)
    expect(cell).not.toContain("text-[9px]");
  });

  it("상세 신뢰도 배지도 단일 상수다 (목록만 회수하면 상세에 3벌이 남는다)", () => {
    // 함수가 아니라 상수여야 한다 — confidence 로 분기하는 순간 색이 되돌아온 것이다
    // (`followup-engine.ts` INFO_BADGE_COLOR 선례와 같은 형태).
    expect(SCORE_CARD).toContain("const CONFIDENCE_BADGE_CLASS =");
    expect(SCORE_CARD).not.toContain("function confidenceBadgeClass");
    const badgeConst = slice(SCORE_CARD, "const CONFIDENCE_BADGE_CLASS", "\n");
    for (const hue of ["emerald", "amber", "rose"]) {
      expect(badgeConst).not.toContain(hue);
    }
  });
});

describe("D2: 평가 배지 — 리터럴이 아니라 상태 토큰을 가리킨다", () => {
  const badge = slice(SELLERS, "const badgeColors", "return (");

  it("네 등급 전부 토큰 유틸을 쓴다 (리터럴 hue 금지)", () => {
    for (const hue of ["emerald-", "amber-", "rose-"]) {
      expect(badge).not.toContain(hue);
    }
  });

  it("비추천 빨강이 점수 밴드의 빨강과 같은 토큰이다", () => {
    // 다른 토큰을 쓰면 같은 뜻인데 두 빨강이 미묘하게 달라 "맞추려다 실패한 것"처럼 보인다.
    expect(badge).toContain("text-status-urgent-text");
  });

  it("미진행은 상태 토큰을 쓰지 않고 원래 모습 그대로다 — '판단 불가'는 의미축의 값이 아니다", () => {
    // 테두리 포함해 목록·상세가 같아야 한다(base 에서 border 를 뺀 부수효과로 목록만 무테가 됐던 걸 되돌림).
    expect(badge).toContain("미진행: \"border border-slate-200 bg-slate-100 text-slate-500\"");
    expect(slice(DETAIL_PAGE, "const FIT_BADGE", "};")).toContain("미진행: \"bg-slate-100 text-slate-500 border-slate-200\"");
  });

  it("StatusBadge 정본(P8 가드레일 2)과 같은 토큰 짝을 쓴다", () => {
    // 이 배지가 상태 배지 정본에서 다시 갈라지는 걸 막는다. 정본이 hue 를 바꾸면 여기서 깨져
    // "같은 의미 다른 색"이 조용히 재발하는 대신 알려준다.
    const canonical = read("components/crm/status-badge.tsx");
    for (const pair of [
      ["bg-status-success-bg", "text-status-success"],
      ["bg-status-caution-bg", "text-status-caution"],
      ["bg-status-urgent-bg", "text-status-urgent-text"],
    ]) {
      const joined = pair.join(" ");
      expect(canonical, `정본이 "${joined}" 를 더는 안 쓴다 — 평가 배지 정렬 근거가 무너졌다`).toContain(joined);
      expect(badge).toContain(joined);
    }
  });

  it("목록과 상세의 평가 배지가 같은 토큰을 쓴다 (prod 에서 두 빨강으로 갈라져 있던 것)", () => {
    // 반쪽 마이그레이션이 남긴 실제 버그: 목록=rose-700(크림슨) / 상세=--status-urgent-text(벽돌).
    // 두 표면이 다시 갈라지면 여기서 깨진다.
    const detail = slice(DETAIL_PAGE, "const FIT_BADGE", "};");
    for (const hue of ["emerald-", "amber-", "rose-"]) {
      expect(detail, `상세 평가 배지에 ${hue} 리터럴이 되살아났다`).not.toContain(hue);
    }
    expect(detail).toContain("text-status-urgent-text");
    expect(detail).toContain("text-status-success");
    expect(detail).toContain("text-status-caution");
  });
});

describe("D2: 색은 판단 지점으로 옮겼다 — 회수만 남는 회귀 방지", () => {
  // 순서 제약(오너): 회수와 추가는 같은 PR. 추가분이 빠지고 회수만 남으면 화면이 더 밋밋해진다.
  it("셀러 목록이 AI 점수 밴드 SSOT 를 소비한다", () => {
    expect(SELLERS).toContain("resolveSellerScoreBand");
    expect(SELLERS).toContain("SELLER_SCORE_BAND_TEXT");
  });

  it("셀러 상세 ScoreCard 도 같은 SSOT 를 소비한다 (오너 결정 ③)", () => {
    expect(SCORE_CARD).toContain("resolveSellerScoreBand");
    expect(SCORE_CARD).toContain("SELLER_SCORE_BAND_TEXT");
  });

  it("목록이 임계값을 직접 참조해 밴드를 재정의하지 않는다", () => {
    // 이 프로젝트 색 버그의 반복 원인이 "화면마다 삼항"이었다(goal-band·profit-tone 이 생긴 이유).
    // ScoreCard 는 fitDistanceLabel("추천까지 N점") 때문에 임계값을 정당하게 import 하므로 제외한다 —
    // 대신 위 단언이 ScoreCard 도 색은 SSOT 에서 받는다는 걸 고정한다.
    expect(SELLERS).not.toContain("COMPOSITE_RECOMMEND_THRESHOLD");
    expect(SELLERS).not.toContain("COMPOSITE_HOLD_THRESHOLD");
  });
});
