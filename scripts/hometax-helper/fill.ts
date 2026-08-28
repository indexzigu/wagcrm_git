/**
 * 홈택스 건별발급 폼 채우기 — **입력까지만** 하고 멈춘다.
 *
 * 이 파일은 브라우저를 만지는 유일한 곳이며, 클릭은 반드시 `assertClickAllowed`를
 * 통과해야 한다(`guards.ts` — 발급·서명 계열은 무조건 거부, 허용 목록 밖도 거부).
 * 계약 테스트가 "가드 없는 click 호출"을 소스 스캔으로 막는다.
 *
 * 실패해도 창을 닫지 않고 채운 데까지 남긴다 — 오너가 이어서 수동 입력하면 되므로
 * 실패는 사고가 아니라 불편이다(설계 「실패 모드」). 자동 재시도는 하지 않는다:
 * 같은 폼에 두 번 입력하면 값이 덧붙거나 중복될 수 있다.
 */
import type { Page } from "playwright";
import { assertClickAllowed, assertIssueSubmitAllowed } from "./guards";
// 인증 단계 걷기는 로그인과 **같은 기계**를 쓴다 — 복제하면 그 안의 함정 해결책을 잃는다.
import { clickLabeledSteps } from "./login";
// ⛔ 상한을 베끼지 않는다 — 앱(CRM)이 자를 때 쓰는 값과 헬퍼가 검사할 때 쓰는 값이
//    갈리면, 한쪽은 통과시키고 다른 쪽은 막는 상태가 된다. SSOT 하나를 같이 쓴다.
//    (별칭 대신 상대경로 — 이 헬퍼는 tsx 로 도는 별도 런타임이라 해석기가 다르다.)
import { HOMETAX_TEXT_MAX_BYTES, countHometaxBytes } from "../../src/lib/hometax-text";
import { allowedClickLabels, type HometaxFieldKey, type SelectorMap } from "./selectors";

/** 헬퍼가 CRM 에서 받는 페이로드 — `TaxInvoiceRow`(src/lib/tax-invoice-builder.ts)의
 *  부분집합이다. 헬퍼는 별도 계산을 하지 않는다(금액은 CRM 이 이미 확정한 값). */
export type InvoicePayload = {
  buyerBusinessNumber: string;
  buyerName: string;
  buyerCeo: string;
  buyerAddress: string;
  buyerBusinessType: string;
  buyerBusinessItem: string;
  buyerEmail1: string;
  /**
   * 작성일자 `YYYYMMDD`(`TaxInvoiceRow.invoiceDate` 형식). 화면에는 `yyyy-mm-dd` 로
   * 넣는다 — 아래 `toHometaxDate` 가 변환한다.
   *
   * ⚠️ 없으면 홈택스 기본값(오늘)이 그대로 남는데, 작성일자는 **공급 연월일**이라
   * 지난달 건을 오늘 날짜로 발행하면 과세기간이 어긋난다.
   */
  invoiceDate?: string;
  totalSupplyAmount: number;
  totalTaxAmount: number;
  lineItems: Array<{
    /** 거래일자의 **일(DD)** — `TaxInvoiceRow.lineItems[].date`. */
    date?: string;
    name: string;
    supplyAmount: number;
    taxAmount: number;
    remark: string;
  }>;
};

/** `20260806` → `2026-08-06`. 이미 하이픈이 있으면 그대로 둔다. */
function toHometaxDate(raw: string | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 8) return "";
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export type FillOutcome = {
  /** 실제로 채운 필드 */
  filled: HometaxFieldKey[];
  /** 셀렉터 맵에 항목이 없어 건너뛴 필드 — 오너에게 "여기는 손으로 채우세요"가 된다 */
  skipped: HometaxFieldKey[];
  /**
   * 홈택스가 자동으로 채우는 칸이라 우리가 건너뛴 필드.
   *
   * ⚠️ 이건 실패가 아니라 **정상**이다(2026-08-06 실측). 건별발급 폼은 사업자등록번호를
   * 넣고 「확인」을 누르면 국세청이 상호·대표자·사업장주소·업태·종목을 조회해 채우고,
   * 그 칸들은 `disabled` 로 잠겨 있다. 우리가 채우려 들면 Playwright 가 "element is
   * not enabled" 로 15초를 기다리다 실패한다 — 그래서 **잠긴 칸은 건드리지 않는다.**
   */
  autoFilled: HometaxFieldKey[];
  /** 사업자등록번호 「확인」을 눌렀는가 — 이 클릭이 위 자동 채움을 촉발한다. */
  confirmedBusinessNumber: boolean;
  /**
   * 공급받는자 정보를 **어느 경로로** 채웠는가. 오너가 평소 쓰는 「거래처 조회」가
   * 1순위이고, 안 되면 사업자번호 + 「확인」으로 폴백한다(오너 지시, 2026-08-06).
   *
   * `note` 는 **왜 폴백했는지**를 남긴다 — 거래처 미등록인지, 동명이 여러 건인지에
   * 따라 오너가 할 일이 다르다(등록하러 갈지, 등록을 정리할지).
   */
  counterparty: {
    method: "lookup" | "businessNumber" | "none";
    note?: string;
  };
  /**
   * 넣은 값이 화면에 그대로 반영되지 않은 필드 — **이게 비어 있지 않으면 발급하면 안 된다.**
   *
   * ⛔ 2026-08-06 실사고: 공급가액 1,000,000 을 넣자 홈택스가 세액 100,000 을 자동
   * 계산해 채웠는데, 그 위에 우리가 세액을 또 넣으면서 기존 값에 **덧붙어**
   * 100,000,100,000 이 됐다(합계 1000억). 조용히 틀린 금액이 남는 것이 이 도구에서
   * 가장 위험한 실패라, 이제 넣은 뒤 **다시 읽어 대조**하고 어긋나면 여기 담는다.
   */
  mismatched: Array<{ field: HometaxFieldKey; expected: string; actual: string }>;
  /**
   * 홈택스가 띄운, **사람이 골라야 하는 창**의 제목. 비어 있지 않으면 그 선택이
   * 끝나야 폼이 완성된다.
   *
   * ⚠️ 대표 사례는 「종사업장 선택」이다(2026-08-06 실측) — 종사업장을 여러 개 둔
   * 거래처는 사업자등록번호 확인 후 어느 사업장인지 묻는 창이 뜬다. 잠실이냐
   * 이천이냐는 **거래 실질에 따른 판단**이고 CRM 에는 그 정보가 없으므로, 헬퍼가
   * 자동으로 고르지 않는다 — 잘못 고르면 엉뚱한 사업장으로 계산서가 나간다.
   * 감지해서 알리는 데까지가 헬퍼의 몫이다.
   */
  pendingUserChoice: string | null;
  /** 「계산」을 눌러 세액·합계를 채웠는가. 이 클릭이 없으면 세액이 빈 채로 남는다. */
  calculatedAmount: boolean;
};

/**
 * 사람의 선택을 기다리는 창이 떠 있는지 본다. WebSquare 모달은 여러 구현이 섞여
 * 있어 특정 클래스 하나로 잡지 않고, **보이는 대화상자**를 폭넓게 훑어 제목을 읽는다.
 */
async function detectPendingChoice(page: Page): Promise<string | null> {
  const dialog = page
    .locator('[role="dialog"], .w2modal, .w2popup_window, .w2window')
    .filter({ visible: true })
    .first();
  if (!(await dialog.isVisible({ timeout: 2_000 }).catch(() => false))) return null;
  const text = (await dialog.innerText().catch(() => "")).trim();
  if (!text) return "선택 창";
  /**
   * 🪤 **첫 줄이 창 이름이 아닐 수 있다**(2026-08-07 실측). 홈택스 모달의 첫 줄은
   * 스크린리더용 「레이어 팝업」이라, 그대로 쓰면 오너에게 "「레이어 팝업」 창을
   * 띄웠습니다"라는 아무 정보 없는 안내가 나간다 — 무슨 창인지가 곧 오너가 할 일인데
   * 그걸 못 알려주는 셈이다. 껍데기 문구를 건너뛰고 **첫 의미 있는 줄**을 쓴다.
   */
  /**
   * 껍데기 줄. 실측된 실제 구성(2026-08-07):
   *   `레이어 팝업` ⏐ `레이어팝업시작` ⏐ **`공급가액, 세액 자동계산`** ⏐ 안내문…
   * 즉 스크린리더용 마커가 **두 줄** 앞에 붙는다 — 첫 줄만 걷어내면 여전히 껍데기를
   * 집는다(첫 시도가 그랬다).
   */
  const GENERIC = /^(레이어\s*팝업(시작|끝)?|팝업|레이어|닫기|×|x)$/i;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // 무슨 창인지 못 맞히면 안내가 쓸모없어지므로, 실제 줄 구성을 남겨 다음에 고칠 수
  // 있게 한다(줄 앞부분만 — 이 창에는 금액이 실릴 수 있다).
  console.log(
    `[hometax-helper] 선택 창 감지: ${lines.slice(0, 4).map((l) => l.slice(0, 24)).join(" ⏐ ")}`,
  );
  const meaningful = lines.find((line) => line.length > 1 && !GENERIC.test(line));
  return meaningful?.slice(0, 40) || "선택 창";
}

