# Codebase & Document Map (AGENTS.md 라우터 모듈)

> `AGENTS.md`의 Mandatory Reading Router가 지정하는 조건부 필독 모듈이다.
> 세션에서 **첫 코드 수정 전 1회 전문**을 읽고 캐시한다.

## Stack (2026-07 실측)

- **프레임워크:** Next.js 16.2.4 App Router(`cacheComponents` 활성) +
  React 19 + TypeScript 5. **Next 16은 대부분 모델의 학습 컷오프보다
  최신이다** — API가 기억과 다르면 `node_modules/next/dist/docs/`(실존 확인됨)
  를 정본으로 한다.
- **🪤 인증 게이트는 `src/middleware.ts` 가 아니라 `src/proxy.ts` 에 있다.** Next 16 이
  미들웨어 파일 규약을 `middleware.ts` → **`proxy.ts`** 로 개명했다(`PROXY_FILENAME`,
  `node_modules/next/dist/lib/constants.js`). `src/proxy.ts` 가
  `src/lib/supabase/middleware.ts` 의 `updateSession` 을 호출하고, matcher 가 `/api` 를
  포함하므로 **세션 없는 요청은 라우트 핸들러에 도달하기 전에 `/login` 으로 307 된다**
  (2026-08-04 실측). 학습 데이터가 `middleware.ts` 로 기억하고 있어 **"미들웨어가 없으니
  API 가 무방비다"라는 오판이 실제로 나왔다** — 인증 커버리지를 판단하기 전에 이 파일부터
  연다. 세션 게이트에서 **면제되는** 경로(`/api/cron/*` · `/api/auth/*` · 인제스트 3종 ·
  포털 · Sentry 터널)에서만 핸들러 자체 가드가 유일한 인증이며, 그 불변식은
  `api-route-auth-coverage.contract.test.ts` 가 강제한다. 라우트의 `requireAuth` 는
  전수가 아니며 그 자체로는 결함이 아니다(2차 방어).
  같은 이유로 **역할(`operator`) 집행도 이 게이트 한 곳에 있다** — 라우트의 `requireRole`
  이 아니라 `updateSession` 의 **화이트리스트**다(`src/lib/auth-roles.ts`). 신규 라우트는
  별도 조치 없이 기본 차단이므로, operator 에게 화면을 열 때만 그 목록에 추가한다(아래
  Code SSOT 표의 `isOperatorAllowedPath` 항목).
- **데이터:** Prisma 6 + PostgreSQL(Supabase). 로컬 전용 sqlite 스키마가
  별도로 있다(`prisma/schema.sqlite.prisma` — `npm run db:generate`가
  postgres·sqlite 클라이언트를 이중 생성).
- **UI:** Tailwind CSS v4 + shadcn/ui(radix-ui) + `motion`. 차트는
  recharts·Tremor, 토스트는 sonner.
- **테스트:** Vitest 4 — 테스트 파일은 제품 코드 옆 co-location
  (`*.test.ts(x)`). Playwright 데스크톱 회귀는 `e2e/`. Sentry는
  프로덕션에서만 로드(`src/instrumentation.ts`).
- **주요 경로:** `src/app`(페이지 + `api/`) ·
  `src/components/{crm,mobile,portal,ui}` · `src/lib`(도메인 로직) ·
  `src/services` · `src/repositories` · `scripts/`(운영 스크립트) · `e2e/` ·
  **`ygrd-link/`(별도 배포체 — Cloudflare Worker, 유입추적 리다이렉터. Next 앱이
  아니므로 루트 `tsconfig.json` 에서 제외돼 있고 자체 `npm run typecheck` 를 쓴다)**.
  `knowledge/`(런타임 지식 매니페스트, `index.json`)와 `.knowledge/`(백엔드
  도메인 문서, OKF)는 서로 다른 디렉터리다 — 혼동 금지.

## Domain Models (Prisma)

`Partner`(거래처/브랜드) · `Seller`(셀러) · `Deal`(딜) ·
`SalesCampaign`(캠페인 = 딜×셀러×회차, `roundNumber`) ·
`CampaignGroup`(조합 캠페인) · `OrderCampaign` + `NaverOrderSnapshot` +
`OrderFulfillmentState`(주문 파이프라인) · `NaverSettlementCase`(정산) ·
`Asset`(콘텐츠 자산) · `ReferenceInboxItem`(발굴 인박스) ·
`SystemTaskStatus`(크론 관측) · `BannedPhraseRule` + `DealClaim`(광고 표현
컴플라이언스 — C1 클레임 게이트).

## Code SSOT — 아래 심볼이 담당하는 로직은 새로 만들지 말고 재사용한다

