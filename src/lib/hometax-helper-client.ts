/**
 * 홈택스 건별발급 로컬 헬퍼와의 브라우저 측 통신 계약.
 *
 * 헬퍼는 오너 Mac 로컬(127.0.0.1)에서 도는 별도 프로세스다 — CRM(Vercel)이 직접
 * 홈택스를 조작할 수 없으므로(인증서·로그인 세션이 로컬 브라우저에 있다), 이 모듈이
 * 발행 데이터(`TaxInvoiceRow`)를 헬퍼로 넘기고 헬퍼가 홈택스 건별발급 폼을 채운다.
 * **발급·전자서명은 항상 오너가 화면에서 직접 한다** — 헬퍼는 입력까지만 하고
 * 멈추는 것이 설계의 안전장치다(설계 정본:
 * `docs/private/specs/2026-08-05-hometax-local-helper-design.md`).
 *
 * 페이로드 타입은 `TaxInvoiceRow`(tax-invoice-builder)를 그대로 쓴다 — 홈택스
 * 서식에 필요한 공급자·공급받는자·금액·품목이 전부 들어 있고, XLSX 일괄발급과
 * 같은 SSOT(`buildTaxInvoiceRows` ← 보드 ISSUE 행)에서 나오므로 화면·파일·헬퍼
 * 세 표면의 금액이 구조적으로 일치한다. 여기서 별도 페이로드 타입을 만들지 말 것.
 *
 * ⚠️ https 페이지에서 http://127.0.0.1 로의 fetch 는 브라우저가 loopback 을 secure
 * context 로 취급해 mixed content 차단 없이 허용된다. Chrome Private Network Access
 * 프리플라이트 응답(`Access-Control-Allow-Private-Network: true`)은 헬퍼 쪽 책임이다.
 */
import type { TaxInvoiceRow } from "@/lib/tax-invoice-builder";

/**
 * 기본 주소는 loopback 고정이다 — 외부 호스트로 바꾸면 발행 데이터(사업자번호·금액)가
 * 로컬 밖으로 나간다. 오버라이드는 포트 충돌 대응용이며 여전히 로컬 주소만 의도한다.
 */
export const HOMETAX_HELPER_BASE_URL =
  process.env.NEXT_PUBLIC_HOMETAX_HELPER_URL ?? "http://127.0.0.1:9410";

/** 2단계에서 `scripts/hometax-helper/`가 이 이름으로 붙는다 — 안내 문구가 공유한다. */
export const HOMETAX_HELPER_START_COMMAND = "npm run hometax:helper";

/** 스킴 앱을 설치(또는 재설치)하는 명령 — 깨우기가 실패했을 때의 안내 문구가 쓴다. */
export const HOMETAX_HELPER_INSTALL_COMMAND =
  "bash scripts/hometax-helper/install-url-scheme.sh";

/**
 * 헬퍼를 **깨우는** 커스텀 URL 스킴. 오너 Mac 에 등록된 `HometaxHelper.app`
 * (`install-url-scheme.sh`)이 이 스킴을 받아 헬퍼가 꺼져 있으면 띄운다.
 *
 * ⛔ **쿼리로 데이터를 넘기지 않는다** — macOS 는 URL 을 Apple Event 로 전달해서
 * 앱의 셸 스크립트가 argv 로 받지 못한다(2026-08-06 실측). 이 스킴은 "깨우기 전용"
 * 이고 발행 데이터는 종전대로 `POST /issue` 로 간다. 그래서 사업자번호·금액이 URL
 * (브라우저 이력·OS 로그에 남는 자리)에 실릴 일이 구조적으로 없다.
 */
export const HOMETAX_HELPER_WAKE_URL = "hometax-helper://start";

/**
 * 스킴을 열어 헬퍼를 깨운다.
 *
 * 🪤 **반드시 클릭 핸들러의 사용자 제스처 안에서 불러야 한다**(2026-08-06 실측).
 * Chrome 은 외부 프로토콜 실행에 사용자 제스처를 요구해서, 콘솔·타이머·긴 비동기
 * 뒤에서 부르면 `Not allowed to launch … because a user gesture is required` 로
 * 조용히 막힌다. 실제 버튼 클릭으로 트리거하면 (「항상 허용」 저장 후) 확인창 없이
 * 실행된다. 그래서 호출부는 클릭 → (짧은 health 확인) → 이 함수 순서를 지킨다.
 */
export function wakeHometaxHelper(): void {
  if (typeof window === "undefined") return;
  window.location.href = HOMETAX_HELPER_WAKE_URL;
}

/**
 * 깨운 뒤 헬퍼가 응답할 때까지 짧게 기다린다(폴링).
 *
 * 실측 기동 시간은 `open` 부터 `/health` 응답까지 **약 4초**였다(2026-08-07, 콜드
 * 스타트 + Chrome 창 열기 포함). 그보다 넉넉히 잡되, 스킴이 아예 등록되지 않은
 * 환경(앱 미설치)에서 오너를 오래 붙잡지 않도록 상한을 둔다 — 실패는 사고가 아니라
 * "터미널에서 켜세요"로 강등되는 안내다.
 */