/**
 * 「계산」이 띄우는 **자동계산 확인 창**을 닫는다 — **우리가 연 창이므로 우리가 닫는다.**
 *
 * 이 창을 열어 둔 채 끝내면 오너 화면이 모달에 막힌 상태로 남는다. 그 상태의 응답이
 * 「채웠으니 검토하세요」든 「선택해 주세요」든, 오너가 할 수 있는 일은 우리가 만든
 * 창을 손으로 치우는 것뿐이다 — 자동화가 일을 덜어 준 게 아니라 만든 셈이다.
 *
 * ⛔ **아무 「확인」이나 누르지 않는다.** 홈택스의 확인 버튼은 표준 위젯이라 **발급
 * 확인 창도 같은 모양**일 수 있다. 그래서 창의 **문구로 먼저 판별**하고(자동계산 창인
 * 것이 확인될 때만) 누른다 — 판별에 실패하면 손대지 않고 그대로 둔다. 금지 패턴
 * 검사도 그대로 지난다(`assertClickAllowed`).
 *
 * ℹ️ 이 창이 확정하는 값은 **홈택스 자신의 계산**이다(홈택스가 「1원 정도 차이가 있을
 * 수 있다」고 안내하는 그 값). 우리가 넣은 공급가액은 그대로 유지되고 세액만 홈택스가
 * 채우므로(세액은 `SKIP_FIELDS` — 우리가 넣지 않는다) 확정해도 우리 값이 덮이지 않는다.
 */
const CALCULATION_DIALOG_PATTERN = /공급가액[\s,]*세액[\s]*자동계산/;
const CALCULATION_CONFIRM_LABEL = "확인";

/**
 * 진단용 — 자동계산 팝업을 **닫지 않고 남긴다**(`HOMETAX_HELPER_KEEP_CALC_DIALOG=1`).
 *
 * 이 팝업은 열려 있을 때만 DOM 에 그려져서, 평소처럼 곧바로 닫으면 `/inspect` 덤프에
 * 한 조각도 안 남는다 — 팝업 안 입력칸의 셀렉터를 알아낼 방법이 없다. 오너 지적
 * (2026-08-09)으로 「합계를 팝업에 넣어 홈택스가 공급가액·세액을 함께 계산하게 한다」로
 * 흐름을 바꾸려면 그 셀렉터가 먼저 필요하다.
 *
 * ⛔ 평상시에는 켜지 말 것 — 열린 채로 끝나면 오너 화면이 모달에 막힌다.
 */
const KEEP_CALC_DIALOG = process.env.HOMETAX_HELPER_KEEP_CALC_DIALOG === "1";

