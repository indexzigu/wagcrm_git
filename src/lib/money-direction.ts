/**
 * 자금 방향(입금/지급) 색 규칙 SSOT — "같은 의미는 같은 색"(P8).
 *
 * 오너 승인 2026-07-15(모바일 색 배치 시안, D1 포함). 하나의 의미가 모바일에서 **5가지**로
 * 렌더되고 있었다 — 그중 셋은 입금과 지급의 색이 **아예 같아** 방향이 화살표 모양으로만
 * 구분됐다:
 *   1. 홈 정산 대기      둘 다 text-slate-800 (아이콘조차 없음 — 첫 화면인데 가장 약했다)
 *   2. 정산 확인 상단     둘 다 text-muted-foreground/70
 *   3. 일정 일별 목록     둘 다 text-primary
 *   4. 정산 대기 시트     emerald-500 / rose-500 리터럴 (2.54:1 — 비텍스트 3:1 도 미달)
 *   5. 캘린더 SVG 링      --money-in / --money-out (유일하게 토큰을 쓰던 곳)
 *
 * 규칙: **방향은 아이콘 + 색 한 쌍으로만 말한다.** 입금 ↓, 지급 ↑.
 *
 * ## 이 축에 태우면 안 되는 것
 * 적자·손실·위험은 **심각도축**이지 방향축이 아니다 — `--status-urgent` 계열을 쓴다
 * (`mobile-campaign-card` 의 적자 배지가 선례). `--money-out` 토큰 주석이 "지급은 위험이
 * 아니라서 --status-urgent 에 흡수할 수 없다"고 선언하는데, 그 역도 참이다.
 * 지급은 나쁜 일이 아니라 **정상적인 사실**이다.
 *
 * ## `profit-tone.ts` 와의 경계 (둘 다 `text-money-in-text` 를 쓴다 — 통합하지 말 것)
 * 두 모듈은 **다른 축**이고, 기준은 단위(₩ vs %)가 아니라 **"실제 이체냐 계산된 판정이냐"** 다:
 * - **여기(money-direction)** = 돈이 실제로 오가는 **사건**의 방향. 입금 ↓ / 지급 ↑.
 *   양쪽 다 가치중립적 사실이라 out 이 위험색을 쓰지 않는다.
 * - **`profit-tone`** = 여러 줄이 상쇄된 **결과값**의 부호. 흑자 / 적자.
 *   적자는 판정이라 `--status-urgent-text`(경고)를 쓴다 — money-out 이 아니다.
 *
 * "들어온 돈"이라는 극이 겹쳐 `text-money-in-text` 를 공유할 뿐이다. 한쪽으로 합치면
 * 지급(정상 사실)과 적자(경고)가 같은 색이 되어 캘린더 링처럼 이 토큰을 차분하게 쓰는
 * 자리의 의미까지 흔들린다. (두 세션이 독립적으로 같은 결론에 도달 — ss-ux-designer 판정 2026-07-15)
 */

import { CircleArrowDown, CircleArrowUp } from "lucide-react";

export type MoneyDirection = "in" | "out";

/**
 * 방향 **아이콘** 짝 — 색과 같은 자리에 둔다.
 *
 * ## 왜 상수인가 (2026-08-28)
 * 이 파일은 색을 통일하면서 *"방향은 아이콘 + 색 한 쌍으로만 말한다"* 고 선언했는데,
 * **아이콘은 통일하지 않고 화면마다 각자 import 했다.** 그래서 색은 같은데 모양이 갈렸다:
 * 모바일 4곳은 원 안 화살표였고 데스크톱(정산 헤더 · 선택 바)은 선 끝 화살표였다.
 * 오너가 화면에서 그 어긋남을 발견해 **원 안 화살표로 통일**했다(2026-08-28).
 *
 * 원을 고른 이유는 취향이 아니라 크기다 — 이 아이콘이 놓이는 자리는 12~14px 이고,
 * 선 끝 화살표는 그 크기에서 화살표 꼬리와 받침선의 간격이 1px 아래로 떨어져 두 선이
 * 붙어 보인다(오너 지적의 실체). 원은 면적이라 같은 크기에서 형태가 유지된다.
 *
 * ⛔ **`lucide-react` 에서 직접 import 하지 말 것** — 주석만 남기면 드리프트를 못 잡는다는
 * 것이 아래 두 무채색 상수가 이미 배운 교훈이고, 아이콘은 그 교훈이 적용되지 않아 실제로
 * 갈렸다. `money-direction-icon.contract.test.ts` 가 직접 import 를 소스 스캔으로 막는다.
 *
 * 소비처: `settlement-selection-bar` · `settlement-page-client`(정산 헤더) ·
 * `mobile-home-settlement-card` · `mobile-settlement-pending-sheet` ·
 * `mobile-schedule-day-list` · `mobile-campaign-detail-sheet`.
 */
export const MONEY_DIRECTION_ICON = {
  in: CircleArrowDown,
  out: CircleArrowUp,
} as const;

/**
 * 아이콘·**초점 금액** 텍스트 색 — 흰 카드 표면 전용.
 *
 * 대비 실측(흰 배경): in `--money-in-text` #047857 = 5.48:1 · out `--money-out` #E11D48 = 4.70:1.
 * 둘 다 AA 통과. 비대칭(-text 변형이 in 에만 있음)은 의도다 — out 은 원본이 이미 통과다.
 *
 * **대칭이 이 맵의 핵심 계약이다.** 한쪽만 칠하지 말 것: 지급만 빨갛고 입금은 회색이면
 * "지급 = 나쁜 것"으로 오독된다. 둘 다 칠하거나 둘 다 안 칠하거나다.
 */