export async function waitForHometaxHelper(
  timeoutMs = 20_000,
  intervalMs = 1_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (await checkHometaxHelperHealth()) return true;
  }
  return false;
}

/**
 * 헬퍼의 `/issue` 응답. 실패(`FAILED_AT`)도 사고가 아니라 "여기까지 채웠으니 이어서
 * 수동 입력"이라는 신호다 — 헬퍼는 실패 시점의 브라우저 창을 닫지 않고 열어 둔다.
 */
export type HometaxHelperIssueResult =
  | { status: "FILLED"; message?: string }
  // 헬퍼가 로그인 화면 어디까지 데려다 놨는지를 문구로 알려 준다 — 오너가 지금 무엇을
  // 하면 되는지가 매번 다르다(여섯 자리만 누르면 되는 상태 vs 중간에서 멈춘 상태).
  | { status: "NEED_LOGIN"; message?: string }
  /**
   * 홈택스가 사람이 눌러야 하는 창을 띄운 상태(종사업장 선택 · 「공급가액, 세액
   * 자동계산」 확인 등). **폼은 채워져 있다** — 실패가 아니다.
   *
   * 🪤 이 값이 이 목록에서 빠져 있어서 실사용에서 **「홈택스 로컬 헬퍼와의 통신에
   * 실패했습니다」로 둔갑했다**(2026-08-07 실측). 헬퍼는 「…창을 띄웠습니다, 화면에서
   * 선택해 주세요」라고 정확히 보고했는데, 모르는 status 라 클라이언트가 throw 했고
   * 다이얼로그의 catch 가 통신 오류로 뭉갰다. 폼이 멀쩡히 채워진 상태를 오너는
   * 「실패」로 읽는다 — 헬퍼가 아는 status 는 여기에 전부 있어야 한다.
   */
  | { status: "NEEDS_CHOICE"; message?: string }
  /**
   * 헬퍼가 「발급하기」까지 눌렀고 **홈택스 확인 팝업이 떠 있는** 상태(오너 승인
   * 2026-08-08). 성공도 실패도 아니고 **사람 차례**다 — 그 팝업의 확인과 전자서명은
   * 헬퍼가 절대 누르지 않는다(`scripts/hometax-helper/guards.ts`).
   */
  | { status: "AWAITING_CONFIRM"; message?: string }
  /**
   * 헬퍼가 확인 팝업을 지나 **인증서 비밀번호 창까지** 진행한 상태(오너 승인
   * 2026-08-08 — 「비밀번호 패드까지 전부 진행」). 이 도구가 멈추는 최종 지점이고,
   * 남은 행위는 오너가 여섯 자리를 누르는 것뿐이다.
   */
  | { status: "AWAITING_SIGNATURE"; message?: string }
  | { status: "FAILED_AT"; step: string; message?: string };

/** `/health` 1.5초 타임아웃 — 헬퍼 미실행이 정상 상태(항상 켜 두는 데몬이 아니다)라
 * 미응답을 빠르게 "꺼져 있음"으로 판정한다. 상시 폴링은 하지 않는다(버튼 클릭
 * 시점에만 1회 확인 — 미실행 상태에서 콘솔 에러를 양산하지 않기 위한 설계 결정). */
export async function checkHometaxHelperHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${HOMETAX_HELPER_BASE_URL}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 헬퍼가 보는 홈택스 로그인 상태. `UNKNOWN` 은 「창이 없거나 아직 못 읽었다」이고
 * **로그아웃이 아니다** — 둘을 합치면 CRM 이 영영 기다리거나 반대로 성급히 포기한다.
 */
export type HometaxLoginState = "IN" | "OUT" | "UNKNOWN";

/**
 * 헬퍼에게 로그인 상태를 묻는다. `waitMs` 를 주면 **그 시간까지 기다렸다가** 답하므로
 * (long-poll) 로그인이 끝나는 즉시 돌아온다 — 되묻는 간격이 곧 지연이던 문제의 처방이다.
 *
 * 응답 타임아웃은 `waitMs` 보다 넉넉히 크게 잡는다. 서버가 기다리는 시간보다 클라이언트가
 * 먼저 끊으면 **정상 대기를 실패로 읽는다.**
 */