async function confirmCalculationDialog(page: Page): Promise<boolean> {
  if (KEEP_CALC_DIALOG) {
    console.log("[hometax-helper] 진단 모드: 자동계산 팝업을 닫지 않고 둡니다(KEEP_CALC_DIALOG=1).");
    return false;
  }
  const dialog = page
    .locator('[role="dialog"], .w2modal, .w2popup_window, .w2window')
    .filter({ visible: true })
    .first();
  if (!(await dialog.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
  const text = (await dialog.innerText().catch(() => "")).trim();
  if (!CALCULATION_DIALOG_PATTERN.test(text)) return false;

  assertClickAllowed(CALCULATION_CONFIRM_LABEL, [CALCULATION_CONFIRM_LABEL]);
  const byRole = dialog
    .getByRole("button", { name: CALCULATION_CONFIRM_LABEL, exact: true })
    .filter({ visible: true })
    .first();
  const target = (await byRole.count().catch(() => 0))
    ? byRole
    : dialog.locator(`input[value="${CALCULATION_CONFIRM_LABEL}"]`).filter({ visible: true }).first();

  try {
    await target.click({ timeout: 8_000 });
  } catch (err) {
    // 삼키지 않는다 — 못 닫았으면 오너 화면에 그대로 남으므로 사실을 남긴다(P0).
    console.error(
      "[hometax-helper] 자동계산 확인 창을 닫지 못했습니다:",
      err instanceof Error ? err.message.split("\n")[0] : String(err),
    );
    return false;
  }
  await page.waitForTimeout(800);
  return true;
}

/** 화면 표시값을 비교용으로 정규화 — 홈택스가 붙이는 콤마·공백·하이픈을 걷어낸다. */
function normalizeForCompare(value: string): string {
  return value.replace(/[,\s-]/g, "");
}

/**
 * 텍스트에서 사업자등록번호처럼 보이는 토큰을 전부 뽑아 **숫자만** 남겨 돌려준다.
 *
 * 🪤 앞뒤 경계(`(?<!\d)` / `(?!\d)`)가 핵심이다 — 없으면 12자리 숫자 덩어리 안에서
 * 10자리를 잘라내 **엉뚱한 번호를 만들어낸다.** 거래처 선택에서 그건 곧 오발행이다.
 */
export function extractBusinessNumbers(text: string): string[] {
  return [...text.matchAll(/(?<!\d)\d{3}-?\d{2}-?\d{5}(?!\d)/g)].map((m) => m[0].replace(/\D/g, ""));
}

/** 사업자등록번호 동일성 — 하이픈·공백 표기 차이를 흡수하고 **10자리 숫자**로만 비교한다. */
export function sameBusinessNumber(a: string, b: string): boolean {
  const x = a.replace(/\D/g, "");
  const y = b.replace(/\D/g, "");
  return x.length === 10 && x === y;
}

export type CounterpartyRow = { index: number; numbers: string[] };
export type CounterpartyChoice =
  | { ok: true; index: number }
  | { ok: false; reason: "none" | "ambiguous" };

/**
 * 거래처 검색 결과에서 고를 행을 정한다 — **정확히 한 건일 때만 고른다.**
 *
 * ⛔ 이 함수가 이 경로의 안전장치 전부다. 거래처를 잘못 고르면 엉뚱한 회사 앞으로
 * 계산서가 나가고, 그건 발급하고 나서야 드러난다. 그래서 「비슷한 것 중 제일 그럴듯한
 * 것」을 고르는 규칙을 두지 않는다 — 상호 부분일치도, 첫 행 우선도 없다. 사업자등록
 * 번호가 **정확히** 일치하는 행이 하나면 그것, 0건이거나 2건 이상이면 포기다.
 * 포기는 실패가 아니라 사업자번호 입력 경로로의 폴백이다(호출부가 처리한다).
 */
export function chooseCounterpartyRow(rows: CounterpartyRow[], wanted: string): CounterpartyChoice {
  const matches = rows.filter((row) => row.numbers.some((n) => sameBusinessNumber(n, wanted)));
  if (matches.length === 1) return { ok: true, index: matches[0]!.index };
  return { ok: false, reason: matches.length === 0 ? "none" : "ambiguous" };
}

/** 페이로드에서 각 필드에 넣을 문자열을 뽑는다. 금액은 숫자만(콤마 없이) — 홈택스
 *  입력칸이 자동 포맷하므로 우리가 콤마를 넣으면 파싱이 어긋날 수 있다. */
function resolveFieldValues(payload: InvoicePayload): Record<HometaxFieldKey, string> {
  const item = payload.lineItems[0];
  // 이메일은 화면이 아이디/도메인 두 칸으로 받는다(실측) — `@` 로 가른다.
  // `@` 가 없으면 도메인을 비워 두고 아이디 칸에만 넣는다: 잘못 쪼개 엉뚱한 주소를
  // 만드는 것보다, 한 칸이 빈 채로 사람이 보고 채우는 편이 안전하다.
  const at = payload.buyerEmail1.indexOf("@");
  const emailId = at === -1 ? payload.buyerEmail1 : payload.buyerEmail1.slice(0, at);
  const emailDomain = at === -1 ? "" : payload.buyerEmail1.slice(at + 1);

  return {
    buyerBusinessNumber: payload.buyerBusinessNumber,
    buyerName: payload.buyerName,
    buyerCeo: payload.buyerCeo,
    buyerAddress: payload.buyerAddress,
    buyerBusinessType: payload.buyerBusinessType,
    buyerBusinessItem: payload.buyerBusinessItem,
    buyerEmailId: emailId,
    buyerEmailDomain: emailDomain,
    invoiceDate: toHometaxDate(payload.invoiceDate),
    // 거래일자의 일(日). 작성일자 = 공급 연월일이므로 보통 같은 값이고, 없으면
    // 작성일자에서 가져온다. ⚠️ 이 값이 작성일자보다 **뒤면 홈택스가 지운다**(실측).
    itemDay: item?.date?.replace(/\D/g, "") || (payload.invoiceDate ?? "").replace(/\D/g, "").slice(6, 8),
    itemName: item?.name ?? "",
    itemSupplyAmount: String(item?.supplyAmount ?? payload.totalSupplyAmount),
    // ⛔ 세액은 **빈 문자열**이다 — 우리가 넣지 않는다.
    //
    // 홈택스는 공급가액을 넣으면 세액을 스스로 계산해 채운다(실측). 그 위에 우리가
    // 또 넣으면 2026-08-06 사고처럼 기존 값에 덧붙어 100,000 이 100,000,100,000 이
    // 된다. 계산 주체를 하나로 두는 것이 유일한 안전책이고, 홈택스 계산값이 우리
    // 값과 다르면 그건 **사람이 봐야 할 신호**이지 우리가 덮어쓸 일이 아니다.
    // (아래 `SKIP_FIELDS` 가 실제로 입력을 건너뛴다.)
    itemTaxAmount: "",
    remark: item?.remark ?? "",
  };
}

/**
 * 값이 있어도 **입력하지 않는** 필드. 홈택스가 스스로 채우는 칸이라 우리가 손대면
 * 중복 입력이 된다(위 `itemTaxAmount` 주석의 실사고).
 */
const SKIP_FIELDS: ReadonlySet<HometaxFieldKey> = new Set<HometaxFieldKey>(["itemTaxAmount"]);

/**
 * **이미 값이 있으면 덮어쓰지 않는** 필드 — 국세청이 사업자등록번호로 조회해 채운
 * 공급받는자 정보다.
 *
 * ⛔ 2026-08-06 실사고: 종사업장 선택이 끝나자 잠겨 있던 칸이 열렸고, 우리 로직이
 * 「열려 있으니 채운다」로 판단해 **국세청이 넣은 정식 주소를 CRM 의 축약 주소로
 * 덮어썼다.** 국세청 조회값이 CRM 값보다 정확하다 — CRM 은 낡을 수 있고(주소 변경·
 * 상호 변경) 우리가 손으로 입력한 값이다. 잠김 여부가 아니라 **값의 유무**로
 * 판단해야 한다.
 *
 * 이메일은 여기 넣지 않는다 — 계산서를 어디로 보낼지는 우리가 정하는 값이고,
 * 홈택스의 거래처 기본값보다 CRM 이 최신인 것이 정상이다.
 */
const PRESERVE_IF_FILLED: ReadonlySet<HometaxFieldKey> = new Set<HometaxFieldKey>([
  "buyerName",
  "buyerCeo",
  "buyerAddress",
  "buyerBusinessType",
  "buyerBusinessItem",
]);

/**
 * 건별발급 화면까지 이동한다 — **URL 직행이 1순위**, 메뉴 클릭은 폴백이다.
 *
 * ⛔ 오너가 매번 손으로 화면을 찾아 들어가야 한다면 자동화라고 부를 수 없다(오너
 * 지적, 2026-08-06). 홈택스는 WebSquare SPA 라 화면이 URL 쿼리로 지정되므로,
 * `issueFormUrl` 하나면 클릭 없이 재현된다 — 자동 생성 id 에 기대는 메뉴 클릭보다
 * 깨질 여지도 적다. 그래서 URL 이 있으면 클릭 경로는 아예 타지 않는다.
 *
 * 이미 그 화면에 있으면 다시 이동하지 않는다 — 오너가 열어 둔 작업 상태(입력하던
 * 값·조회 결과)를 우리가 날리지 않기 위해서다.
 */
/**
 * 시작 전 **열려 있는 모달을 닫는다.**
 *
 * ⛔ 2026-08-06 실사고: 거래처 조회 팝업이 떠 있는 상태에서 발행을 시작했더니
 * 「위치를 못 찾고 화면이 왔다갔다 하다가 실패」했다. 모달이 떠 있으면 그 뒤의 메뉴·
 * 버튼이 클릭을 못 받고, 우리는 그걸 "셀렉터가 틀렸다"로 오해하게 된다.
 *
 * 헬퍼는 오너가 쓰던 창을 그대로 물려받으므로 **깨끗한 화면을 가정하면 안 된다** —
 * 직전에 무엇을 하다 왔는지 알 수 없다. Escape 는 클릭이 아니라 가드 대상이 아니고,
 * 발급·서명 버튼을 누를 수 없다.
 */
async function closeOpenDialogs(page: Page, attempts = 3): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const dialog = page
      .locator('[role="dialog"], .w2modal, .w2popup_window, .w2window')
      .filter({ visible: true })
      .first();
    if (!(await dialog.isVisible({ timeout: 1_500 }).catch(() => false))) return;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
  }
}

export async function navigateToIssueForm(page: Page, map: SelectorMap): Promise<void> {
  // 물려받은 창의 상태를 모르므로 먼저 정리한다(위 실사고).
  await closeOpenDialogs(page);

  if (map.issueFormUrl) {
    if (page.url() !== map.issueFormUrl) {
      await page.goto(map.issueFormUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // WebSquare 는 셸 로드 뒤 화면을 그린다 — 폼이 그려지기 전에 fill 하면 실패한다.
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    }
    return;
  }

  // 폴백: 셀렉터 맵에 URL 이 없을 때만 메뉴를 클릭해 찾아간다.
  // ⚠️ 클릭은 전부 가드를 통과한다 — 맵에 발급 버튼을 적어 넣어도 여기서 거부된다.
  const allowed = allowedClickLabels(map);
  for (const [label, selector] of Object.entries(map.navigation ?? {})) {
    assertClickAllowed(label, allowed);
    // 🪤 `.first()` 가 필수다(2026-08-06 실사고). 메뉴 id 가 화면마다 달라서 셀렉터를
    // 합집합(`#combineMenuAtag_…, #menuAtag_…`)으로 두는데, **둘 다 존재하는 화면**이
    // 있어 Playwright 가 strict mode 위반으로 거부한다. 둘은 같은 onclick
    // (`fn_topMenuOpen`)을 가진 같은 메뉴라 어느 쪽을 눌러도 결과가 같다.
    const link = page.locator(selector).first();
    try {
      await link.click({ timeout: 8_000 });
    } catch {
      // 🪤 홈택스 메뉴 링크는 **대메뉴가 접혀 있으면 보이지 않는다** — 일반 클릭은
      // "element is not visible" 로 실패한다(2026-08-06 실측). 그런데 그 링크의
      // onclick(`fn_topMenuOpen`)은 화면을 직접 여는 함수라, 펼치지 않고 눌러도
      // 목적지에 도달한다. 대메뉴를 먼저 펼치려면 자동 생성 id(`wq_uuid_369`)에
      // 기대야 하는데 그건 세션마다 바뀌므로 더 취약하다.
      //
      // ⚠️ force 는 가시성 검사를 건너뛸 뿐 **금지선을 건너뛰지 않는다** — 위
      // `assertClickAllowed` 를 이미 통과한 대상에만 쓴다.
      try {
        await link.click({ timeout: 8_000, force: true });
      } catch {
        // `force` 도 hit target 을 요구해서 완전히 숨겨진 요소에는 통하지 않는다
        // (실측: "Element is not visible" 로 동일 실패). 마지막 수단으로 클릭
        // **이벤트만** 보낸다 — onclick 핸들러는 가시성과 무관하게 실행된다.
        // ⚠️ 여기까지 온 대상은 이미 `assertClickAllowed` 를 통과했다.
        await link.dispatchEvent("click", { timeout: 8_000 });
      }
    }
    // 화면 전환(WebSquare 는 셸 안에서 화면을 갈아끼운다)을 기다린다.
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_200);
  }
}

