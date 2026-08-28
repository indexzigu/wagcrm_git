/**
 * 홈택스 로컬 헬퍼의 **절대 금지선** — 이 파일이 "헬퍼는 발급·서명을 누르지 않는다"를
 * 코드로 강제한다.
 *
 * 설계 정본: `docs/private/specs/2026-08-05-hometax-local-helper-design.md`
 * 「절대 금지선(P0)」. 헬퍼가 하는 일은 **폼 입력까지**이고, 발급·전자서명은 오너가
 * 열린 창에서 직접 한다. 그 경계가 이 도구의 안전장치 전부다 — 자동 발급은 되돌릴 수
 * 없고(수정세금계산서 절차), 전자서명은 법적 행위이기 때문이다.
 *
 * ## 왜 deny-by-default 인가
 *
 * 금지 목록만 두면 "우리가 미처 적지 못한 발급 버튼"이 통과한다 — 홈택스 문구는 화면
 * 개편으로 바뀌고, 우리는 그 화면을 아직 실측하지도 못했다(2단계 착수 시점 기준).
 * 그래서 **허용 목록에 없으면 무조건 거부**하고, 허용 목록에 있더라도 금지 패턴에
 * 걸리면 다시 거부한다(이중 방어). 셀렉터 맵이 비어 있으면 헬퍼는 **아무것도 클릭하지
 * 못한다** — 안전한 기본값이 "동작 안 함"이지 "일단 눌러봄"이 아니다.
 */

/**
 * 발급·서명·제출 계열 문구. 하나라도 포함되면 그 요소는 **절대** 클릭하지 않는다.
 *
 * ⚠️ 이 목록을 줄이거나 완화하는 것은 오너 승인 사안이다. 특히 「발급」·「서명」은
 * 이 도구의 존재 이유(사람이 최종 승인)를 지우는 단어다.
 * 🪤 「조회」·「검색」처럼 읽기 동작은 여기 넣지 않는다 — 사업자번호 확인 버튼 등
 * 입력을 돕는 조회는 허용 대상이라, 금지 목록을 넓히면 헬퍼가 할 일이 없어진다.
 */
export const FORBIDDEN_CLICK_PATTERNS: readonly string[] = [
  "발급",
  "서명",
  "전송",
  "제출",
  "신고",
  "전자세금계산서 발행",
  "확인후발급",
  "즉시발급",
  "일괄발급",
  "승인",
  "결제",
  "納付",
  "납부",
];

/**
 * ⚠️ **「인증 화면 이동」은 2026-08-08 오너 승인으로 금지 목록에서 빠졌다.**
 *
 * 한 차례 금지어로 넣었다가(발급하기까지만 열던 단계) 같은 날 오너가 **비밀번호
 * 패드까지 진행**을 지시해 해제했다. 지금 이 도구가 멈추는 지점은 확인 팝업이 아니라
 * **인증서 비밀번호 입력**이다.
 *
 * ⛔ 그래도 「서명」은 금지 목록에 남아 있고, 비밀번호는 **선언된 단계 라벨에만**
 * 클릭이 나가는 deny-by-default 구조로 보호된다(숫자 키패드는 어떤 단계 라벨과도
 * 일치하지 않는다). 이 보호는 "구조적으로 불가능"이 아니라 "허용 목록에 없음"이라는
 * 점을 분명히 해 둔다 — 키패드는 타이핑이 아니라 **클릭**이라, 타이핑 금지 계약
 * (`login.ts`)이 덮지 못하는 자리다.
 */