async function readHometaxLoginState(waitMs = 0, signal?: AbortSignal): Promise<HometaxLoginState> {
  try {
    /**
     * 🪤 **취소 신호를 fetch 에 직결한다**(2026-08-09 실사용 지적). 종전에는 타임아웃
     * 신호만 걸어서, 토스트의 「취소」를 눌러도 진행 중인 long-poll(최대 15초 chunk)이
     * **끝나야** 호출부 루프가 abort 를 확인했다 — 오너에게는 "취소 버튼이 작동하지
     * 않는다"로 보였다. `AbortSignal.any` 로 묶으면 누르는 즉시 요청이 끊긴다.
     */
    const timeout = AbortSignal.timeout(waitMs + 5_000);
    const res = await fetch(`${HOMETAX_HELPER_BASE_URL}/login-status?waitMs=${waitMs}`, {
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!res.ok) return "UNKNOWN";
    const body = (await res.json()) as { state?: string };
    return body.state === "IN" || body.state === "OUT" ? body.state : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

/**
 * 오너가 홈택스 로그인을 끝낼 때까지 기다린다(자동 재개용).
 *
 * ⛔ **이 대기는 헬퍼의 창을 건드리지 않는다** — 조회는 읽기 전용 엔드포인트이고,
 * 발행을 다시 쏘며 기다리는 방식이 아니다. 그렇게 하면 매 재시도가 로그인 단계를
 * 다시 클릭해 **오너가 누르던 인증서 창을 초기화**한다.
 *
 * 기본 상한 5분은 「인증서 고르고 여섯 자리 누르는」 시간을 덮되, 잊고 자리를 뜬
 * 경우에 화면이 영원히 묶이지 않을 만큼으로 잡았다. ⏱️ 처음엔 3분이었는데 **실사용
 * 첫 시도에서 그대로 만료됐다**(2026-08-07) — 인증서를 고르는 단계가 있어 생각보다
 * 길다. 만료돼도 「다시 누르세요」 안내로 안전하게 끝나지만, 기본값이 실제 사람의
 * 속도보다 짧으면 그 안내가 기본 경험이 된다. `signal` 로 취소할 수 있다(토스트의
 * 「취소」).
 *
 * 🪤 **되묻지 않고 기다린다**(2026-08-07 개정). 종전에는 2초마다 상태를 물었는데,
 * 그러면 **간격이 곧 지연**이라 오너가 비밀번호를 다 눌러도 화면이 최대 2초쯤 멍하니
 * 있었다(실사용 체감 지적). 이제 헬퍼가 로그인 완료를 직접 기다렸다가 답하므로
 * (`waitMs`), 홈택스가 로그인 후 페이지를 이동하는 그 순간 바로 돌아온다.
 *
 * 한 번에 다 기다리지 않고 조각내는 이유: 상한을 두지 않으면 헬퍼가 요청을 오래 붙잡아
 * 종료·재기동이 늦어지고, 중간에 「취소」를 눌러도 그 조각이 끝날 때까지 반응하지 못한다.
 */
export async function waitForHometaxLogin(
  { timeoutMs = 300_000, chunkMs = 15_000, signal }: {
    timeoutMs?: number;
    /** 한 번의 대기 요청이 헬퍼를 붙잡는 시간. 취소 반응성과 연결 유지의 절충점이다. */
    chunkMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    const startedAt = Date.now();
    // 취소 신호를 함께 넘긴다 — 넘기지 않으면 chunk 가 끝날 때까지 취소가 안 먹는다(위 🪤).
    const state = await readHometaxLoginState(
      Math.max(0, Math.min(chunkMs, deadline - startedAt)),
      signal,
    );
    if (signal?.aborted) return false;
    if (state === "IN") return true;
    // 헬퍼가 그 시간만큼 이미 기다렸으므로 여기서 또 재우면 그만큼이 순수한 지연이다.
    // 다만 **즉시 돌아온 경우**(창이 없어 UNKNOWN, 헬퍼가 꺼져 연결 실패 등)는 그대로
    // 두면 초당 수백 번 두드리게 되므로 그때만 잠깐 쉰다.
    if (Date.now() - startedAt < 500) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
}

/**
 * 세금계산서 1건을 헬퍼로 보낸다 — 1회 호출 = 계산서 1장(보드 행 1개). 다건 연속
 * 발급은 의도적으로 지원하지 않는다: 1건씩 검토하는 것이 이 도구의 안전장치이고,
 * 다건은 XLSX 일괄발급 경로가 담당한다(설계 「범위 밖」).
 *
 * 네트워크 실패(헬퍼가 도중에 꺼짐 등)는 throw 한다 — 호출부가 "헬퍼 연결 실패"로
 * 구분해 보고한다(P0 No Silent Failure).
 */
export async function sendInvoiceToHometaxHelper(
  invoice: TaxInvoiceRow,
): Promise<HometaxHelperIssueResult> {
  const res = await fetch(`${HOMETAX_HELPER_BASE_URL}/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invoice }),
  });
  if (!res.ok) {
    throw new Error(`헬퍼 응답 오류 (HTTP ${res.status})`);
  }
  const body = (await res.json()) as HometaxHelperIssueResult;
  // ⚠️ 헬퍼가 내는 status 를 여기에 **전부** 열거해야 한다. 하나라도 빠지면 정상 응답이
  //    throw 로 바뀌고, 호출부의 catch 가 그것을 「통신 실패」로 뭉갠다(위 NEEDS_CHOICE
  //    주석의 실사고). 모르는 값을 막는 것이 이 검사의 목적이지, 아는 값을 빠뜨리는
  //    것이 아니다.
  if (
    body.status !== "FILLED" &&
    body.status !== "NEED_LOGIN" &&
    body.status !== "NEEDS_CHOICE" &&
    body.status !== "AWAITING_CONFIRM" &&
    body.status !== "AWAITING_SIGNATURE" &&
    body.status !== "FAILED_AT"
  ) {
    throw new Error("헬퍼 응답을 해석할 수 없습니다.");
  }
  return body;
}