/**
 * 「거래처 조회」로 공급받는자를 채워 본다. **성공했을 때만** `true` 를 돌려주고,
 * 나머지는 전부 폴백 사유와 함께 `false` 다 — 애매한 상태를 성공으로 보고하지 않는다.
 *
 * 흐름: 팝업 열기 → 사업자번호로 검색 → 행 판정(`chooseCounterpartyRow`) → 선택 →
 * **폼의 사업자번호를 되읽어 대조**. 마지막 대조가 이 경로의 최종 방어선이다 — 팝업이
 * 우리 의도와 다르게 동작해도 폼에 남은 번호가 다르면 여기서 걸린다.
 */
async function tryCounterpartyLookup(
  page: Page,
  map: SelectorMap,
  wantedBusinessNumber: string,
): Promise<{ ok: boolean; note?: string }> {
  const cfg = map.counterpartyLookup;
  if (!cfg) return { ok: false, note: "거래처 조회 셀렉터가 맵에 없습니다" };
  // 🪤 `/inspect` 초안은 여는 버튼만 잡고 팝업 내부는 **빈 문자열**로 남긴다(팝업이
  // 떠 있어야 DOM 에 있으므로). 그걸 그대로 붙여 넣은 맵으로 팝업을 열면 열어 놓고
  // 헤매게 되므로, 아예 시작하지 않고 무엇이 비었는지 알린다.
  const missing = [
    !cfg.open?.selector && "open.selector",
    !cfg.searchInput && "searchInput",
    !cfg.resultRow && "resultRow",
  ].filter(Boolean);
  if (missing.length > 0) {
    return {
      ok: false,
      note: `거래처 조회 셀렉터가 미완성입니다(${missing.join(", ")}) — 팝업을 연 상태에서 /inspect 를 한 번 더 돌리세요`,
    };
  }

  /**
   * 열어 둔 팝업을 닫는다 — **폴백이 이어지려면 반드시 닫혀야 한다.**
   *
   * ⛔ 2026-08-06 실사고: Escape 만 눌렀는데 이 팝업은 **Escape 로 안 닫힌다.** 그대로
   * 떠 있는 채 사업자번호 경로가 이어졌고, 팝업이 뒤쪽 클릭을 전부 가로막아 오너
   * 화면이 멈춘 상태로 끝났다. 실패했을 때 **원래 상태로 되돌리는 것**까지가 이 경로의
   * 책임이다 — 실패는 불편이어야지 막힘이 되면 안 된다.
   */
  const dismiss = async () => {
    if (cfg?.close?.selector) {
      assertClickAllowed(cfg.close.label, [cfg.close.label]);
      await page.click(cfg.close.selector, { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
    // 닫기 버튼이 없거나 실패했을 때의 마지막 수단(가드 대상 아님 — 클릭이 아니다).
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
  };

  try {
    assertClickAllowed(cfg.open.label, [cfg.open.label]);
    await page.click(cfg.open.selector, { timeout: 10_000 });
    await page.waitForTimeout(800);

    const digits = wantedBusinessNumber.replace(/\D/g, "");
    if (digits.length !== 10) {
      await dismiss();
      return { ok: false, note: `사업자등록번호가 10자리가 아닙니다(${digits.length}자리)` };
    }

    const search = page.locator(cfg.searchInput);
    await search.fill("", { timeout: 10_000 });
    await search.fill(digits, { timeout: 10_000 });
    if (cfg.search) {
      assertClickAllowed(cfg.search.label, [cfg.search.label]);
      await page.click(cfg.search.selector, { timeout: 10_000 });
    } else {
      await search.press("Enter");
    }
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);

    // 결과 행을 읽어 **번호로만** 판정한다(상호는 표기가 흔들린다 — 오너 실사례:
    // 같은 거래처가 「코믹라이프」에서 「서울모아」로 상호를 바꿨다).
    const rowLocator = page.locator(cfg.resultRow);
    const count = await rowLocator.count();
    const rows: CounterpartyRow[] = [];
    for (let i = 0; i < count; i++) {
      const row = rowLocator.nth(i);
      const text = cfg.rowBusinessNumber
        ? await row.locator(cfg.rowBusinessNumber).innerText().catch(() => "")
        : await row.innerText().catch(() => "");
      rows.push({ index: i, numbers: extractBusinessNumbers(text) });
    }

    const choice = chooseCounterpartyRow(rows, digits);
    if (!choice.ok) {
      await dismiss();
      return {
        ok: false,
        note:
          choice.reason === "none"
            ? `거래처 목록에 이 사업자등록번호가 없습니다(결과 ${count}건) — 홈택스에 거래처로 등록해 두면 다음부터 이 경로를 씁니다`
            : `같은 사업자등록번호의 거래처가 여러 건입니다(결과 ${count}건) — 헬퍼가 고르지 않습니다`,
      };
    }

    // 행 자체가 아니라 지정된 요소(보통 라디오)를 누른다 — 그리드에 따라 행 클릭이
    // 무시되는데, 그 실패는 「눌렀는데 아무 일도 안 일어남」이라 원인 찾기가 가장 번거롭다.
    const chosenRow = rowLocator.nth(choice.index);
    const clickTarget = cfg.rowSelect ? chosenRow.locator(cfg.rowSelect) : chosenRow;
    // 🪤 3단 폴백이 필요하다(2026-08-06 실측). 라디오는 「visible·enabled·stable」인데도
    // **"element is outside of the viewport"** 로 클릭이 거부됐다 — WebSquare 그리드가
    // 행을 가상 스크롤로 배치해서 Playwright 의 뷰포트 판정과 어긋난다. 스크롤을 시도해도
    // 같은 결과였다(재시도 로그 실측).
    // ⚠️ force 는 액션 판정만 건너뛴다 — 금지선과 무관하고, 이 대상은 데이터 행이지
    // 발급 버튼이 아니다(발급·서명 라벨은 애초에 맵에 못 들어온다).
    try {
      await clickTarget.click({ timeout: 8_000 });
    } catch {
      try {
        await clickTarget.click({ timeout: 8_000, force: true });
      } catch {
        await clickTarget.dispatchEvent("click", { timeout: 8_000 });
      }
    }
    if (cfg.confirm) {
      assertClickAllowed(cfg.confirm.label, [cfg.confirm.label]);
      await page.click(cfg.confirm.selector, { timeout: 10_000 });
    }
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);

    // ⛔ 최종 대조. 팝업이 닫혔다는 사실만으로 "골랐다"고 말하지 않는다.
    const bsnoSelector = map.fields.buyerBusinessNumber;
    if (!bsnoSelector) {
      return { ok: false, note: "사업자번호 칸 셀렉터가 없어 결과를 대조할 수 없습니다" };
    }
    const applied = await page.locator(bsnoSelector).inputValue().catch(() => "");
    if (!sameBusinessNumber(applied, digits)) {
      return {
        ok: false,
        note: `거래처를 골랐지만 폼의 사업자등록번호가 다릅니다(화면 "${applied}") — 이 경로를 신뢰하지 않습니다`,
      };
    }
    return { ok: true };
  } catch (err) {
    await dismiss();
    return { ok: false, note: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 폼을 채운다. 셀렉터가 없는 필드는 **추측하지 않고 건너뛴다** — 엉뚱한 칸에 사업자
 * 번호를 넣는 것보다 비워 두는 편이 안전하고, 무엇이 비었는지는 결과로 보고된다.
 */
/**
 * 확인 팝업이 떴는지 판별하는 문구. 「발급하시겠습니까」는 이 팝업 고유의 물음이다.
 *
 * ⛔ 아무 모달이나 「발급 확인창」으로 읽지 않는다 — 자동계산 확인창·종사업장 선택창이
 * 같은 위젯이라, 문구 없이 판단하면 **누르지도 않은 상태를 「발급 직전」으로 보고**한다.
 */
const ISSUE_CONFIRM_DIALOG_PATTERN = /발급하시겠습니까|삭제가\s*불가능/;

/**
 * ⚠️ 판별자가 `status` 가 **아니라** `outcome` 인 것은 의도다. `/issue` 응답의 status 와
 * 이름이 같으면, 헬퍼가 내는 응답 status 를 CRM 클라이언트가 전부 열거하는지 검사하는
 * 계약 테스트(`hometax-helper-client.test.ts`)가 **내부 값까지 응답으로 오인**한다.
 * 이건 내부 결과이지 CRM 이 보는 값이 아니다.
 */
export type SubmitOutcome =
  /**
   * 확인 팝업을 지나 **인증서 비밀번호 창까지** 갔다(오너 승인 2026-08-08).
   * 이 도구가 멈추는 최종 지점이고, 남은 행위는 오너가 여섯 자리를 누르는 것뿐이다.
   */
  | { outcome: "AWAITING_SIGNATURE"; clicked: string[] }
  /** 인증 단계를 걷다 중간에 멈췄다 — 어디서 멈췄는지가 곧 오너가 이어받을 지점이다. */
  | { outcome: "AUTH_STOPPED"; clicked: string[]; stoppedAt: string }
  /** 「발급하기」를 눌렀고 확인 팝업이 떴다 — 이제 사람이 누른다. */
  | { outcome: "AWAITING_CONFIRM"; dialogText: string }
  /** 누르긴 눌렀는데 확인 팝업을 못 봤다. **성공이라고 말하지 않는다.** */
  | { outcome: "SUBMIT_NO_DIALOG"; note: string }
  /** 아예 누르지 못했다(선언 없음·비활성·셀렉터 불일치). 폼은 채워진 채로 남는다. */
  | { outcome: "SUBMIT_SKIPPED"; note: string };

/**
 * 「발급하기」를 누른다 — **발급이 확정되는 것이 아니라 확인 팝업이 뜨는 데까지**다
 * (오너 승인 2026-08-08, `guards.ts` `assertIssueSubmitAllowed` 의 유일한 예외).
 *
 * ⛔ **이 함수는 확인 팝업을 건드리지 않는다.** 팝업의 「확인(인증 화면 이동)」은 금지
 * 패턴이라 눌릴 수 없고, 전자서명은 애초에 우리 손이 닿지 않는다. 여기서 하는 일은
 * 「눌렀다」와 「팝업이 떴다」를 사실대로 보고하는 것뿐이다.
 *
 * 🪤 **버튼이 비활성일 수 있다** — 2026-08-08 사고가 정확히 그것이었다(비고 100byte
 * 초과로 홈택스가 발급 버튼을 잠갔다). 그때 억지로 누르려고 기다리지 않고 사유를 담아
 * 돌려준다: 폼은 채워져 있으므로 오너가 화면에서 고쳐 누르면 된다.
 */
/** 발행 전 자체 검토에서 걸린 항목. 사람이 읽는 문장이 곧 오너가 할 일이다. */
export type PreflightProblem = { field: string; reason: string };

/**
 * **발행 전 자체 검토**(오너 지시 2026-08-08: "발행 누르기 전에 자체적으로 한번 검토").
 *
 * ## 왜 필요한가
 *
 * 헬퍼가 「발급하기」까지 누르게 되면서(같은 날 개정) 오너가 폼을 눈으로 보는 단계가
 * 사라졌다. 그 자리를 사람 대신 **기계 대조**로 채운다 — 이 함수가 하나라도 잡으면
 * 발급 버튼을 **누르지 않는다.**
 *
 * ## 무엇을 보나 — 화면에서 **다시 읽어** 페이로드와 대조한다
 *
 * 「우리가 넣은 값」이 아니라 **지금 화면에 있는 값**을 읽는 것이 핵심이다. 홈택스가
 * 자동 계산하거나(세액) 자동으로 채우거나(국세청 조회) 조용히 지우는 칸이 있어서
 * (2026-08-06: 계산을 누르자 품목 일자가 사라졌다), 넣은 값만 믿으면 화면과 어긋난 채
 * 발급이 나간다.
 *
 * ## 바이트 상한을 여기서 미리 잡는 이유
 *
 * 홈택스는 상한 초과를 **네이티브 alert 로** 알리는데, 그건 Playwright 가 자동으로
 * 닫아 버려 원인 없이 "아무 일도 안 일어남"이 된다(2026-08-08 실사고 — 원인 규명에
 * 세 번의 왕복이 들었다). 우리가 먼저 재면 그 왕복이 없다. 상한값은 CRM 이 자를 때
 * 쓰는 것과 **같은 SSOT** 다.
 */
/**
 * `read` 의 결과 — **세 상태를 구분한다**(2026-08-08 리뷰 반영).
 *
 * ⛔ "맵에 셀렉터가 없음"(설정상 검사 대상이 아님)과 "셀렉터는 있는데 조회가
 * 실패함"(DOM 일시 재렌더 등 실제 이상)을 같은 `null` 로 합치면, 유일한 자동
 * 방어선이 원인 모를 실패에서 **조용히 통과**로 바뀐다 — 발급 버튼이 눌린 뒤에야
 * 문제를 알게 된다. `no-selector` 는 판단 보류(그 칸을 검사하기로 한 적이 없다),
 * `read-failed` 는 **검토 실패로 취급**한다(fail-closed — 이 함수의 존재 이유가
 * "모르면 막는다"이므로 읽기 자체가 안 되는 상태를 통과시키지 않는다).
 */
type FieldRead =
  | { status: "ok"; value: string }
  | { status: "no-selector" }
  | { status: "read-failed" };

export async function preflightBeforeSubmit(
  page: Page,
  map: SelectorMap,
  payload: InvoicePayload,
): Promise<PreflightProblem[]> {
  const problems: PreflightProblem[] = [];
  const read = async (key: HometaxFieldKey): Promise<FieldRead> => {
    const selector = map.fields[key];
    if (!selector) return { status: "no-selector" };
    try {
      return { status: "ok", value: await page.locator(selector).inputValue() };
    } catch {
      return { status: "read-failed" };
    }
  };

  // ① 홈택스 자체 제약 — 자유 텍스트 칸의 바이트 상한.
  for (const [key, label] of [
    ["remark", "품목비고"],
    ["itemName", "품목명"],
  ] as const) {
    const result = await read(key);
    if (result.status === "read-failed") {
      problems.push({ field: label, reason: "화면에서 값을 읽지 못해 바이트 상한을 확인할 수 없습니다." });
    } else if (result.status === "ok" && countHometaxBytes(result.value) > HOMETAX_TEXT_MAX_BYTES) {
      problems.push({
        field: label,
        reason: `${countHometaxBytes(result.value)}바이트로 홈택스 상한(${HOMETAX_TEXT_MAX_BYTES}바이트)을 넘습니다.`,
      });
    }
  }

  // ② 상대·날짜·금액이 CRM 이 확정한 값과 같은가. 화면 값이 정답이 아니라 **대조 대상**이다.
  const expectations: Array<{ key: HometaxFieldKey; label: string; expected: string }> = [
    { key: "buyerBusinessNumber", label: "공급받는자 등록번호", expected: payload.buyerBusinessNumber },
  ];
  /**
   * ⚠️ **공급가액 대조는 경로에 따라 다르다.** 자동계산 팝업을 쓰면 그 칸은 홈택스가
   * 채운 값이라 우리 페이로드와 1원 단위로 다를 수 있다(그게 이 경로를 택한 이유다) —
   * 여기서 우리 값과 대조하면 **정상 상태를 실패로 보고**한다. 팝업 경로의 금액 검증은
   * `fillAmountViaCalcPopup` 이 「공급가액 + 세액 == 합계」로 이미 했다.
   */
  if (!map.calcPopup) {
    expectations.push({
      key: "itemSupplyAmount",
      label: "품목 공급가액",
      expected: String(payload.lineItems[0]?.supplyAmount ?? payload.totalSupplyAmount),
    });
  }
  for (const { key, label, expected } of expectations) {
    if (expected === "") continue; // CRM 이 애초에 넣을 값이 없으면 대조 대상이 아니다.
    const result = await read(key);
    if (result.status === "no-selector") continue; // 이 칸을 검사하기로 한 적이 없다.
    if (result.status === "read-failed") {
      problems.push({ field: label, reason: "화면에서 값을 읽지 못해 CRM 값과 대조할 수 없습니다." });
      continue;
    }
    if (normalizeForCompare(result.value) !== normalizeForCompare(expected)) {
      problems.push({ field: label, reason: `화면 값 "${result.value}" 이 CRM 값 "${expected}" 과 다릅니다.` });
    }
  }

  return problems;
}

export async function submitIssueForm(page: Page, map: SelectorMap): Promise<SubmitOutcome> {
  /**
   * ⛔ 결과를 **로그에도** 남긴다(P0). 사유는 응답 `message` 로도 가지만, CRM 이 배포되기
   * 전이거나 호출부가 그 필드를 안 쓰면 오너에게 도달하지 못한다 — 실제로 착지 당일
   * "발급하기를 안 누르는데?"만 남고 사유가 통째로 사라졌다. 로그는 그 경로와 무관하다.
   */
  const report = (result: SubmitOutcome): SubmitOutcome => {
    const detail =
      "note" in result
        ? result.note
        : "stoppedAt" in result
          ? `「${result.stoppedAt}」에서 멈춤 (지나온 단계: ${result.clicked.join(" → ") || "없음"})`
          : "clicked" in result
            ? `비밀번호 창까지 진행 (${result.clicked.join(" → ")})`
            : "확인 창이 떴습니다";
    console.log(`[hometax-helper] 발급 클릭: ${result.outcome} — ${detail}`);
    return result;
  };

  const selector = map.issueSubmit?.selector;
  if (!selector) {
    return report({
      outcome: "SUBMIT_SKIPPED",
      note: "셀렉터 맵에 `issueSubmit` 이 없어 발급 버튼을 누르지 않았습니다(선언 없이는 누르지 않습니다).",
    });
  }
  // 금지선의 단 하나의 예외 — 선언된 그 셀렉터와 정확히 같을 때만 통과한다.
  assertIssueSubmitAllowed(selector, map.issueSubmit?.selector);

  const button = page.locator(selector);
  if (!(await button.isEnabled({ timeout: 5_000 }).catch(() => false))) {
    return report({
      outcome: "SUBMIT_SKIPPED",
      note:
        "홈택스가 발급 버튼을 잠가 두었습니다 — 입력값 중 하나가 홈택스 검증에 걸린 상태입니다" +
        "(예: 비고 100byte 초과). 열린 창에서 해당 칸을 고친 뒤 직접 누르세요.",
    });
  }

  /**
   * ⛔ **네이티브 알림을 삼키지 않는다**(P0, 2026-08-08).
   *
   * Playwright 는 `dialog` 핸들러가 **없으면 자동으로 닫는다.** 이 헬퍼에는 핸들러가
   * 한 줄도 없었으므로, 홈택스가 발급 검증 실패를 `alert()` 로 띄웠다면 그 문구는
   * 화면에도 로그에도 남지 않고 사라진다 — 오너 눈에는 「아무 일도 안 일어남」이다.
   * 실제로 "발급하기를 안 누르는데?"의 원인 후보가 이것이었다.
   *
   * ⛔ **`accept()` 를 쓰지 않는다.** 확인을 누르는 것은 이 도구가 사람에게 남겨 둔
   * 행위다 — 네이티브 확인창을 자동 수락하면 금지선을 우회하는 통로가 된다.
   * 기록하고 닫기만 한다.
   */
  let nativeAlert: string | null = null;
  const onDialog = (d: { type: () => string; message: () => string; dismiss: () => Promise<void> }) => {
    nativeAlert = `${d.type()}: ${d.message()}`.replace(/\s+/g, " ").slice(0, 200);
    console.log(`[hometax-helper] 홈택스 알림(자동 닫힘): ${nativeAlert}`);
    void d.dismiss().catch(() => {});
  };
  page.on("dialog", onDialog);

  try {
    await button.click({ timeout: 10_000 });
  } finally {
    // 이 함수 밖의 동작까지 가로채지 않는다 — 리스너는 클릭 구간에만 붙인다.
    setTimeout(() => page.off("dialog", onDialog), 10_000);
  }

  const dialogs = page
    .locator('[role="dialog"], .w2modal, .w2popup_window, .w2window')
    .filter({ visible: true });
  const dialog = dialogs.first();
  /**
   * 🪤 **`isVisible()` 로 기다릴 수 없다**(2026-08-08 실측). Playwright 의 `isVisible()`
   * 은 `timeout` 옵션을 받지만 **기다리지 않고 즉시 판정한다** — waiting assertion 이
   * 아니다. 처음엔 `isVisible({ timeout: 8_000 })` 으로 썼고, 발급 버튼을 실제로 눌렀는데
   * 팝업이 렌더되기 전에 곧바로 「떠 있는 창이 없습니다」로 판정했다(8초를 기다린 적이
   * 없다). 기다리는 것은 `waitFor` 다.
   *
   * ⚠️ 같은 파일의 `detectPendingChoice`·`confirmCalculationDialog` 도 같은 패턴이지만
   * 그쪽은 **클릭 + `waitForTimeout` 뒤에** 불려 창이 이미 떠 있는 상태를 본다 — 같은
   * 코드가 호출 시점 때문에 한쪽만 깨졌다. 이 함수는 클릭 **직후**라 반드시 기다려야 한다.
   */
  await dialog.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});

  /**
   * 🪤 **문구가 아니라 버튼으로 판별한다**(2026-08-08 실측, 두 번째 실패). 문구 매칭은
   * 두 가지로 깨졌다 — ①`.first()` 가 확인 창이 아닌 다른 보이는 레이어를 집는 경우
   * ②그 레이어를 바로 집었는데도 `innerText()` 가 스크린리더용 마커(「레이어 팝업」)
   * 만 돌려주고 본문(「전자세금계산서를 발급하시겠습니까?」)을 놓치는 경우 — 실제로
   * 오너 화면에는 그 문구와 「확인(인증 화면 이동)」 버튼이 멀쩡히 떠 있었다.
   *
   * 이 팝업의 **유일한 고유 표식**은 버튼 문구 「확인(인증 화면 이동)」이다(다른 팝업
   * 어디에도 없는 문구). 버튼을 찾으면 그 조상을 확인 창으로 본다 — `getByRole` 은
   * 접근성 트리를 보므로 화면리더 마커에 가려지지 않는다.
   *
   * ⛔ **이 버튼을 클릭하지 않는다** — 찾기만 한다. 클릭은 여전히 사람 몫이고,
   * 그 문구 자체가 `guards.ts` 의 금지 패턴이라 클릭 경로로는 애초에 눌리지 않는다.
   */
  const confirmButton = page.getByText("확인(인증 화면 이동)", { exact: true }).filter({ visible: true }).first();
  const confirmed = await confirmButton
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);

  if (!confirmed) {
    const seen: string[] = [];
    const count = await dialogs.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 6); i++) {
      const t = (await dialogs.nth(i).innerText().catch(() => "")).trim();
      if (t) seen.push(t.replace(/\s+/g, " ").slice(0, 50));
    }
    return report({
      outcome: "SUBMIT_NO_DIALOG",
      note:
        "발급 버튼을 눌렀지만 확인 창을 확인하지 못했습니다 — 화면 상태를 직접 보세요. " +
        (nativeAlert
          ? `홈택스 알림: ${nativeAlert}`
          : seen.length > 0
            ? `본 창(${seen.length}개): ${seen.join(" ⏐ ")}`
            : "떠 있는 창이 없습니다(검증 오류일 수 있습니다)."),
    });
  }
  /**
   * 확인 팝업을 지나 **비밀번호 창까지** 밟는다(오너 승인 2026-08-08 — 「비밀번호 패드까지
   * 전부 진행」). 선언(`issueAuth.steps`)이 없으면 종전대로 여기서 멈춘다.
   *
   * ⛔ 비밀번호는 누르지 않는다. 클릭은 선언된 단계 라벨에만 나가고(deny-by-default),
   * 숫자 키패드는 어떤 라벨과도 일치하지 않는다.
   */
  const authSteps = map.issueAuth?.steps ?? [];
  if (authSteps.length === 0) {
    const text = (await dialog.innerText().catch(() => "")).trim();
    return report({
      outcome: "AWAITING_CONFIRM",
      dialogText: (text || "확인(인증 화면 이동) 버튼 확인됨").replace(/\s+/g, " ").slice(0, 200),
    });
  }

  const { clicked, stoppedAt } = await clickLabeledSteps(page, authSteps);
  if (stoppedAt) {
    // 멈춘 지점을 그대로 말한다 — 폼과 확인 팝업은 이미 지나왔으므로 오너가 화면에서
    // 그 단계부터 이어가면 된다(되돌릴 것이 없다).
    return report({ outcome: "AUTH_STOPPED", clicked, stoppedAt });
  }
  return report({ outcome: "AWAITING_SIGNATURE", clicked });
}

