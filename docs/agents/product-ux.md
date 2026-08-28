# Product & UX Rules — P2 · P3 · P5 (AGENTS.md 라우터 모듈)

> `AGENTS.md`의 Mandatory Reading Router가 지정하는 조건부 필독 모듈이다.
> 화면·UI·기능(데스크톱/모바일 불문)을 변경하기 전에 **전문**을 읽는다.
> 시각 스타일·모션을 만지면 `docs/agents/design-system.md`(P8)도 함께 필독.

## P2. WAG CRM Product and UX Rules

- **Operational CRM Lens:** 모든 사용자 요청과 피드백은 구현 전에 운영 CRM 및
  UX 전문가 관점으로 해석한다.

- **Workflow Goal First:** 주요 UI/기능 변경 전, 해당 화면이 지원해야 하는
  사용자 의사결정과 업무 흐름을 먼저 설명한다.

- **Decision-Value Priority:** 데이터가 명확한 판단 가치를 가질 때만 UI 요소를
  강조한다. 단순 개수, 장식적 요약, 이동만 제공하는 카드는 우선순위를 낮춘다.

- **Information Hierarchy Before Polish:** 시각적 정리보다 정보 구조와 업무상
  판단 순서를 먼저 검토한다.

- **Seller Alias Priority:** 캠페인 이름 자동 조합 및 화면 상의 셀러명 노출 시, 셀러의 별칭(alias)이 존재한다면 실명(name) 대신 별칭을 최우선으로 표기한다.

- **Campaign Naming Auto-Generation:** 캠페인 이름은 수동으로 지정하지 않으며, 항상 `[딜이름] - [셀러명]` (회차가 존재할 경우 `[딜이름] - [셀러명] N차`) 형태로 자동 조합하여 부여한다. 구현체는 `generateCampaignName`(`src/lib/campaign-name.ts`) — 우회 구현 금지.

- **Campaign Round Badge:** 카드 뷰(판매 관리 등)에서 캠페인 차수(roundNumber)는 딜이름 텍스트 뒤에 붙이지 않고, 셀러명 우측에 전용 배지(Badge) 형태로 분리 배치한다. 이때 카드 뷰 헤더는 좌우 분산 정렬 대신 가독성을 위해 `[딜이름] [아이콘][셀러명] [차수 배지]`의 한 줄 흐름 포맷으로 렌더링한다. 단, 아이콘이 딜이름과 셀러명 사이의 구분기호 역할을 하므로 하이픈(-)은 사용하지 않는다.

- **Growth Direction Lock:** 성장 관련 기능 제안은 소개 기반 플라이휠
  (`GROWTH_FLYWHEEL_PLAN.md`)을 전제로 한다. 콜드 아웃리치 자동화와 금전
  레퍼럴 인센티브 설계는 오너가 실측 근거로 기각했다 — 다시 제안하지 않는다.

- **Toast Ownership:** 일반 원칙은 전역 `~/.gemini/config/rules/styleseed.md`
  mechanical checks §8로 승격됐다(2026-08-01 — 성공 토스트는 액션당 한 곳 소유,
  동기화 콜백 무음). 상태 동기화 콜백은 무음이다. 성공 토스트는 액션당 한
  곳만 소유한다. 인라인 저장은 "성공 무음 · 실패만 토스트(`InlineEditField`
  소유)" 계약이며 회귀 테스트로 고정돼 있다 — 인라인 저장에 성공 토스트를
  추가하는 순간 회귀다.

- **Unconfirmed Link Guard:** 트래킹 링크 등 미확정 값(`""`·`"pending"`)은
  UI에서 "미확정"으로 표기하고 링크 액션을 노출하지 않는다. 새 표면을 만들
  때도 이 가드를 상속한다.

## P3. Mobile CRM Rules

- **Mobile Is Not Desktop Parity:** 모바일 CRM의 기본 목적은 PC 기능을 압축해
  제공하는 것이 아니다.

- **Primary Mobile Use Case:** 모바일은 빠른 상태 확인, 리스크 감지, 간단한
  후속 액션을 위한 화면으로 본다.

- **Major Mobile Screen Changes:** 주요 모바일 화면 변경 전, 그 화면이 어떤
  사용자 판단을 돕는지와 제안된 정보 구조가 그 판단을 어떻게 지원하는지
  명시한다.

- **Mobile Component Home:** 모바일 전용 컴포넌트는 `src/components/mobile/`
  안에만 생성한다. 계약 테스트(`src/components/mobile/__tests__/mobile-breakpoint-contract.test.ts`)가
  이 디렉터리를 전수 스캔해 `md:hidden`류 미디어쿼리 분기 금지를 강제한다
  (P5와 한 몸이다).

- **Mobile IA & Write Path:** 모바일은 3탭 정보구조를 유지한다. 모바일의 쓰기
  경로는 2종이다(오너 승인 2026-07-15) — ① 예비 캠페인 생성
  (`POST /api/mobile/campaigns/draft`), ② 주문 동기화 트리거
  (`POST /api/mobile/order-sync`, 캠페인 상세 당겨서 새로고침 · TTL 90s
  게이트 — 계약 상세는 `docs/agents/data-contracts.md` P7). 그 외 쓰기 경로
  신설은 오너 게이트. 스펙 SSOT는 `MOBILE_UX_PLAN.md`.

## P5. Desktop UI Protection against Mobile Adjustments

- **Adaptive over Responsive:** Do not use CSS media queries (e.g., `md:hidden`, `hidden md:flex`) to toggle entirely different structural components between mobile and desktop if it degrades the desktop experience when the window is resized.
- **User-Agent Detection Priority:** Mobile views must be conditionally rendered in React based on User-Agent detection (e.g., `useIsMobile()` checking navigator.userAgent) so that desktop users always get the full desktop view regardless of window width.
- **Do not overwrite desktop components:** When asked to restore or fix a mobile view, ensure you do not overwrite, delete, or hide the desktop component structure.