export const MONEY_DIRECTION_TEXT: Record<MoneyDirection, string> = {
  in: "text-money-in-text",
  out: "text-money-out",
};

/**
 * 캘린더 SVG 링 stroke — **비텍스트(3:1) 표면 전용**이라 원본 토큰을 그대로 쓴다.
 *
 * `--money-in`(#059669)은 흰 배경 3.77:1 로 링에는 적법하지만 **텍스트엔 미달**이다.
 * 이 토큰이 원래 링용으로 잡힌 값이라 텍스트 소비처가 0곳이었던 것 — 텍스트에는
 * 위 MONEY_DIRECTION_TEXT 를 쓴다. 두 맵을 섞지 말 것.
 */
export const MONEY_DIRECTION_STROKE: Record<MoneyDirection, string> = {
  in: "var(--money-in)",
  out: "var(--money-out)",
};

/**
 * **목록 행**의 금액 색 — 무채색이다(방향은 왼쪽 아이콘이 이미 말한다).
 *
 * 대기 목록은 행이 여러 개라 금액마다 색이 붙으면 **아무것도 안 튄다**
 * ("표는 주의가 필요한 소수에만", P8 §2). 초점 숫자(홈 타일)만 MONEY_DIRECTION_TEXT 를 쓴다.
 *
 * ⚠️ 종전 근거는 *"진짜 판단축인 **지연 배지**가 묻힌다"* 였다 — 그 배지(`MobileOverdueBadge`)는
 * 2026-08-26 오너 지시로 **제거됐다**(예정일 경과는 어떤 시각 표기도 갖지 않는다). 근거의
 * 그 절반은 소멸했지만 규칙은 P8 §2(무채색은 랭크 선언) 위에 그대로 선다 — 배지가 사라졌으니
 * 금액을 칠해도 된다는 뜻이 **아니다.**
 *
 * 소비처: `MobileSheetAmount`(정산 대기 시트·캠페인 상세 시트 공용) · `MobileScheduleDayList`.
 * 상수로 **실제 소비**시키는 이유: 주석만 남기면 드리프트를 못 잡는다 — 착지 전 이 값이
 * 소비처 0곳이었고, 그건 이 PR 이 고치는 `--money-in`(정의만 되고 소비처 0곳이라 아무도
 * 안 쓰던 토큰)과 정확히 같은 실패다.
 */
export const MONEY_ROW_AMOUNT_NEUTRAL = "text-slate-800";

/**
 * **이미 오간 대금** 줄의 색 — 아이콘·금액 공용. 위 `MONEY_ROW_AMOUNT_NEUTRAL` 보다
 * **한 단계 더 낮은 무채 랭크**다(slate-800 #1E293B → muted-foreground #64748B).
 *
 * ## 왜 두 무채색이 있나 (합치지 말 것)
 * 무채색은 부재가 아니라 **랭크 선언**이다(P8 §2). 완료 줄을 숨기지 않고 실제 이체일에
 * 세우기로 한 오너 확정(2026-08-26) 때문에 한 날짜에 「끝난 일」과 「할 일」이 섞이는데,
 * 둘이 같은 무게면 **그 날 아직 할 일이 무엇인지가 끝난 줄에 묻힌다**(모바일 일정탭의
 * 목적은 빠른 상태 확인·리스크 감지 — P3). 그래서 랭크가 둘이다:
 * - `MONEY_ROW_AMOUNT_NEUTRAL` = 아직 오갈 돈. 금액은 무채색이되 **또렷하게**
 *   (방향은 왼쪽 아이콘의 유채색이 말한다).
 * - 여기 = 이미 오간 돈. 아이콘의 방향색까지 걷어 **줄 전체를 배경으로 내린다.**
 *   화살표 **모양은 유지**하므로 입금/지급 정보는 잃지 않는다.
 *
 * `MONEY_DIRECTION_TEXT` 의 in/out 대칭 계약은 깨지지 않는다 — 완료 줄에서는
 * **양방향 모두** 무채색이다("둘 다 칠하거나 둘 다 안 칠하거나").
 *
 * ⛔ **정적 `opacity-*`·`brightness-*` 로 딤 처리하지 말 것** — 모바일 프레스 계층
 * (P8: ①딤 ②축소 ③bg 틴트 ④투명도)과 겹쳐 "표면당 정확히 한 계층" 계약이 깨진다.
 * 무게는 **색 값**으로만 낮춘다. #64748B 는 P8 데이터 텍스트 하한(slate-500)과 같은 급이다.
 *
 * 소비처: `MobileScheduleDayList` 의 완료 대금 줄 · `MobileCampaignDetailSheet` 의
 * `SettlementRow`(방향 아이콘 tone + 금액) · `MobileSheetAmount`(`dim`).
 * 주석만 남기면 드리프트를 못 잡으므로 위 `MONEY_ROW_AMOUNT_NEUTRAL` 과 같은 형식으로
 * **전 소비처를 나열한다** — 소비처가 늘 때 이 줄도 함께 갱신할 것.
 */
export const MONEY_ROW_SETTLED_MUTED = "text-muted-foreground";