/**
 * 「공급가액, 세액 자동계산」 팝업으로 금액을 채운다 — **합계만 주고 나머지는 홈택스가**
 * (오너 지시 2026-08-09).
 *
 * ## 왜 이 경로인가
 *
 * 종전에는 공급가액을 우리가 넣고(`round(합계/1.1)`) 세액은 홈택스가 계산했다. 그런데
 * **홈택스는 절사하고 우리는 반올림한다**(실측 2건) — 두 주체가 각자 반올림하니 합이
 * 정산 금액과 1원 어긋났고, 그 상태로 계산서가 실제 발행됐다. 합계 하나만 주면 두 값이
 * **같은 주체**에서 나오므로 구조적으로 어긋날 수 없다.
 *
 * ⛔ **결과 칸(공급가액·세액)은 읽기만 한다.** 우리가 덮어쓰면 2026-08-06 의 덧붙기
 * 사고(100,000 → 1000억)가 되살아난다. 대조만 하고, 어긋나면 사실대로 보고한다.
 *
 * 반환: 대조 결과. 팝업 경로를 쓰지 못했으면 `null`(호출부가 종전 경로로 떨어진다).
 */
async function fillAmountViaCalcPopup(
  page: Page,
  map: SelectorMap,
  totalVatIncluded: number,
): Promise<{ supply: string; tax: string; total: number } | null> {
  const popup = map.calcPopup;
  if (!popup) return null;

  assertClickAllowed(popup.openLabel, [popup.openLabel]);
  await page.click(popup.open, { timeout: 10_000 });
  // 팝업은 즉시 그려지지 않는다 — 입력칸이 붙을 때까지 기다린다(isVisible 은 대기하지
  // 않는다는 2026-08-08 교훈).
  const totalInput = page.locator(popup.totalInput);
  await totalInput.waitFor({ state: "visible", timeout: 8_000 });

  /**
   * ⛔ **매 단계 실측을 남긴다**(2026-08-09). 결과가 0 으로 나오는데 원인을 두 번
   * 헛짚었다(계산 버튼만 → 엔터 추가). 화면이 무엇을 받았는지 안 보이면 추측만
   * 쌓인다 — 넣은 직후·엔터 후·계산 후를 각각 읽어 어느 단계에서 값이 사라지는지
   * 로그가 직접 말하게 한다.
   */
  const trace = async (stage: string) => {
    const t = (await totalInput.inputValue().catch(() => "?")).trim();
    const s = (await page.locator(popup.supplyResult).inputValue().catch(() => "?")).trim();
    const x = (await page.locator(popup.taxResult).inputValue().catch(() => "?")).trim();
    console.log(`[hometax-helper] 자동계산 ${stage}: 합계칸="${t}" 공급="${s}" 세액="${x}"`);
  };

  /**
   * 🪤 **`fill()` 로는 이 칸에 값이 들어가지 않는다**(2026-08-09 오너 실측: "합계에
   * 금액을 안 적고 계산버튼을 누르던데?"). WebSquare 금액 칸은 마스킹·포맷터가 붙어
   * 있어 프로그램적 value 설정을 되돌린다 — 화면은 빈칸인데 코드는 넣었다고 믿는다.
   *
   * 그래서 **실제 키 입력**으로 친다(`pressSequentially`). 두 번 헛짚은 뒤에야
   * 여기까지 왔다: 계산 버튼만 → 엔터 추가 → **입력 자체가 실패**. 원인이 뒤가 아니라
   * 앞에 있었다.
   *
   * ⛔ 넣은 뒤 **반드시 다시 읽어 확인**하고, 안 들어갔으면 거기서 멈춘다 — 빈 합계로
   * 계산하면 0원이 되고, 그 상태가 발급까지 가면 되돌릴 수 없다.
   */
  await totalInput.click({ timeout: 8_000 });
  await totalInput.fill("").catch(() => {});
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await totalInput.pressSequentially(String(totalVatIncluded), { delay: 30 });
  await trace("입력 직후");

  const typed = normalizeForCompare((await totalInput.inputValue().catch(() => "")).trim());
  if (typed !== normalizeForCompare(String(totalVatIncluded))) {
    throw new Error(
      `합계 입력이 화면에 들어가지 않았습니다(넣은 값 ${totalVatIncluded} / 화면 "${typed}") — ` +
        `이 상태로 계산하면 0원이 됩니다.`,
    );
  }

  /**
   * 🪤 **엔터를 쳐야 계산이 돈다**(2026-08-09 실측). 팝업 안내문이 「합계를 입력하시고
   * **엔터키를 누르시면** 공급가액…」이라고 명시하는데, 처음엔 그걸 읽고도 「계산」
   * 버튼만 누르면 되는 줄 알았다 — 결과가 **공급가액 0 · 세액 0** 으로 나왔다.
   * `fill()` 은 값만 넣고 WebSquare 의 계산 트리거(keyup/Enter)를 깨우지 못한다.
   *
   * ⛔ 이 `press("Enter")` 를 지우지 말 것 — 지우면 0원 계산서가 발급 직전까지 간다
   *    (이번엔 「공급가액+세액 == 합계」 검증이 잡아서 멈췄다).
   */
  await totalInput.press("Enter");
  await page.waitForTimeout(700);
  await trace("엔터 후");

  // 엔터로 이미 계산됐을 수 있지만, 버튼도 눌러 둔다 — 둘 다 같은 계산이라 중복이
  // 문제되지 않고, 어느 한쪽 트리거가 바뀌어도 살아남는다(이중 방어).
  assertClickAllowed(popup.calcButton.label, [popup.calcButton.label]);
  await page.click(popup.calcButton.selector, { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(700);
  await trace("계산 버튼 후");

  const supply = (await page.locator(popup.supplyResult).inputValue().catch(() => "")).trim();
  const tax = (await page.locator(popup.taxResult).inputValue().catch(() => "")).trim();

  assertClickAllowed(popup.confirm.label, [popup.confirm.label]);
  await page.click(popup.confirm.selector, { timeout: 8_000 });
  await page.waitForTimeout(600);

  console.log(
    `[hometax-helper] 자동계산 팝업: 합계 ${totalVatIncluded} → 공급가액 ${supply} · 세액 ${tax}`,
  );
  return { supply, tax, total: totalVatIncluded };
}

export async function fillInvoiceForm(
  page: Page,
  map: SelectorMap,
  payload: InvoicePayload,
): Promise<FillOutcome> {
  const values = resolveFieldValues(payload);
  const filled: HometaxFieldKey[] = [];
  const skipped: HometaxFieldKey[] = [];
  const autoFilled: HometaxFieldKey[] = [];

  const mismatched: FillOutcome["mismatched"] = [];

  /**
   * 한 칸을 채운다. 세 가지를 지킨다:
   * ① 잠긴 칸은 건드리지 않는다(홈택스가 채울 자리)
   * ② **먼저 비우고** 넣는다 — WebSquare 입력은 기존 값에 덧붙는 사고가 있었다
   * ③ 넣은 뒤 **다시 읽어 대조**한다 — 조용히 틀린 금액이 남는 것이 최악이다
   */
  async function fillOne(key: HometaxFieldKey, selector: string): Promise<void> {
    const locator = page.locator(selector);
    if (!(await locator.isEditable({ timeout: 5_000 }).catch(() => false))) {
      autoFilled.push(key);
      return;
    }
    const expected = values[key];
    // 넣을 값이 없으면 **비우지 않는다.** 빈 문자열로 fill 하면 홈택스가 넣어 둔
    // 기본값(작성일자=오늘 등)을 지워 버린다 — 안 넣느니만 못하다.
    if (expected === "") {
      skipped.push(key);
      return;
    }
    // 국세청이 조회해 채운 칸은 덮어쓰지 않는다(위 `PRESERVE_IF_FILLED`).
    if (PRESERVE_IF_FILLED.has(key)) {
      const existing = (await locator.inputValue().catch(() => "")).trim();
      if (existing) {
        autoFilled.push(key);
        return;
      }
    }
    await locator.fill("", { timeout: 15_000 });
    await locator.fill(expected, { timeout: 15_000 });
    // 홈택스가 콤마를 붙이거나 자릿수를 다듬을 수 있으므로 정규화해서 비교한다.
    const actual = await locator.inputValue().catch(() => "");
    if (normalizeForCompare(actual) !== normalizeForCompare(expected)) {
      mismatched.push({ field: key, expected, actual });
      return;
    }
    filled.push(key);
  }

  // ① 「거래처 조회」가 1순위다(오너가 평소 쓰는 경로). 성공하면 등록번호·상호·
  //    대표자·주소·업태·종목이 한 번에 들어오므로 아래 사업자번호 경로를 타지 않는다.
  const counterparty: FillOutcome["counterparty"] = { method: "none" };
  let confirmedBusinessNumber = false;

  if (map.counterpartyLookup) {
    const result = await tryCounterpartyLookup(page, map, payload.buyerBusinessNumber);
    if (result.ok) {
      counterparty.method = "lookup";
      // 홈택스가 채운 칸이다 — 우리가 넣은 것이 아니므로 `filled` 가 아니라 여기다.
      autoFilled.push("buyerBusinessNumber");
    } else {
      counterparty.note = result.note;
    }
  }

  // ② 폴백: 사업자등록번호 입력 → 「확인」 → 국세청 조회.
  //    ⚠️ 거래처 조회가 성공했으면 타지 않는다 — 다시 넣고 확인을 누르면 이미 들어온
  //    조회 결과를 흔들 수 있다(국세청 재조회 · 종사업장 선택 창 재등장).
  if (counterparty.method !== "lookup") {
    const bsnoSelector = map.fields.buyerBusinessNumber;
    if (bsnoSelector) await fillOne("buyerBusinessNumber", bsnoSelector);
    else skipped.push("buyerBusinessNumber");

    // ⚠️ 이 클릭도 금지선을 통과한다. 라벨에 「발급」·「서명」이 없어야 하므로 맵에는
    //    "등록번호 확인" 같은 이름으로 적는다(`selectors.ts` 의 라벨 규약).
    if (map.confirmBusinessNumber && filled.includes("buyerBusinessNumber")) {
      const { label, selector } = map.confirmBusinessNumber;
      assertClickAllowed(label, [label]);
      await page.click(selector, { timeout: 15_000 }).catch(() => {});
      // 조회 왕복을 기다린다 — 이게 끝나야 잠겨 있던 칸이 채워지고 다음 입력이 유효하다.
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(800);
      confirmedBusinessNumber = true;
    }
    if (filled.includes("buyerBusinessNumber")) counterparty.method = "businessNumber";
  }

  // 확인 직후에 뜨는 선택 창(종사업장 등)을 감지한다 — 자동으로 고르지 않는다.
  let pendingUserChoice = await detectPendingChoice(page);
  let calculatedAmount = false;

  /**
   * 금액을 **자동계산 팝업**으로 넣을 수 있으면 공급가액은 직접 채우지 않는다
   * (오너 지시 2026-08-09 — 1원 오차의 근본 수정). 팝업이 선언돼 있지 않으면 종전대로
   * 공급가액을 직접 채운다.
   */
  const useCalcPopup = Boolean(map.calcPopup);

  // ③ 나머지 필드. 확인 이후에도 잠겨 있으면 홈택스가 채운 칸이므로 그대로 둔다.
  for (const key of Object.keys(values) as HometaxFieldKey[]) {
    if (key === "buyerBusinessNumber") continue;
    // 홈택스가 스스로 계산하는 칸(세액)은 값이 있어도 넣지 않는다 — 넣으면 중복된다.
    if (SKIP_FIELDS.has(key)) {
      autoFilled.push(key);
      continue;
    }
    // 팝업 경로를 쓰면 공급가액도 홈택스가 채운다 — 우리가 넣으면 두 주체가 각자
    // 반올림해 합이 어긋난다(그게 1원 오차의 원인이었다).
    if (useCalcPopup && key === "itemSupplyAmount") {
      autoFilled.push(key);
      continue;
    }
    const selector = map.fields[key];
    if (!selector) {
      skipped.push(key);
      continue;
    }
    await fillOne(key, selector);
  }

  /**
   * ③-b 자동계산 팝업 — 합계를 넣고 홈택스가 공급가액·세액을 계산하게 한다.
   *
   * 대조는 **합계**로 한다: 홈택스가 낸 공급가액 + 세액이 우리가 넣은 합계와 같아야
   * 한다. 어긋나면 `mismatched` 에 담아 발급을 막는다(그 상태로 나가면 정산 금액과
   * 다른 계산서가 발행된다 — 이번에 실제로 일어난 일이다).
   */
  if (useCalcPopup) {
    const total = payload.totalSupplyAmount + payload.totalTaxAmount;
    try {
      const result = await fillAmountViaCalcPopup(page, map, total);
      if (result) {
        calculatedAmount = true;
        const supply = Number(normalizeForCompare(result.supply));
        const tax = Number(normalizeForCompare(result.tax));
        if (!Number.isFinite(supply) || !Number.isFinite(tax) || supply + tax !== total) {
          mismatched.push({
            field: "itemSupplyAmount",
            expected: `합계 ${total}`,
            actual: `공급가액 ${result.supply} + 세액 ${result.tax}`,
          });
        }
      }
    } catch (err) {
      // ⛔ 삼키지 않는다(P0) — 금액이 안 들어간 채 발급으로 넘어가면 최악이다.
      mismatched.push({
        field: "itemSupplyAmount",
        expected: `합계 ${total}`,
        actual: `자동계산 팝업 실패: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      });
    }
  }

  // ④ 「계산」 — **종전 경로**(공급가액 직접 입력)에서만 쓴다. 공급가액만 넣으면 세액·
  //    합계가 비어 있어(실측) 이 클릭이 채웠다. 팝업 경로를 쓰면 이미 계산이 끝났다.
  //    ⚠️ 금액을 넣은 뒤에 눌러야 의미가 있으므로 마지막 단계다.
  if (!useCalcPopup && map.calculateAmount && filled.includes("itemSupplyAmount")) {
    const { label, selector } = map.calculateAmount;
    assertClickAllowed(label, [label]);
    await page.click(selector, { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(600);
    calculatedAmount = true;

    // 우리가 띄운 자동계산 확인 창은 우리가 닫는다(위 함수의 ⛔ 주석). 이걸 안 하면
    // 아래 선택 창 감지가 **우리가 만든 모달**을 「사람이 골라야 하는 창」으로 보고해,
    // 오너에게 "직접 선택해 주세요"라고 떠넘기게 된다 — 실제로 그렇게 나갔다.
    await confirmCalculationDialog(page);

    // ⛔ 계산 **이후에** 다시 본다(2026-08-06 실사고). 「계산」은 확인 팝업을 띄우는데,
    // 선택 창 감지가 계산보다 **먼저**라 그 팝업을 못 봤다 — 응답은 `FILLED`인데 오너
    // 화면은 팝업에 막혀 있었다. 「채웠다」는 사람이 이어받을 수 있는 상태일 때만
    // 할 수 있는 말이다.
    //
    // 그리고 값도 다시 대조한다: 계산을 누르자 홈택스가 **품목 일자를 지우는** 것을
    // 실측했다(작성일자보다 뒤인 일자였다). 넣은 직후에만 확인하면 그 삭제를 놓친다.
    pendingUserChoice = (await detectPendingChoice(page)) ?? pendingUserChoice;
    for (const key of filled) {
      const selectorForKey = map.fields[key];
      if (!selectorForKey) continue;
      const actual = await page.locator(selectorForKey).inputValue().catch(() => "");
      if (normalizeForCompare(actual) !== normalizeForCompare(values[key])) {
        mismatched.push({ field: key, expected: values[key], actual });
      }
    }
  }

  /**
   * 팝업 경로에서도 **끝난 뒤 다시 본다.** 계산이 품목 일자를 지우는 사고(2026-08-06)가
   * 있었고, 팝업을 닫은 뒤 남는 모달도 있을 수 있다 — 「채웠다」는 사람이 이어받을 수
   * 있는 상태일 때만 할 수 있는 말이다.
   */
  if (useCalcPopup) {
    pendingUserChoice = (await detectPendingChoice(page)) ?? pendingUserChoice;
    for (const key of filled) {
      const selectorForKey = map.fields[key];
      if (!selectorForKey) continue;
      const actual = await page.locator(selectorForKey).inputValue().catch(() => "");
      if (normalizeForCompare(actual) !== normalizeForCompare(values[key])) {
        mismatched.push({ field: key, expected: values[key], actual });
      }
    }
  }

  return {
    filled,
    skipped,
    autoFilled,
    confirmedBusinessNumber,
    counterparty,
    mismatched,
    pendingUserChoice,
    calculatedAmount,
  };
}
