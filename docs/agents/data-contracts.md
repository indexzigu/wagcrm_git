# Data & External API Contracts — P7 (AGENTS.md 라우터 모듈)

> `AGENTS.md`의 Mandatory Reading Router가 지정하는 조건부 필독 모듈이다.
> 주문·정산·지표·집계, 네이버/인스타그램 API, 수집기, 캐시 정책을 만지기
> 전에 **전문**을 읽는다. 여기 있는 계약은 전부 실사고 또는 실측으로
> 확정됐다.

- **Order-Count Vocabulary (세 숫자를 혼동 금지):** 한 결제(`orderId`)가
  옵션·색상별로 여러 **상품주문 라인**(`productOrderId`)으로 쪼개진다. 여기서
  나오는 세 숫자를 이름 그대로 못 박는다(오너 확정 2026-07-12):
  - **주문건수 = 결제(orderId) 단위 distinct** = `distinctOrderCount`
    (`validOrderKeys.size`). 화면 "주문 N건"·객단가(AOV) 분모의 **정본**.
    distinct 키는 `resolveOrderCountKey`(orderId 우선, 없으면 `po:productOrderId`).
  - **주문수량 = 옵션별 판매 수량 합** = `quantity` 필드(구 `orderCount`
    컬럼, #101 리네임 — 아래 참조). 세금계산서·정산서가 쓰는 값.
  - **상품주문 라인수** = `totalOrders`(`totalOrders++` 카운터). 내부 비율
    분모(linkRatio, 인사이트 경로별 비중)용일 뿐 **"주문건수"로 표시하면
    안 된다** — 다회선 주문에서 부풀려진다. 일별 `dailyStats.orders`·포털
    "주문 N건"·AOV가 이걸 잘못 쓰던 실사고(2026-07-12, PR #100)로 전부
    `distinctOrderCount`로 교정. 미백필 과거 마감 캠페인은 `distinctOrderCount
    ?? totalOrders` 폴백(order-dashboard 카드 규칙)을 공유한다.
- **quantity Field (구 orderCount, #101 리네임):** `SalesCampaign.quantity`·
  `CampaignDeal.quantity`는 **판매 수량**을 저장한다(정산 매출식
  `actualSales = sellingPrice × quantity`의 근거 — 세금계산서 `quantity`·정산서
  "수량" 칸으로 직결). 예전 필드명 `orderCount`가 "주문 건수"로 반복 오독돼
  `quantity`로 리네임했고, **DB 컬럼명은 `@map("orderCount")`로 그대로 유지**한다
  (데이터 마이그레이션 없음 — schema↔migrations diff 빈값·guard 재검증). 실제
  주문 건수는 위 `distinctOrderCount`다 — 단, `cachedDistinctOrderCount` 캐시는
  **캠페인 마감 시점에만 영속**되므로 진행 중 캠페인에서 0인 것은 버그가
  아니다(그때는 order-converter 보드가 라이브 집계). 혼동해서 "고치지" 말 것.
  별개로, `campaign-performance-report.ts`의 `orderCount`(AOV 분모 = 진짜
  주문수)와 발주/배송 카운트(`action-log`·`EmailSendModal`)는 이 필드가 아니다.

- **Pipeline Delay Warnings (지연 경고 3버킷):** 카드가 "파악이 필요한 건"만
  빨간 배지+팝오버로 띄우는 경과일 임계값(오너 확정). ① **주문확인 후 발주
  지연** = `newAfter`(주문확인됐지만 발주요청·송장 전) 결제 후
  `CONFIRM_DELAY_WARN_DAYS`(2일)↑. ② **배송대기** = 발주요청(poRequestedAt) 후
  `PENDING_DELAY_WARN_DAYS`(2일)↑ 송장 미회신. ③ **배송중** = 결제 후
  `SHIPPING_DELAY_WARN_DAYS`(5일)↑. 버킷 판정은 `deriveOrderPipelineBucket`,
  경고 집계·목록은 `campaigns-handler`(활성 캠페인만 — 마감은 조기반환).
  clock: newAfter·배송중은 결제시각, 배송대기는 poRequestedAt.

- **Valid-Order Enum Discipline:** 유효주문 판정은 `INVALID_ORDER_STATUSES`
  단일 SSOT(8곳 공유)다. 네이버 `productOrderStatus` enum과 문자열까지 정확히
  일치해야 한다 — 오타 `PAY_WAITING`(실제값 `PAYMENT_WAITING`)과
  `CANCELED_BY_NOPAYMENT` 누락으로 전 지표가 부풀려진 실사고(PR #53)가 있다.
  수정 시 실데이터 실값 대조 + 회귀 테스트를 남긴다.

- **Campaign Period SSOT = 판매관리 일정 (오너 확정 2026-07-15, 기존 규칙 개정):** 집계 창의 정본은
  **판매관리(`SalesCampaign`) 일정**이고, 네이버 스토어 기간(`OrderCampaign.salePeriod`)은 **관측값**이다.
  - **왜:** 스토어는 기간 연장·'종료 후 별도 주문건을 받으려고 임시로 판매를 여는' 운영 때문에 실제 회차
    경계와 어긋난다. 그 값이 판매캠페인으로 흘러들면 **정산서·정산리포트·구글 캘린더·재구매 집계·
    대시보드·셀러 요약이 전부 판매캠페인 기간을 소비**하므로 오염이 그 전부로 번진다.
  - **단방향 불변:** 동기화는 `SalesCampaign → OrderCampaign.startDate/endDate` **한 방향뿐**이다.
    역방향(`syncSalesCampaignPeriod`)은 제거됐다 — **되살리지 말 것**. 그건 스토어가 판매중/대기이기만
    하면 GET마다 판매캠페인을 덮어써서, 운영자가 판매관리에서 고친 기간을 다음 로드에 되돌렸다.
  - **`salePeriod`를 창으로 덮지 않는다:** 관측값을 보존해야 '스토어엔 연장이 있는데 판매관리엔 없다'를
    감지할 수 있다. 판매캠페인 **미연결** 캠페인에서만 `salePeriod`가 창의 폴백 근거다.
  - **동결 기준 = 마감(`isActive`)이 아니라 정산 락(`isSalesCampaignLocked`):** 판매마감은 되돌리는 경우가
    있고, 반품·구매확정 때문에 판매일정 후 ~10일은 정산대기로 변동 가능하다. **정산이 시작되면
    (`SETTLEMENT_IN_PROGRESS` 이상) 그때부터 확정**이라 창을 얼려 마감 스냅샷·정산 귀속
    (`cachedProductOrderIds`)과 어긋나지 않게 한다. (2026-07-12의 "마감이면 동결"은 이 규칙으로 대체됐다 —
    네이버 재동기화가 마감 캠페인 창을 늘리지 않는다는 취지는 이제 "스토어는 창을 아예 못 건드린다"로 흡수.)
  - **기간후 주문은 회차 성과에 포함한다(오너):** 그 건이 마무리돼야 정산이 시작되기 때문. 포함시키는
    방법은 **운영자가 판매관리에서 종료일을 늘리는 것**이고(자동 귀속 아님), 그 트리거는 기간 후 주문 배지
    (`postPeriodOrderCount`)다 — 배지가 뜨면 판매관리에서 늘린다 → 매출에 포함되고 배지가 사라진다.
    발주서(`execute`)는 `시작일~now`로 **종료 필터가 없다** — 창을 안 늘리면 "발주엔 있고 매출엔 없는"
    불일치가 되고 이게 과거 실사고(58 vs 발주 78)의 축이다.
  - **1:N은 표준이다(실측: 주문캠페인 1개에 딜별 판매캠페인 4~5개).** 창은 `min(시작)~max(종료)` 합성이고,
    기간이 서로 다르면 합성 창이 짧게 운영한 딜엔 정확하지 않다 — 오너 결정은 **"합성하되 어긋나면 경고"**
    (`periodMismatch`). 실제 어긋난 사례가 prod에 있다.
  - **표시는 반드시 창에서 파생한다(`periodLabel`).** `salePeriod`를 그냥 띄우면 표시와 집계가 갈라져
    "화면 기간은 맞는데 매출만 다르다"는 실사고(#170)가 재발한다. SSOT는 `src/lib/order-converter/sale-window.ts`
    (`resolveSalesCampaignWindow` · `formatKstPeriodLabel`).

- **Same-Link Campaign Handover (같은 상품 링크의 셀러 교체, 오너 확정 2026-07-23):**
  한 상품 링크의 **상품명을 바꿔가며 셀러를 교체**해 회차를 이어 돌리는 것이 정상 운영이다
  (예: `[셀러A X 브랜드] …` → `[셀러B X 브랜드] …`). 그래서 여러 캠페인이 같은 `productId`를
  가리키는 건 사고가 아니다.
  - **상품명은 소유권 신호가 아니다.** 주문 스냅샷의 `productName`은 그 라인이 **마지막으로
    동기화된 시점의 상품명**이라, 이름을 바꾸면 그 뒤 재싱크된 **과거 주문까지** 새 이름을
    갖는다(실측 2026-07-23: 같은 날 안에서 결제 시각순으로 두 이름이 번갈아 등장). `productId`도
    같고 옵션·매핑도 회차가 공유하므로 **변별력이 0이다.**
  - **분리 신호는 결제 시각 × 캠페인 집계창뿐이다.** 집계는 이미 캠페인별 창으로 주문을 먼저
    거르므로(handler·closed-cache 공통), **창이 겹치지 않으면 분리는 자동**이다. 운영자가
    판매관리에서 회차 경계를 안 겹치게 잡는 것이 유일한 정답이다.
  - **교차 귀속 가드는 창 조건을 반드시 동반한다**(`orderBelongsToPeerCampaign`, SSOT는
    `campaign-match.ts`): 이름이 다른 캠페인을 가리켜도 **그 캠페인 창이 결제 시각을 담지
    못하면 양보하지 않는다.** 창 조건 없이 이름만 보면 순차 전환에서 **침묵 누락**이 난다 —
    옛 회차는 "새 셀러 것"이라며 양보하고 새 회차는 창 밖이라 걸러 아무도 안 센다.
  - **창까지 겹치면 코드로는 못 가린다.** 그 구간 주문은 어떤 신호로도 셀러를 나눌 수 없어 두
    캠페인이 각자 전량 집계한다(실사고 2026-07-23: 두 마감 캐시 합이 원천 실재 수량 초과).
    `findSharedLinkWindowConflicts`가 감지해 서버 로그로 경고하며, 해소는 코드가 아니라 운영
    (회차 경계 분리)이다. **딜(판매캠페인) 단위 수량은 별도로 운영자가 관리하므로 정산은
    이 겹침의 영향을 받지 않는다** — 어긋나는 건 주문캠페인 상위 캐시뿐이다.

- **Naver Commerce API Quirks:** ① 변경피드에 실리지 않는 상태 전이가 있다
  (발주확인, `DELIVERING→DELIVERED` 등) — 이런 전이는 query-by-id 재조회로
  스냅샷을 직접 최신화한다. ② `DISPATCHED`는 주문 상태값이 아니라 변경유형
  코드다(실제 배송중 상태값은 `DELIVERING`). ③ 발송지연 API는 건별 호출이며
  고객 알림을 취소할 수 없다 — 실 프로덕션 주문 ID로 개발/QA 중 호출 절대
  금지. ④ 공식 문서는 `apicenter.commerce.naver.com/llms/*`이고 슬러그는
  camelCase다. ⑤ 정산(pay-settle) API 5종은 현 자격증명으로 호출 가능
  실증됐고 daily는 31일 제한 — SSOT는 `NAVER_SETTLEMENT_API_PLAN.md`.

- **Mobile Order Refresh (모바일 수동 최신화 1종, 오너 승인 2026-07-15):**
  모바일 매출 GET(`/api/mobile/**/sales`·pulse)은 **동기화 트리거 금지가
  불변**이다 — 영속 스냅샷·cached 컬럼만 읽고 runSync·네이버 fetch·`after()`
  백그라운드 작업을 태우지 않는다. 수동 최신화는 전용
  `POST /api/mobile/order-sync` **1종뿐**(캠페인 상세 당겨서 새로고침, 설계
  옵션 C): ① 신선도 게이트 — 최신 `NaverOrderSnapshot.lastCallTime`만
  select(주문 블롭 미조회), TTL 기본 90s(`MOBILE_ORDER_REFRESH_TTL_S`
  60~120 클램프) 이내면 `{status:"fresh"}` **200**(429 아님). ② stale이면
  기존 `runSync('CHANGED')` 재사용(in-flight dedupe·45s 쿨다운 포함) — 8초
  초과 시 `{status:"syncing"}` 선응답하고 동기화는 백그라운드 완주. ③ 금지:
  revalidate 계열 호출·FULL 모드·sweepDeliveringOrders/클레임 알림 등 크론
  부가작업 탑재. ④ 분당 3회 초과(인메모리)만 429 + Retry-After — 기본 3회
  (`MOBILE_ORDER_REFRESH_RPM` 1~10 클램프, 오너 결정 2026-07-15: 서버
  사용량 보수적 운용). 순수 게이트·응답 해석은
  `src/lib/mobile-order-refresh.ts`가 SSOT.

- **Mobile Sales Read = Aggregate Column Only:** 모바일 매출 상세의 live
  경로는 `NaverOrderSnapshot.dailyAggregate`(일별 집계 JSON)만 select한다 —
  `orders` 블롭은 조회당 1.5~5.2MB egress라 읽지 않는다(과거 egress 초과
  실사고와 동일 축). 집계는 동기화 쓰기 시점에 계산해 함께 저장하고, 계산
  실패는 삼키지 않고 `{v:0}` 마커로 표기한다. 읽기는 **행 단위 폴백** —
  null(레거시)·`{v:0}`·버전 불일치·캠페인 멤버십 미커버 행만 블롭을 읽어
  **동일 함수**(`computeSnapshotDailyAggregate`)로 재계산하므로 두 경로 수치가
  일치한다. 귀속 우주(`loadAggregationCampaignSources`)는 데스크톱과 같은
  `orderCampaign.isActive` 게이트를 쓴다 — 마감 캠페인을 넣으면 상품명이
  겹치는 라인이 모바일에서만 배제돼 과소집계된다. SSOT는
  `src/lib/order-converter/daily-aggregate.ts`.

- **Live 조회 창 = 캠페인 창이 정한다 (now 상대 하한 금지, 2026-08-03 실사고):**
  스냅샷 읽기 창의 **시작은 도메인 창**(캠페인 기간, 위 *Campaign Period SSOT*)이 정하고,
  `now` 상대 상한은 **폭주 가드로만** 쓴다. 판정 SSOT 는 `resolveLiveWindowKeys`
  (`daily-aggregate.ts`, 상수 `MAX_LIVE_WINDOW_DAYS`) 하나이고 읽기 경로 4곳이 공유한다 —
  모바일 매출 상세·모바일 펄스·데스크톱 `campaigns-handler`·발송지연 대상 조회.
  - **왜:** `Math.max(캠페인_시작, now − 30일)` 은 캠페인 시작일이 **고정**인데 하한이 매일
    **전진**해, 시작 후 30일이 지나는 순간부터 캠페인 초반 날짜가 하루에 하나씩 조회 밖으로
    밀려난다. 차트 표시가 아니라 **주문 건수·매출 숫자 자체**가 줄어드는 침묵형 결함이다.
    방아쇠는 캠페인 길이가 아니라 **경과 시간**이고, 노출 구간은 *캠페인 종료 ~ 발주 마감*
    사이다 — 마감하면 cached 경로가 전 기간 동결본을 읽어 자연 치유되므로
    **"마감을 늦게 누를수록 수치가 줄어드는"** 형태로만 드러나 사후 재현이 어렵다.
    read-path 4곳이 **전부** 이 형태였다(#248 에서 2곳, #249 에서 나머지 2곳).
  - **30일의 출처는 `SNAPSHOT_WINDOW_DAYS`(스냅샷을 *쓰는* 창)다** — 읽기 쪽이 그 숫자를
    "30일보다 오래된 건 존재하지 않는다"로 오독해 베꼈다. **스냅샷 행을 지우는 코드는 레포에
    없으므로 더 오래된 행은 그대로 남아 있다**(2026-08-03 프로덕션 실측: 30일 밖 행이 다수
    실재하고 대부분 `dailyAggregate` 를 갖고 있어 블롭 폴백 없이 값싸게 읽힌다). 즉 캡은 없는
    데이터를 보호한 게 아니라 **있는 데이터를 버리고 있었다.**
  - **egress 규율과 충돌하지 않는다** — 캠페인은 최대 30일 안쪽으로 운영되므로(오너) 읽는
    스냅샷 행 수는 종전과 같은 자릿수다. 데스크톱 `campaigns-handler` 도 마찬가지다:
    그 창이 구동하는 것은 스냅샷 하이드레이션이고, 네이버를 부르는
    `runSync('FULL', { startDateKey, endDateKey })` 는 **L1+DB 완전 무데이터 부트스트랩에서만**
    발화한다. ⛔ 종전 코드 주석 *"API 과호출 방지, 최대 30일"* 은 **부정확했다** — 그 문구가
    오해의 출처였다.
  - ⛔ **숫자만 키우는 수정을 하지 말 것** — 같은 결함이 뒤로 미뤄질 뿐 구조가 그대로다.
    상한에 걸려 잘리면 삼키지 않고 `console.warn` + 응답 `coverage.truncated` 로 고지한다(P0).
    화면은 그 구간을 "주문 0"이 아니라 **"조회한 적 없음"**으로 다뤄야 한다.
  - ⚠️ **`naver-order-sync.enumerateSnapshotDateKeys` 는 이 계약의 대상이 아니다** — 그쪽은
    "어느 날짜를 **쓰는가**"(dirty 무효화 폭)라 쓰기 창으로 좁히는 것이 맞다. 🪤 실제로
    소급 스크립트가 그 함수를 재사용했다가 **같은 결함을 재발**시켰다(6월 마감분 4건이 통째로
    "창 0일"로 스킵). 읽기 창과 쓰기 창을 같은 상수로 묶지 말 것.
  - 계약은 `live-window-floor.contract.test.ts` 가 고정한다 — 등재된 읽기 경로를 **소스 스캔**해
    ①SSOT 위임 ②`now` 상대 하한(`capMs`·`windowFloorMs`·`MAX_DAYS`…) 부재를 본다. 단위
    테스트로는 **미래의 새 호출부**를 못 막기 때문이고, 정규식이 깨져도 초록이 되지 않도록
    **양성 대조군**을 함께 둔다.

- **마감 캠페인의 인트라데이는 마감 시 동결한다 (2026-08-03):** 10분 버킷은
  `OrderCampaign.cachedIntradayBuckets` 에 **마감 시 1회 계산해 영속**한다 —
  `cachedInsights` 와 정확히 같은 부류다.
  - **왜 읽기 시점 합성이 아닌가:** 마감 캠페인의 읽기 경로(`getCachedSalesDetail`)는 스냅샷
    집계(`dailyAggregate.bv`)를 **아예 타지 않는다**(live 전용). 즉 합성이 구조적으로
    불가능하고, 네이버 조회창이 지나면 원천도 사라진다. 비용은 0이다 — 마감 라우트가 이미
    손에 든 `recentOrders` 를 **같은 분기 안에서** 한 번 더 셀 뿐이라 추가 API 호출·egress 가 없다.
  - ⛔ **"마감 캠페인을 귀속 우주에 넣어 live 경로로 태운다"는 금지된 접근이다** — 위
    *Mobile Sales Read* 의 `orderCampaign.isActive` 게이트 때문에 상품명이 겹치는 라인이
    모바일에서만 배제돼 **과소집계**된다. 마감 라우트는 네이버 원본 주문을 자기 창으로 직접
    거르므로 그 우주를 건드리지 않는다 — 이 설계를 택한 이유가 그것이다.
  - **버킷 인덱스는 반드시 `resolveIntradayBucketIndex`(daily-aggregate SSOT)를 재사용한다** —
    직접 계산하면 live 와 버킷 경계가 갈려 같은 캠페인이 두 해상도에서 다른 그림이 된다.
    유효주문 판정·주문 카운트 키도 `cachedDailyStats` 와 **같은 분기 안에서** 세야 한다
    (별도 루프를 돌면 교차 귀속 가드 밖이라 다른 셀러 회차의 주문이 샌다 — 위
    *Same-Link Campaign Handover*).
  - **날짜별로 분해해 저장한다** — 차트가 dateKey 단위로 「기록 없음」을 판정하기 때문이다.
    버전 축은 `bv` 하나이고(형태가 스냅샷 집계와 동일) 컬럼이 null 인 과거 마감분은
    **일별 해상도로 degrade** 한다(없는 데이터를 지어내지 않는다).
  - **소급은 스냅샷에서 한다** — `scripts/backfill-closed-intraday-buckets.ts`(예행 기본,
    `--apply` 는 오너 승인 사안). 네이버 재조회 경로(`recalc-closed-campaign-cache.ts` ·
    admin recalc)는 판매기간이 오래 지나면 **조회창 만료로 빈 결과**가 오므로 쓰지 않는다.
    쓰기는 버킷 **한 컬럼뿐**이라 기존 마감 기록을 덮을 수 없고, 재계산 매출이 동결 매출과
    크게 어긋나면 `--allow-drift` 없이는 보류한다 — 드리프트의 흔한 원인은 커버리지 부족이
    아니라 **같은 링크 순차 전환의 창 겹침**이다(짝이 되는 캠페인이 반대 방향으로 어긋나고
    합계는 비슷하면 이쪽이다).

- **Claims Read = claimSource Column Only:** 클레임 조회(claims 라우트)는
  `NaverOrderSnapshot.claimSource`(클레임 보유 주문 최소 프로젝션, v1 봉투)만
  select한다 — 30일 `orders` 블롭 전량 read-path 파생은 과거 egress 초과의
  최대 지분이라 금지(2026-07-21, dailyAggregate와 동일 계약). 프로젝션은
  동기화 쓰기 시점(`upsertDaily`)에 저장하고, 계산 실패는 삼키지 않고 `{v:0}`
  마커로 표기한다. 읽기는 **행 단위 폴백** — null(레거시)·`{v:0}`·버전
  불일치 행만 그 날짜 블롭을 읽어 **동일 SSOT**(`extractClaimSourceOrders` →
  `deriveClaims`)로 파생하므로 두 경로 결과가 일치한다. 파생 결과가 아닌 소스
  프로젝션을 저장하는 이유: 캠페인 귀속(matchedCampaignName)은 살아있는 캠페인
  목록에 의존해 쓰기 시점에 얼리면 낡는다. **프로젝션 필드는
  `deriveClaimsFromOrder`+`resolveOrderCampaignName` 소비 필드의 상위집합
  계약** — 소비 필드를 추가하면 `ClaimSourceOrder`에도 반드시 동승시킨다.
  SSOT는 `src/lib/order-converter/claim-derive.ts`.

- **Snapshot Blob Egress Discipline (orders 블롭 왕복 금지 확장, 2026-07-24):**
  `NaverOrderSnapshot.orders` 블롭은 **실제로 파싱하는 경로만** 싣는다(dailyAggregate·
  claimSource 계약의 일반화). ① 쓰기 RETURNING — `upsertDaily`는 `select:{id,snapshotDate}`로
  좁혀 방금 올린 블롭을 되받지 않는다. ② 커서 전진 — `advanceCursor`(커서·syncType만
  update)로만 한다. 종전처럼 `findLatestCursor`(현재는 메타 select)로 블롭을 읽어 동일
  orders를 재기록하면 CHANGED 사이클마다 행 크기만큼 egress가 왕복한다. 커서 전진이
  dailyAggregate 재계산을 생략해도 읽기 측 행 단위 폴백이 정합을 보장한다. ③ 카운트
  소비자(에이전트 툴 get_order_snapshot)는 `findRangeCounts`를 쓴다. ④ 크론 클레임
  알림(notifyForAffectedDates)은 claims 라우트와 동일하게 claimSource 우선 + 행 단위
  블롭 폴백이다. 이 select들은 `naverOrderSnapshotRepository.test.ts`의 egress 계약
  테스트가 고정한다.

- **Notification Badge Polling = countOnly (2026-07-24):** 사이드바 배지 30초 폴링은
  `GET /api/notifications?unread=true&countOnly=true`로 미읽음 **개수만** 받는다 — 목록
  전송은 드롭다운을 열 때(listQuery)뿐이다. 미읽음 전량(무상한)을 상시 폴에 실으면
  미읽음 누적에 비례해 Pooler egress가 무한 증가한다(실측 귀속). 배지 경로에 목록을
  되살리지 말 것. 계약은 `notificationService.test.ts`가 고정한다.

- **Naver Call Observability = 요약 + 실패만(전량 계측 금지, 2026-07-30):** 네이버
  호출은 도입 전까지 **한 건도 계측되지 않았다**(실측: `ApiCallLog` provider 가
  INSTAGRAM 35행·YOUTUBE 1행, **NAVER 0행**). 그래서 "주문확인 1클릭이 몇 번 부르는가"를
  코드 상한 계산으로만 말할 수 있었다. SSOT는 `src/lib/order-converter/naver-api-usage.ts`.
  - **남기는 것 2종:** ① **오퍼레이션 요약 1행** — 운영자가 명시적으로 누른 작업
    (`naver_op_confirm_order`=주문확인 · `naver_op_order_excel`=발주요청) 1회당 1행.
    metadata 에 `logicalCalls`(조회 청크 수) · `httpAttempts`(401·429 재시도 포함) ·
    `rateLimitRetries` · `tokenRefreshes` · `skipped` · `byEndpoint` · `elapsedMs`.
    **조회 범위 최적화의 전후 비교는 이 행으로 한다.** ② **종국 실패 1행** —
    `naver_api_call` scope, `apiRequest` 가 **포기한** 실패만.
  - ⛔ **행을 만들지 않는 것 2종: ①성공한 개별 호출 ②재시도로 이어지는 일시적 실패
    (401 토큰만료 · 429 레이트리밋).** 둘은 같은 이유로 고볼륨이다 — 동기화·상품검색은
    대시보드 GET 마다 나가고, 429 는 청크 19개 × 외부 2회 × 내부 4회 = **150행대**까지
    간다. 그리고 `dashboard-data.ts` 가 ApiCallLog 를 **provider 무관 `take: 20`** 으로
    읽어 **UI 3곳**(증빙 페이지의 「최근 API 로그」 표 · 캠페인 사이드패널 · 정산 패널)에
    그대로 뿌리므로, 고볼륨 NAVER 행이 상위 20을 점거하면 **Meta App Review 증빙 표에
    Instagram 행이 0개**가 된다. 그래서 이 둘의 호출량은 요약 행의 카운터로만 센다.
    ⚠️ **401·429 를 개별 행으로 되살리지 말 것** — 그게 정확히 이 계측이 막으려는 실패
    모드다(최초 구현이 그렇게 했다가 교차검증에서 적발됐다).
    401 을 행으로 남기면 안 되는 별도 이유: 토큰 만료 후 재발급은 **자기치유 정상
    이벤트**라, 행을 남기면 "NAVER 실패 건수"가 구조적으로 0이 될 수 없어 실패율을 신호로
    쓸 수 없게 된다(패널에서 빨간 배지로도 렌더된다).
  - **재시도 소진 사례는 `429 + retrying:false` 행으로 찾는다.** `apiRequest` 의 루프
    뒤 throw 는 도달 불가다(`attempt === maxAttempts` 면 401·429 분기가 모두 거짓이라
    "그 외 에러"가 먼저 기록·throw 한다) — `statusCode: 0` 행을 찾으면 영구히 0건이다.
  - **Meta 증빙 완화의 적용 범위(정확히):** `getCachedMetaReviewChecklistData` 의
    **카운트 카드**만 provider 로 좁힌 전용 조회로 분리했다. 같은 페이지의 「최근 API
    로그」 표와 캠페인 사이드패널·정산 패널은 **여전히 공유 top-20 창**을 읽는다 —
    위 볼륨 규율(일시적 실패 미기록)이 지켜지는 한 NAVER 행이 드물어 문제되지 않지만,
    **그 규율을 완화하면 이 세 표면이 함께 깨진다.** 카운트 카드를 공유 창 필터로
    되돌리지 말 것.
  - ⚠️ **계측되지 않는 것:** 동기화(CHANGED/FULL)·상품검색의 **성공 호출량**, 일시적
    재시도의 **개별 이력**, 그리고 **토큰 발급 호출**(`/v1/oauth2/token`)이다. 토큰 발급은
    `getAccessToken`/`getNaverToken` 이 tally 컨텍스트 밖에서 캐시(약 2시간)를 두고 돌아
    `httpAttempts` 에 안 들어간다 — 콜드 인스턴스 + 401 재발급이면 1클릭당 미계측 2건의
    **체계적 과소집계**다. "네이버 호출 전량 계측"으로 읽지 말 것.
    특히 `searchNaverProducts`(`naver-commerce-api.ts` = `apiRequest` 와 **별개의 두 번째
    클라이언트**)는 종국 실패만 계측된다. ⛔ 종전 서술 "쿨다운이 없다"는 **SUPERSEDED**
    (2026-07-30, 아래 항목).

- **`searchNaverProducts` = 60초 TTL 쿨다운 (측정 후 결정, 2026-07-30):** 이 조회는
  `campaigns-handler` 의 `needsNaver` 가 참인 동안 **대시보드 GET 1회당 1회** 나갔다.
  - **계측 없이 소급 측정할 수 있다 — Sentry 서버 트레이스(`tracesSampleRate: 0.1`)의
    `http.client` **스팬**을 세면 된다.** `ApiCallLog` 행도, 새 `console.log` 도, 배포도,
    24시간 대기도 필요 없다(그래서 P7 볼륨 규율을 건드리지 않는다 — 성공 호출을 행으로
    남기면 provider 무관 top-20 창을 점거해 Meta 증빙 표가 무너진다).
    ⚠️ **`dataset=transactions` 로 찾으면 0건이라 "호출이 없다"고 오판한다** — 라우트
    핸들러 **안에서** 나가는 호출은 독립 transaction 이 아니라 부모의 **span** 이다
    (`after()`·크론에서 나가는 호출만 부모가 없어 transaction 으로 보인다). `dataset=spans`
    로 조회할 것. 이 경로는 다른 네이버·유료 호출량 조사에도 그대로 쓸 수 있다.
  - **실측(30일):** 총 776회 · 활성일 16~192회/일 · 비활성일 **0회**(재동기화 창 게이트가
    실제로 막고 있다는 증거) · 종국 실패 0건. 대시보드 GET 시계열과 활성일에 한 자리도
    다르지 않아 **GET당 정확히 1회**가 실측으로 확인됐다.
  - **사후 실측 — 쿨다운은 물렸다(2026-08-05, PR #171 배포 후):** 판정 근거는 비율이
    아니라 **60초 내 연쇄 요청(burst)의 거동**이다. 배포 전에는 60초 안에 2건 이상 들어온
    트레이스 8개(요청 39건)에서 **억제가 한 건도 없었고**(39요청 → 39호출), 배포 후에는
    burst 2개(요청 4건)에서 **3건이 억제됐다**(4요청 → 1호출). 요청 대비 호출 비율은
    0.99 → 0.43. **burst 내부 지표는 분모(트래픽 물량)와 무관하므로** "오너가 대시보드를
    덜 열어서"라는 교란과 갈린다 — 종전 관측이 못 가르던 지점이 이걸로 해소됐다.
    ⚠️ 배포 후 표본이 대시보드 스팬 7건·burst 2개로 작다. **방향과 기전이 예측과
    일치한다까지가 관측된 것이고 억제율의 크기는 아니다.** 트리거 캠페인 그레이스가
    2026-08-06 에 만료돼 재측정 창은 새 캠페인이 리드 창에 들어올 때까지 없다.
    - **재측정 시 함정 2종(위 `dataset=spans` 에 더해):** ①분모를
      `transaction:"GET /order-converter/api/dashboard-stats"` 로만 잡으면 샘플을 흘린다 —
      같은 라우트가 `executing api route (app) /...` 로 기록되는 트레이스가 있다(실제로
      한 건을 "대시보드 외 호출부"로 오분류한 전례). `transaction:"*dashboard-stats*"
      is_transaction:true` 로 잡을 것. ②`events-stats`(10% 샘플 환산 집계)만 보면 판정이
      흐려진다 — `events` 로 `timestamp`·`trace` 를 뽑아 조인하면 원시 실측이 되고,
      트레이스 단위 샘플링 덕에 "그 요청이 호출을 냈는가"가 결정적으로 읽힌다.
  - **호출량은 문제가 아니었다** — 무료 API·429 없음. **비용은 지연이었다:** 이 호출이
    GET 핸들러 안에서 동기 await 되고 avg 751ms / p95 1356ms 라 대시보드 GET
    평균(1735ms)의 약 43% 를 차지했다. 쿨다운의 근거는 호출 절감이 아니라 **응답시간**이다.
  - **구현:** `globalThis` TTL 캐시 + in-flight dedupe(`runSync` 와 같은 관용구). 모듈 지역
    변수가 아니라 `globalThis` 인 이유는 이 함수가 **서로 다른 라우트 번들 2곳**
    (campaigns-handler · `/api/naver/products`)에서 import 되어 모듈 인스턴스가 갈릴 수
    있기 때문이다. **실패는 캐시하지 않는다**(장애가 TTL 만큼 연장되지 않게).
  - ⛔ **TTL 을 재동기화 창에 근접하게 키우지 말 것.** 60초가 안전한 이유는 창
    (`shouldResyncCampaignPeriod`)이 리드 2일 + 그레이스 7일짜리라서다 — 이 조회의 존재
    이유("스토어에서 기간이 연장됐는데 판매관리엔 없다" 감지, 58 vs 발주 78 실사고의 축)는
    그대로 유지된다. 계약은 `naver-commerce-api.test.ts` 가 고정한다(특히 "TTL 이 지나면
    다시 조회한다").
  - **계측 쓰기에는 3초 상한이 있다**(`withWriteTimeout`). 기록은 `apiRequest` 의 p-queue
    슬롯 안이나 스트림 라우트의 `controller.close()` **직전**에서 await 되므로, 실패가
    아니라 **hang** 하면 발주서 작업이 실행시간 한도에 걸리거나 주문확인 버튼이 멈춘다.
    계측은 best-effort 라 상한 초과분은 버린다.
  - **논리 호출 ≠ HTTP 시도**를 섞지 말 것. "19회"는 논리 호출(청크)이고, 429 재시도가
    붙으면 HTTP 시도는 더 크다. 두 카운터를 따로 두는 이유다.
  - 전달은 `AsyncLocalStorage`(`runWithNaverCallTally`) — `apiRequest` 시그니처에 인자를
    추가하면 5곳 넘는 호출부 중 하나만 빠져도 계측에 구멍이 난다. `apiRequest` 는
    컨텍스트를 **진입 시 동기적으로** 읽는다(내부 p-queue 가 실행을 지연시켜 큐 콜백
    안에서 읽으면 유실될 수 있다).
  - ⚠️ **`skipped` 가 0인 이유는 "스킵 로직이 없어서"가 아니다.** `execute/stream` 에
    스킵 게이트가 **이미 있는데 죽어 있다** — `cacheForDate.stats.newOrders/preparing` 을
    읽지만 `__naverDailyCache` 의 실제 writer 전부(`naver-order-sync` `runFullSync` ·
    `campaigns-handler` 하이드레이션)는 엔트리 루트에 `newOrdersCount`/`preparingCount` 로
    쓴다. `.stats` writer 는 **0곳**이라 `skipChunk` 는 영구 false 다(레포 이관 커밋
    `b6aead5` 이후 그 파일은 한 번도 수정되지 않았다 — 반품/교환 작업과 무관하다).
    **따라서 후속 최적화는 "스킵 게이트 추가"가 아니라 "죽은 게이트의 형태 불일치 수정"
    이다.** 이걸 혼동하면 `skipped>0` 이 새 최적화의 효과인지 옛 게이트의 발화인지
    구분되지 않는다.
  - 계측 기록은 **절대 throw 하지 않는다**(실패 시 `console.error` 만) — 계측이 발주서
    생성을 깨면 안 된다. 계약은 `naver-api-usage.test.ts` 가 고정한다.

- **Product-Order Query Paging = `page` 파라미터 (계약 확정 2026-07-30):**
  `GET /v1/pay-order/seller/product-orders`(조건형 상품 주문 상세 내역 조회)는 **`page` 로
  페이지네이션한다.** 근거는 네이버 커머스API 공식 기술지원 Discussion
  [#2476](https://github.com/commerce-api-naver/commerce-api/discussions/2476) 의 실제 요청
  예시(`{from, to, rangeType, pageSize: 300, page: 3, ...}`).
  - ⚠️ **이 레포는 5곳 전부에서 `page` 를 보내지 않아 창당 `pageSize`(300) 초과분을 조용히
    유실했다** — execute · execute/stream · campaign-orders · closed-campaign-cache ·
    **naver-order-sync `runFullSync`**. 가장 위험한 건 `runFullSync` 다: **스냅샷 빌더**라
    절단이 대시보드·모바일 매출·정산·클레임·재구매, 그리고 발주 조회 생략 게이트
    (`order-fetch-window`)의 **근거 자체**로 번진다. 실측(2026-07-30) 하루 최대 224건으로
    아직 터지지 않았지만 상한의 75%였다.
  - **SSOT 는 `src/lib/order-converter/product-order-paging.ts`** 하나다. 종료 조건은
    정산 동기화와 같은 관용구(`반환 수 < pageSize` → 마지막). 응답에 총건수 메타가 있는지
    확인할 수 없어 이 방식이 계약 가정을 가장 적게 한다.
  - **방어 2종(실 API 검증 불가 환경이라 필수):** ①**중복 페이지 감지** — `page` 가 무시되면
    같은 1페이지가 무한 반복되므로 직전 페이지의 첫 `productOrderId` 가 같으면 중단하고
    `pageParamSuspect` 를 켠다. ②**`productOrderId` dedup** — 중복 라인이 발주서에 실리면
    **같은 주문이 두 번 발송**된다(되돌릴 수 없다).
  - `hitPageLimit`·`pageParamSuspect` 는 **삼키지 않는다** — 발주서 누락으로 직결되는 신호다.
  - **`rangeType` = 창의 날짜 술어. 호출부 4곳 전부 `PAYED_DATETIME` 명시 완료**
    (오너 결정 2026-07-30 — 1·2단계 모두 착지).
    Discussion [#3614](https://github.com/commerce-api-naver/commerce-api/discussions/3614)
    실측: `ORDERED_DATETIME` 과 `PAYED_DATETIME` 결과가 다르고, 주문일 익일 결제 건은
    `ORDERED_DATETIME` 으로 **양쪽 날짜 모두에서 안 잡힌다**. 관측된 허용값은
    `ORDERED_DATETIME`·`PAYED_DATETIME`·`DISPATCHED_DATETIME`(#3551)·
    `CLAIM_COMPLETED_DATETIME`(#3440).
    - **1단계(PR #162): 발주서를 만드는 경로 2곳** — `order-fetch-window` →
      주문확인(execute/stream)·발주요청(execute). 스냅샷 미접촉이라 집계 영향 0.
    - **2단계: 스냅샷 경로 3곳** — `runFullSync`(스냅샷 빌더)·`closed-campaign-cache`·
      `campaign-orders`. 착수 전 우려("귀속 기준이 갈려 재빌드 판단 필요")는 **기본값 실측
      확정으로 소멸**했다 — 같은 값을 명시하는 것이므로 동작 변화가 없다(아래 ✅).
    - **누락 방지는 `product-order-range-type.contract.test.ts` 가 담당한다** — 헬퍼를 부르는
      **모든** 파일을 소스 스캔해 각 호출이 `PRODUCT_ORDER_RANGE_TYPE_PAYED` 를 넘기는지
      확인하고(미래 호출부까지 덮는 유일한 수단), `runFullSync`·`fetchClosedCampaignOrders`
      두 경로는 mock 으로 **실제 쿼리에 실리는지**까지 본다. 새 호출부가 술어를 빼먹는 것은
      **침묵형 회귀**다(조회는 정상 동작하고, 어긋난 사실은 네이버가 기본값을 바꾸는 날
      "발주서에 주문이 빠졌다"로만 드러난다). 파라미터 자체는 옵셔널로 남긴다 —
      `DISPATCHED_DATETIME` 같은 다른 술어가 필요한 호출부가 생길 수 있고, 모듈이 술어를
      강제하면 그때 우회가 생긴다. ⚠️ 종전 계약 "생략 시 키 없음"은 이제 **메커니즘 전용**
      (빈 문자열을 보내지 않는다)이고 `product-order-paging.test.ts` 소관이다 —
      "스냅샷 경로의 현행 동작 보존"이라는 1단계 범위 장치로 읽지 말 것.
    - **왜 `PAYED_DATETIME` 인가:** 스냅샷의 날짜 귀속이 이미 `paymentDate` 우선
      (`orderToDateKey`)이라, 창의 술어를 결제일로 맞추면 **조회 창과 저장 키가 일치**한다.
      `order-fetch-window` 의 **날짜별 생략 게이트는 그 일치를 전제로 성립**하는데, 종전에는
      그 전제가 "API 기본값이 우연히 맞기를 바라는" 상태였다. 매출 정의(결제 기준)와도 맞다.
    - ✅ **API 기본값은 `PAYED_DATETIME` 이었다(2026-07-30 프로덕션 실측 확정).** 근거는
      **불일치 날짜가 `2026-07-12` 로 명시 전후 동일**하다는 것이다 — 명시 전(07-30T08:25Z)
      행의 `metadata.countMismatchDates` 와 명시 후(07-30T10:26Z) 행의
      `metadata.countMismatch` 가 같은 날짜를 가리킨다. 같은 창에서 같은 날짜가 나왔으므로
      창 술어가 바뀌지 않았음이 확정된다. 문서 도메인은 fetch 차단이고 Commerce 자격증명이
      로컬에 없어 **사전** 확인은 불가능했다.
    - ⛔ **"명시 전후의 `countMismatch` 가 `41/43` 으로 동일했다"로 적지 말 것(종전 서술
      정정, 2026-07-30 DB 실측).** 명시 전 행에는 **`countMismatch` 키 자체가 없다** —
      #148 이 넣은 필드명은 `countMismatchDates`(날짜만)였고, #162(`8201fe2`)가 이를
      **`countMismatch`(`날짜:조회수/기록수`)로 개명하면서 수치를 처음 담았다**(`rangeType`
      도 같은 커밋). 즉 **비교가 성립하는 해상도는 날짜까지이고, 수치 `41/43` 은 "전" 쪽에
      존재한 적이 없다.** 결론은 유효하지만 근거를 수치 일치로 과장하지 말 것 —
      "증거가 없었다"가 아니라 **"증거가 저해상도였다"** 가 정확하다.
      (수치 쪽 교차 근거는 #145 실사고 분석의 조회 41 &lt; 기록 43 이다: 07-12 스냅샷 43건 중
      `paymentDate` null 2건.)
    - ⚠️ **`ApiCallLog.metadata` 는 JSON 문자열 컬럼이다** — `metadata.countMismatch` 같은
      객체 접근은 `undefined` 를 돌려줘 "계측이 비었다"로 오독하게 된다. 반드시 `JSON.parse`
      후 읽는다.
    - **따라서 1·2단계 모두 동작 변화 0 인 명시화였다** — 기본값과 **같은 값**을 명시하는
      것이므로 스냅샷 귀속 기준이 바뀌지 않았고 **재빌드가 불요**했다. 2단계를 별도 PR 로
      나눈 이유는 위험이 아니라 blast radius 다(스냅샷을 소비하는 표면 전부 — 착지 후 관측이
      필요하다).
    - ⚠️ **2단계의 주 경로는 자동으로 검증되지 않는다.** `runFullSync` 는 크론이 돌리지
      않는다(크론은 `runSync('CHANGED')` 만 돌고 FULL 은 L1 캐시+DB 가 **완전 무데이터**인
      부트스트랩에서만 발화한다). 즉 프로덕션 트래픽만으로는 스냅샷 경로의 새 술어가 한 번도
      실행되지 않을 수 있다 — 착지 후 확인은 "무엇을 볼까"보다 **"무엇이 그것을 실행시키나"**
      를 먼저 물어야 한다. 계약 테스트의 mock 검증이 이 공백을 메우는 주 수단이고, 프로덕션
      관측은 아래 회귀 지표(스냅샷 `ordersCount` 비감소 · `countMismatch` 기준선)로 한다.
    - ⚠️ **기본값이 확정됐다는 것이 "명시가 불필요하다"는 뜻은 아니다.** 네이버가 예고 없이
      기본값을 바꾸면 생략 게이트의 전제("조회 창 술어 == 스냅샷의 `paymentDate` 귀속")가
      조용히 깨진다. 명시는 그 리스크를 없앤다 — **되돌리지 말 것.**
    - **관측 방법(2단계·회귀 확인용):** 계측 요약 행(`naver_op_confirm_order`)의
      `metadata.countMismatch`(`날짜:조회수/기록수`)와 `metadata.rangeType` 을 대조한다.
      기준선 `2026-07-12:41/43`. `rangeType` 필드가 "언제부터 명시된 값인가"를 가르는 표식이다
      (Vercel 로그 보존이 1일이라 로그로는 사후 추적이 안 된다).
  - **조회 결과와 스냅샷이 어긋나는 구조적 원인 2종**(2026-07-30 실측으로 3종 → 2종 축소):
    ①**`paymentDate` 없는 주문**(결제대기 등) — 결제일 기준 창이 돌려주지 않는데 스냅샷은
    `orderDate→orderCreateDate` 폴백으로 귀속한다. 실측 `2026-07-12` 의 43건 중 2건이 이것이고
    그게 `41/43` 의 전부다. ②**탈퇴한 구매자의 주문은 커머스API 가 아예 제공하지 않는다**
    (Discussion [#3133](https://github.com/commerce-api-naver/commerce-api/discussions/3133)
    공식 답변).
    ⛔ 종전에 3번째로 적었던 "`rangeType` 불일치"는 **원인이 아니었다** — 기본값이 이미
    `PAYED_DATETIME` 이었음이 확정됐다(위). 그래서 조회수 대조는 **영구히 관측 신호**이고
    차단 근거가 될 수 없다는 결론은 그대로다(원인 ①②는 남는다).
  - `pageSize` 상한은 문서화돼 있지 않다 — 300 을 유지한다(추측으로 올리지 말 것).

- **Pending-Order Fetch Window = order-fetch-window SSOT (2026-07-30):** 발주 대상 조회의
  창·청크·생략 판정은 `src/lib/order-converter/order-fetch-window.ts` 하나다. 주문확인
  (`execute/stream`)·발주요청(`execute`) 두 라우트가 각자 사본을 갖고 있었고 **이미 어긋나
  있었다**(상태 필터: stream 은 `PRODUCT_READY` 포함, execute 는 미포함 → 같은 캠페인에서
  발주서가 갈릴 수 있었다).
  - **청크는 KST 자정에 정렬한다(불변).** 종전엔 `startDate`(UTC 자정 = **KST 09:00**)에서
    23.9h 씩 전진해 "07-12" 라벨 청크가 실제로는 `07-12 09:00 ~ 07-13 08:54` 를 덮었다
    (24h 중 07-12 는 15h 분). 그 위에서 날짜 단위 판정(생략·대조)을 하면 **다른 날짜의 근거를
    보게 된다.** `runFullSync` 가 이미 KST 자정 순회라 선례가 있다.
  - **창 시작은 `resolveCampaignQueryStartMs`(sale-window SSOT)** — 저장 창과 판매관리 창 중
    **이른 쪽**. 종전 두 라우트는 `startDate` 만 자체 파싱해 판매관리 창을 무시했다(2026-07-15
    실사고 계열). 그래서 캠페인 조회에 `salesCampaigns` 를 동승시켜야 한다.
  - **생략은 스냅샷이 적극 증언할 때만** — 4조건 전부: ①변경피드 커서 건강(6h 이내)
    ②오늘·어제 아님 ③스냅샷 **행 존재** ④`newOrdersCount === 0`. **"모름"은 생략하지
    않는다**(행 없음은 "주문 0인 날"과 "동기화 미도달"이 구분 안 됨). 근거 로드가 실패하면
    **전량 조회로 안전 강등**한다 — 못 읽은 것을 "발주 대상 없음"으로 오독하면 발주서가 비어
    나간다.
  - ⚠️ **바로 위 *"행 없음 = 모름"* 은 이 게이트 전용 판정이다 — 표시 계층으로 옮기지 말 것**
    (2026-08-03 실사고). 여기서 모름으로 보는 이유는 **발주서 누락(P0)** 이 걸려 있어 틀릴 때
    비싼 쪽으로 기울이기 때문이지, "행이 없으면 실제로 알 수 없다"는 사실 주장이 아니다.
    한 세션이 이 문장을 근거로 **타임라인 차트가 그 날짜를 0 으로 그리는 것은 거짓말**이라고
    두 번 보고했고, 둘 다 틀렸다.
    **실제 판별은 `syncType` 으로 한다:** `runFullSync` 는 30일을 **전수 열거**해 upsert 하므로
    주문 0인 날도 행이 생기고(실측: `ordersCount=0` 행이 FULL 구간에 몰려 있다), CHANGED 는
    `ordersByDate`(변경피드에 뜬 날짜)만 upsert 한다. 따라서 **CHANGED 구간의 행 부재는
    원칙적으로 "그 날짜에 귀속된 주문이 없다"** 이고, 그 구간을 0 으로 표시하는 것이 옳다.
    커서가 전량 성공 시에만 전진하는 at-least-once 구조라 놓친 창은 재조회된다.
    ⛔ 그렇다고 **이 게이트를 완화하지는 말 것** — 표시가 틀리면 화면 한 칸이지만 발주가
    틀리면 주문이 통째로 빠진다. 두 계층은 **틀릴 때의 대가가 다르므로 판정도 다르다.**
  - ⛔ **`isDirty` 를 게이트에 넣지 말 것.** `isDirty` 는 "FULL 로 다시 받아야 하나"라는
    **다른 질문**이다. (종전에 함께 적혔던 "48행 중 45행이 상시 true" 근거는 아래 *Snapshot
    Dirty Invalidation* 으로 수리됐다 — 그 절반은 더 이상 유효하지 않지만, 게이트에 넣는 것은
    **발주서 누락(P0)** 이 걸린 별도 오너 판단이다.)
  - **게이트 근거는 발주 대상의 상위집합이어야 한다.** `newOrdersCount` 로 "발주 대상 0"을
    판정하므로, `PENDING_FULFILLMENT_STATUSES` 가 그 카운터 범위를 벗어나면 **그 상태만 남은
    날짜를 조용히 생략**해 발주서에서 누락시킨다(P0). 그래서 `countStatuses` 에
    **`PRODUCT_READY` 를 추가**했다(dispatch 라우트가 실제로 취급하는 값인데 세 카운터
    어디에도 없었다 — 실측 관측 0건이라 동작 변화는 없다). 포함 관계는
    `order-fetch-window.test.ts` 가 **양방향**(선언 목록 ⊆ 커버 범위 · 구현이 실제로 그렇게
    세는지)으로 고정한다 — 한쪽만 고치는 드리프트를 막는다.
  - **조회 온전성 대조 = 스냅샷을 oracle 로.** 그 날 조회 라인수 < 스냅샷 `ordersCount` 면
    절단·부분 실패 신호이므로 **발주서를 만들지 않고 중단**한다. 종전엔 이 경로에 비교 대상이
    아예 없어 "이번 조회가 온전했는가"를 물어볼 수 없었다.
  - **페이징은 `product-order-paging` 이 담당한다**(위 항목). 종전의 "창 이분 재조회" 우회는
    계약이 확정돼 **제거됐다** — 5개 호출부 전부가 이제 `page` 를 따라간다.
  - **`no-work` 는 실패가 아니다.** "발주 대상 0건"과 "매핑 불일치"는 처방이 정반대인데 종전엔
    같은 문구("매핑 룰에 해당하는 주문이 없습니다")를 써서 **멀쩡한 매핑을 의심하게** 만들었다
    (baseline 첫 행이 정확히 그 경우). 두 상황을 분리하고, 계측 요약의 `outcome`
    (`success|no-work|failure`)으로 실패율에서 benign 을 분리한다.

- **Snapshot Dirty Invalidation = 무효화 폭 ⊆ 갱신이 커버하는 폭 (2026-07-30):**
  `NaverOrderSnapshot.isDirty` 를 찍는 유일한 API 는 **타깃** `naverOrderSnapshotRepository
  .markDirty(dateKeys)` 다. 창 전체를 찍던 `markAllDirty()` 는 **은퇴했다 — 되살리지 말 것.**
  - **왜 반드시 타깃이어야 하는가:** dirty 를 **지우는** 주체는 "그 날짜의 `upsertDaily`" 하나뿐이고,
    크론은 `runSync("CHANGED")` 만 돌아 **변경피드에 잡힌 날짜 + 오늘**만 upsert 한다
    (`runFullSync` 는 부트스트랩 전용이라 평상시 실행되지 않는다). 따라서 설정 폭(30일) > 해제
    폭(1일)이면 플래그는 **단조 증가**한다. 실제로 그렇게 됐다: 실측 **48행 중 47행이 상시 true**
    (clean 은 오늘 1행뿐, `syncType=FULL` 20행은 부트스트랩 이후 한 번도 재기록되지 않음).
    그 결과 "이 날짜가 정말 재조회가 필요한가"를 물어볼 수 없어 **관측 가치가 0** 이 됐고,
    PR #145 가 발주 조회 생략 게이트에서 `isDirty` 를 제외해야 했다.
  - **무효화는 정밀 갱신의 폴백이다(순서 함정).** `syncOrdersByIds` 로 query-by-id 재조회를 하는
    경로는 그 날짜를 `isDirty:false` 로 upsert 하므로, 그 **뒤에** dirty 를 찍으면 **방금 자기가 한
    갱신을 되돌린다.** 발송처리(dispatch) 라우트가 정확히 그랬다 — 지금은 `syncOrdersByIds` 가
    **실패했을 때만** `markDirty(datesToInvalidate)` 로 폴백한다(그 실패가 `console.warn` 하나로
    묻히던 P0 축도 함께 막힌다).
  - **기간만 아는 호출부는 `enumerateSnapshotDateKeys(startMs, endMs)`** 로 날짜키를 만든다
    (KST 자정 정렬 · 30일 창 클리핑 · 종료 미정은 오늘까지). 마감취소가 이 경로다.
  - **"영향 날짜를 모른다"는 창을 넓힐 근거가 아니다.** 모르면 창을 넓히지 말고 정밀 갱신 경로
    (`syncOrdersByIds`)를 쓴다.
  - **기존 dirty 는 자연 해소되지 않는다** — 스냅샷 행을 지우는 코드가 레포에 없다. 구조 수정과
    짝을 이루는 1회 정리는 `scripts/clear-stale-snapshot-dirty.ts`(예행 기본, `--apply` 는 오너
    승인 사안). 오늘·어제는 의도적으로 남긴다(어차피 TTL 이 재조회를 태우고, 발주 생략 게이트도
    이 둘을 생략 대상에서 뺀다).
  - 계약은 `snapshot-dirty-lifecycle.contract.test.ts`(불변식 + 소스 스캔) ·
    `naverOrderSnapshotRepository.test.ts`(쿼리 폭) · `naver/dispatch/route.test.ts`(성공 시
    무효화 0 · 실패 시 아는 날짜만)가 고정한다.
  - ⚠️ **이 수리의 목표는 네이버 호출 절감이 아니다.** 폴링 상한(30초) < CHANGED 쿨다운(45초)
    이라 폴링 GET 은 추가 네이버 호출을 만들지 못하고, `isSnapshotStale` 이 당일에 1분 TTL 을
    주므로 dirty 를 전부 지워도 `staleDates` 는 비지 않는다. 실제 이득은 ①방문당 대시보드 GET
    감소(각 GET 이 30일 집계를 도는 무거운 라우트) ②"갱신 중" 라벨의 신호 가치 ③**플래그의
    관측 가치 회복**이다. 기대 효과를 호출 절감으로 과장하지 말 것.

- **Repurchase Metric Definition:** "재구매"는 회차간(앞선 회차 구매 이력자)
  기준이다 — 같은 캠페인 안의 2회 이상 구매가 아니다. per-person 키는
  `ordererNo`. 구현은 `src/lib/cross-campaign-repurchase.ts`.

- **Collection Cost Guard:** 새 유료 스크래핑(Apify/RapidAPI) 호출 경로 추가는
  지양한다 — 이미 수집 중인 무료 데이터(Instagram Graph Tier0)의 재사용을
  먼저 검토한다(오너 원칙). 유료 API 호출자는 화이트리스트 계약 테스트
  (`instagram-scrape-callers.contract.test.ts`)에 등록해야 한다.
  `INSTAGRAM_COLLECT_MODE=mock`에서 no-op인 것은 **engagement 수집기 2종**
  (`instagram-engagement-collector`·`campaign-engagement-collector`)뿐이다 —
  팔로워 수집기(`instagram-collector`)의 mock은 no-op이 아니라 **난수를 만들어
  저장한다**(기존값 +50~200 증분). mock은 명시 opt-in이며, 미설정은 mock이
  아니라 "미설정"으로 거부된다(`src/lib/collect-mode.ts`, P9 참조).

- **Mock Collection = sqlite 전용 (서술만으로는 못 막았다 → 이제 코드가 막는다,
  2026-07-30):** 위 항목의 "mock은 난수를 저장한다"는 경고는 **서술로만** 있었고
  재발 방지 장치가 없었다. 그 사이 프로덕션에 `source="MOCK"` 스냅샷이 남았고,
  `ApiCallLog`의 해당 호출 시각이 팔로워 크론 스케줄과 무관해 **프로덕션 크론이 아니라
  로컬 세션 유입**으로 판정됐다(오너 승인 후 삭제, 잔여 0건 확인 — 건수는 P9 항목에
  한 번만 적는다). 위험의 실체는 모드 이름이 아니라 **그 쓰기가 어디로 가는가**다 —
  레포 `.env`의 `DATABASE_URL`이 프로덕션 DB이므로(P0) `npm run dev`·`scripts/*`
  에서 mock을 켜면 그대로 프로덕션 적립이다.
  - **판정 SSOT는 `mockCollectBlockedReason`**(`src/lib/collect-mode.ts`) —
    `mode === "mock"` × `isRemoteDatabaseUrl()`(`prisma-client.ts`) 조합만 거부한다.
    `resolveCollectMode`의 계약("설정됐는가" 하나)은 **바꾸지 않았다**: 같은 `null`이
    "미설정"과 "거부됨"을 동시에 뜻하면 호출부가 사유를 잘못 보고한다(짝 문구
    `collectModeUnsetReason`이 "미설정"이라 거짓 원인이 된다).
  - **거부 방식은 호출부의 관례를 따른다:** 크론 수집기 2종(`instagram-collector`·
    `youtube-collector`)은 `result.errors`에 사유를 담고 skip(throw 하면 크론 전체가
    죽는다), 사용자 트리거 라우트(`/api/sellers/[id]/channel-info`, 플랫폼 3종)는
    500 에러 응답이다. **조용한 skip은 금지**(P0 No Silent Failure).
  - **쓰기 차단선(구조적 백스톱):** `recordSellerMetricsSnapshot`이 **MOCK 접두사
    라벨 + 원격 DB** 조합을 throw로 거부한다. 호출부 게이트를 거치지 않는 새 writer가
    생겨도 막힌다. **mock 라벨은 이제 `MOCK` 하나다**(유튜브의 `MOCK_API`는 은퇴 — 아래
    항목). 접두사 매칭은 그대로 두는데, 목적이 "현행 두 라벨 수용"에서 **"미래의 `MOCK_*`
    변형이 차단선을 우회하지 못하게"**로 바뀌었을 뿐이다 — 정확 일치로 좁히지 말 것.
  - ⚠️ **`DATABASE_URL` 미설정·빈값은 원격으로 보지 않는다.** 연결 문자열이 없으면
    Prisma가 붙지도 못해 오염 경로가 아니고(쿼리 시점에 스스로 실패한다), 원격으로
    취급하면 DB를 안 쓰는 단위 테스트·CLI가 이유 없이 막힌다. `createPrismaClient`의
    데모 모드 가드가 이미 같은 판정을 쓴다.
  - **거부 문구에 `DATABASE_URL`을 담지 않는다**(자격증명 포함 — P0). "원격 DB(비-sqlite)"
    까지만 말한다.
  - 계약은 `mock-collect-write-guard.contract.test.ts`가 고정한다 — 두 층의 동작 +
    **음성 대조군**(sqlite면 mock도 저장 · 원격이어도 실수집 라벨은 저장) + 소스 스캔
    (`resolveCollectMode` 호출부 전수: 게이트를 부르지 않으면 실패, 면제는 "mock을
    무조건 거부"하는 engagement 수집기 2종뿐이고 그 사실도 스캔으로 확인한다).

- **Snapshot Source Label = 실행 경로의 사실(모드 문자열 아님, 2026-07-24):**
  `SellersHistory.source`는 "어느 경로가 이 데이터를 썼는가"를 사후에 복원하는
  **유일한 관측 창구**다 — Vercel의 sensitive env는 `vercel env pull` 시 빈값으로
  내려와 `INSTAGRAM_COLLECT_MODE`의 실제 값을 읽을 수 없다. 그래서 라벨은 설정값이
  아니라 **실제로 성공한 경로**여야 한다.
  - **실사고:** 팔로워 크론(`instagram-collector`)이 모드 문자열을 그대로 라벨로
    옮겨서, 이 파일에서 Apify 실행 코드가 제거된 뒤에도 `mode=apify` 이면 **부르지도
    않은 `APIFY_API`** 가 스냅샷에 찍혔다. 출처를 믿을 수 없어 `ApiCallLog` 교차검증이
    필요했다.
  - **크론 팔로워 수집 라벨(SSOT = `INSTAGRAM_SNAPSHOT_SOURCE`,
    `src/lib/collectors/instagram-collector.ts`):** `MOCK`(난수·외부 호출 없음) ·
    `INSTAGRAM_SCRAPER`(공개 웹 프로필 `/api/v1/users/web_profile_info/` 성공) ·
    `INSTAGRAM_API`(스크래퍼 실패 후 Meta Graph `business_discovery` 폴백 성공).
    **비-mock 2단 폴백의 두 갈래는 라벨이 서로 달라야 한다** — 같아지면 이 필드로
    경로를 사후 구분할 수 없어 관측 가치가 0이 된다(회귀 테스트
    `instagram-collector-source.test.ts`가 고정).
  - **유튜브 라벨(SSOT = `YOUTUBE_SNAPSHOT_SOURCE`,
    `src/lib/collectors/youtube-collector.ts`, 2026-07-31):** `MOCK`(난수·외부 호출 없음 —
    **인스타와 같은 문자열**) · `YOUTUBE_API`(Data API v3 `channels?part=statistics` 성공) ·
    `APIFY_API`(Apify 액터 — 수집기는 run 시작만 하고 적립은 웹훅
    `/api/cron/apify-webhook/youtube`가 한다. 그래서 **웹훅이 이 상수를 import**해 쓴다).
    - **인스타와 같은 사고가 여기 그대로 남아 있었다.** 두 호출부가
      `${mode.toUpperCase()}_API`로 라벨을 **모드에서 파생**했는데, 실행 경로는 셋인 반면
      분기는 `apify`·`mock`이 아닌 **모든** 값을 Data API로 흘린다 → `=api`면 `API_API`,
      **`=instagram`이면 `INSTAGRAM_API`**(인스타 Graph 폴백 라벨과 **충돌** — 같은 라벨이
      두 플랫폼의 다른 경로를 가리키면 사후 구분이 불가능해진다), `=mock`이면 `MOCK_API`.
    - **소급 의미 변경 없음(실측 2026-07-31):** 프로덕션에 `MOCK_API`·`YOUTUBE_API` 행이
      **0건**이고 YouTube 셀러 자체가 0명이라, 이 통일은 과거 행을 재해석하지 않는다.
      (인스타의 과거 `APIFY_API` 행은 진짜 Apify라 여전히 **소급 수정하지 않는다** — 아래.)
    - 회귀 테스트 `youtube-collector-source.test.ts`가 고정한다(모드 문자열이 라벨을
      좌우하지 않음 · `INSTAGRAM_API` 충돌 부재 · 세 라벨 상호 구분).
  - **다른 경로의 기존 라벨은 그대로다:** `GRAPH_ER`(주간 ER 크론) ·
    `AI_ANALYZE`(수동 분석) · `APIFY_API`(수동 채널정보 `/api/sellers/[id]/channel-info/**`
    — **여기는 지금도 진짜 Apify를 쓴다**) · `INTERNAL`(운영자 수동 입력·서비스 갱신).
    과거 `APIFY_API` 행 중 일부는 진짜 Apify라 **소급 수정하지 않는다.**
  - **소비처는 전부 "특정 값 아님" 판정이므로 새 라벨 추가는 안전하다**(추가 전 재확인):
    수집기 2종의 재수집 게이트 `source: { not: "INTERNAL" }` ·
    셀러 상세 이력표의 `=== "MANUAL" ? 수동 : 자동`. **화이트리스트로 바꾸지 말 것** —
    바꾸는 순간 새 경로가 조용히 누락된다.
  - 값이 있는데 라벨이 없으면 **저장하지 않고 실패로 남긴다**(P0 No Silent Failure) —
    출처 불명 행이 쌓이면 이 필드가 다시 못 쓰게 된다.

- **Paid-Call Observability = `ApiCallLog`(전용 테이블 신설 금지):** 유료 수집
  호출의 지출·실패 기록은 **기존 `ApiCallLog` 한 테이블**에 모은다. 규약은 기존
  수집기(`instagram-collector`·`youtube-collector`)를 따라 **`provider`=플랫폼**
  (`ApiProvider` 유니온 = INSTAGRAM/YOUTUBE/NAVER/INTERNAL),
  **`permissionScope`=벤더·경로 판별자**다. `@@index([provider, calledAt])`와
  `@@index([permissionScope, calledAt])`가 이미 있어 월별 집계가 인덱스를 탄다 —
  전용 테이블을 새로 파면 마이그레이션 비용만 늘고 얻는 게 없다.
  - **Apify 댓글 수집(Tier0 보조)**: `permissionScope='apify_comment_scraper'`.
    Tier0(무료 Graph)가 성공해도 **댓글 텍스트는 Graph가 원천 미제공**이라 유료
    액터를 한 번 더 부르는 구조이고, 과금이 **결과(댓글) 수 비례**라
    `metadata.receivedComments`가 곧 비용이다. SSOT는
    `src/lib/seller-analysis/apify-comment-usage.ts`(기록·단가·지문) +
    `…-report.ts`(월별 집계, 순수).
  - **성공·실패 양쪽 다 1행 남긴다**(P0 No Silent Failure). 댓글 수집은 "실패해도
    분석은 진행" 설계라 실패가 가장 조용히 묻히는 지점이다. 그래서
    `fetchCommentsByShortcode`는 HTTP·네트워크 실패에 **throw 하지 않고**
    관측치(`usage.ok=false`)를 돌려준다 — throw 로 되돌리면 실패 경로의 지출이
    다시 안 보이게 된다.
  - **호출이 실제로 나간 경우만 기록한다.** 토큰 미설정·타깃 0건 같은 skip은 지출이
    없으므로 남기지 않는다 — 넣으면 "월 호출 횟수"가 부풀어 지표 자체가 못 쓰게 된다.
    (댓글 없이 끝난 Tier0는 `sourceTier` 문자열로 이미 구분된다.)
  - ⛔ **토큰·시크릿을 `endpoint`·`metadata`·`errorMessage`에 넣지 않는다**(P0).
    실제 요청 URL에는 `?token=`이 붙으므로 `endpoint`는 **호스트·쿼리 없는 경로
    라벨**만 쓰고(`COMMENT_ENDPOINT_LABEL`), 계정 구분이 필요하면 비가역 지문
    (`describeApifyToken` = sha256 앞 6자)만 남긴다. 계약 테스트가 기계로 강제한다.
  - **월별 확인:** `npm run report:apify-comments`(읽기 전용). 판정선은 **계정당
    월 $5**다 — 크레딧이 계정 간에 이동하지 않으므로 풀 합계만 보면 한 계정의 소진을
    놓친다. 리포트가 토큰 지문별로 쪼개는 이유이고, 이 분해를 합계로 되돌리지 말 것.

- **Gemini Call Observability = 종국 실패만 (2026-08-01, 무증상 장애에서 나왔다):**
  Gemini 호출은 도입 전까지 **한 건도 계측되지 않았다**(실측: 최근 10일 `ApiCallLog`
  가 NAVER 6행·INSTAGRAM 2행, **Gemini 0행**). 그 상태에서 **프로젝트 월 지출 상한이
  초과돼 전 호출이 `429 RESOURCE_EXHAUSTED` 로 죽어 있었는데 아무 신호가 없었다** —
  운영자가 버튼을 눌러 실패를 눈으로 보기 전까지 모르고, 시스템 레이더도 초록이다.
  죽는 표면은 콘텐츠 가이드 하나가 아니라 **키워드 추출·셀러 분석·아웃리치 메시지·
  어시스턴트·VOC·가격표·클레임 추출 전부**다(같은 클라이언트를 탄다).
  SSOT는 `src/lib/agent/gemini-usage.ts`.
  - **남기는 것 1종:** 종국 실패 1행. `provider='INTERNAL'`(외부 SNS 플랫폼이 아니라
    내부 AI 경로) · `permissionScope='gemini_generate'`. `metadata` 에 `kind`
    (`NO_KEYS`·`NETWORK`·`HTTP`·`KEYS_EXHAUSTED`) · `model` · `keysTried` ·
    `lastKeyFingerprint` · `elapsedMs` · `spendCapSuspected`.
  - ⛔ **행을 만들지 않는 것 2종: ①성공한 개별 호출 ②다음 키로 넘어가는 중간 실패.**
    NAVER 계측과 같은 이유다 — `dashboard-data.ts` 가 ApiCallLog 를 **provider 무관
    `take: 20`** 으로 읽어 UI 3곳(Meta 증빙 「최근 API 로그」 표·캠페인 사이드패널·
    정산 패널)에 뿌리므로, 고볼륨 행이 상위 20을 점거하면 **Meta App Review 증빙 표에
    Instagram 행이 0개**가 된다. 어시스턴트·콘텐츠 가이드(레이싱 2발)가 정확히 그
    고볼륨이다. 성공 계측이 필요해지면 개별 행이 아니라 **오퍼레이션 요약 1행** 방식을
    쓸 것(`recordNaverOperationUsage` 선례).
  - **`spendCapSuspected` 가 왜 따로 있나:** 429 는 "잠깐 몰렸다"와 "이번 달 예산이
    끝났다"가 **같은 코드**다. 후자는 재시도로 절대 낫지 않으므로 사유 문자열의 상한
    표현으로 갈라 둔다.
  - **상한은 키가 아니라 프로젝트 단위다 — 그래서 로테이션의 효과가 갈린다.**
    같은 프로젝트의 키를 아무리 돌려도 같은 429 지만, **다른 프로젝트·계정의 키**를
    풀에 넣으면 로테이션이 실제로 우회한다(`BACKUP_GEMINI_API_KEY`, 콤마 다중 허용 —
    `collectGeminiApiKeys`). 그래서 이 계측에서 실무 가치가 가장 큰 필드가
    **`lastKeyFingerprint`** 다: "죽은 게 어느 키인가"를 알아야 그 키만 빼거나 다른
    계정 키를 앞에 둘 수 있다.
    🪤 **키가 1개면 로테이션은 돌지 않는다** — 실측 2026-08-01: 로컬 `.env` 에
    `GEMINI_API_KEY` 1개뿐이고 `BACKUP_GEMINI_API_KEY` 가 없어 3회 시도가 전부 **같은
    키**를 쳤다. 그 결과를 "Gemini 전면 장애"로 읽었으나 **프로덕션은 Vercel env 를
    쓰므로 키 구성이 다를 수 있다**(P9 「검증 판정 위생」 — 이 도구가 보는 범위가
    무엇인가). 로컬 키 실패를 프로덕션 장애의 근거로 쓰지 말 것.
  - ⛔ **키를 `endpoint`·`metadata`·`errorMessage` 에 넣지 않는다**(P0 — 레포 public).
    요청 URL 이 `?key=<원문>` 이므로 `endpoint` 는 호스트·쿼리 없는 경로 라벨
    (`geminiEndpointLabel`)만 쓰고, 키 구분이 필요하면 비가역 지문(sha256 앞 6자)만
    남긴다. **오류 본문은 우리가 만들지 않으므로**(프록시가 요청 URL 을 에코할 수 있다)
    저장 직전 `redactGeminiSecrets` 로 한 겹 더 지운다.
  - **계측되지 않는 것:** 성공 호출량·토큰 사용량·중간 재시도 이력. "Gemini 호출 전량
    계측"으로 읽지 말 것. 비용 추적이 필요하면 별도 설계 사안이다.
  - 계약은 `src/lib/agent/__tests__/gemini-usage.contract.test.ts` 가 고정한다 —
    키 유출·성공 행 생성·**클라이언트의 종국 실패 경로 누락**(소스 그렙)을 함께 막는다.
    마지막 항목이 중요한 이유: SDK 갈래 `withGeminiKeyRotation` 이 실제로 키 폴백 없이
    방치돼 있던 전례가 있다(2026-07-30 적발).

- **촬영 컷 시안 생성 = `interactions` 표면 · 컷 캐시 · 스타일 락 (2026-08-01):**
  콘텐츠 가이드의 컷마다 **구도 스케치**를 그려 프레임에 채운다. 로직 SSOT는
  `src/lib/guide-sketch.ts`(순수) + `src/lib/agent/gemini-image.ts`(호출).
  - ⚠️ **엔드포인트가 텍스트와 다르다.** 텍스트는 `/v1beta/models/<id>:generateContent`,
    이미지는 **`/v1beta/interactions`**(SDK `interactions.create`). 계측의 `endpoint`
    라벨도 `surface` 축으로 갈라 둔다 — 안 가르면 이미지 실패가 텍스트 실패처럼 기록돼
    "어디가 죽었나"를 못 본다. 선례: `seller-analysis/gemini.ts` 가 같은 표면을 쓴다.
  - **규격은 SDK 타입이 정본이다**(`node_modules/@google/genai`). 🪤 `image_size` 는
    **`"512"`** 이고 `"512px"` 가 아니다(`ImageResponseFormatImageSize = "512"|"1K"|"2K"|"4K"`)
    — 웹 검색 결과가 `512px` 라고 답한 것을 SDK 타입이 정정했다. 모델 ID·파라미터를
    기억이나 검색 결과로 확정하지 말 것(`rules-gemini-api.md` P0).
  - **비용 설계는 컷 캐시다.** 시안은 **컷 텍스트의 함수**라 `cutSketchKey`(자리+피사체
    해시)로 캐시한다 — 초안을 다시 생성해도 컷이 그대로면 이미지 호출이 **0건**이다.
    ⚠️ 키에 `why`(카피)나 `no`(번호)를 넣지 말 것 — 문구만 다듬거나 순서만 바꿔도
    돈이 나간다. 저장은 `DealGuideDraft.sketches`(JSON, 초안과 수명주기 동일).
  - **폭주 차단은 `MAX_SKETCHES_PER_GUIDE` 한 곳.** 프롬프트가 3~5컷을 요구해도
    **모델 출력은 보장이 아니다** — 컷 10개짜리 응답 하나가 곧 비용 사고다. 상한은
    **새로 그리는 것에만** 걸고(캐시 재사용은 비용 0), 초과분은 `skipped` 로 보고한다.
  - ⛔ **스타일 락을 완화하지 말 것**(`SKETCH_STYLE_LOCK`) — 흑백 선화·구도 전용,
    글자·로고·식별 가능한 얼굴·지어낸 제품 디테일 금지. 이 문구가 "촬영 지시서
    스케치"와 "제품 사진"을 가르는 **유일한 장치**다. 실물과 다른 제품 이미지는 셀러에게
    잘못된 기준을 주고 표시광고 측면에서도 근거 없는 시각 주장이 된다. 프롬프트 **맨 앞**에
    둬서 뒤 문장이 덮어쓰지 못하게 한다. 완화는 오너 승인 사안.
  - **컷 목록은 저장된 초안에서 다시 파싱한다** — 클라이언트가 보낸 값을 믿지 않는다.
    그리는 대상이 곧 비용이라, 입력을 그대로 받으면 임의 문자열로 이미지를 뽑는 통로가 된다.
  - **점진적 향상이다.** 텍스트 가이드를 먼저 렌더하고 시안은 이어서 채운다(점선 프레임이
    자리표시자). 실패·저장소 미설정이면 프레임이 빈 채로 남을 뿐 기능이 깨지지 않는다.
    컷 하나가 실패해도 나머지는 그린다(`allSettled`) — 한 장 때문에 이미 쓴 돈을 버리지 않는다.
  - 저장은 기존 `uploadBytes`/`publicMediaUrl`(Supabase `seller-media`)을 재사용한다.
    별도 이미지 서버(imgBB 등)는 **불필요**로 판정 — 512px JPEG 이라 용량이 무의미하고
    (실측 2026-08-01 전체 59MB/Pro 100GB), 외부 호스트는 SSRF 가드·토큰·가용성만 늘린다.
  - 계약: `guide-sketch.contract.test.ts`(스타일 락·상한·캐시 키) ·
    `gemini-image.test.ts`(응답 파싱은 던진다 — 빈 이미지를 저장하지 않는다).

- **RapidAPI 키 풀(2026-07-23):** 키 선택 SSOT는 `src/lib/rapidapi-keys.ts`의
  `rapidApiFetch()` 하나다. RapidAPI를 직접 `fetch` 하지 말 것.
  - `RAPIDAPI_KEYS`(콤마 구분) = 인스타 수집용 **풀**. 앞에서부터 쓰다
    `429`(쿼터 소진)·`403`(미구독)이면 다음 키로 넘어간다. **적은 순서가 곧 소진
    순서**이므로 신선한 키를 앞에 둔다. 그 외 상태코드에서는 로테이션하지 않는다
    — 핸들 오류 하나로 풀 전체를 태우지 않기 위해서다.
  - 정책이 **순차 소진(무상태)** 인 이유: 이전 구현은 모듈 전역 인덱스
    라운드로빈이라 서버리스에서 인스턴스마다 0으로 리셋돼 **첫 키만 태우고
    나머지 슬롯이 놀았다**. 상태를 들고 있으면 이 결함이 되살아난다.
  - ⚠️ **키마다 구독한 API가 다르다.** 풀은 **모든 키가 구독한 엔드포인트**
    (`instagram-scraper-20251`)에만 쓴다. 한 키에만 구독이 붙은 경로(X 조회 =
    `twitter-api45`)는 풀이 아니라 `RAPIDAPI_KEY` **단일 키**를 쓴다 — 풀에 넣으면
    미구독 키를 뽑았을 때 403이다.
  - ⚠️ X 조회 응답은 **없는 핸들에도 HTTP 200**을 주고 본문 `status:"notfound"` +
    전 필드 `null`이다. `res.ok`만 보면 이름 `null`·팔로워 0이 셀러 레코드와
    스냅샷에 기록된다 — 본문 `status`까지 판정할 것.

- **Seller Post/Story Classification (홍보/무관 통합 모델, 오너 2026-07-13):**
  캠페인 상세 "셀러 게시물"·"셀러 스토리"는 "전량 노출 후 분류(홍보/무관)"로 통일한다.
  - **홍보 = Asset 등록(성과추적)**: 게시물의 "홍보" 확정은 `SellerPostClassification`이
    아니라 **Asset(EXTERNAL_LINK) 등록**이 SSOT다(ER 크론·딜레퍼런스·보관을 그대로 태운다).
  - **무관 = `SellerPostClassification`(OTHER)**: 후보에서 영구 숨김. 이 테이블에 저장되는
    유효값은 사실상 OTHER(+되돌리기 시 행 삭제)뿐이다 — **CAMPAIGN을 여기 쓰면 Asset과
    이중 SSOT**가 되므로 금지(`PATCH /api/campaigns/[id]/posts/classification`가
    OTHER|UNREVIEWED만 허용). 스토리는 ER이 없어 `SellerStorySnapshot.classification`
    (CAMPAIGN/OTHER/UNREVIEWED)이 그대로 SSOT.
  - **is_gongu는 필터가 아니라 자동추천**: `suggestCampaignPosts`는 더 이상 is_gongu로
    후보를 거르지 않는다(릴스 등 짧은 캡션 유실 해소). is_gongu는 `SuggestedPost.recommended`
    파생 신호로만 쓰고 **GET에서 DB에 쓰지 않는다**(읽기 부작용 없음 계약 — 다음 세션이
    실수로 GET에 자동 태그 쓰기를 넣지 말 것). 홍보 확정은 사람이 원클릭 등록해야 발생한다.
  - **무관 숨김 범위**: 캠페인 표시(suggested-posts·stories GET)에서만 OTHER를 감춘다.
    전역 트리아지(`/admin/stories`)는 감추지 않는다(무관 복원 경로).
  - **증분 수집(중복 방지)**: 스토리 크론은 `startOfKstDay` 기준 "오늘 이미 수집한 셀러"의
    뷰어 조작을 건너뛴다(수동 `force`는 우회, DB dedup은 그대로). 게시물은 Graph
    `business_discovery.media`가 커서 미지원이라 fetch 증분 불가 → `mergePostsPreview`로
    재분석 시 창 내 후보 유실만 방지(cap 45).

- **Partner Autofill Name Guard:** 거래처 사업자정보 자동입력은 `name` 필드를
  덮어쓰지 않는다(공란일 때만 채움) — 캠페인 자동명명의 셀러/거래처명 SSOT
  보호 목적이다.

- **Script Env Loading:** `scripts/*.ts` 단독 실행은 `.env`를 자동 로드하지
  않는다 — `set -a; source .env; set +a` 후 실행한다(P0의 prod DB 주의 동반).

- **Cache Policy Coupling:** 캐시 티어·태그를 바꾸면 `src/lib/cache-policy.ts`
  ↔ `next.config.ts`(cacheLife) ↔ `CACHE_OPERATIONS.md` 3곳을 함께 갱신하고
  `npm run verify:cache-policy`로 검증한다.

- **Progressive Lock Architecture (마감 캠페인 사후 취소 동기화):** 캠페인 마감(`isActive=false`) 이후 네이버에서 발생하는 '취소/반품'은 원본 스냅샷의 `cachedTotalRevenue` / `cachedDistinctOrderCount`를 직접 변조하거나 읽기 시점(Read-Path)에 라이브 재계산하지 않는다. 대신 `cachedPostCloseCancelQuantity`, `cachedPostCloseCancelRevenue` 필드에 "사후 취소 델타(Delta)"만 원자적(Atomic)으로 누적 업데이트(Write-Path)한 뒤 클라이언트에는 합산하여 반환한다.
  - **Why (도입 이유):** (1) **데이터 무결성 보존**: 마감 당시의 스냅샷 원본(수익, 수량)을 훼손하지 않아 과거 정산 내역과의 대조 및 보존이 가능하다. (2) **성능 최적화**: 매번 GET 요청 시 무거운 JSON 파싱 및 동적 델타 차감을 수행하지 않음으로써, 조회 성능과 데이터베이스 부하를 획기적으로 낮춘다. (3) **유연성**: 운영자가 언제든 원본 스냅샷과 사후 취소 변동분을 분리해서 추적할 수 있다. (2026-07-13 확정, PR #134)

- **정산 신원(주민등록번호·계좌) 소유 모델 — 개인 셀러에게 거래처를 만들지 않는다
  (오너 확정 2026-07-24):** 개인(비사업자) 셀러의 주민등록번호·정산 계좌는
  **`Seller` 가 소유**하고, 입력면은 셀러 상세의 「정산 정보」 섹션이다. 거래처가
  연결돼 있으면 같은 자리에 거래처 신원(사업자번호·대표자)을 읽기 전용으로 보여준다.
  - ⛔ **"개인 셀러도 `Partner(type=SELLER)` 레코드를 만들어 거기서 관리하자"는 안은
    기각됐다.** 근거 3가지(실측 2026-07-23): ① 개인 → 사업자 **전환이 실제로 일어난다**
    (전환자 2명·전환 캠페인 2건 실측) — 거래처를 만들면 전환할 때마다 개인용/사업자용
    거래처가 둘로 쌓인다. ② 거래처는 계약 주체인데 개인 셀러의 계약 주체는 셀러
    자신이다. ③ 주민등록번호는 **소득자 개인에게 귀속**되므로 전환해도 바뀌지 않는다.
  - **전환 대응은 이미 `SalesCampaign.sellerTaxType` 스냅샷이 담당한다.** 캠페인 생성
    시점의 유형이 그 캠페인에 박히고, `isIndividualSeller()` 가 **스냅샷을 사업자번호보다
    우선** 본다. 그래서 개인 시절 캠페인은 사업자 전환 후에도 `INDIVIDUAL` 로 남아
    원천징수 대상에 정상 포함된다 — **"현재 사업자니까 과거 지급도 사업자"로 판정하는
    로직을 새로 만들지 말 것**(그게 이 스냅샷이 막고 있는 사고다).
  - ⚠️ **주민등록번호를 목록 페이로드(`SellerSummary`)에 넣지 말 것** — 셀러 전원(160명
    규모)의 값이 목록 조회 한 번에 브라우저로 내려간다. 상세를 연 1명만
    `GET /api/sellers/[id]/settlement-info`(오너 인증 뒤) 로 가져온다. 계약 테스트
    `resident-number-exposure.contract.test.ts` 가 목록·포털·허용목록 밖 파일 유입을
    전수 스캔으로 막는다(새 소비처는 그 파일의 `ALLOWED_FILES` 에 사유와 함께 등재).

- **Prisma `groupBy` 의 `where` 에 관계 필터를 쓰지 말 것 (실사고 2026-07-31):**
  `salesCampaign.groupBy({ by:[...], where: { seller: { name } } })` 는 **에러 없이
  0건**을 돌려준다. 그걸 "그 셀러는 캠페인이 없다"로 읽어 집계를 오판했다(스칼라
  `sellerId` 로 재조회해 정정). 집계 쿼리의 필터는 **스칼라 컬럼으로** 건다 —
  관계로 좁혀야 하면 먼저 id 를 조회해 `in` 으로 넘긴다. 빈 결과가 나오면 "정말
  없는 것"과 "필터가 안 먹은 것"을 구분할 것.