/**
 * 금지선의 **단 하나의 예외** — 건별발급 화면의 「발급하기」 버튼(오너 승인 2026-08-08).
 *
 * ## 무엇이 바뀌었고 무엇이 그대로인가
 *
 * 바뀐 것: 헬퍼가 폼을 채운 뒤 「발급하기」까지 누른다. 그러면 홈택스가 **확인 팝업**을
 * 띄운다(공급받는자·작성일자·합계·공급가액·세액 요약 + 「발급한 전자세금계산서는 삭제가
 * 불가능합니다」).
 *
 * 그대로인 것: **그 팝업부터는 사람이다.** 확인 클릭도, 전자서명도 헬퍼가 하지 않는다
 * (위 금지 패턴 「인증 화면 이동」·「서명」). 즉 되돌릴 수 없는 행위의 직전에서 멈추는
 * 구조 자체는 유지되고, 멈추는 **지점만** 한 칸 뒤로 옮겼다.
 *
 * ## ⚠️ 오너가 감수하기로 한 것 (기록)
 *
 * 확인 팝업은 **품목명과 비고를 보여주지 않는다.** 그래서 그 두 칸은 사람 눈을 거치지
 * 않고 최종 게이트에 도달한다 — 2026-08-08 의 100byte 사고가 난 칸이 정확히 그 둘이다.
 * 제안 시 이 점을 알렸고 오너가 「채우자마자 발행까지 자동」을 선택했다. 되돌리려면
 * 이 예외를 지우면 된다(`submitIssueForm` 호출부 한 줄과 함께).
 *
 * ## 왜 라벨이 아니라 셀렉터로 허용하는가
 *
 * 라벨로 열면(예: 금지 목록에서 「발급」을 빼면) **홈택스의 모든 발급 계열 버튼**이
 * 함께 열린다 — 즉시발급·일괄발급·재발송이 같은 단어를 쓴다. 이 함수는 셀렉터 맵이
 * `issueSubmit` 으로 **명시 선언한 그 요소 하나**와 정확히 일치할 때만 통과시키므로,
 * 열리는 문이 한 개로 고정된다. 선언이 없으면(기본값) 아무것도 눌리지 않는다 —
 * deny-by-default 는 여기서도 유지된다.
 */
export function assertIssueSubmitAllowed(selector: string, declared: string | undefined): void {
  const target = (selector ?? "").trim();
  const allowed = (declared ?? "").trim();
  if (!allowed) {
    throw new ForbiddenClickError(
      "발급하기",
      "NOT_ALLOWLISTED",
      `셀렉터 맵에 \`issueSubmit\` 이 선언돼 있지 않습니다 — 선언 없이는 발급 버튼을 누르지 않습니다.`,
    );
  }
  if (target !== allowed) {
    throw new ForbiddenClickError(
      "발급하기",
      "NOT_ALLOWLISTED",
      `선언된 발급 버튼(\`issueSubmit\`)과 다른 요소는 누를 수 없습니다.`,
    );
  }
}

export class ForbiddenClickError extends Error {
  constructor(
    readonly label: string,
    readonly reason: "FORBIDDEN_PATTERN" | "NOT_ALLOWLISTED",
    /** 기본 문구 대신 쓸 사유(발급 버튼 예외처럼 원인이 특정될 때). */
    detail?: string,
  ) {
    super(
      detail ??
      (reason === "FORBIDDEN_PATTERN"
        ? `금지된 클릭 대상입니다(발급·서명 계열): "${label}" — 헬퍼는 입력까지만 하고 발급은 사람이 합니다. ` +
          `※ 이동용 항목인데 막혔다면 금지 목록을 건드리지 말고 **라벨만** 바꾸세요 ` +
          `(예: "건별발급 메뉴" → "건별 화면"). 라벨은 우리가 짓는 이름이고, 실제 클릭 대상은 셀렉터가 정합니다.`
        : `허용 목록에 없는 클릭 대상입니다: "${label}" — 셀렉터 맵의 navigation 항목만 클릭할 수 있습니다.`),
    );
    this.name = "ForbiddenClickError";
  }
}

/** 공백·전각공백을 지운 비교용 문자열 — "발 급"처럼 띄어쓰기로 우회되지 않게 한다. */
function normalize(text: string): string {
  return text.replace(/[\s 　]/g, "");
}

export function matchesForbiddenPattern(label: string): boolean {
  const target = normalize(label);
  return FORBIDDEN_CLICK_PATTERNS.some((pattern) => target.includes(normalize(pattern)));
}

/**
 * 클릭 전 반드시 통과해야 하는 게이트. 브라우저를 만지는 코드는 이 함수를 거치지 않고
 * `page.click`을 부르면 안 된다 — 그 규약은 계약 테스트가 소스 스캔으로 강제한다.
 *
 * @param label 사람이 읽는 대상 이름(셀렉터 맵의 키 또는 버튼 텍스트)
 * @param allowedLabels 셀렉터 맵이 navigation 용으로 선언한 라벨 전체
 */
export function assertClickAllowed(label: string, allowedLabels: readonly string[]): void {
  if (matchesForbiddenPattern(label)) {
    throw new ForbiddenClickError(label, "FORBIDDEN_PATTERN");
  }
  if (!allowedLabels.includes(label)) {
    throw new ForbiddenClickError(label, "NOT_ALLOWLISTED");
  }
}
