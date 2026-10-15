/**
 * **화면 문구 용어집** — 오너가 매일 읽는 운영 화면의 낱말 정본.
 *
 * 규칙 정본은 `docs/agents/product-ux.md` P2 「화면 문구 기준」이고, 이 파일은 그 규칙이 쓰는
 * 낱말 목록이다. 기계 검사 `src/__tests__/ui-copy-terms.contract.test.ts` 가 이 파일을 읽는다 —
 * 낱말을 테스트에 다시 적지 말 것(두 곳이 어긋나면 검사가 엉뚱한 것을 잡는다).
 *
 * ## 새 화면 문구를 쓰기 전에
 * 1. 대상·상태 이름은 아래 `UI_LABEL_TABLES` 의 기존 라벨 표에서 가져온다.
 * 2. 표에 없는 새 상태 낱말이면 **붙여 쓴 한 낱말**로 짓는다(「승인대기」). 띄어 쓴 형태가
 *    다른 화면에 이미 있으면 `STATUS_WORD_SPACING` 에 한 줄 더한다.
 * 3. 설명문에 `DEV_WORDS` 의 낱말이 들어가면 오너의 업무 말로 바꾼다.
 */

/**
 * 상태 낱말의 띄어 쓴 형태 → 붙여 쓴 정본.
 *
 * 근거: 상태 낱말 기준(오너 확정 2026-10-08) ① 「상태는 붙여 쓴 한 낱말」. 그날 결재함·봇 활동 표가
 * 이 표기로 정리됐고(#161), 모바일·정산 화면에는 띄어 쓴 형태가 남아 있었다(2026-10-15 실측 19곳).
 *
 * ⚠️ 검사는 문자열 **전체가** 이 낱말과 같을 때만 잡는다 — 「진행 중인 캠페인이 없습니다」 같은
 * 문장 속 띄어쓰기는 맞춤법대로 띄우는 것이 맞으므로 대상이 아니다.
 */
export const STATUS_WORD_SPACING: Readonly<Record<string, string>> = {
  "승인 대기": "승인대기",
  "확정 대기": "확정대기",
  "확인 대기": "확인대기",
  "정산 대기": "정산대기",
  "세팅 대기": "세팅대기",
  "지급 대기": "지급대기",
  "발송 대기": "발송대기",
  "제안 중": "제안중",
  "협의 중": "협의중",
  "진행 중": "진행중",
  "처리 중": "처리중",
  "실행 중": "실행중",
  "반영 중": "반영중",
  "재시도 중": "재시도중",
  "판매 중": "판매중",
  "정산 중": "정산중",
  "정산 진행": "정산중",
  "판매 예정": "판매예정",
  "판매 마감": "판매마감",
  "판매 종료": "판매종료",
  "정산 완료": "정산완료",
  "반영 완료": "반영완료",
  "전환 완료": "전환완료",
  "실행 완료": "실행완료",
  "발송 완료": "발송완료",
  "지급 완료": "지급완료",
  "입금 완료": "입금완료",
  "입금 확정": "입금확정",
  "거래 중": "거래중",
  "거래 보류": "거래보류",
  "거래 중단": "거래중단",
  "사용 불가": "사용불가",
  "판정 불가": "판정불가",
  "대조 불가": "대조불가",
  "조회 불가": "조회불가",
  "부분 충족": "부분충족",
  "생성 실패": "생성실패",
  "수집 실패": "수집실패",
  "연동 실패": "연동실패",
  "샘플 테스트": "샘플테스트",
};

/**
 * 화면에 내지 않는 개발 용어. 오너는 이 낱말을 업무 말로 읽지 못한다(되묻게 된다).
 * 값 = 대신 쓸 말(빈 문자열 = 그 낱말을 빼고 문장을 다시 쓴다).
 *
 * 영문은 낱말 경계로, 한글은 부분 일치로 잡는다.
 */
export const DEV_WORDS: Readonly<Record<string, string>> = {
  null: "—",
  undefined: "—",
  NaN: "—",
  payload: "내용",
  enum: "",
  boolean: "",
  true: "예",
  false: "아니오",
  "[object Object]": "",
  레코드: "항목",
  엔티티: "항목",
  스키마: "",
  페이로드: "내용",
  파라미터: "",
  쿼리: "조회",
};

/**
 * 대문자로만 된 낱말 중 **화면에 그대로 보여도 되는 것**(약어·단위·외부 상표).
 * 그 밖의 대문자 낱말(`PENDING`·`SAMPLE_TESTING`)은 코드값이 새어 나온 것으로 본다.
 * 늘릴 때는 「오너가 화면에서 그 글자 그대로 읽는 낱말인가」로 판정한다.
 */
export const ALLOWED_UPPERCASE_WORDS: ReadonlySet<string> = new Set([
  "NAVER", "KAKAO", "SMS", "SNS", "URL", "PDF", "CSV", "XLSX", "HTML", "VAT", "OK", "CS", "ID",
  "API", "QR", "AI", "PC", "GMV", "ROAS", "CPC", "CTR", "KST", "UTC", "YGRD", "WAG",
]);

/**
 * 코드값이 담기는 필드 이름. 이 필드를 라벨 표 없이 화면에 바로 그리면 영문 코드가 보인다
 * (실사고: 결재함 카드에 도구 이름 `create_partner` 가 그대로 뜸, 2026-09-23).
 * `reason`·`kind` 처럼 이미 한국어 문장이 담기는 필드는 넣지 않는다(오탐).
 */
export const RAW_CODE_FIELDS: ReadonlySet<string> = new Set([
  "status", "type", "state", "channel", "provider", "stage", "action",
]);

/**
 * 재사용할 라벨 표(코드값 → 화면 낱말). 새 화면에서 같은 값을 그릴 때 새 표를 만들지 말고
 * 여기서 찾는다. 표에 없는 영문 코드가 보이면 그 표에 낱말을 등록한다(P2 「화면 문구 기준」 ③).
 * 화면에서 표를 조회할 때는 `표[x] ?? x` 대신 `displayLabel(표, x)`(src/lib/display-label.ts)를 쓴다 —
 * 표에 없는 영문 코드는 「—」, 한글 저장값은 그대로 보인다. 「모를 때」 낱말은 둘뿐이다 — 값 칸 「—」,
 * 이름·상태 칸 「알 수 없음」(같은 파일의 `NO_LABEL`·`UNKNOWN_NAME`).
 */
export const UI_LABEL_TABLES = {
  "캠페인 상태": "campaignStatusLabels (src/lib/crm-types.ts)",
  "딜 상태": "dealStatusLabels (src/lib/crm-types.ts)",
  "업무 상태": "taskStatusLabels (src/lib/crm-types.ts)",
  "판매 채널": "salesChannelLabels (src/lib/crm-types.ts)",
  "거래처 유형": "partnerTypeLabels (src/lib/crm-types.ts)",
  "API 기록 출처": "apiProviderLabels (src/lib/crm-types.ts)",
  "대상 종류(거래처·셀러·딜·캠페인)": "ENTITY_TYPE_LABELS (src/components/crm/approvals/entity-type-labels.ts)",
  "필드 이름": "FIELD_LABELS (src/lib/field-labels.ts)",
  "결재함 작업 이름": "ACTION_LABELS (src/components/crm/approvals/proposal-card.tsx)",
  "주문 작업 기록": "ORDER_ACTION_LABELS (src/lib/order-converter/action-log.ts)",
  "사이드바 메뉴": "src/components/crm/crm-sidebar.tsx",
} as const;