| 심볼 | 위치 | 역할 |
| --- | --- | --- |
| `generateCampaignName` | `src/lib/campaign-name.ts` | 캠페인명 자동 조합(P2 규칙의 구현체) |
| `countEffectiveCampaigns` | `src/lib/campaign-group-count.ts` | **유효 캠페인 수**(그룹=1건) SSOT — 대시보드 KPI·셀러 누적 수 등 "개수" 노출 표면용. ⚠️ 전 표면 대상이 아니다: 삭제 가드·딜 상세 목록 건수·칸반 카운트·정산 리포트는 행 단위가 정답(오너 확정 2026-07-30). 월 가중 배분은 `buildEffectiveCampaignPeriods`(그룹=멤버 포락선), 셀러별 집계는 `tallyEffectiveCampaignCounts`(Prisma groupBy 접기) |
| `buildOverdueSettlementItems` | `src/lib/agenda-settlements.ts` | 대시보드 "지연된 정산"(`/api/agenda`) 목록 SSOT — 그룹은 1행으로 접고(금액은 멤버 합산, id는 대표 멤버 — `PATCH /api/campaigns/[id]/settlement-status`가 그룹 전파하므로 모달 액션이 그룹 전체에 걸린다) 지연 판정은 **그룹 플래그**로 한다. ⚠️ **입금/지급 플래그의 SoT는 그룹 스칼라다(CG-1)** — 멤버 행의 `isDepositReceived`/`isPayoutCompleted`는 낡을 수 있어, 멤버 플래그로 그룹의 지연·불일치를 판정하면 **이미 입금된 그룹이 멤버 수만큼 지연으로 뜬다**(실제 결함이었다, #196). 🪤 같은 이유로 **Prisma `where` 프리필터로 지연을 거르지 말 것** — 그룹 날짜만 있고 멤버 날짜가 null인 건을 통째로 누락한다(정산 단계 전량 fetch 후 JS 판정이 계약). 그룹 날짜가 null이면 멤버 최솟값 폴백(`buildUpcomingEvents`와 동일 규칙). 같은 규약의 짝: 커버리지 버킷 `foldBucketCampaigns`(`schedule-gap-briefing.ts`) · 데이터 점검 `computeDataIntegrityIssues`(`data-integrity.ts`). 죽은 집계 필드로 이 판정이 되살아나는 경로는 `dashboard-settlement-sot.contract.test.ts`가 막는다(#198). ⚠️ **모집단·「오늘」 경계·그룹 접기는 이제 `settlement-stage.ts` 가 소유한다**(T-062) — 여기서 다시 쓰지 말 것 |
| `SETTLEMENT_STAGE_STATUSES` · `isOverdueKst` · `foldByGroup` · `resolveSettlementStartOverdue` | `src/lib/settlement-stage.ts` | 정산 **단계 축**의 공통 판정 SSOT(client-safe 순수) — ①대금 표면의 모집단 ②「늦었다」의 날짜 경계 ③조합 캠페인 접기 ④「정산 착수 지연」. T-062(2026-08-27) 실측에서 두 표면(데스크톱 아젠다 · 모바일 정산 대기 목록)이 **세 축 전부** 갈라져 있었다 — 상태 집합이 3파일에 손으로 박혀 있었고, 경계가 `date <= now` 대 `ymd < today` 로 달랐으며(예정일이 UTC 자정 저장이라 전자는 **오늘 예정을 오전부터 지연으로** 봤다), 접기는 아젠다만 해서 한 묶음이 모바일에서 멤버 수만큼 줄·건수를 차지했다. ⛔ 세 규칙 중 어느 것도 표면에서 다시 쓰지 말 것 — `settlement-surface-parity.contract.test.ts` 가 **같은 픽스처를 두 빌더에 넣어 결과 일치**를 보고 소스 스캔으로 상태 집합 재선언을 막는다(⚠️ 스캔 대상은 손으로 적은 목록이다 — 대금 대기/지연을 만드는 표면을 새로 만들면 거기 등재할 것. 전수 스캔을 안 쓰는 이유는 같은 상태 문자열이 정산 리포트·명세서·대시보드 캐시에서 **다른 질문에도 정당하게** 쓰이기 때문이다). ⚠️ **「정산 착수 지연」은 대금 지연과 축이 다르다** — 저쪽은 "돈이 예정일에 안 왔다"(액션 = 입금 확인·지급 완료), 이쪽은 "절차를 시작 안 했다"(액션 = 캠페인을 정산 단계로 넘김). 합치면 금액도 대금 칸(`CampaignMoneySlot`)도 없는 줄이 모달을 여는 목록에 섞인다. 노출은 `data-integrity.ts` 의 `SETTLEMENT_NOT_STARTED`(데이터 점검·리스크 신호 카드, 오너 확정 2026-08-27). 🪤 **필터를 넓히는 것으로 이 사각을 닫으려 하지 말 것** — 실측상 정산 단계 밖에는 정산 예정일이 **한 건도 없고**(입력 화면이 정산 페이지에서만 열린다) 넓혀도 추가 0건이다. 🪤 **2026-08-25 에 제거된 정산표 지연 경고의 부활로 읽지 말 것** — 모집단이 정산 단계 **이전**(`PRE_SETTLEMENT_SALE_STATUSES`)이라 그 경고를 무너뜨린 「전 행 점등」이 구조적으로 없다(`settlement-table.tsx` 묘비 주석에 상호참조) |
| `resolveSettlementFlagSnapshot` · `writeSettlementFlags` | `src/lib/settlement-flag-write.ts` | 정산 완료 플래그 3종(`isDepositReceived`/`isPayoutCompleted`/`isSupplierPayoutCompleted`)의 **CG-1 SoT 읽기·쓰기 SSOT**. 그룹 소속이면 정본은 **그룹 스칼라**이고 멤버 행 값은 낡을 수 있다 — 그래서 이 플래그를 만지는 코드는 읽을 때도 쓸 때도 「어느 행이 정본인가」를 먼저 골라야 하고, 그 선택이 호출부마다 재구현되면 **한쪽만 그룹을 인지하는 상태**가 된다. 🪤 실제로 그렇게 갈렸다: 오너의 버튼 경로(`PATCH …/settlement-status`)는 그룹 스칼라에 썼는데 어시스턴트 경로(`write-executor.handleConfirmSettlement`)는 `salesCampaign.updateMany` **하나만** 돌려, 그룹 소속 캠페인을 확정하면 멤버 행만 true 가 되고 **그룹 스칼라는 false 로 남았다**(화면·지연 판정·정산 목록이 전부 그룹 스칼라를 읽으므로 「확정했는데 화면은 그대로」 · 반대로 `computeAutoStatus` 는 멤버 플래그로 status 를 전진시켜 어긋난 행이 남는다). `buildOverdueSettlementItems` 의 #196 과 같은 부류다. ⚠️ **`status` 는 이 규칙의 대상이 아니다** — 그룹 스칼라가 없는 멤버 고유 값이라 그룹 소속이어도 멤버 행에 쓴다. ⚠️ **그룹이면 금액 게이트도 그룹 단위로 센다**(`sumMoneySlotAmounts`) — 플래그가 그룹 스칼라라 쓰기가 조합 전체에 미치는데 대표 멤버 한 명의 금액으로 통과시키면 게이트가 지키는 범위와 쓰기 범위가 어긋난다. ℹ️ **예외 1건: `campaignService.updateCampaign`(캠페인 PATCH)** 은 같은 규칙을 이미 지키지만 플래그를 계산서일·예정일·반품기간과 **한 statement 로 묶어** 쓰므로 쪼개지 않는다(쪼개면 그룹 쓰기가 두 번으로 갈려 원자성만 잃는다). ℹ️ `PATCH /api/campaigns/bulk` 도 같은 결함(그룹 미인지)을 갖고 있었다 — 앱 내 호출부 0건인 죽은 표면이라 **제거가 오너 확정됐다**(2026-08-27: 「일괄 처리 창구를 따로 두지 않고 멤버 체크의 그룹 전파로 해결한다」). ⚠️ 그 제거는 **별도 PR 소관**이라 이 줄은 상태가 아니라 결정을 적는다 — 라우트가 아직 있으면 아직 안 착지한 것이고, 복원 차단 계약은 그 라우트의 `__tests__/route.test.ts` 「제거된 표면」이 소유한다. 계약은 `settlement-flag-write.contract.test.ts`(두 경로의 SSOT 위임 + 직접 쓰기 부재를 **AST** 로 스캔 — 🪤 주석에 금지 문자열이 설명으로 인용돼 있어 정규식으로 세면 자기 자신을 잡는다) · `settlement-flag-write.test.ts` |
| `resolveBrandSettlementTotal` | `src/lib/settlement-brand-total.ts` | 거래처(브랜드사)와 주고받을 **캠페인 1건의 정산 총액** 판정 SSOT — 채널이 정한 기준액(우리몰·셀러몰=물품대금 / 브랜드몰=영업수익)에 브랜드 구간 부가 항목을 더한다. **부호가 방향이다**(양수=받을 돈 · 음수=지급할 돈) — 부가 항목이 채널의 기본 방향을 뒤집을 수 있어 채널로만 정하면 「지급할 총액 +500,000원」 같은 거짓말이 나온다. 부호 없는 `0` 에서만 채널 기본 방향(`resolveCampaignMoneySlots` 의 SUPPLIER 슬롯)을 쓴다. ⛔ **화면에서 다시 계산하지 말 것** — 이 함수가 생긴 이유가 그것이다(재무 카드 안에 인라인으로 있던 것을 정산 선택 바가 같은 금액을 합산하게 되면서 옮겼다, #529). 소비처는 재무 카드(`campaign-side-panel`)와 거래처별 묶음(`settlement-partner-breakdown.ts` → 정산 선택 바) 둘이다. ⚠️ **`isEstimated` 를 떨어뜨리지 말 것** — 물품대금 미입력이면 총액이 공식 추정인데 그 신호를 버리면 오너가 확정 금액과 추정 금액을 구분하지 못한 채 이체한다(교차 검증 지적 2026-08-28). ⚠️ 물품대금 3-상태는 `goods-cost.ts` 가 소유하고 산술 기여값은 `resolveGoodsCostContribution` 이 접는다 — 여기서 다시 접으면 재무 카드의 물품대금 행과 총액이 갈린다. ℹ️ 이 값을 **손익**(`operatingProfit`·「조정 후 손익」)에 넣지 말 것: 물품대금 소비처 경계는 `expected-receivables-scope.contract.test.ts` 가 지킨다. 계약은 `settlement-brand-total.test.ts` · `settlement-partner-breakdown.test.ts` |
| `rollupGroupPeriod` · `recomputeGroupRollup` | `src/services/campaignGroupService.ts` | 그룹 기간 롤업 = **멤버 포락선(min~max)의 비정규화 복사본**. 산식은 `rollupGroupPeriod` 하나이고 두 갱신 경로가 공유한다 — `recomputeGroup`(멤버십 변경) · `recomputeGroupRollup`(멤버 **기간 수정**, 캠페인 PATCH 라우트가 호출). ⛔ 기간 수정에서 `recomputeGroup` 을 재사용하지 말 것(멤버 ≤1 **해체** + 이름 **자동 재생성**이 딸려온다). 실사고 2026-08-01: 갱신 주체가 멤버십 경로 하나뿐이라 기간 수정이 복사본을 낡게 만들었고(prod 20그룹 중 2건·종료 최대 11일 차), 홈 「다가올 14일 일정」(그룹 값 **우선**)과 그룹 합류 후보 검색(롤업 겹침 조회 → **제안이 안 뜨는 침묵형 실패**)이 그 값을 읽었다. 구글 캘린더는 무관 — `syncGroupOne` 이 멤버에서 직접 계산한다(실측 확인). ℹ️ **자동 이름(대표 딜 = 시작일 최소 멤버)은 기간 수정 시 의도적으로 갱신하지 않는다** — 수동/자동 이름을 구분하는 플래그가 없어 재생성하면 오너의 수동 이름이 날짜 수정만으로 사라진다(낡은 라벨 < 이름 소실). 이름은 다음 멤버십 변경 때 `recomputeGroup` 이 정리한다. 계약은 `campaignGroupRollup.contract.test.ts` |
| `fanOutMemberSchedule` | `src/services/campaignGroupService.ts` | 그룹 **일정 통합 연동** SSOT — 한 멤버의 `startDate`·`endDate`·`returnPeriodEndDate` 수정을 형제 멤버에 복사한다(조합 캠페인 = 1개 실캠페인이므로 일정도 통합 운영, 오너 확정 2026-08-04). ⛔ **정산일 9종처럼 그룹 스칼라 SoT + 읽기 오버레이로 "정리"하지 말 것** — 이 3필드는 `toCampaignRow` 를 거치지 않고 **멤버 컬럼을 직접** 읽는 소비처가 있다(`dashboard-data.ts`·`cached-crm-data.ts` 의 `where: { returnPeriodEndDate: { lt } }` · `desktop-dashboard.ts` 의 `select`). 그룹 SoT 로 옮기면 멤버 컬럼이 null 로 남아 "반품기간 지난 정산대기" 카운터가 **조용히 0** 이 된다(#196 함정과 동형). 기간은 소비처가 더 넓다(차수 계산·주문 조회 창·월 배분·캘린더). 🪤 호출 순서는 **팬아웃 → `recomputeGroupRollup`** — 뒤집으면 포락선이 팬아웃 이전 값으로 계산된다. 기간은 `periodChanged` 일 때만 복사하고(같은 값 재전송 무쓰기), 원본 멤버는 라우트의 단일 update 가 소유한다. 응답의 `groupScheduleSyncedCount` 는 영속 필드가 아니라 **고지용 일회성 신호**다. 설계 정본은 `docs/private/specs/2026-08-04-group-schedule-sync-design.md`, 계약은 `groupScheduleFanout.contract.test.ts`(소스 스캔 포함) |
| `refreshCampaignRows` · `LIST_REFRESH_FAILED_MESSAGE` | `src/lib/campaign-row-refresh.ts` | 쓰기 직후 **캠페인 행을 다시 읽어 화면에 되꽂는** 동작의 SSOT(클라이언트 전용). 상위 콜백이 **행 하나를 교체하는** 계약이라 목록이 스스로 따라오지 않아, 화면마다 「무엇을 다시 읽을지」를 각자 정하다 **사본이 갖춘 조각이 서로 달라졌다** — 흡수한 사본 셋 중 모양을 검증한 것은 정산 패널 하나뿐이었고, 보드 표면 넷 중 실패를 알린 것은 둘뿐이었다. ⛔ 문구는 이 모듈이 갖지 않는다 — 표면마다 사용자가 취할 행동이 다르다. ⚠️ 그룹 멤버십 변경 시 **바뀐 행 전부**를 넘기는 규칙과, 그것이 `CAMPAIGN_DETAIL_INCLUDE` 의 `group._count` 에 의존한다는 사실(T-100)은 **모듈 헤더가 정본이다 — 여기서 다시 적지 않는다.** 계약은 `campaign-row-refresh.contract.test.ts`(전수 대조 + 상수 파생 needle + 프로브) · 행위는 `campaign-row-refresh.test.ts` |
| `InlineDateField` | `src/components/crm/inline-date-field.tsx` | 즉시 저장되는 날짜 입력의 **커밋 시점 SSOT**(P8·P2). `<input type="date">` 는 세 세그먼트가 채워지는 **중간 상태마다** `change` 를 쏘므로(`2026-07-20` 입력 중 일 세그먼트에 `2` 만 들어간 순간 이미 `2026-07-02`), 그 이벤트마다 저장하면 `disabled` 토글·응답 재렌더가 입력 중인 세그먼트를 날려 **두 번째 자릿수를 칠 수 없다**(실사고 2026-08-04 — 「대금 결제 일정」이 `2026-07-02` 로 저장됐다). 처방은 디바운스가 아니라 **커밋을 blur·Enter 로 옮기는 것**이다(타이머가 없어 대기 시간에 따라 동작이 갈리지 않고, 필드를 떠나기 전엔 저장이 없어 달력 월 이동도 저장을 유발 못 한다). ⛔ `value=` 제어 컴포넌트로 되돌리지 말 것 — 외부 값 변경은 `key` 재마운트로 반영한다. 전수 조사상 이 레포에 커스텀 달력은 없고 전부 네이티브 input 이며, 갈리는 것은 저장 시점뿐이다(로컬 state→저장버튼 13곳·비제어 onBlur 1곳은 정상이었다). 계약은 `inline-date-field.test.tsx` |
| `classifyDecryptability` · `runEncryptionKeyAudit` | `src/lib/encryption.ts` · `src/lib/encryption-audit.ts` | 주민등록번호 **키 정합 감사** SSOT(P0·P6) — "저장된 값이 **지금 이 프로세스의** `ENCRYPTION_KEY` 로 열리는가"를 세는 크론 `encryption-key-audit`(매일 02:30 KST)의 판정부. 도입 계기는 **무증상 열화**(2026-08-13): 컷오버로 키가 갈려 몇 행이 안 열리는데 대량 조회 경로의 `decryptOrNull()` 이 빈칸을 돌려주므로 화면에서 **미입력과 구분되지 않았고** 며칠간 아무도 몰랐다(빌드 로그를 우연히 읽다 발견). ⛔ **파생 규칙(`padEnd(32)`)·키 사다리를 감사기가 다시 구현하지 말 것** — `scripts/reencrypt-resident-numbers.ts` 가 이미 사본을 들고 있는 그 함정이다. ⛔ `decrypt()`/`decryptOrNull()` 로 세지 말 것: 전자는 현재 키 → 구 키를 **차례로** 시도해 "현재 키로 열리는가"를 물을 수 없고(재암호화 미완이 정상으로 보인다), 후자는 성공 시 **평문을 반환**해 감사 경로에 값이 흘러든다. `classifyDecryptability` 는 복호화 결과를 버리고 등급만 남긴다. ⚠️ **실행 위치가 이 감사의 본질이다** — 검사 대상은 "앱이 쓰는 키 × 앱이 붙은 DB" 쌍이고 CI(preflight = 일회용 빈 Postgres)로는 원리적으로 못 본다. 크론인 이유의 정본은 P6 `deployment.md` 「실행 위치가 요점이다」 — ⛔ 이 표에 있던 사본 「개발 머신 스크립트(레포 `.env` = 구 Supabase)로도 못 본다」는 **SUPERSEDED**(2026-08-13 컷오버 · 2026-08-26 실측). 판정 축: 어느 키로도 안 열림·구 키로만 열림 = **빨강**, 평문 = 개수만(축이 다른 문제), 저장 0건 = `empty`(빨강 아님 — 개인 셀러 원천징수용이라 정상일 수 있다), 셀러 0명 = `broken`(감사 불능 — `db-exposure-audit` 의 "테이블 0개는 깨끗함이 아니다" 와 같은 판정). 보고는 **개수와 셀러 id 만**(값·키 금지). 계약은 `encryption-audit.contract.test.ts`(행위 + 값 비유출 소스 스캔 — 🪤 주석을 걷어내고 스캔한다: 설명문이 금지 문자열을 인용해 자기 자신을 위반으로 잡는다) |
| `INVALID_ORDER_STATUSES` | `src/lib/order-converter/group-orders.ts` | 유효주문 집계 제외 상태(P7) |
| `isSupplementProduct` · `SUPPLEMENT_PRODUCT_CLASS` | `src/lib/order-converter/product-class.ts` | 네이버 `productClass` 로 **추가구성상품(추가옵션)인가**를 가르는 판정 SSOT(P7). 주문 귀속의 분기점이라 집계·발주 표면마다 필요한데 종전에는 **7곳에 손으로 복사**돼 있었고, 사본이 갈려도 **타입도 테스트도 잡지 못한 채 실패가 조용하다** — 라인이 메인으로 오분류되면 집계에서 사라질 뿐 오류가 나지 않는다(`INVALID_ORDER_STATUSES` 가 오타 하나로 전 지표를 부풀린 것과 같은 부류, P7 Valid-Order Enum Discipline). ⚠️ **2차 귀속 규칙은 표면마다 달라 이 모듈이 갖지 않는다** — 분류만 답한다. 비교 전 `toNfc` 를 거치는 이유와 ⛔`normalizeForCompare` 금지 사유, 네이버가 보내는 형태를 다시 확인하는 방법은 **모듈 헤더가 정본**이다 — 여기서 다시 적지 말 것. 계약은 `product-class.contract.test.ts`(AST 소스 스캔 — 🪤 소비처 단언은 이름 등장이 아니라 **호출 노드**를 센다: `includes()` 로 재면 호출부를 리터럴 비교로 되돌려도 `import` 줄만으로 초록이다) · 행위는 `product-class.test.ts` |
| `deriveOrderPipelineBucket` | `src/lib/order-converter/order-fulfillment.ts` | 주문 파이프라인 버킷(데스크톱·모바일 공용) |
| `computeDormancyTier` · `tallySellerRuns` | `src/lib/seller-dormancy.ts` | 셀러 **휴면 티어** 판정 SSOT(F1 1단계, 순수·Prisma 무의존) — 마지막 **진행 시작일** 이후 경과로 건강(<90일)/휴면(90~180)/제외(180+)를 가른다. 상수는 `DORMANT_DAYS`·`EXCLUDE_DAYS` **둘뿐**(오너 확정 D20) — ⛔ 개인 평균 간격의 1.5×/2× 배수 설계는 **폐기됐다**(표본이 얇을 때 개인 평균은 틀린 확신). **과거 진행 0건은 '판정 불가'이고 0일이 아니다**(`seller-fit.ts` 가 고친 "미입력을 낙제로" 결함의 같은 부류), 미래 시작일은 마지막 진행이 아니다(v1 의 경과일 음수 함정). 진행 횟수는 그룹을 1회로 접는다 — 접기는 `tallyEffectiveCampaignCounts` 에 위임한다. ⚠️ **`recampaign-timing.ts` 와 통합 금지** — 저쪽은 본인 간격 중앙값(상대 케이던스)으로 "평소 주기가 돌아왔나"를 묻고 이쪽은 절대 일수로 "얼마나 오래 거래가 없나"를 묻는다. ⚠️ **`fitLevel` 과 합산 금지 · 정렬·필터의 기본 기준 금지**(D10 — 계정 신호와 거래 실적을 한 숫자로 합치면 이미 확인된 불일치가 숨는다). 목록 페이로드의 `runCount`·`lastRunStartAt` 은 `campaignCount`(전 상태 누적)와 **모수가 다르다**. 계약은 `seller-dormancy.test.ts`(⏰ 고정 날짜 픽스처 금지 — P9 시한폭탄 등재 지점) |
| `computeRecampaignAlerts` | `src/lib/recampaign-timing.ts` | 재캠페인 **적기** 알림(F1) — 셀러별 시작일 간격 **중앙값**을 케이던스로 보고 도래/임박(14일)을 판정. `RUN_STATUSES`("시작일이 도래한 실행 상태")가 이 레포의 **"실행됨" 어휘 SSOT**다 — C2 오퍼 진단·휴면 판정이 같은 집합을 재사용한다. 소비처는 영업 관리 알림 카드(`/api/recampaign-alerts`)와 **기안 생성**(`/api/recampaign-proposals`) |
| `rankSellerCandidatesForDeal` · `rankDealCandidatesForSeller` | `src/lib/deal-seller-matching.ts` | 딜↔셀러 **양방향 후보 판정** SSOT(F1 2단계, 순수·Prisma 무의존) — (셀러×딜) 쌍의 진행 신호로 사유 코드(`SAME_DEAL_RERUN`/`SAME_PARTNER`/`LONG_GAP_SELLER`/`NEW_MATCH`)와 D3 우선순위(`RERUN_PRIORITY_SALES`)를 붙인다. **같은 F1 계열 3모듈의 축이 다르다**: `seller-dormancy`=얼마나 오래 거래가 없나(절대 일수) · `recampaign-timing`=평소 주기가 돌아왔나(상대 케이던스) · 이 파일=누구에게 **무엇을**(딜 차원). ⛔ 셋 통합 금지 — 앞 둘의 병행 유지는 오너 확정이고 이 모듈은 통합이 아니라 직교 축 추가다. ⛔ `fitLevel` 과 합산 금지 · **D3 부스터를 필터로 쓰지 말 것**(정렬·배지 전용, D10 — 문턱 미만을 숨기면 오너가 아는 예외가 사라진다). 재진행 간격은 새 임계를 만들지 않고 `DORMANT_DAYS` 를 재사용한다(D20 의 90일이 애초에 D3 출처라, 별도 상수를 세우면 같은 오너 진술이 두 숫자로 갈린다). **쌍 매출 미입력은 0 이 아니라 판정 보류**다(`seller-fit.ts` 가 고친 "미입력을 낙제로"의 같은 부류). 🪤 **딜 상태의 영문 이름으로 의미를 짐작하지 말 것** — `ARCHIVED` 는 "완료"이고 `DROPPED` 는 "보류"다(`dealStatusLabels`). 그래서 셀러→딜 후보 풀이 두 겹이다: 신규 제안은 살아 있는 딜만, **재진행은 완료 딜이 주 모집단**이다(끝난 딜을 빼면 D3 재진행이 원천적으로 안 뜬다 — 실렌더에서 잡힌 결함). 판정 축은 `DealCandidateInput.isLive` 하나이고 상태 문자열은 라우트 밖으로 새지 않는다. ⚠️ **매칭 키에 카테고리를 쓰지 않는 것은 의도다** — `Deal.category` 는 마케팅 카테고리가 아니라 클레임 게이트 규칙 선택자(C1 §4)이고 사실상 미입력이며 `Seller.category` 는 어휘가 다른 자유 텍스트 다중 태그다. 조인하면 어휘가 어긋난 채 거의 매칭되지 않는다(오너 확정 2026-08-04, 실적 기반으로 대체). 설계 정본은 `docs/private/specs/2026-08-04-deal-seller-matching-design.md`, 계약은 `deal-seller-matching.test.ts`(⏰ 고정 날짜 픽스처 금지) |
| `buildProposalDedupeKey` · `readProposalDedupeKey` | `src/lib/recampaign-proposal.ts` | F1 기안의 **중복 제거 키** SSOT — `셀러id + 사유코드 + 딜id`(멱등성 4종 세트 ②). ⛔ 셀러 단독 키로 되돌리지 말 것: 같은 `requestType` 을 케이던스 기안과 딜 스코프 기안이 공유하므로 셀러만 보면 **과차단**이다("이 셀러에 열린 기안 있음" 하나로 서로 다른 딜 제안이 전부 막힌다). ⚠️ **상태 스코프 dedup 이라 DB 유니크 제약으로 못 만든다** — 같은 조합도 3개월 뒤엔 다시 기안돼야 해서 "열린 기안" 안에서만 유일하다. 호출부가 열린 행을 조회해 키로 비교한다. 🪤 **`structuredResult` 는 프로바이더에 따라 모양이 다르다** — `actionProposalRepository` 가 SQLite 에선 Json 을 **문자열로** 저장하고 raw Prisma 로 읽으면 그 문자열이 그대로 올라온다. 객체만 처리하면 로컬에서 dedup 이 **조용히 뚫린다**(실측 사고 — 유닛 테스트는 객체만 넣어 통과했다). 사유 미기록 레거시 행은 `CADENCE_DUE` 로 본다(이 폴백이 없으면 넓히려다 뚫린다). 계약은 `recampaign-proposal.test.ts` |
| `foldSellerRunSignals` | `src/lib/deal-seller-candidates-query.ts` | 딜↔셀러 후보 조회의 **셀러 단위 진행 신호** 집계(서버 전용). 🪤 **쌍 레벨 접기 결과를 더해서 만들지 말 것** — `CampaignGroup` 은 실캠페인 1개를 **딜별 N행**으로 분할한 것이라(CG-1) 한 그룹이 같은 셀러의 여러 딜에 걸친다(프로덕션 그룹은 **전부** 다딜 구성이다). (셀러,딜) 쌍으로 접은 값을 셀러 단위로 재합산하면 **한 번 진행한 그룹이 딜 수만큼 부풀어 오른다**(2026-08-04 교차 검증에서 발견). 셀러 개수는 `(sellerId, groupId)` 당 한 행으로 먼저 접은 뒤 `tallyEffectiveCampaignCounts` 에 위임한다. ⚠️ 계약의 그룹 픽스처는 **여러 딜에 걸친 그룹**을 반드시 포함한다 — 같은 딜 안에서만 섞으면 이 회귀를 못 잡는다(종전 테스트가 그래서 놓쳤다). 계약은 `deal-seller-candidates-query.test.ts` |
| `parseStoredJson` · `parseStoredJsonObject` | `src/lib/stored-json.ts` | 저장된 Json 컬럼 **읽기** SSOT(순수·client-safe). 🪤 **이 레포의 Json 은 프로바이더마다 모양이 다르다** — 리포지토리 4종(`actionProposalRepository`·`priceSheetRepository`·`priceMonitorSnapshotRepository`·`assistantConversationRepository`)이 "Postgres 는 객체, SQLite 는 문자열"로 이원화해 저장하고 **역직렬화는 리포지토리 쪽에만 있다.** raw Prisma 로 읽고 `value as T` 로 캐스팅하면 **Postgres 에선 통하고 SQLite 에서만 조용히 빈 값**이 된다 — 타입도 테스트도 못 잡는다(픽스처를 프로덕션 모양으로만 만들면 초록이다). 실사고 2건: ①기안 dedup 이 로컬에서 통째로 뚫려 중복 기안 생성 ②가격표 「반영 결과」가 성공한 반영을 "생성 0건"으로 표시. ⛔ Json 컬럼을 raw 로 읽었으면 캐스팅하지 말고 이 함수를 통과시킨다. 재발 방지는 `stored-json.contract.test.ts` 의 **필드 단위 소스 스캔** — ⚠️ 파일 단위로 느슨하게 바꾸지 말 것(파일 단위 판정은 위 ②를 놓쳤다, 양성 프로브로 확인). 행 통째로 넘기는 자리는 그 테스트의 `ROW_LEVEL_HANDLED` 에 이유와 함께 열거한다 |
| `PROPOSAL_COOLDOWN_DAYS` · `selectProposable` | `src/lib/proposal-idempotency.ts` | 반복 실행 기안의 **멱등성 4종 세트** SSOT(순수·client-safe). 정본은 `docs/marketing-skills/README.md` §3-2(로컬 전용). ①마커는 `SystemTaskStatus`(`withSystemTaskStatus` 래퍼) ②키는 `buildProposalDedupeKey` ③쿨다운은 여기 ④'이미 처리'는 이력 조회가 **상태를 가리지 않아** 흡수한다(거부·승인·실행 전부 처리됨). ⚠️ **쿨다운은 생성 시각이 아니라 마지막 활동 시각으로 잰다** — 생성 시각으로 재면 오래 전에 올라와 어제 거부된 기안이 하루 만에 다시 올라온다(오너 확정: 거부는 3개월 뒤 재등장). ⛔ 쿨다운(`PROPOSAL_COOLDOWN_DAYS`)과 재진행 임계(`DORMANT_DAYS`)를 한 상수로 합치지 말 것 — 지금 둘 다 90 이지만 "재진행할 때가 됐나"(도메인 임계)와 "얼마나 자주 말을 걸어도 되나"(노출 예산)는 다른 질문이다. 상한 절단분(`droppedByCap`)은 호출부가 반드시 노출한다. 소비처는 크론 `recampaign-auto-propose`. 계약은 `proposal-idempotency.test.ts` |
| `countDistinctSellerIds` · `isCrossSellerSet` | `src/lib/cross-seller.ts` | 한 주문캠페인에 **서로 다른 셀러**가 붙었는지 판정하는 SSOT(순수·의존성 0, P0 직결). 같은 불변식을 **세 곳**이 본다 — 셀러 대면 표면(`seller-portal.ts`, 걸리면 **표시 제외**) · 퍼지 자동매핑(`mapping-service.autoMapOrderCampaign`, **전체 거부**) · 수동 매핑 저장(`api/campaigns/[id]`, **400 롤백**). ⚠️ **왜 위험한가**: 포털은 `salesCampaigns` 중 하나라도 자기 셀러면 그 캠페인을 "내 것"으로 보고 **캠페인 전체 집계**를 렌더하므로, 두 셀러가 한 주문캠페인에 붙으면 A 화면에 A+B 합산이 A 실적으로 나간다(「Seller-Facing Data Exposure」 위반). ⛔ **판정을 `productId` 로 바꾸지 말 것** — 주문 귀속은 productId 가 아니라 상품명·옵션명의 **양방향 부분일치**(`campaign-orders.ts`)라 이름이 겹치면 귀속 단계에서도 흔들린다. 판정은 실제로 합산이 흘러드는 조건, 즉 **링크 관계의 distinct sellerId** 를 본다. ⛔ **미입력 sellerId 를 "또 하나의 셀러"로 세지 말 것**(정상 건 오탐 — "미입력을 낙제로" 부류). 🪤 자동매핑의 거부는 **결정과 쓰기가 분리돼 있어야** 성립한다 — 종전엔 루프 안에서 곧바로 `productMapping.update` 를 날려, 거부 판정만 넣으면 이미 절반이 쓰인 상태가 됐다. ⛔ **쓰기 차단이 착지했다고 포털 게이트를 지우지 말 것**: 쓰기 차단은 "새로 안 생기게", 포털 게이트는 "있어도 안 새게"로 축이 다르다(미래의 새 writer·차단 이전 기존 데이터를 덮지 못한다). 정책 근거(오너 확정 2026-08-05: 주문캠페인은 셀러·회차마다 새로 만든다 → 이 상태는 정상 운영에 없다)는 `seller-portal.ts` 상단이 정본. 계약은 `mapping-cross-seller-guard.contract.test.ts`(행위 + 수동 경로 소스 스캔) |
| `resolveGoalBand` | `src/lib/goal-band.ts` | 매출 목표 달성률 밴드 색 — 히어로 네이비 표면(데스크톱·모바일 공용, P8). 화면마다 삼항을 새로 쓰면 두 히어로가 또 갈라진다 |
| `MONEY_DIRECTION_TEXT` | `src/lib/money-direction.ts` | 자금 **방향**(입금↓/지급↑) 색 — 실제 이체 **사건**, 양쪽 다 가치중립(P8). 텍스트맵/링맵 분리(대비 기준이 다름) |
| `resolveProfitTone` | `src/lib/profit-tone.ts` | 손익 **판정**(흑자/적자) 색 — 상쇄된 **결과값**의 부호(P8). 적자는 경고라 `status-urgent-text`. **`money-direction`과 다른 축 — 통합 금지** |
| `resolveAccess` · `resolveUserRole` · `isOperatorAllowedPath` | `src/lib/auth-allowlist.ts` · `src/lib/auth-roles.ts` | 인가 판정과 `operator` 접근 경계 SSOT(P0). 축이 둘이다 — **승인**은 `app_metadata.status`(`resolveAccess`: 오너 바닥 → approved/rejected → 없으면 대기), **역할**은 `app_metadata.role`(유효값일 때만) → 오너 바닥 → `operator` 순이다. 오너 조작 표면은 `/settings/accounts`. ⛔ **`user_metadata.role` 을 읽지 말 것** — 그 필드는 `supabase.auth.updateUser({ data })` 로 **사용자 본인이** 쓸 수 있어(공개 anon key + 본인 세션) 역할 출처로 쓰면 operator 가 콘솔 한 줄로 스스로 admin 이 되고 아래 화이트리스트 전체가 무의미해진다(리뷰에서 잡힌 실제 구멍, 착지 전 수정). `app_metadata` 는 `@supabase/auth-js` 타입이 "Only a service role can modify" 라고 못박은 필드다. 감시자는 `middleware-role-gate.test.ts` 의 자기 승격 차단 단언 — ⛔ 종전 기본값 `\|\| "admin"` 으로 되돌리지 말 것: 그러면 승인만 된 계정이 곧바로 **전체 권한**을 얻는다(운영자 2인은 오너 바닥이라 metadata 없이도 admin 을 유지하므로 되돌릴 이유가 없다). ⛔ 판정을 env 로 되돌리지 말 것 — `ALLOWED_LOGIN_EMAILS`·`ADMIN_LOGIN_EMAILS` 는 2026-08-08 에 삭제됐고, env 는 소스 상수를 **치환**해 오너가 잠기는 사고를 냈다. 판독기가 세 곳(`auth-context`·`middleware`·`user-registry`)이라 기본값이 서로 어긋난 이력이 있다 — 새 판독기를 쓰지 말고 이 함수를 부른다. **접근**은 화이트리스트다 — 블랙리스트로 뒤집으면 신규 라우트·페이지가 기본 공개가 되고, 이 레포는 라우트가 계속 늘어나므로 누락이 곧 침묵형 유출이다. 집행 지점은 `updateSession` 하나이고 라우트마다 복사하지 않는다(크론 인증 18사본 중 2건이 fail-open 이던 선례). 🪤 게이트가 `isPortalPublicPath` 를 제외 조건으로 두는데 그 판정은 **예약 슬러그가 아닌 한 세그먼트 경로를 전부 셀러 포털로 본다** — 앱 라우트가 `RESERVED_PORTAL_SLUGS` 에서 빠지면 operator 가 그 페이지를 렌더한다(API 가 403 이어도 서버 렌더 데이터는 이미 나간 뒤). 🪤 API 판정은 접두사가 아니라 **경로 세그먼트**다(`/order-converter/api/*` 도 라우트 핸들러라, 접두사로 보면 페이지 취급이 되어 fetch 가 307 을 따라간다). 역할 쿠키 `wag_crm_role` 은 **표시용이고 권한 경계가 아니다**(위조해도 자기 화면 메뉴만 바뀐다) — 서버 판정에 쓰지 말 것. 계약은 `middleware-role-gate.test.ts`(런타임 실행) · `auth-role-resolution.test.ts`(기본값 회귀) · `katalk-page-role.test.tsx`(화면단). 오너 절차는 `docs/runbooks/staff-upload-account.md` |
| `resolveOrderBrand` | `src/lib/order-converter/order-brand.ts` | 발주 브랜드 = 거래처 설정 |
| `RESERVED_PORTAL_SLUGS` | `src/lib/portal-slug.ts` | 최상위 라우트 예약(P7) |
| `StatusBadge` | `src/components/crm/status-badge.tsx` | 상태 색 정본(P8) — `ui/`가 아니라 `crm/`에 있다 |
| `useIsMobile` | `src/hooks/use-mobile.ts` | UA 기반 모바일 분기(P5) |
| `resolveImapHost` · `resolveSmtpConfig` · `orderMailboxesForScan` · `isOwnSenderAddress` | `src/lib/mail-config.ts` | 메일 서버 **좌표·발신인·편지함 순회 정책** SSOT. 소비처 셋(수취 계산서 스캔 · 송장 회신 · 발주 발송)이 같은 계정 자격증명을 공유하는데 호스트만 각자 리터럴로 박혀 있어, 계정을 옮기면 **한 곳을 빠뜨려도 타입도 테스트도 못 잡는** 상태였다(2026-09-01 구글 전환의 계기). ⚠️ 이 모듈에는 구글에서만 터지는 함정이 여럿이라 **표 아래 「메일 경로의 함정」 절을 반드시 함께 읽는다** — SNI · 자모 분리 이름 · 발신인 침묵 치환 · 편지함 제외 판정. 계약은 `mail-config.contract.test.ts`, 오너 절차는 `docs/runbooks/gmail-mail-cutover.md` |
| `toNfc` · `normalizeForCompare` | `src/lib/text-normalize.ts` | 외부에서 온 한국어 문자열을 **비교 전에** 맞추는 정규화 SSOT(메일 밖에서도 쓴다 — 회신 엑셀 파서). ⛔ 세 단계(NFC·공백 제거·소문자화)를 호출부에서 다시 적지 말 것. 사유는 아래 함정 절 ②. |
| `CRM_CACHE_LIFE` | `src/lib/cache-policy.ts` | 캐시 티어(next.config.ts `cacheLife`와 동기) |
| `ingestLaneGuard` · `assertServerLane` | `src/lib/kakao/ingest-lane.ts` | 인제스트 **레인 정합** SSOT(P0 인접) — "인증은 통과했는데 **상대가 틀린** 수집"을 막는다. 도입 계기는 **무증상 오배송**(2026-08-26): 셀프호스트 컷오버 뒤 **13일간** 카톡 업무기록이 운영 CRM 에 0건 들어왔고, 유실이 아니라 **은퇴한 구 배포 → 은퇴 DB** 로 쌓이고 있었다(launchd 수집 잡이 구 배포 URL 을 하드코딩, 그 배포가 살아서 200 을 돌려줬다). 🪤 **양쪽 다 정상으로 보인다** — 러너는 `uploaded=N / OK` + 종료코드 0, 운영 CRM 은 그냥 조용하다. 토큰도 스키마도 멱등도 전부 통과하므로 기존 방어선 어디에도 걸리지 않는다("카톡 기록이 안 보인다"를 UI 버그로 조사하면 영원히 못 찾는다). **방어가 두 방향인 것이 핵심이다**: ①서버가 러너의 선언(`x-ingest-lane`)을 **자기 정본 오리진**(`NEXT_PUBLIC_APP_URL`)과 대조해 어긋나면 쓰기 0 + 409 ②러너가 응답의 `lane` 필드 부재를 **낡은 배포의 지문**으로 보고 업로드 전에 중단. ⛔ **①만 넣지 말 것** — 이 사고의 상대는 정의상 낡은 코드를 돌고 있어 서버 검사가 원리적으로 도달하지 못한다(실효 방어는 ②다). ⛔ 서버 신원을 요청 `Host` 로 대체하지 말 것("부른 주소 vs 받은 주소"라 항상 일치 → 구 배포도 통과). **fail-closed 방향이 서버·러너 반대인 것도 의도다**: 서버가 fail-closed 면 env 한 줄이 비는 순간 프로덕션 수집이 통째로 막히고(같은 날 `INGEST_TOKEN` 공란으로 실제로 겪었다), 러너는 모르면 안 쓴다(막혀도 아카이브에 원본이 남아 커서 미전진으로 따라잡히지만, 모르는 채 쓰면 **어디 썼는지 모르는 데이터**가 생긴다 — 오너 확정 2026-08-26). ⚠️ 루프백(로컬 dev)은 체계 밖이다(dev 의 `NEXT_PUBLIC_APP_URL` 이 프로덕션 오리진이라 단언을 걸면 로컬 예행이 전부 409). 계약은 `ingest-lane.contract.test.ts`(행위 + **인제스트 계열 라우트 전수 소스 스캔** — 🪤 주석을 걷어내고 스캔한다) |
| `SELFHOST_ENV_CONTRACT` · `evaluateSelfhostEnv` | `scripts/selfhost-env-contract.ts` | 셀프호스트 프로덕션 `.env` 의 **키별 처분 선언** SSOT(P6·P0 인접) — `required`(배포 중단) · `degrades`(경고) · `optional`(조용히 통과) · `unused-here`(값이 있으면 경고). 도입 계기는 **무증상 정지**: 컷오버 때 구 플랫폼이 sensitive 값을 빈 문자열로 내려줘 남은 공란 중 하나(`INGEST_TOKEN`)가 카카오 인제스트 분단 사고의 두 번째 원인이었는데, fail-closed 라 수집이 전량 401 인데도 **러너가 레포 밖이라 CRM 에는 신호가 하나도 없었다**. ⛔ **일괄 필수화 금지** — 채우면 안 되는 키(`ENCRYPTION_KEY_PREVIOUS` 는 교체 런북이 제거를 지시)와 짝 중 하나만 채우는 키가 섞여 있다. 짝은 `satisfiedBy` 로 묶는다(`NAVER_CLIENT_SECRET` ↔ `…_BASE64` · `RAPIDAPI_KEY` ↔ `…KEYS` · `APIFY_API_TOKEN` ↔ `…TOKENS` · `GEMINI_API_KEY` ↔ `BACKUP_…`) — 안 묶으면 정상 상태가 전부 거짓 오류가 된다. 🪤 **집행 위치가 본질이다**: `scripts/check-env.ts` 는 `release:check` 안에서만 돌아 **개발 머신·CI 만** 보므로 이 파일을 원리적으로 못 본다. 그래서 별도 CLI(`scripts/check-selfhost-env.ts`, `npm run env:check:selfhost`)가 **파일을 직접 읽고** `infra/selfhost/deploy.sh` P0 안전장치 ③ 이 집행한다. ⛔ 크론으로 옮기지 말 것 — `applyDbInstagramToken()` 처럼 런타임에 `process.env` 를 덮어쓰는 경로가 있어 프로세스를 보면 파일이 비어도 초록이 나온다(거짓 성공). ⛔ 프로덕션 기준을 CI `check-env` 에 얹지 말 것(required 체크라 전 PR 이 막힌다). ⚠️ **`required` 를 늘리기 전에 실 `.env` 로 예행할 것.** 미분류 키는 **경고**이지 오류가 아니다(즉시 실패하는 점검기는 무시당한다 — `board:check` 의 「좌표 없는 항목」과 같은 판단). 계약은 `selfhost-env-contract.test.ts`(판정 + 표 위생 + `deploy.sh` 배선 **순서** — 🪤 셸 주석의 `npm run build` 언급이 먼저 잡혀 거짓 실패가 났다, 주석 줄을 걷어내고 센다) |
| `verifyCronAuth` · `verifyCronQuerySecret` | `src/lib/cron-auth.ts` | 크론·웹훅 **공유 시크릿 인증 SSOT**(P0). `/api/cron/*` 는 `src/proxy.ts` 세션 게이트에서 prefix 로 통째로 면제되므로(크론에 세션이 없다) **핸들러의 이 검사가 유일한 인증**이다. ⚠️ **Next 16 은 `middleware.ts` 를 `proxy.ts` 로 개명했다** — "middleware.ts 가 없으니 게이트가 없다"는 오독이 이 모듈이 생긴 계기다(게이트는 있었고, 비인증 요청은 라우트 도달 전 307 된다). 계약은 **fail-closed**: `CRON_SECRET` 미설정이면 **아무도** 통과하지 못한다. 종전에는 이 검사가 18개 라우트에 손으로 복사돼 있었고 실제로 갈라졌다(2026-08-04 감사) — 2건이 `if (CRON_SECRET && …)` / `if (!CRON_SECRET) return true` 형태의 **fail-open** 이었고(비인증 GET 200 실측), 나머지 16건도 미설정 시 기대값이 리터럴 `"Bearer undefined"` 라 그 문자열로 통과할 수 있었다. 비교는 상수 시간(`timingSafeEqual`) — 원격에서 반복 호출 가능한 표면이라 조기 종료가 오라클이 된다. ⛔ 새 크론에 쿼리형(`verifyCronQuerySecret`)을 쓰지 말 것 — 쿼리 문자열은 액세스 로그·리퍼러에 남는다. 그 함수는 **헤더를 붙일 수 없는 외부 웹훅**(Apify 웹훅 설정은 URL 만 받는다) 전용이다. 시크릿을 **행사**하는 `/api/system/cron-run`(레이더 수동 실행)은 검증자가 아니라 호출자라 예외다. 사본 재발·면제 라우트의 가드 누락은 `api-route-auth-coverage.contract.test.ts` 가 소스 전수 스캔으로 막고, fail-closed 동작은 `cron-auth.test.ts`(예시)와 `cron-auth.property.test.ts`(프로퍼티)가 고정한다. 🪤 **그 스캔 범위를 `route.ts` 로 좁히지 말 것** — 초판이 그랬다가 ①인증을 자체 재구현해 **프로덕션을 import 하지 않던 테스트**(라우트가 fail-open 인 동안에도 초록불이라 거짓 신호를 냈다)와 ②`system-task-status.ts` 의 **19번째 사본**(기록 게이트용 비교)을 둘 다 놓쳤다. 현재 스캔은 `src/app/api` + `src/lib` 전체이며 판정 기준은 "`process.env.CRON_SECRET` 을 읽으면서 authorization 헤더를 **읽는다**"(= 검증자 형태)다 — 헤더를 **보내기만** 하는 호출자(`system/cron-run`·OAuth 콜백)와 env 를 세팅만 하는 테스트 셋업은 걸리지 않는다 |
| `KNOWN_JOBS` | `src/lib/cron-jobs.ts` | 크론 잡 명세 — 레이더 표시 + 수동 실행 허용 목록 파생(P6, 계약 테스트로 라우트·스케줄 동기 강제) |
| `INSTAGRAM_SNAPSHOT_SOURCE` | `src/lib/collectors/instagram-collector.ts` | 팔로워 크론 스냅샷 출처 라벨 — **실행 경로의 사실**(모드 문자열 아님, P7). 스크래퍼/Graph 폴백이 서로 다른 라벨을 받는다 |
| `YOUTUBE_SNAPSHOT_SOURCE` | `src/lib/collectors/youtube-collector.ts` | 유튜브판 같은 규약(P7) — `MOCK`(인스타와 **같은 문자열**) · `YOUTUBE_API` · `APIFY_API`. 종전 `${mode.toUpperCase()}_API` 파생은 `=instagram` 일 때 인스타 Graph 라벨과 충돌했다. Apify 갈래의 실제 writer 는 웹훅(`api/cron/apify-webhook/youtube`)이라 그쪽이 이 상수를 import 한다 — 문자열을 다시 손으로 적지 말 것 |
| `classifyGraphBdFailure` | `src/lib/instagram-graph-error.ts` | Meta Graph `business_discovery` 실패의 **폴백 판정**(P7) — 계정별(개인계정→유료 Apify 폴백) vs 전역(토큰·한도·장애→폴백 금지). HTTP 상태만 보는 분기를 새로 쓰면 토큰 만료가 개인계정으로 오인돼 전 셀러에서 유료 호출이 샌다. 실패는 `recordGraphBdFailure`가 `ApiCallLog` 1행으로 영속 |
| `fetchAllProductOrderPages` | `src/lib/order-converter/product-order-paging.ts` | `GET /v1/pay-order/seller/product-orders` 의 **페이징 SSOT**(P7) — `page` 파라미터를 따라가 한 창의 전 페이지를 모은다. 종전 5곳 전부가 `page` 를 안 보내 창당 300건 초과분을 유실했다(스냅샷 빌더 포함). 이 엔드포인트를 직접 `apiRequest` 로 부르지 말 것. `rangeType`(창의 날짜 술어)은 **호출부가 정하고, 현행 4곳은 전부 `PAYED_DATETIME` 을 명시한다**(발주서 경로 = 1단계 PR #162, 스냅샷 경로 3곳 = 2단계). 기본값도 `PAYED_DATETIME` 임이 프로덕션 실측으로 확정돼 두 단계 모두 동작 변화 0이었다 — 명시하는 이유는 네이버가 기본값을 바꿔도 "조회 창 술어 == 스냅샷의 `paymentDate` 귀속" 전제가 조용히 깨지지 않게 하는 것이다. 새 호출부의 술어 누락은 **침묵형 회귀**라 `product-order-range-type.contract.test.ts` 가 전수 스캔 + 실쿼리 mock 으로 막는다 |
| `fetchPendingOrderWindow` | `src/lib/order-converter/order-fetch-window.ts` | 발주 대상 조회의 창·청크·생략 판정 SSOT(P7) — 주문확인·발주요청 공용. KST 자정 정렬 · `resolveCampaignQueryStartMs` 로 창 시작 · 스냅샷 `newOrdersCount` 근거 생략(4조건) · 스냅샷 대조 온전성 검사 · pageSize 절단 의심 시 창 이분. 라우트에 조회 루프를 다시 복사하면 두 발주서가 또 갈라진다 |
| `recordNaverOperationUsage` | `src/lib/order-converter/naver-api-usage.ts` | 네이버 호출 계측 — 오퍼레이션 요약 1행 + 실패 1행(P7). 조회 범위 최적화의 전후 비교 지표(`logicalCalls`/`skipped`)가 여기서 나온다. **성공한 개별 호출은 남기지 않는다**(ApiCallLog top-20 창을 점거해 Meta 증빙 페이지를 죽인다). tally 전달은 `runWithNaverCallTally`(AsyncLocalStorage) — `apiRequest` 시그니처에 인자를 늘리면 호출부 누락으로 구멍이 난다 |
| `recordApifyCommentUsage` | `src/lib/seller-analysis/apify-comment-usage.ts` | 유료 댓글 수집 지출 계측 — `ApiCallLog` 기록·단가·토큰 지문(P7). 월별 집계는 `…-report.ts`, 조회는 `npm run report:apify-comments` |
| `checkText` | `src/lib/claims/claim-gate.ts` | 광고 표현 컴플라이언스 판정(C1 M1) — 금지 표현 매칭 + 필수 고지 확인. **순수 함수**(Prisma 무의존, 규칙은 주입)라 서버·클라 공용. 화면마다 정규식을 새로 쓰면 판정이 갈라진다. 사전 정본은 `banned-phrase-seed.ts`, 판정 계약은 `claim-gate.contract.test.ts`가 고정(severity 완화·검출 축소는 오너 승인 사안). ⚠️ **사전 파일을 고치는 것만으로는 판정이 바뀌지 않는다** — 화면·라우트는 `BannedPhraseRule` **DB 행**을 읽는다. 프로덕션 반영은 `scripts/seed-banned-phrases.ts --sync`(예행 기본, `--apply`는 오너 승인 사안)이고 동기화 키는 `phrase`다(`category`는 이관 대상이라 키가 못 된다). `severity`는 운영자 승격 보존을 위해 덮어쓰지 않고, 비활성 행은 되살리지 않는다 |
| `loadDealClaimContext` | `src/lib/claims/deal-claim-context.ts` | 게이트·생성기에 넣을 **딜 클레임·카테고리**를 결정. 옵션 딜은 부모 클레임을 **합집합**으로 상속하고 카테고리는 자기 값 우선(C1 §4). 이 규약이 claims 라우트에만 인라인으로 있어서 content-guide 라우트가 손으로 다시 쓰다 **실제로 갈라졌다**(부모 치환 → 옵션 딜의 자기 전용 금지 표현이 게이트에서 무시 · 부모 카테고리 우선 → 옵션 지정 카테고리가 덮임). ⚠️ C2 오퍼 진단의 `parentDealId ?? id`(부모 **치환**)와 **다른 규약이다** — 오퍼는 본품 단위로 성립하지만 표현 제약은 누적된다. **통일 금지.** 짝 함수 `toGateClaims`·`selectPromptClaims`는 **APPROVED만** 통과시킨다(PROPOSED를 넣으면 AI 추출 미검수 표현이 승인처럼 취급된다). 서버 전용(Prisma) — 판정은 `checkText`. 계약은 `deal-claim-context.contract.test.ts`(호출부가 상속을 재구현하는지 소스 스캔) |
| `VERBALIZED`·`EFFICACY`·`PARTICLE` | `src/lib/claims/banned-phrase-seed.ts` | 금지 표현 정규식의 **활용형·조사 흡수 조각**. 게이트는 형태소 분석을 하지 않으므로 어미·조사를 규칙마다 손으로 열거하면 **같은 취지의 규칙끼리 검출력이 갈린다** — 실측 2회: ①`(치료\|완치\|예방)(에\|해\|합니다\|됩니다\|효과)`가 "완치시켜"·"완치 사례"를 통과시켰고 ②이를 고친 초판 `EFFICACY`가 `에\s*(?:좋\|도움)`으로 **조사 뒤 단어를 다시 열거**해 "치료에 효과가 있다"를 놓쳤다. 규칙 안에 어미·조사를 새로 열거하지 말고 이 조각을 조합한다. 명사 단독을 잡지 않는 것은 **의도**다(법정 면책 "질병의 예방 및 치료를 위한 의약품이 아닙니다"가 오탐이 되면 게이트가 무시당한다) |
| `ensureCampaignTrackedLink` | `src/lib/short-link.ts` | 유입추적 단축링크(`go.ygrd.kr/{code}`) 발급·집계 SSOT. **캠페인당 1개 멱등** — 재발급하면 셀러가 이미 게시물에 박은 링크의 통계가 갈라진다(목적지가 바뀌면 코드는 두고 `targetUrl` 만 수정). 집계(`getLinkStats`)는 봇을 기본 제외하고 일자를 **KST** 로 가른다(`visitorHash` 에 KST 날짜가 섞여 있어 UTC 로 자르면 일별 순방문자 합이 총계와 어긋난다). ⚠️ `getCampaignFunnel` 의 분자는 주문 **건수**가 아니라 판매 **수량**이다(P7 Order-Count Vocabulary — 그래서 필드명이 `quantityPerVisitor` 다. `conversionRate` 로 되돌리지 말 것). 리다이렉트 경로는 이 레포가 아니라 `ygrd-link/` Worker 소관. 만료는 **KST 종료일 다음날 00:00**(`resolveLinkExpiry`)이고, 캠페인 종료일이 바뀌면 PATCH 트랜잭션이 팬아웃·본 update **뒤**에 `syncCampaignLinkExpiry` 로 그룹 형제 링크까지 다시 계산한다 — ⛔ 밀리초 덧셈(`+30일`)으로 되돌리지 말 것(종료일의 시각 성분 때문에 같은 규칙이 28일·30일로 갈렸다) · ⛔ 계산을 SQL 로 옮기지 말 것(소급 스크립트 `backfill-tracked-link-expiry.ts` 도 같은 함수를 쓴다) · ⛔ `isActive` 를 섞지 말 것(만료=시간 축, 수동 중단=스위치 축이고 Worker 가 둘을 OR 로 본다). 순서 계약은 `linkExpiryFollowsCampaign.contract.test.ts` · ⚠️ 소급 스크립트(`backfill-tracked-link-expiry.ts`) 실행 전까지 **기존 링크 행은 옛 값(+30일)** 그대로다 — 신규 발급과 종료일이 바뀐 캠페인만 새 규칙을 탄다. |
| `GEMINI_PRIMARY_MODEL` | `src/lib/gemini-model.ts` | Gemini 주모델·thinking 티어 SSOT. 모델 ID를 호출부에 하드코딩하면 또 표류(2.5/3.5 혼재)한다. 폴백 사다리 rung은 각 호출부가 유지 |
| `recordGeminiFailure` | `src/lib/agent/gemini-usage.ts` | Gemini **종국 실패** 계측 — `ApiCallLog` 1행(P7). **성공에는 부르지 않는다**: `dashboard-data.ts` 가 provider 무관 `take: 20` 으로 읽어 Meta 증빙 표를 채우므로 고볼륨 행(어시스턴트·콘텐츠 가이드 레이싱 2발)이 상위 20을 점거하면 Instagram 행이 사라진다(NAVER 계측이 밟은 함정과 동일). 도입 계기는 **무증상 장애** — 프로젝트 월 지출 상한 초과로 전 Gemini 표면이 429 로 죽었는데 `ApiCallLog` 에 Gemini 행이 0건이라 아무 신호가 없었다(2026-08-01 실측). ⚠️ 키를 저장하지 않는다(P0, 레포 public) — `endpoint` 는 쿼리 없는 라벨, 키는 지문만, 오류 본문은 `redactGeminiSecrets` 통과. 429 의 `spendCapSuspected` 는 "일시 폭주"와 "예산 소진"을 가른다. 상한은 **키가 아니라 프로젝트 단위**라 같은 프로젝트 키를 돌리는 건 소용없지만 **다른 계정 키를 풀에 넣으면 로테이션이 우회한다** — 그래서 `lastKeyFingerprint`("죽은 게 어느 키인가")가 이 계측의 핵심 필드다. 🪤 키가 1개면 로테이션은 돌지 않는다(실측: 로컬 `.env` 는 1개뿐이라 3회가 같은 키를 쳤고, 그걸 전면 장애로 오독했다 — 프로덕션은 Vercel env 라 구성이 다를 수 있다). 계약은 `gemini-usage.contract.test.ts` |
| `truncateToHometaxBytes` · `HOMETAX_TEXT_MAX_BYTES` | `src/lib/hometax-text.ts` | 홈택스 자유 텍스트 칸의 **바이트 상한**(100byte) SSOT — 세금계산서 품목명·품목 비고가 공유한다. 🪤 **글자 수로 자르지 말 것**: 홈택스는 바이트로 검증하는데 종전 캡이 `length <= 200`(글자 수)이라, 한글 200자(=600byte)가 캡을 통과한 뒤 **오너가 발급 버튼을 누르는 순간** 화면 상단 100byte 오류로 거부됐다(T-025, 오너 실측 2026-08-08 — 그전까지 이 상한은 "확인하지 못한 추정치"로 코드에 적혀 있었다). ⚠️ 오류 문구가 **어느 칸을 가리키는지는 갈리지 않았으므로** 우리가 채우는 자유 텍스트 칸 전부에 같은 캡을 건다 — 한 칸만 고치면 다음 칸이 같은 이유로 튕길 때 원인 추적을 처음부터 다시 한다. 인코딩은 **UTF-8(한글 3byte)로 보수적으로** 센다: 상대가 EUC-KR 기준이어도 안전하고, 반대로 잡으면 그대로 거부당한다(틀렸을 때의 대가가 비대칭). 자르기는 코드포인트 단위이고(바이트 절단은 깨진 문자·쪼개진 이모지를 남긴다) 잘린 사실은 반드시 표시한다 — 조용히 자르면 오너가 그 값을 전체 내역으로 오독한다. 캡은 XLSX·TSV·헬퍼 세 경로가 공유하는 빌더에 걸려 포맷별로 다른 계산서가 나오지 않는다. 계약은 `hometax-text.test.ts` |
| `cutSketchKey` · `SKETCH_STYLE_LOCK` | `src/lib/guide-sketch.ts` | 촬영 컷 시안 SSOT(P7). **스타일 락**이 "촬영 지시서 스케치"와 "제품 사진"을 가르는 **유일한 장치**다 — 흑백 선화·구도 전용, 글자·로고·식별 가능한 얼굴·지어낸 제품 디테일 금지, 프롬프트 **맨 앞**에 둬 뒤 문장이 못 덮게 한다. 완화는 오너 승인 사안. **캐시 키는 자리+피사체만** 해시한다 — `why`(카피)나 `no`(번호)를 넣으면 문구만 다듬거나 순서만 바꿔도 이미지 비용이 나간다(재생성 비용 0의 근거가 이 정의다). 폭주 차단은 `MAX_SKETCHES_PER_GUIDE` 한 곳이고 **새로 그리는 것에만** 건다. 호출은 `agent/gemini-image.ts` — ⚠️ **엔드포인트가 텍스트와 다르다**(`/v1beta/interactions`, SDK `interactions.create`)라 계측도 `surface` 축으로 가른다. 🪤 규격은 SDK 타입이 정본: `image_size` 는 **`"512"`** 이지 `"512px"` 가 아니다(웹 검색이 틀렸고 `node_modules/@google/genai` 타입이 정정했다). 계약은 `guide-sketch.contract.test.ts` · `gemini-image.test.ts` |

| `sortStatementCampaigns` · `buildSettlementStatementFileName` | `src/lib/settlement-statement.ts` | 정산 명세서의 **표시 순서**와 **이미지 파일명** SSOT. 이 파일은 "정본 함수는 있는데 호출부가 한 조각을 손으로 다시 만든다"를 세 번 겪었다 — ①상세 패널의 자체 SVG(자사 마진 유출, P0) ②자체 평문 빌더 ③T-023 의 **파일명**(목록은 `정산명세서_{수신자}_{날짜}.png`, 상세는 `settlement-{id}.png` — 셀러에게 내부 식별자가 갔다). 순서도 같은 부류였다: 묶음 명세서가 호출부 배열(정산표의 현재 정렬) 그대로 렌더돼 같은 묶음이 매번 다른 차례로 나갔고, **문서번호까지 그 순서에서 파생**돼 같은 선택인데 번호가 달라졌다. ⛔ 호출부에서 정렬하거나 파일명을 조립하지 말 것. 캠페인은 진행 기간 오름차순(미입력은 **뒤로** — 빈 문자열을 그대로 비교하면 미입력이 맨 앞으로 올라와 "가장 먼저 진행한 건"으로 읽힌다), 품목은 `getStatementDeals` 가 이름순으로 접는다(🪤 Prisma 의 `campaignDeals` include 에 `orderBy` 가 없어 **DB 순서는 정의되지 않았다** — 캠페인을 수정하면 같은 명세서가 다시 뽑을 때 품목 순서가 바뀐다). 금액 소비처는 전부 합산이라 순서 무관이다. 계약은 `settlement-statement-order.test.ts`(행위) · `settlement-statement-surface-parity.contract.test.ts`(표면 전수 소스 스캔 — ⚠️ 스캔 대상에서 **주석을 걷어낸다**: 이 계약의 경고문 자체가 금지 문자열을 인용해 자기 자신을 위반으로 잡았다) |

| `STMT_DEDUCTION_TEXT` | `src/lib/settlement-statement.ts` | 명세서에서 **유일한 유채색 텍스트**(원천세 차감액)의 색 SSOT(T-027). 종전 `#ef4444` 는 흰 배경 **3.76:1** 로 AA 본문(4.5)에 미달했다 — 10px 글자이고 셀러가 "내 지급액에서 얼마가 빠졌나"를 확인하는 숫자라 흐리면 안 되는 자리다. 🪤 **이 항목이 P8 §5「토큰은 표면 종속」의 교과서적 사례다**: 의미상 맞는 앱 토큰 `--money-out`(#E11D48 — 지급·차감은 경고가 아니라 정상 사실, `money-direction.ts` 가 그 경계를 소유)이 흰 배경 4.70 으로 통과하고도 **소계 행 틴트 `#f8fafc` 에서 4.49 로 미달**해 채택할 수 없었다(`--status-urgent` #BF5050 도 4.48 로 동일하게 탈락). 그래서 규칙대로 대비를 직접 계산해 같은 계열 한 단계 아래 `#be123c`(6.29 / 6.01)를 쓴다 — 색상 계열을 유지해 앱의 money-out 과 시각적으로 이어진다. ⚠️ **이 문서는 CSS 변수를 쓸 수 없다**(메일 본문에 `:root` 가 안 따라가 색이 죽는다) — 그래서 리터럴이고, 대비는 사람이 계산해 주석에 남긴다. 같은 패스에서 11px 보조 주석 `#94a3b8`(2.56:1)도 문서가 이미 쓰는 `#64748b`(4.76)로 낮췄다(신규 색 아님). 계약은 `settlement-statement-contrast.contract.test.ts` — ⛔ **색 리터럴을 고정하지 말 것**: 그 테스트는 출력 HTML 에서 색을 뽑아 **두 배경 모두에서 대비를 매번 다시 계산**한다(지켜야 하는 건 특정 색이 아니라 읽힌다는 성질이다). 양성 프로브 확인됨 — `#ef4444` 로 되돌리면 실측치와 함께 실패한다 |
| `STMT_NAME_CELL` · `STMT_NUM_CELL` · `stmtHeadCell` | `src/lib/settlement-statement.ts` | 명세서 품목 표의 **줄바꿈·정렬·열 너비 SSOT**(T-024). 개인(원천세)·법인(부가세) 두 표가 같은 8열 뼈대를 **인라인 스타일로 각자** 갖고 있어 한쪽만 고치면 즉시 갈라진다. ⚠️ **인라인인 것은 제약이지 게으름이 아니다** — 이 조각은 메일 본문으로 붙여넣어지고 메일 클라이언트가 `<style>`·class 를 떼어내므로, class 로 옮기면 셀러가 받는 문서에서 서식이 통째로 사라진다. **줄바꿈:** ⛔ `word-break: break-all` 로 되돌리지 말 것 — 그 값이 `그립형 20000` 을 **숫자 한가운데서** `2000`/`0` 으로 갈라 셀러가 다른 모델로 읽을 수 있었다(오너 신고 캡처). 처방은 `keep-all`(어절 단위로 넘김) + `overflow-wrap: anywhere`(토큰 하나가 열보다 길 때만 최후수단, 없으면 긴 SKU 가 표를 밀어낸다) **+ 품목명 열 26%→34%**(대부분 SKU 가 애초에 한 줄에 들어간다). **정렬 축은 헤더와 본문이 서로 다르고 그것이 의도다**(오너 확정 2026-08-10 · 국세청 별지 세금계산서 서식과 실무 ERP 관행 확인): 헤더는 **전 열 가운데**(열 이름표 띠), 본문은 품목명 좌 · 수수료율 가운데 · **금액·수량 우측**(자릿수를 세로로 맞춰야 셀러가 소계와 대조한다 — ⛔ 금액 가운데 정렬 금지). 🪤 초판은 "헤더도 본문 축을 따른다"였고 그 근거(헤더 우측 끝과 숫자 우측 끝이 한 세로선)는 **웹 데이터 테이블 관례이지 국내 명세서 관례가 아니었다** — 오너가 뒤집었다. **상하 정렬은 명시 선언한다**(`vertical-align: middle`): 브라우저·html2canvas 실측으로는 기본값이 이미 middle 이지만(오프셋 1.0px 로 두 경로 일치) 그건 선언이 아니라 UA 기본값 의존이고, 셀러가 어느 렌더러로 열지 우리가 못 고른다. 계약은 `settlement-statement-table-style.contract.test.ts`(출력 HTML 검사 — 🪤 `<th[^>]*>` 는 `<thead>` 도 물고, `indexOf("품목명")` 으로 자르면 첫 헤더 셀이 통째로 잘려 나가 엉뚱한 열을 검사한다. 둘 다 초판이 밟았다) |

## 메일 경로의 함정 — 구글에서만 터지는 것들 (2026-09-02 실사고)

> 위 Code SSOT 표의 `resolveImapHost`·`toNfc` 행이 이 절을 가리킨다. 전부 **다음메일에서는
> 드러나지 않다가** 구글로 옮기는 순간 터진 종류이고, 증상이 모두 **조용한 0건**이다.
> 배포 전 실계정 점검에서 잡았지만, 그 사이 결함 버전이 배포돼 프로덕션 메일 수신이
> 한동안 중단됐다.

### ① SNI 누락 — 수신 2경로가 동시에 죽는다

`node-imap` 은 평문 소켓을 먼저 열고 그 소켓을 `tls.connect({ host, socket })` 에 넘기는데,
**소켓을 넘기면 Node 가 `host` 에서 SNI 를 유추하지 않는다.** 없으면 구글이 이 도메인용이
아닌 인증서를 내주고 `self-signed certificate` 로 끊긴다. 대조군 실측: `imap.daum.net` 은
SNI 유무와 무관하게 붙는다(단일 인증서 호스트).

⛔ `resolveImapConfig` 의 `tlsOptions.servername` 을 지우지 말 것. 계약은 **`servername: host`
대입**을 본다 — 🪤 `tlsOptions: { servername` 으로 재면 **타입 선언에도 걸려** 실제 대입을
지워도 초록이다(변이 테스트로 실측). 발신(nodemailer)은 스스로 SNI 를 넣으므로 무관하다.

### ①-b 소비처에 호스트를 다시 적지 말 것

접속 좌표는 `mail-config.ts` **한 곳**에만 둔다. 소비처 셋(`tax-invoice-mail/mail-scan.ts` ·
`order-converter/api/fetch-emails` · `order-converter/api/send-email`)이 같은 자격증명을
공유하므로, 호스트를 각자 적으면 계정을 옮길 때 **한 곳을 빠뜨려도 타입도 테스트도 못 잡는다**
— 그 기능만 옛 서버에 새 자격증명으로 붙어 인증 실패한다.

계약(`mail-config.contract.test.ts`)이 지키는 것:
- `src`·`scripts` **전수**에서 SSOT 밖의 메일 호스트 리터럴 0건(문자열 리터럴 안만 본다 —
  🪤 소스 전체에 정규식을 돌리면 `imap.seq.fetch(…)` 같은 **속성 체인**이 걸린다).
- `imaps.connect(…)`·`new Imap(…)` 으로 붙는 곳은 `resolveImapConfig` 를 **거친다** — connect
  인자가 SSOT 호출에서 온 것인지를 **AST 로** 본다. ⚠️ 「전부」가 아니다: 구조분해로 떼어낸
  `const { connect } = imaps` 형태는 탐지 밖이다(맨 `connect(` 를 다 물면 무관한 호출이 섞인다). ⛔ 정규식으로 되돌리지 말 것: 이 계약은 정규식으로 세 번
  뚫렸다(①`resolveImapConfig` 를 언급만 해도 통과 ②`port`·`tls` 키 부재로 재니 정작
  `tlsOptions:` 가 안 걸려 거짓 음성 ③`g` 플래그 누락으로 **파일당 첫 connect 만** 검사).
  지금은 스프레드 덮어쓰기·변수 호이스트·파일 내 둘째 호출·`new Imap(` 네 형태를 잡는다(변이 확인).
- 🪤 **주석을 걷어내고 스캔한다** — 이 트랙의 문서가 옛·새 서버 이름을 **설명하려고** 인용해서,
  원문 그대로 스캔하면 계약이 **자기 주석에 걸려** 영구히 빨간불이 된다(레포 선례 다수).
  단 `//` 앞의 `:` 는 지킨다 — 가드 없이 자르면 `"imaps://imap.example.net"` 같은 URL 형태
  설정이 통째로 잘려 이번엔 반대로 **위반이 사라진다**.
- 🪤 「없음」 단언에는 **양성 프로브**를 짝지운다 — 스캐너가 고장 나도 초록이기 때문이다.

### ② 자모 분리(NFD) — 조용히 INBOX 로 폴백한다

구글은 한글 편지함·라벨 이름을 **NFD** 로 돌려준다(`세금계산서` 가 코드포인트 12개 vs 조합형
5개). 정확 일치도 부분 일치도 실패해 `pickTaxInvoiceBox` 가 `INBOX` 로 떨어지고, 라벨 규칙에
「받은편지함 건너뛰기」가 걸려 있으면 **스캔이 0건**인데 화면에는 「메일 미발견」으로 보여
미수취와 구분되지 않는다.

⚠️ **편지함 이름만의 문제가 아니다** — 제목·첨부 파일명·**회신 엑셀의 헤더와 셀 값**이 같은
축이고, 그쪽은 형태를 **보낸 사람**이 정해서(맥에서 만든 파일은 NFD 가 상시) 실측으로 미리
못 거른다. 정규화는 `text-normalize` 가 소유하고 **비교만 정규화하고 반환은 서버 원문**을
유지한다(`openBox` 는 서버 어휘로 열어야 한다). 우리 소스 리터럴은 NFC 로 커밋한다는 전제도
계약이 고정한다.

### ③ 발신인 침묵 치환

`SMTP_FROM_EMAIL` 의 주소를 구글 계정에 **발신 주소로 등록·인증**하지 않으면, 오류가 아니라
**로그인 계정 주소로 조용히 바뀌어** 나간다(로그는 성공, 브랜드사 화면에서만 드러난다).
`isOwnSenderAddress` 가 로그인 계정 주소도 함께 보는 이유이고(안 보면 우리가 보낸 발주서
원본이 회신으로 오인된다), env 표에서 `SMTP_FROM_EMAIL` 이 `degrades` 인 이유다.
⚠️ 부분 문자열로 비교하지 말 것 — 거래처 `mytest@…` 가 로그인 `test@…` 를 포함해 **정상
회신이 폐기**된다. 주소를 뽑아 정확히 비교하고 꺾쇠는 **마지막** 것을 집는다(RFC 5322).

### ③-b 자격 증명은 앱 비밀번호다 — OAuth 를 다시 제안하지 말 것

구글은 2025-03-14 부로 일반 비밀번호의 IMAP·SMTP 접속을 차단했다. `SMTP_PASS` 에 들어가는
것은 2단계 인증을 켠 계정에서 발급한 **앱 비밀번호**다.

⛔ **OAuth 로 바꾸자는 제안은 이미 기각됐다**(2026-09-01) — 메일함 전체 접근
(`https://mail.google.com/`)은 구글의 **제한 범위 스코프**라 별도 **CASA 보안 감사**가 붙고,
이 작업 규모에 비해 과하다는 것이 기각 사유다. ⚠️ 구체적 비용·기간은 이 레포가 실측한 값이
아니므로 적지 않는다 — 다시 제안하려면 그때의 공식 문서로 직접 확인할 것.

### ④ 서버는 계정 주소에서 파생한다 — 상수로 되돌리지 말 것

셀프호스트는 `main` 을 pull 해 배포하므로, 구글을 무조건 기본으로 두면 오너가 `.env` 를
바꾸기 **전에** 배포가 도는 순간 옛 자격증명이 구글로 가서 수신 2경로·발신 1경로가 **동시에**
죽는다(env 점검기는 「비었는가」만 보므로 원리적으로 못 잡는다). 옛 사업자 폴백의 존속은
계약이 **있어야 통과**하는 방향으로 고정한다.

### ⑤ 편지함 제외는 두 겹이다

종전 인라인 목록은 다음메일의 **띄어쓴** 한국어 이름(`지운 편지함`)만 알아서 구글의
`휴지통`·`보낸편지함`·`전체보관함`·`중요편지함`이 하나도 안 걸렸다(전체보관함·중요는 다른 폴더의
사본이라 같은 메일을 두 번 훑는다). 판정은 ①IMAP 특수용도 속성 ②공백을 걷어낸 이름 폴백.
ℹ️ **`전체보관함`은 제외가 아니라 맨 뒤로 미룬다** — 읽고 보관한 회신은 거기에만 남으므로
빼면 영영 「회신 없음」이 되고, 호출부가 첫 발견에서 멈추므로 앞에서 찾으면 비용이 0 이다.

## ⚠️ PR 번호는 레포를 가려서 읽는다 — 겹은 둘이 아니라 **셋**이다 (실사고 2026-07-31·2026-08-29)

이 레포는 **두 번** 이관됐다: `indexzigu/wag-crm` → (2026-07-16) `indexzigu/wagcrm` →
(2026-08-28) `indexzigu/wagcrm_git`. 매번 이력을 공유하지 않고 재출발해 **PR 번호가
#1 부터 다시 시작**했으므로, 같은 번호가 최대 세 작업을 가리킨다 — 실측된 충돌:

| 번호 | 최초 (`wag-crm`) | 2번째 (`wagcrm`) |
| --- | --- | --- |
| #187 | `6e0f5b4` docs(agents) 색 사용처 | `5725dd2` fix(claims) 채택분 출처 배선 |
| #188 | `4e67fe6` fix(auth) 로그인 safe-area | `e9ca4bb` fix(claims) 모델명 출처 |

**어느 레포인지는 참조 시점으로 가른다:** 2026-07-16 이전 = `wag-crm` · 07-16~08-28 =
`wagcrm` · 08-28 이후 = 현행 `wagcrm_git`. 구 레포 둘 다 비공개로 살아 있어 오너 권한
`gh pr view <N> -R <슬러그>` 로 제목·생성시각을 대조할 수 있다(읽기 전용 아카이브).

**증상 ⓐ 사람 쪽:** 보드·핸드오프의 맨 `#188` 을 오늘 번호로 읽어 "이미 착지한 작업"에
재착수 지시가 나가거나, 반대로 진행 중인 작업을 완료로 오판한다. 2026-07-31 에 실제로
보드 한 줄이 두 작업을 동시에 가리키는 상태로 발견됐다.

**증상 ⓑ 기계 쪽 — 상시 빨강이 진짜 드리프트를 삼킨다(2026-08-29):** `npm run board:check`
가 드리프트 **26건**을 냈는데 전부 같은 사유(`PR 을 조회할 수 없다`)였고 **진짜 드리프트는
0건**이었다. 보드가 참조하는 26건이 전부 2번째 레포 번호인데 점검기는 현행 레포에서만
조회했기 때문이다. 늘 빨강인 점검기는 곧 안 보게 되고, **그 학습이 진짜 드리프트까지
삼킨다** — 그건 이 점검기가 애초에 막으려던 사고다(2026-07-29: 보드 참조 PR 42건이 전부
MERGED 인데 대기 마커 16건이 남아 완료된 작업에 재착수 지시가 나갔다).

**규약 — 구 레포 번호를 쓸 때는 반드시 한정한다:** `구레포#188(4e67fe6)` 처럼 레포와
커밋 해시를 같이 적는다. 현 레포 번호는 맨 `#NN` 으로 둔다.

🔑 **다만 실보드는 그보다 강한 것을 이미 쓰고 있고, 기계는 그쪽을 읽는다.** 실측
2026-08-29 기준 보드의 PR 링크 **83건 전부**가 `github.com/<owner>/<repo>/pull/N` 풀 URL
이고 슬러그가 100% 균일했다 — 즉 레포 식별 정보가 이미 보드 안에 있다. 그래서
`scripts/board-drift-check.mjs` 는 **링크의 슬러그로 레포를 갈라** 각 레포에서 조회하고,
구 레포 항목은 `LEGACY_ARCHIVED`(드리프트 아님)로 접는다. **보드 26줄을 손으로 고치지
않는다** — 보드는 git 미추적·다세션 공유 파일이라 되돌릴 이력이 없고, 26회 치환은 그
자체가 P0 위험이다(2026-07-30 덮어쓰기 실사고). 판정 계약은
`scripts/__tests__/board-drift-check.test.ts` 의 (F)(G)(H) 절.

⚠️ **구 레포에서도 낡은 대기 마커는 계속 잡는다.** 조용하게 만드는 것과 탐지력을 끄는
것은 다르다 — 머지 여부는 아카이브 조회로 판정 가능하고, "완료된 작업에 재착수" 사고는
레포와 무관하게 사고다.

🪤 **구 레포 번호는 해시로 검증되지 않는다.** 이관이 이력을 재작성해 구 커밋은 현
`origin/main` 의 조상이 **아니다**(`git merge-base --is-ancestor` 가 항상 거짓, 잔존
로컬 브랜치에만 남아 있다). 그래서 "그 수정이 prod 에 있나"는 해시가 아니라 **코드 존속**
으로 확인한다 — `git show origin/main:<파일> | grep <핵심 문자열>`. 해시로 찾다가
"유실됐다"고 오판하지 말 것(실제 사례: safe-area 수정은 해시만 갈렸고 코드는 존속했다).
⛔ 종전 서술의 `origin/release` 는 **SUPERSEDED** — 2026-08-13 셀프호스팅 컷오버로 그
브랜치는 구 플랫폼 롤백 창구로만 남았고 현행 레포에는 아예 없다(배포 판정 정본은
셀프호스트 배포 마커다 — `deployMarkerPath()`).

## ⚠️ 외부 IO 는 라우트의 `after()` 가 소유한다 (실사고 2026-07-30)

도메인 서비스(`src/services/*`)는 **DB 트랜잭션만** 책임지고, 구글 캘린더·메일 같은
**외부 부수효과는 라우트가 `after()` 훅으로** 수행한다(트랜잭션 밖으로 빼기 위해).

**⛔ 그래서 스크립트·배치에서 도메인 서비스를 직접 부르면 그 훅이 통째로 빠진다.**
실사고: `campaignGroupService.dissolveGroup` 을 스크립트에서 직접 호출해 그룹을
해제했더니, `DELETE /api/campaign-groups/[id]` 의 `scheduleDissolvedCalendarCleanup`
(그룹 이벤트 삭제 + 멤버 개별 이벤트 재생성)이 실행되지 않아 **구글 캘린더에 고아
이벤트**가 남았다. 코드로는 영원히 찾을 수 없는 상태가 된다.

- **서비스 계층만 보고 "정리 로직이 없다"고 판정하지 말 것** — 이 사고에서 실제로
  그렇게 오진해 불필요한 수정 PR 을 준비했다가 되돌렸다. 정리는 **라우트에 이미
  있었다.**
- 스크립트로 같은 일을 해야 하면 **라우트를 호출하거나 그 훅과 같은 순서를 재현**한다.
  삭제되면 장부를 못 읽으므로 **필요한 id 는 작업 전에 확보**해야 한다.
- 🪤 **낡은 주석이 오진의 출발점이 된다.** 위 사고의 근원은 `schema.prisma` 의
  `calendarEventIds … CG-3 배선 전 미사용` 이었다 — 실제로는 배선돼 **20그룹 중
  19그룹이 쓰고 있었다.** 주석의 "미사용·미배선" 서술은 **실데이터로 한 번 확인**하고
  믿는다(배선 완료 시 주석 정정은 그 PR 의 몫이다).

## Document Trust Map (문서 지도)

새 영속 문서를 만들면 **같은 PR에서 이 지도에 등록**한다(역할·신뢰 등급).
지도에 없는 문서는 다음 정리 때 아카이브 대상으로 간주한다
(AGENTS.md의 Documentation Management Policy).

- **항상 신뢰(살아있는 정본):** `PROJECT_MASTER.md`(작업 보드)와
  `PROJECT_LOG.md`(완료 아카이브)는 **로컬 전용·git 미추적**이다 — 워크트리가
  아닌 메인 레포 루트의 사본을 읽고 쓴다. 그 외: `CACHE_OPERATIONS.md` · `README.md`
  (로컬 실행·검증 명령) · `RELEASE_CHECKLIST.md` ·
  `SECURITY_AND_BACKUP_MANUAL.md` · `.knowledge/index.md` ·
  `FEATURE_SPEC.md`(구현 현황 정본) · `docs/agents/*.md`(본 거버넌스 모듈) ·
  `ygrd-link/README.md`(유입추적 Worker의 배포·시크릿·수집 항목 정본 — 이 레포에서
  유일하게 Cloudflare 배포 절차를 담는다. wag-crm 배포 규율(P6)과는 별개 레인이다) ·
  `docs/handoff/*.md`(활성 작업 상세 — 인덱스 보드의 상세면) ·
  `docs/private/{specs,plans}/*.md`(**로컬 서고, git 미추적** — 설계서·계획서의
  서식지. 종전 `docs/superpowers/` 추적분 56건이 2026-08-28 이곳으로 이관됐다
  (공개 전환 준비). fresh clone·클라우드 세션에는 존재하지 않는다 — 소스 주석의
  「설계 정본:」 포인터가 이 경로를 가리키는데 파일이 없으면, 문서가 삭제된 것이
  아니라 **읽을 수 없는 환경**인 것이다. 메인 레포 사본이 정본. 🪤 예외 2건 —
  `prisma/migrations/20260808090000_add_campaign_settlement_item/migration.sql` 과
  `…20260820120000_drop_dead_alert_settings/migration.sql` 의 주석은 아직 옛 경로
  `docs/superpowers/…` 를 가리킨다. 적용된 마이그레이션을 고치면 Prisma 체크섬이
  깨져 `migrate deploy` 가 멈추므로 **의도적으로 치환하지 않았다** — 그 두 줄을
  따라갈 때는 `docs/superpowers/` 를 `docs/private/` 로 바꿔 읽을 것) ·
  `docs/runbooks/*.md`(**오너 대면 운영 절차** — 계정 개설·메일 계정 전환
  (`gmail-mail-cutover.md`) 등 사람이 손으로 밟는 단계.
  `docs/agents/*` 가 에이전트용 거버넌스인 것과 축이 다르다: 이쪽 독자는 오너이고,
  명령은 붙여넣기 가능해야 하며 제시 전 실행 검증을 거친다(P4 Pre-Verification)).
- **해당 기능 작업 시 SSOT:** `docs/private/specs/2026-07-25-content-order-correlation-design.md`
  (콘텐츠 발행×주문 반응 시각화 — 오너 승인 설계) ·
  `docs/private/specs/2026-08-01-price-sheet-sub-item-selection-design.md`
  (가격표 인제스트 하위품목 묶기 선택 — 오너 승인 설계) ·
  `docs/private/specs/2026-08-03-tax-filing-helper-design.md`
  (세무 신고자료 도우미 — 채널별 계산서 상대·방향·금액 확정표가 최우선 정본이다.
  초판의 「발행=우리→셀러」 서술은 틀린 것으로 정정됐으니 그 절부터 읽는다.
  ⚠️ 그 표의 **셀러몰 행은 2026-08-07 문서로 다시 정정됐다** — 아래 항목과 함께 읽는다.
  ⚠️ 「두 표면의 분업」의 **단위 = 지급월 × 전체는 세금계산서 탭에 한해 SUPERSEDED**다
  — 바로 아래 2026-08-09 문서를 함께 읽는다) ·
  `docs/private/specs/2026-08-09-tax-board-axis-and-channel-labels-design.md`
  (세무처리 보드 **축 전환** + 채널별 자금 라벨 — 오너 승인 설계. §1의 **채널별 자금·계산서
  순서**(브랜드몰·우리몰·셀러몰 각각 누가 먼저 청구하고 누가 나중에 지급받는가)가
  최우선 정본이고, 「계산서는 항상 지급보다 먼저」라는 사실이 이 트랙 전체의 전제다.
  ⛔ 세금계산서 탭을 다시 지급월로 자르지 말 것 · ⛔ 자금 라벨용 채널→상대 표를 새로
  만들지 말 것(`TAX_INVOICE_OBLIGATION_TABLE` 파생) · ⛔ `pendingCount`·`totalsByDirection`
  에 BACKLOG 를 섞지 말 것(오너가 홈택스에 옮기는 숫자다) · ⚠️ 개인 셀러 가드를 자금
  라벨에 복사하면 지급 칸이 사라진다) ·
  `docs/private/specs/2026-08-12-withholding-status-on-settlement-card-design.md`
  (정산 카드의 **원천징수 신고 상태 표시** — 오너 승인 설계. 개인 셀러 캠페인의 죽어 있던
  「셀러 계산서 수취」 칸을 그 **지급월**의 원천징수 신고 상태로 갈아끼운다. ⛔ **읽기
  전용이다** — SoT 는 월 단위 `TaxFilingLog` 하나이고, `sellerInvoiceIssuedAt` 에 신고일을
  쓰면 세금계산서 보드·수취 대조 엔진·정산 명세서가 「계산서를 수취했다」로 오독한다.
  완료 기준은 **3절차 전부**(오너 확정 2026-08-12)이고 표시 일자는 1번 원천세 신고일이다.
  ⚠️ 「10일에 3절차를 함께 처리한다」는 전제 위에 선 기준이며, 홈택스가 그날 간이지급명세서
  제출을 여는지는 §확정 사항의 **미확인 가정**으로 남아 있다) ·
  `docs/private/specs/2026-08-07-settlement-invoice-direction-design.md`
  (정산 카드 계산서 방향 표시 + 발행·수취 액션 — 오너 승인 설계. **셀러몰 의무표 정정**
  (공급사 수취 · 셀러 발행)의 근거와 파급 목록이 여기 있다. 정정으로 전 채널이
  「필드명 = 상대」로 균일해져 "이름에 속지 말 것" 경고가 폐기됐다) ·
  `docs/private/specs/2026-08-12-settlement-invoice-column-design.md`
  (정산 진행 목록의 「다음 업무」 → 「계산서」 열 교체 — 오너 승인 설계. **왜 원천세
  신고를 캠페인 행에 넣지 않는가**(`TaxFilingLog` 는 월 단위라 같은 달 전 행이 동일값이
  된다)와, 목록이 체크리스트가 아니라 **타임스탬프를 읽어야 하는 이유**(오너가 실제로
  쓰는 정산 카드 경로가 체크리스트를 갱신하지 않아 열이 현실을 안 따라왔다)가 여기 있다.
  ⛔ 열에서 채널 분기·라벨 매핑을 재작성하지 말 것 — `resolveCampaignInvoiceSlots` 파생.
  ⛔ 의무 없는 칸이라도 **값이 있으면 날짜를 계속 보여준다**(2026-08-07 §4-2 상속)) ·
  `docs/private/specs/2026-08-07-settlement-money-separation-design.md`
  (캠페인 재무정산 **돈의 세 성격 분리** — 오너 승인 설계. 부가 항목
  (`CampaignSettlementItem`)의 저장 축이 왜 「계산서 방식 × 대상」인지, 통과 항목
  (광고비)이 왜 한 행이 아니라 **두 행**인지, 재무 카드 3구간 재편의 표시 규칙이
  여기 있다. ⛔ **셀러 정산 기준 = actualSales × 셀러수수료율** 불변식과 「부가 항목은
  파생·저장 손익에 반영하지 않는다」가 이 트랙의 절대선이다 — 판정 SSOT 는
  `src/lib/settlement-items.ts`, 물품대금 3-상태는 `src/lib/goods-cost.ts`) ·
  `docs/private/specs/2026-08-04-group-schedule-sync-design.md`
  (그룹 캠페인 일정 통합 연동 + 날짜 입력 커밋 시점 — 오너 승인 설계. **팬아웃 vs 그룹 SoT**
  판단 근거와 반품기간 소급 정리 규칙이 여기 있다) ·
  `docs/private/specs/2026-08-04-deal-seller-matching-design.md`
  (딜↔셀러 양방향 검토 = F1 2단계 — 오너 승인 설계. **두 타이밍 축(`seller-dormancy` ·
  `recampaign-timing`)과 무엇이 다른 질문인지**, D3 매출 조건의 단위가 왜 (셀러×딜) 쌍인지,
  카테고리 매칭이 왜 불가한지가 여기 있다. 세 모듈을 통합하자는 제안 전에 §1·§3 을 읽는다) ·
  `docs/private/specs/2026-08-05-hometax-local-helper-design.md`
  (홈택스 건별발급 **로컬 헬퍼** — 오너 승인 설계, 1단계 착지. 발급·전자서명은 영구히
  사람 몫이라는 **절대 금지선**과, CRM(https)→로컬 헬퍼(127.0.0.1) 연결이 앱 CSP 에
  막혔던 실사고가 여기 있다. 페이로드는 XLSX 와 **같은 라우트·같은 빌더**를 쓴다 —
  별도 타입·라우트를 만들자는 제안 전에 「데이터 계약」절을 읽는다) ·
  `docs/private/specs/2026-08-14-menubar-server-control-design.md`
  (셀프호스트 메뉴바 앱 — 오너 승인 설계. 앱은 얇은 화면이고 판정은 `status.sh`,
  파괴적 동작은 `preview.sh` 가 소유한다는 위임 제약이 여기 있다. 앱(Swift)에서
  docker·launchctl 직접 호출 금지 — 계약 `menubar-app-delegation.test.ts`.
  **개정 5(2026-08-27) = 배포 완료 알림** — 발화 조건은 배포 마커 변화 **하나**라
  버튼 배포와 터미널 배포가 같은 경로를 탄다. ⛔ `deploy.sh` 가 직접 쏘는 안으로
  되돌리지 말 것(실측: 셸의 `osascript` 알림은 「스크립트 편집기」 신원으로 나가
  「WAG 서버」의 알림 권한·설정을 못 쓴다) · ⛔ 텔레그램(`notify.sh`)에 얹지 말 것
  (🔴 접두 + 같은 키 6시간 하한이라 하루 여러 번인 배포는 둘째 통부터 삼켜진다) ·
  ⛔ 성공 알림을 `runLane` 에도 넣지 말 것(버튼 배포만 2통) · ⚠️ 터미널 실행의
  **실패는 구조적으로 관측 불가**다(마커는 성공했을 때만 쓰인다)) ·
  `docs/private/specs/2026-08-14-menubar-release-section-design.md`
  (메뉴바 **릴리스 섹션**(배포 버튼 + 대기 목록) — 오너 승인 설계, 위 문서의 개정 3.
  ⚠️ **앱이 주는 PATH 는 `/usr/bin:/bin:/usr/sbin:/sbin` 뿐이라(실측) `npm`·`gh`·`npx`
  가 안 보인다** — `deploy.sh` 는 레포에서 유일하게 PATH 보강이 없는 스크립트라 새
  호출자가 그 역할을 진다. 체크아웃 경로를 `release-deploy.sh` 가 **하드코딩해
  소유**하는 이유(2026-08-14 낡은 체크아웃에서 Worker 배포한 실사고)와, 링크 서버
  변경 판정에 **전용 마커**(`deployed.ygrd-link.sha`)를 쓰는 이유가 여기 있다.
  ⛔ 자동 배포로 되돌리지 말 것 — 이 버튼은 프로덕션 DB 에 마이그레이션을 적용한다) ·
  `docs/private/specs/2026-08-14-brand-link-short-link-input-design.md`
  (브랜드사 상품 링크 입력 경로 — 오너 승인 설계. **단축링크는 브랜드사몰, `nt_*` 는 자사
  네이버**라는 채널 원칙(오너 확정)과, 캠페인이 자리표시자로 태어나기 때문에 목적지 선택이
  `pickConfirmedTargetLink` 로 모여야 하는 이유가 §3-3 에 있다. ⛔ 목적지를
  `generatedTrackingLink || baseNaverLink` 로 되돌리지 말 것 — 자리표시자 파생값이 먼저 이겨
  **발급이 영원히 거절된다**. ⚠️ 이미 발급된 링크의 `targetUrl` 정정은 이 설계의 범위 밖이다) ·
  `docs/private/specs/2026-08-15-short-link-preview-refresh-design.md`
  (단축링크 **공유 미리보기 새로고침** — 오너 승인 설계. 메신저가 URL 단위로 굳힌 미리보기
  캐시를 **경로 꼬리 `/{code}/r{token}`** 로 우회한다. ⛔ 이 증상에 **재발행(새 코드)으로
  대응하지 말 것** — 셀러가 이미 게시물에 박은 링크와 통계가 갈라진다. ⛔ **Worker 무수정**이
  전제다: 조회는 `pathname` 첫 세그먼트, 목적지 병합은 `searchParams` 만 보므로 경로 꼬리가
  불활성이라는 것이 이 설계 전체의 받침대다(깨지면 모든 새로고침 링크가 **조용히 폴백**으로
  떨어진다 — tripwire 는 §7). ⛔ 토큰을 `ogFetchedAt` 파생으로 바꾸지 말 것(수집 실패 시
  같은 URL 이 재생산돼 우회가 안 된다) · ⛔ 빈 스냅샷을 저장하지 말 것(`ogFetchedAt` 만
  찍혀 Worker 폴백 수집을 24시간 막는다). ⚠️ **복사가 fetch 보다 먼저**인 순서는 장식이
  아니다 — 수집이 최대 20초라 뒤집으면 클립보드가 사용자 제스처 창을 벗어나 거부된다.
  이 라우트가 `after()` 가 아니라 **await** 하는 사유는 §4) ·
  `docs/private/specs/2026-08-15-link-expiry-follows-campaign-design.md`
  (단축링크 **만료가 캠페인 종료일을 따라간다** — 오너 승인 설계. 만료 규칙이 왜 밀리초
  덧셈이 아니라 **KST 날짜 경계**인지(종료일의 시각 성분 때문에 같은 `+30일` 이 28일·30일로
  갈렸다), 재계산이 왜 **팬아웃 뒤**여야 하는지가 여기 있다. ⛔ 계산을 마이그레이션 SQL 로
  옮기지 말 것 · ⛔ `isActive` 를 섞지 말 것 · ⛔ Worker 를 고치지 말 것(값만 달라지므로
  배포 레인이 CRM 하나로 유지된다)) ·
  `docs/private/specs/2026-08-03-tax-invoice-receipt-mail-engine.md`
  (수취 세금계산서 메일 대조 엔진 — 표준 XML 스키마 실측 근거 + 판정 계약 + **미확인 가정**
  목록. 첨부 형식이 몇 종인지는 아직 미확인이라 그 절을 먼저 읽는다) ·
  `docs/private/specs/2026-08-06-tax-invoice-issue-auto-confirm-design.md`
  (**발행** 세금계산서 메일 자동 확정 — 이 트랙 **최초의 쓰기 경로**다. 정산 필드에 쓰기를
  하기 전에 「안전 제약」절, 특히 **그룹이 캠페인별로 후퇴하면 자동 확정하지 않는다**를
  먼저 읽는다. 그룹은 발행일 필드를 멤버 전원이 공유하므로 멤버 1건을 근거로 찍으면 나머지
  의무까지 조용히 완료로 굳는다. 허용오차 숫자는 **의도적으로 미정**이며 그 사유가 🔴 절에
  있다 — 코드에서 임의로 키우지 말 것) ·
  `docs/private/specs/2026-08-15-sidebar-ia-redesign-design.md`
  (사이드바 IA 업무 흐름 재편 — 오너 승인 설계. 섹션 원칙 "묶음=성격·핵심 업무
  순서=퍼널"과 무라벨 첫 그룹 규칙이 여기 있다. ⛔ "순서=사용 빈도"(#286)로
  되돌리지 말 것) ·
  `docs/private/specs/2026-08-15-sidebar-scroll-affordance-design.md`
  (사이드바 **스크롤 신호** — 넘침을 보이게 만든다 — 오너 승인 설계. `mask-image`
  양끝 페이드를 고른 근거(커스텀 스크롤바·오버레이 div 기각 사유 포함)와, 판정
  결과를 `useState` 가 아니라 DOM 속성에 직접 쓰는 이유(styleseed mechanical
  check 5 — 스크롤 구동 값을 리액트 상태로 흘리면 프레임마다 서브트리가
  리렌더된다)가 여기 있다. ⛔ 밀도·항목 높이·IA 변경은 범위 밖(§2 오너 기각) ·
  ⛔ 엣지 토글에 트랜지션을 추가하지 말 것(§3-5 의도적 무모션)) ·
  `docs/private/specs/2026-08-18-sidebar-icon-collapsed-legibility-design.md`
  (사이드바 **아이콘 변별력** — 오너 승인 설계, 교체 3건 착지. 판정 기준이 "화면을 잘
  표현하는가"가 아니라 **접힘 모드에서 14개가 한 줄로 섰을 때 헷갈리지 않는가**인 이유와,
  dev 셸 Suspense 함정을 우회한 **격리 렌더 판정법**(§3)이 여기 있다. ⛔ `Table2`(판매
  관리)·`Link2`(유입)·`Briefcase`(판매 조건)를 "층위가 어긋난다"며 고치지 말 것 — 셋 다
  모바일 하단탭·리포트 페이지 본문·글로벌 검색이 같은 아이콘을 써서 데스크톱만 바꾸면
  표면이 갈린다(§6) · ⛔ `LayoutDashboard` 는 18px 에서 `Table2` 와 격자가 겹쳐 기각됐다 ·
  ⛔ 실루엣 유사도 자동 판정을 도입하지 말 것(§7)) ·
  `docs/private/specs/2026-08-28-sidebar-hover-overlay-design.md`
  (사이드바 **호버 오버레이** — 오너 승인 설계. 상시 아이콘 레일 + 호버 시 콘텐츠
  **위로 덮으며** 펼침. 티켓 T-052(문서 캐시 손실)의 실제 해소 경로이기도 하다 —
  지속할 상태가 없어져 서버 `cookies()` 읽기가 통째로 사라지는 **부산물**이지, 캐시
  설정을 되돌린 것이 아니다. ⛔ **핀(펼친 채 고정)을 되살리지 말 것** — 오너 명시
  기각이고, 되살리면 §4 의 삭제가 전부 무효가 되어 T-052 가 그대로 돌아온다.
  ⛔ §1-1 을 지우지 말 것 — 3일 전 오너 지적("매 진입마다 접힘으로 시작한다", #455)만
  읽은 세션이 "펼침 기본으로 되돌려야 한다"고 오판하는 것을 막는 절이다.
  ⚠️ 이 설계가 성립하는 이유는 shadcn 사이드바가 **자리 칸 + 떠 있는 패널** 두
  조각이기 때문이다(§3) — 빈 칸만 레일 폭에 고정하면 펼침 시각 규칙은 기존 것을
  그대로 재사용한다) ·
  `docs/private/specs/2026-08-19-cron-staleness-alert-design.md`
  (크론 지연·실패 **알림 전달** 경로 — 오너 승인 설계. 탐지(`cron-staleness.ts`)는 이미 있었고
  없던 것은 전달이라는 진단, 감시자를 크론 밖(메뉴바 앱 타이머)에 두는 이유(자기참조 회피),
  판정을 「마지막 SUCCESS 시각」 한 질문으로 접은 근거가 여기 있다. ⛔ 이 판정을 크론 잡으로
  옮기지 말 것 · ⛔ `KNOWN_JOBS` 사본을 bash 로 만들지 말 것(대상은 crontab 에서 온다) ·
  ⛔ 판정 불능을 `ok` 로 접지 말 것. 2026-08-14 메뉴바 설계서의 「크론 실패 표시 제외」 조문에
  **트립와이어 1건 예외**를 뚫은 개정이기도 하다) ·
  `docs/private/specs/2026-08-19-sustained-unknown-escalation-design.md`
  (지속 **확인 불가** 승격 — 오너 승인 설계. `unknown` 이 오래 이어지면 그 자체가 사고라는 판정과,
  승격 조건이 **경과 ∧ 연속 관측** 둘인 이유(경과만 쓰면 맥이 잠든 것을 장애로 읽는다)가 여기 있다.
  ⛔ 두 조건 중 하나만 쓰는 '단순화' 금지 · ⛔ 폴링 누락을 연속 끊김으로 세지 말 것 · ⛔ `disk` 를
  일관성 이유로 승격·알림 대상에 넣지 말 것(오너 종전 지시). **전달 계약**(`error` 를 낼 수 있는
  키 ⊆ `watched`)을 신설한 문서이기도 하다 — 그게 없어 주간 백업·디스크 error 가 알림 없이 새고
  있었다) ·
  `docs/private/specs/2026-08-19-external-alert-channel-design.md`
  (**외부 채널 알림 경로**(텔레그램) + dead-man 감시 — 오너 승인 설계. 위 두 문서가 남긴
  「미확인 가정」 두 개(앱이 죽으면 전 체계가 조용해진다 · 맥 앞에 없으면 도달 0)를 닫는다.
  "감시자를 감시한다"는 무한 후퇴를 **신호가 안 오는 것을 사고로 본다**(dead-man)로 뒤집어
  끊은 근거와, 소음 억제가 **두 겹**(앱 메모리의 전환 억제 + `notify.sh` 의 절대 하한)인
  이유가 여기 있다 — 앱 메모리만 쓰면 크래시 루프에서 폰이 300초마다 울린다.
  ⛔ heartbeat 발신 주체를 launchd 로 옮기지 말 것(앱이 죽어도 신호가 흘러 닫으려던 구멍이
  살아남는다) · ⛔ `status.sh` 가 직접 발송하게 만들지 말 것 · ⛔ `ygrd-link` Worker 에 얹지
  말 것 · ⛔ `disk` 를 감시 목록에 넣지 말 것(오너 종전 지시 계승) · ⛔ 텔레그램용 감시 목록을
  따로 만들지 말 것(`watched` 공유). `dispatcherService` 처분(제거, 컬럼 드롭은 값 확인 후
  2단계)도 이 문서가 정본이다) ·
  `docs/private/specs/2026-08-25-daily-red-digest-design.md`
  (**일일 「지금 빨강인 것」 요약** — 오너 승인 설계. 위 외부채널 설계서의 **소음 예산
  한 줄에 대한 개정**이다(같은 항목이 빨강인 채 유지 = 0회 → 하루 1회). 전환 알림 1통을
  놓치면 시스템이 다시 말하지 않던 구간을 닫는다 — 알림이 엣지 트리거이고
  `notifiedErrorKeys` 가 프로세스 메모리라, 실패가 이어지는 동안엔 리셋 경로가 하나도
  열리지 않는다는 실측이 근거다. ⛔ 키별 에스컬레이션(A)을 다시 제안하지 말 것(「언제부터
  빨강인가」의 소유자가 없어 새 페이로드 필드가 필요하고, `crons` 처럼 여러 잡을 한 키로
  접는 경우의 **내용 변화**를 못 덮는다) · ⛔ 요약용 감시 목록을 따로 만들지 말 것
  (`Self.watched` 공유) · ⛔ 「전부 정상」을 매일 보내지 말 것 · ⛔ 요약을 크론·dead-man
  Worker 로 옮기지 말 것 · ⛔ 요약 하한(`DIGEST_MIN_INTERVAL_H`)을 항목 하한과 합치지 말 것.
  🪤 Swift 는 소스 스캔으로만 고정되므로 **컴파일이 유일한 실행 검증**이고, 반영에는
  `install-menubar.sh` 재설치가 필요하다) ·
  `docs/private/specs/2026-08-26-selfhost-env-key-coverage-design.md`
  (셀프호스트 `.env` **공란 키 전수 분류** + 점검 범위 확대 설계 — 오너 확정(§4), **선언 표
  구현까지 착지**(§6). 「의도적 공란인가 누락인가」의 키별 판정과 근거가 여기 있다.
  ⛔ **빈 키를 일괄로 채우지 말 것** — 채우면 안 되는 키(`ENCRYPTION_KEY_PREVIOUS` ·
  `NAVER_CLIENT_SECRET`)와 채워도 효과가 없는 키(`WAGCRM_INGEST_URL` — 앱이 읽지 않는다)가
  섞여 있다. ⛔ 점검을 **크론으로 옮기지 말 것**: `applyDbInstagramToken()` 이 프로세스 env 를
  런타임에 덮어써서 파일이 비어 있어도 초록이 나온다(거짓 성공). ⛔ 프로덕션 기준을 CI
  `check-env` 에 그대로 적용하지 말 것(required 체크라 전 PR 이 막힌다). 이 조사에서 나온
  **Graph Tier0 게이트 ↔ DB 토큰 주입의 짝 계약**은 §4-① 에 있다 — `applyDbInstagramToken()`
  은 `process.env.INSTAGRAM_ACCESS_TOKEN` 을 **프로세스 전역으로** 덮어쓰므로, 호출을 빠뜨린
  모듈이 **앞서 돈 다른 진입점 덕에 우연히 통과**하고 앱 재시작 뒤 회차부터 조용히 죽는다
  (`collect-campaign-posts` 실사고 · `enrich-references` 잠복). ⛔ 그 호출을 라우트로 올리지
  말 것 — 게이트와 떨어지면 진입점이 늘 때 다시 갈린다. 계약은
  `instagram-graph-token-applied.contract.test.ts`(게이트 호출자 목록을 **소스에서 파생**한다 —
  손으로 적은 목록이면 새 소비처가 조용히 비켜간다)) ·
  `docs/private/plans/CAMPAIGN_GROUPING_PLAN.md` ·
  `…/GROWTH_FLYWHEEL_PLAN.md` · `…/MOBILE_UX_PLAN.md`(+`_OVERVIEW`) ·
  `…/NAVER_SETTLEMENT_API_PLAN.md` · `…/F4_ORDER_MAPPING_ENGINE_PLAN.md` ·
  `…/REVIEW_QNA_COLLECTION_PLAN.md`(상품 리뷰·문의 VOC 수집/활용).
- **⚠️ 2026-08-28 루트 계획서 전량이 로컬 서고로 내려갔다(공개 전환 준비).**
  종전 레포 루트에 있던 계획서·요구사항·리팩터링 목록 14개는
  `docs/private/plans/` 로, 역사 자료 3개는 `docs/private/history/` 로,
  Kiro 스펙 113개(`.kiro/`)는 `docs/private/kiro/` 로 이관됐고 전부 git 미추적이다
  (`.gitignore` + `archive-handoff-ignored.contract.test.ts`). 🪤 **레포 루트에서
  이 파일들을 못 찾았다고 "삭제됐다"고 판단하지 말 것** — 메인 레포의 위 경로에
  그대로 있다. fresh clone·클라우드 세션에는 없으며, 그 환경에서는 **읽을 수 없는
  것이지 사라진 것이 아니다.** 설계 정본: `docs/private/specs/2026-08-28-repo-republicize-prep.md`.
- **⚠️ 낡음 — 값 참조 금지:** `docs/private/history/DESIGN.md`와
  `design-system/wag-crm/MASTER.md`
  의 색 팔레트는 2026-05 초기값(블루/오렌지)으로 현재 구현과 다르다.
  **색·토큰의 런타임 정본은 `src/app/globals.css`(네이비/골드)다**(P8).
  `ARCHITECTURE.md`의 서비스 상태표도 낡았다(이 파일은 루트에 남겨 뒀다 — 구조
  개요는 공개 레포에 있어도 되는 종류다). `PROJECT_STATUS.md`는 **이 레포에
  없다**(구 레포 잔류) — 구현 현황은 `FEATURE_SPEC.md`를 본다.
  `TACIT.md`는 `.knowledge/`로 가는 스텁이다.
- **역사 자료(지침 아님):** `docs/private/history/ROADMAP.md`(전 단계 완료 종결) ·
  `docs/private/history/chatlog.md`(원본 기획 로그 — 오너·Gemini 대화 전문이라
  추적 승격 금지).
- **⚠️ 이 레포에 없는 것 — 구 레포에서 읽는다(2026-07-30 실측 정정):** 종전 이
  지도는 이관 완료 워크시트 `NOTION_IMPORT_*` · a11y 디버그 덤프
  `seller-detail-*` · `PROJECT_STATUS.md` · `PROJECT_STATUS_HISTORY.md`가
  `docs/archive/`에 있다고 적었으나, **2026-07-16 이관 이후의 레포에는 그
  디렉터리가 존재한 적이 없다**(`git log origin/main -- docs/archive` 공백).
  전부 최초 레포 `indexzigu/wag-crm`에 남아 있고, 07-16 이관이 이력을 공유하지
  않고 재출발하면서 딸려오지 않았다(2026-08-28 이관도 마찬가지다 — 이력을
  가져오지 않는 것이 그 이전의 목적이었다). P6의 **읽기 전용 아카이브** 규칙대로 조회한다:
  `gh api repos/indexzigu/wag-crm/contents/docs/archive`.
  ⛔ **되살려 오지 말 것** — 구 레포의 그 파일들은 공개 전환 준비 때 실명을
  가명(`김본명` 등)으로 치환한 스크럽본이고, 내용은 3천 줄대의 낡은 디버그 덤프라
  운영 가치가 없다. public 레포에 다시 들이는 것은 P0 검토 부담만 늘린다.
- **`docs/archive/`(이 레포)의 현재 용도:** 위 역사 자료의 보관처가 아니라 **앞으로**
  퇴역시킬 문서의 이관처다. 하위 `docs/archive/handoff/`는 착지한 핸드오프 전용이며
  원본과 같은 **로컬 전용·git 미추적**이다(`archive-handoff-ignored.contract.test.ts`가
  강제) — 출처가 달라 등급도 다르니 루트와 하위를 한 규칙으로 묶지 않는다.
