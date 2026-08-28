/**
 * 홈택스 **발급 목록조회** — 「우리가 실제로 발행했는가」를 홈택스에서 직접 읽는다.
 *
 * ## 왜 필요한가
 *
 * 발행 여부의 대조를 국세청 **메일**로만 하면 구멍이 난다 — 세무자료 트랙이 실물
 * 매입 계산서가 존재하는 건의 메일을 편지함 15개 폴더 전수로 찾았는데 **0건**이었다
 * (같은 구간 다른 폴더에서 그 거래처 메일은 다수 잡혔으므로 탐색 자체는 정상 =
 * 양성 대조군). 메일은 발행 사실의 정본이 아니고, 홈택스가 정본이다.
 *
 * ## ⛔ 이 모듈은 읽기 전용이다
 *
 * 화면을 열고 기간을 넣고 「조회」를 눌러 표를 읽는 것까지가 전부다. 발급·수정발급·
 * 재발송 계열은 `guards.ts` 가 라벨로 막는다 — 이 화면 주변에는 「재발송」(전송)과
 * 「수정발급」이 실제로 있어서, 목록조회를 붙인다는 것은 **그 버튼들 옆에서 클릭을
 * 한다**는 뜻이다. 그래서 여기서도 모든 클릭은 `assertClickAllowed` 를 지난다.
 *
 * ## 🪤 메뉴 라벨이 「발급 목록조회」다 — 그대로 쓰면 가드가 막는다
 *
 * 홈택스 메뉴의 실제 텍스트가 「발급 목록조회」인데 「발급」이 금지어다. 이건 결함이
 * 아니라 **설계대로 동작하는 것**이다. 처방은 금지 목록 완화가 **절대** 아니고
 * 셀렉터 맵에서 **라벨만 바꾸는 것**이다(예: `"목록 화면"`). 라벨은 우리가 짓는
 * 이름이고 실제 클릭 대상은 셀렉터가 정한다 — `ForbiddenClickError` 메시지가 그걸
 * 안내한다. 계약 테스트가 이 함정을 고정한다.
 *
 * 메뉴 셀렉터는 오너가 이미 뽑아 둔 덤프에서 확인됐다(2026-08-06):
 *   `#menuAtag_4609050100` = 발급 목록조회 · `#menuAtag_4609050200` = 건별 상세조회
 *   `#menuAtag_4609050300` = 월/분기별 목록조회
 * ⚠️ 결과 표의 셀렉터는 **로그인 후 화면에서만** 잡히므로 맵이 비어 있으면 이 경로는
 * 시작하지 않고 무엇이 비었는지 보고한다(추측 셀렉터를 쓰지 않는다).
 */
import type { Page } from "playwright";
import { assertClickAllowed } from "./guards";
import { extractBusinessNumbers } from "./fill";
import type { SelectorMap } from "./selectors";

/** 목록 한 줄 — **원문 셀을 그대로 보존**한다. 파싱이 틀려도 사람이 볼 수 있어야 한다. */
export type QueriedInvoice = {
  /** 표의 셀 텍스트 원문(열 순서 그대로). */
  cells: string[];
  /** 승인번호로 보이는 값(`YYYYMMDD-********-********`). 못 찾으면 null. */
  approvalNumber: string | null;
  /** 작성일자로 보이는 첫 날짜(`YYYY-MM-DD`). 못 찾으면 null. */
  issueDate: string | null;
  /** 이 줄에 등장한 사업자등록번호 전부(공급자·공급받는자가 함께 있을 수 있다). */
  businessNumbers: string[];
  /** 이 줄에 등장한 금액 전부(콤마 제거). 어느 것이 공급가액인지 단정하지 않는다. */
  amounts: number[];
};

/** 홈택스 승인번호 형식. 앞 8자리는 날짜, 뒤 두 덩어리는 영숫자다. */
const APPROVAL_RE = /(?<!\d)\d{8}-[0-9A-Za-z]{8}-[0-9A-Za-z]{8}(?!\w)/;
const DATE_RE = /(?<!\d)(\d{4})[-.](\d{2})[-.](\d{2})(?!\d)/;
/**
 * 3자리 콤마가 있는 금액. ⚠️ 경계를 걸어 승인번호·사업자번호 조각을 금액으로 읽지 않는다
 * (둘 다 콤마가 없으므로 콤마 요구가 곧 필터다).
 *
 * ⛔ **음수를 반드시 부호째 잡는다**(2026-08-07 실사고). 종전 `(?<![\d-])` 는 앞의 `-` 를
 * 보고 매치를 거부했는데, 정규식은 거기서 멈추지 않고 **한 칸 밀려 다시 시도**한다 —
 * `-1,234,567` 이 `234,567` 로 읽혔다. 부호가 빠지는 정도가 아니라 **자릿수가 잘린 다른
 * 숫자**가 버젓이 나온다. 홈택스 목록에는 수정세금계산서(취소) 행이 실제로 있고 그 금액이
 * 음수라, 이 상태로 대사하면 발행액이 조용히 어긋난다.
 */
const AMOUNT_RE = /(?<![\d,])-?\d{1,3}(?:,\d{3})+(?![\d,])/g;

/**
 * 표 한 줄을 구조화한다 — **단정하지 않는 파싱**이다.
 *
 * 열 순서를 실측하지 못했으므로 「3번째 열이 공급가액」 같은 규칙을 두지 않는다.
 * 그런 규칙은 화면이 한 열만 바뀌어도 조용히 틀린 값을 내는데, 이 도구에서 조용히
 * 틀린 금액은 가장 비싼 실패다(2026-08-06 1000억 사고). 대신 형태로 알아볼 수 있는
 * 것만 뽑고 나머지는 원문으로 남긴다.
 */
export function parseQueryRow(cells: string[]): QueriedInvoice {
  const joined = cells.join(" ");
  const approval = joined.match(APPROVAL_RE);
  const date = joined.match(DATE_RE);
  return {
    cells,
    approvalNumber: approval ? approval[0] : null,
    issueDate: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
    // 🪤 중복을 제거한다(2026-08-06 실측). 홈택스 그리드의 각 행은 **첫 칸에 행 전체를
    // 이어 붙인 요약 셀**을 갖고 있어서, 그대로 뽑으면 같은 번호가 2~3번씩 잡힌다.
    // 번호는 "이 행에 이 거래처가 있는가"를 묻는 집합이라 중복이 의미를 갖지 않는다.
    businessNumbers: [...new Set(extractBusinessNumbers(joined))],
    // ⚠️ 금액은 **중복을 지우지 않는다.** 같은 금액의 품목이 실제로 두 줄일 수 있어서,
    // 여기서 지우면 존재하던 값이 사라진다. 요약 셀 때문에 반복이 보일 수 있다는 점은
    // 소비자가 감안할 몫이고, 그 판단 근거는 `cells` 원문에 남아 있다.
    amounts: [...joined.matchAll(AMOUNT_RE)].map((m) => Number(m[0].replace(/,/g, ""))),
  };
}

export function parseQueryRows(rows: string[][]): QueriedInvoice[] {
  return rows.map(parseQueryRow);
}

/**
 * 특정 거래처의 발행분만 고른다. **사업자등록번호로만** 판정한다 — 상호는 표기가
 * 흔들린다(같은 거래처가 상호를 바꾼 실사례가 있다).
 *
 * ⚠️ 목록 줄에는 공급자(우리) 번호도 함께 실릴 수 있어 「포함」으로 본다. 그래서 이
 * 함수의 결과는 **후보**이지 확정이 아니다 — 우리 번호로 조회하면 전부 걸린다.
 */
export function filterByBusinessNumber(
  invoices: QueriedInvoice[],
  businessNumber: string,
): QueriedInvoice[] {
  const wanted = businessNumber.replace(/\D/g, "");
  if (wanted.length !== 10) return [];
  return invoices.filter((inv) => inv.businessNumbers.includes(wanted));
}

/** 조회한 구간 하나의 결과 — 「무엇을 봤는가」를 구간 단위로 남긴다. */
export type QueryWindowReport = {
  from: string;
  to: string;
  /** 화면의 「총 N건」. 못 읽으면 null(절단 판정 불가 상태를 숨기지 않는다). */
  totalCount: number | null;
  /** 실제로 표에서 읽어 온 행 수. */
  collected: number;
};

export type QueryOutcome =
  | {
      status: "OK";
      invoices: QueriedInvoice[];
      screenUrl: string;
      /**
       * ⛔ **false 면 이 결과로 「발행하지 않았다」를 말할 수 없다.** 총건수를 못 읽었거나
       * 더 쪼갤 수 없는 구간에서도 수집분이 총건수에 못 미친 경우다.
       */
      complete: boolean;
      /** 불완전하면 그 이유 — 조용한 절단을 만들지 않기 위한 필수 출력. */
      incompleteReasons: string[];
      windows: QueryWindowReport[];
      /** 겹치지 않는 구간에서 중복된 승인번호 — 비어 있지 않으면 수집 경로에 결함이 있다. */
      duplicateKeys: string[];
      /** 이 결과가 발행분인지 수취분인지 — 호출부가 방향을 되확인할 수 있게 되싣는다. */
      kind: InvoiceQueryKind;
    }
  | { status: "NOT_CONFIGURED"; missing: string[] }
  | { status: "FAILED_AT"; step: "navigate" | "search" | "parse"; message: string };

/**
 * 홈택스 화면이 강제하는 조회기간 상한.
 *
 * 화면 안내 원문: 「조회기간은 3개월 범위 내로 제한됩니다」(2026-08-07 실측). ⛔ 넘기면
 * **에러 배너 없이 0건**이 나온다 — 2024-12~2026-08 한 방 조회가 조용히 0건을 냈고,
 * 스크린샷을 보기 전까지 「발행 이력 없음」으로 오독될 뻔했다.
 *
 * ⛔ **일수로 환산하지 말 것**(2026-08-07 2차 실사고). 처음엔 89일로 잡았는데, 2월을
 * 걸치는 구간에서는 89일이 곧 3개월이 되어 상한을 넘는다 — `2026-02-24~2026-05-24`(89일)는
 * **0건**, 하루 줄인 `~2026-05-23`은 **10건**이었다(실측). 즉 판정은 달력 기준이고
 * 배타적이다: `to < from + 3개월`. 일수 상한은 "대부분 맞고 2월에만 조용히 틀리는" 규칙이라
 * 가장 나쁜 종류다.
 */
const MAX_WINDOW_MONTHS = 3;

/** 이 시작일로 조회할 수 있는 **마지막 날**(= from + 3개월 − 1일, 말일 보정 포함). */
export function maxWindowEnd(from: string): string {
  const d = toDate(from);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  // 말일 보정 — 1/31 + 3개월은 4/31 이 없으므로 4/30 으로 접는다.
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + MAX_WINDOW_MONTHS + 1, 0)).getUTCDate();
  const target = new Date(
    Date.UTC(year, month + MAX_WINDOW_MONTHS, Math.min(day, lastDayOfTargetMonth)),
  );
  return toYmd(new Date(target.getTime() - 24 * 60 * 60 * 1000));
}

/**
 * 결과 표의 페이지 크기(기본 10). 이 값 자체를 올리려면 드롭다운을 **클릭**해야 하는데,
 * 그 셀렉터는 오너 맵에 없다. 그래서 페이지를 넘기는 대신 **구간을 반으로 쪼갠다** —
 * 새로운 클릭 대상을 도입하지 않고(금지선 표면적을 넓히지 않고) 같은 목적을 이룬다.
 */
const PAGE_SIZE = 10;

/**
 * 절단된 구간을 반으로 쪼갠다. **더 못 쪼개면(하루짜리) `null`.**
 *
 * ⛔ 종료 조건을 `span <= 1` 로 두면 **한 단계 일찍 멈춘다**(2026-08-07 교차 검증 지적).
 * `span === 1` 은 이틀짜리 구간(예: 08-01~08-02)이라 아직 하루 단위가 아니고, 한 번만
 * 더 쪼개면 `{08-01,08-01}` + `{08-02,08-02}` 로 정확히 하루짜리 둘이 나온다. 각 날짜가
 * 페이지 크기 이내면 무손실로 다 담을 수 있는데도 포기하고, 게다가 "하루 단위까지
 * 쪼갰다"는 **사실과 다른 사유**를 남긴다.
 *
 * `from === to` 에서 멈추는 것이 무한 재귀도 막는다 — 그 지점의 `mid` 는 `from` 과 같아
 * 왼쪽 자식이 자기 자신이 된다.
 */
export function bisectRange(
  from: string,
  to: string,
): { left: { from: string; to: string }; right: { from: string; to: string } } | null {
  const span = daysBetween(from, to);
  if (span <= 0) return null;
  const mid = addDays(from, Math.floor(span / 2));
  return { left: { from, to: mid }, right: { from: addDays(mid, 1), to } };
}

function toDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}

function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  return toYmd(new Date(toDate(ymd).getTime() + days * 24 * 60 * 60 * 1000));
}

function daysBetween(from: string, to: string): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / (24 * 60 * 60 * 1000));
}

/** 요청 구간을 화면 상한 이하의 연속 구간으로 자른다(겹치지 않는다 — 겹치면 중복 집계된다). */
export function splitDateRange(from: string, to: string): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  // 방어: 역전된 구간은 빈 배열(조용히 뒤집어 엉뚱한 기간을 조회하지 않는다).
  if (daysBetween(from, to) < 0) return chunks;
  let cursor = from;
  while (true) {
    const limit = maxWindowEnd(cursor);
    if (daysBetween(limit, to) <= 0) {
      chunks.push({ from: cursor, to });
      return chunks;
    }
    chunks.push({ from: cursor, to: limit });
    cursor = addDays(limit, 1);
  }
}

/** 「총 10건」·「총 1,234건」에서 숫자만. 못 찾으면 null — 0 으로 단정하지 않는다. */
export function parseTotalCount(pageText: string): number | null {
  const match = pageText.match(/총\s*([\d,]+)\s*건/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/**
 * 승인번호가 겹치는 행을 **찾아내되 지우지 않는다.**
 *
 * ⛔ 처음엔 조용히 지웠는데(`dedupeInvoices`), 실측에서 겹치지 않는 구간들의 합 49건이
 * 44건으로 줄었다. 구간이 서로 겹치지 않는 이상 중복은 **나올 수 없는 값**이다 — 즉 그
 * 5건은 "중복이니 지워도 되는 것"이 아니라 **무언가 잘못됐다는 신호**(조회 후 표가 아직
 * 갱신되지 않아 직전 구간 결과를 읽었다든지, 승인번호 추출이 엉뚱한 셀을 집었다든지)다.
 * 지워 버리면 그 신호가 사라지고 「44건 전부 확인했다」는 거짓 확신만 남는다.
 *
 * 그래서 행은 전부 보존하고 중복 키만 돌려준다 — 호출부가 `incompleteReasons` 로 올린다.
 */
export function findDuplicateKeys(invoices: QueriedInvoice[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const inv of invoices) {
    const key = inv.approvalNumber ?? `RAW:${inv.cells.join("|")}`;
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  return [...dupes];
}

/**
 * 목록조회 화면으로 이동해 기간으로 조회하고 결과를 읽는다.
 *
 * 실패해도 창을 닫지 않는다 — 오너가 그 화면에서 직접 이어 볼 수 있다(설계 「실패 모드」).
 */
/**
 * 조회 방향. **SALES = 우리가 발행한 것 · PURCHASE = 우리가 수취한 것.**
 * 이 값을 틀리면 「발행했는가」를 묻고 「수취했는가」의 답을 받는다 — 화면은 똑같이
 * 그럴듯해 보이므로 반드시 결과에 되실어 보낸다(아래 `kind`).
 */
export type InvoiceQueryKind = "SALES" | "PURCHASE";

export async function queryIssuedInvoices(
  page: Page,
  map: SelectorMap,
  range: { from: string; to: string },
  kind: InvoiceQueryKind = "SALES",
): Promise<QueryOutcome> {
  const cfg = map.invoiceQuery;
  const missing = [
    !cfg && "invoiceQuery",
    cfg && !cfg.dateFrom && "dateFrom",
    cfg && !cfg.dateTo && "dateTo",
    cfg && !cfg.resultRow && "resultRow",
    cfg && !cfg.search?.selector && "search",
    cfg && Object.keys(cfg.navigation ?? {}).length === 0 && !cfg.screenUrl && "navigation 또는 screenUrl",
  ].filter(Boolean) as string[];
  if (missing.length > 0) return { status: "NOT_CONFIGURED", missing };
  const q = cfg!;

  // ① 화면 이동 — **한 번만** 한다. 아래 구간 순회는 같은 화면에서 기간만 바꿔 다시 조회한다
  //    (구간마다 메뉴를 다시 누르면 클릭 횟수가 구간 수만큼 늘고, 그만큼 금지선 근처에서
  //    더 많이 움직인다).
  const navigated = await navigateToQueryScreen(page, q);
  if (navigated) return navigated;

  // ①-2 구분(매출/매입) 선택. 맵에 없으면 화면 기본값(매출)이며, PURCHASE 를 요청했는데
  //     셀렉터가 없으면 **조용히 매출을 돌려주지 않고** 설정 부족으로 실패시킨다 —
  //     방향이 뒤집힌 답은 없는 답보다 나쁘다.
  if (!q.kind) {
    if (kind === "PURCHASE") return { status: "NOT_CONFIGURED", missing: ["invoiceQuery.kind"] };
  } else {
    try {
      const label = kind === "SALES" ? "매출 구분" : "매입 구분";
      assertClickAllowed(label, [label]);
      const selector = kind === "SALES" ? q.kind.sales : q.kind.purchase;
      const radio = page.locator(selector).first();

      // 3단 폴백 — 창을 좁히면(오너 지시로 화면 가로의 40%) 이 라디오가 가로 스크롤
      // 밖으로 밀려 `check()` 가 "element is outside of the viewport" 로 죽는다(실측).
      // 메뉴 클릭이 쓰는 것과 같은 관용구다.
      await radio.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      try {
        await radio.check({ timeout: 5_000 });
      } catch {
        try {
          await radio.check({ timeout: 5_000, force: true });
        } catch {
          await radio.dispatchEvent("click", { timeout: 5_000 });
        }
      }
      await page.waitForTimeout(500);

      // ⛔ 눌렀다고 믿지 않고 **실제로 선택됐는지 확인한다.** 여기서 조용히 실패하면
      //    화면은 매출인데 결과를 매입이라 부르는, 방향이 뒤집힌 오답이 나온다.
      if (!(await radio.isChecked())) {
        throw new Error("라디오가 선택되지 않았습니다(클릭은 됐으나 상태가 바뀌지 않음).");
      }
    } catch (err) {
      return {
        status: "FAILED_AT",
        step: "navigate",
        message: `구분(${kind}) 선택 실패: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ② 구간을 화면 상한(3개월) 이하로 자르고, 각 구간에서 절단이 감지되면 반으로 더 쪼갠다.
  const invoices: QueriedInvoice[] = [];
  const windows: QueryWindowReport[] = [];
  const incompleteReasons: string[] = [];

  for (const chunk of splitDateRange(range.from, range.to)) {
    const result = await collectWindow(page, q, chunk, invoices, windows, incompleteReasons);
    if (result) return result; // FAILED_AT — 실패는 삼키지 않고 즉시 올린다
  }

  // 겹치지 않는 구간에서 승인번호가 겹치면 그 자체가 이상 신호다 — 지우지 않고 올린다.
  const duplicates = findDuplicateKeys(invoices);
  if (duplicates.length > 0) {
    incompleteReasons.push(
      `승인번호가 겹치는 행 ${duplicates.length}건: 구간이 서로 겹치지 않으므로 나올 수 없는 값입니다 — ` +
        `조회 후 표 갱신 지연 또는 승인번호 추출 오류가 의심됩니다(${duplicates.slice(0, 3).join(", ")}).`,
    );
  }

  return {
    status: "OK",
    invoices,
    screenUrl: page.url(),
    complete: incompleteReasons.length === 0,
    incompleteReasons,
    windows,
    duplicateKeys: duplicates,
    kind,
  };
}

/** 목록조회 화면으로 이동한다. 성공하면 `null`, 실패하면 그대로 반환할 실패 결과. */
async function navigateToQueryScreen(
  page: Page,
  q: NonNullable<SelectorMap["invoiceQuery"]>,
): Promise<QueryOutcome | null> {
  //    ⚠️ 라벨은 전부 가드를 지난다 — 「발급 목록조회」를 그대로 쓰면 여기서 막힌다.
  try {
    if (q.screenUrl && page.url() !== q.screenUrl) {
      await page.goto(q.screenUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    } else {
      const allowed = Object.keys(q.navigation ?? {});
      for (const [label, selector] of Object.entries(q.navigation ?? {})) {
        assertClickAllowed(label, allowed);
        // 🪤 `.first()` — 셀렉터를 합집합으로 둘 수 있고, 두 id 가 **같은 화면에 둘 다**
        // 있으면 Playwright 가 strict mode 위반으로 거부한다(2026-08-06 실사고).
        const link = page.locator(selector).first();
        // 3단 폴백 — 대메뉴가 접혀 있으면 링크가 완전히 숨겨진다(#295 실측).
        try {
          await link.click({ timeout: 8_000 });
        } catch {
          try {
            await link.click({ timeout: 8_000, force: true });
          } catch {
            await link.dispatchEvent("click", { timeout: 8_000 });
          }
        }
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1_000);
      }
    }
    return null;
  } catch (err) {
    return { status: "FAILED_AT", step: "navigate", message: err instanceof Error ? err.message : String(err) };
  }
}

/** 그리드 한 번 읽기 — 행·총건수·비교용 지문을 함께 낸다. */
async function readGrid(
  page: Page,
  q: NonNullable<SelectorMap["invoiceQuery"]>,
): Promise<{ rows: string[][]; totalCount: number | null; signature: string }> {
  const rows = await page.locator(q.resultRow).evaluateAll((nodes) =>
    nodes.map((n) =>
      Array.from(n.querySelectorAll("td,th")).map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()),
    ),
  );
  const nonEmpty = rows.filter((cells) => cells.some((c) => c.length > 0));
  // ⚠️ **함수가 아니라 문자열**로 넘긴다 — `tsx`(esbuild)의 `__name` 주입이 브라우저
  //    컨텍스트에 없어 함수형은 `ReferenceError` 로 죽는다(`browser.ts` 의 같은 주석).
  const pageText = (await page.evaluate(`document.body.innerText || ""`)) as string;
  return {
    rows: nonEmpty,
    totalCount: parseTotalCount(pageText),
    signature: JSON.stringify(nonEmpty),
  };
}

/** 그리드 갱신을 기다리는 상한(ms)과 폴링 간격. */
const GRID_REFRESH_TIMEOUT_MS = 15_000;
const GRID_POLL_INTERVAL_MS = 300;

/**
 * 기간을 넣고 조회한 뒤 표와 「총 N건」을 읽는다.
 *
 * ⛔ **조회 후 그리드가 실제로 바뀔 때까지 기다린다**(2026-08-07 실사고). 종전에는
 * `networkidle` + 1.2초 고정 대기만 했는데, 그것으로는 부족해 **한 구간이 직전 구간의
 * 결과를 그대로 되읽었다.** 그때 「총 N건」까지 직전 값이라 총건수 == 수집수 자기검증도
 * 통과했고, 그 구간의 진짜 7건 대신 남의 5건이 실려 나갔다 — 승인번호 중복으로만 겨우
 * 드러났다. 고정 대기는 "보통은 충분한 시간"이지 "끝났다는 증거"가 아니다.
 */
async function runOneWindow(
  page: Page,
  q: NonNullable<SelectorMap["invoiceQuery"]>,
  range: { from: string; to: string },
): Promise<
  | { ok: true; invoices: QueriedInvoice[]; totalCount: number | null; staleWarning: string | null }
  | { ok: false; outcome: QueryOutcome }
> {
  let before: { signature: string } | null = null;
  try {
    before = await readGrid(page, q);
  } catch {
    // 첫 조회 전이라 표가 아예 없을 수 있다 — 비교 기준이 없을 뿐이므로 계속 진행한다.
    before = null;
  }

  try {
    for (const [selector, value] of [
      [q.dateFrom, range.from],
      [q.dateTo, range.to],
    ] as const) {
      const input = page.locator(selector);
      await input.fill("", { timeout: 10_000 });
      await input.fill(value, { timeout: 10_000 });
    }
    assertClickAllowed(q.search.label, [q.search.label]);
    await page.click(q.search.selector, { timeout: 15_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  } catch (err) {
    return {
      ok: false,
      outcome: { status: "FAILED_AT", step: "search", message: err instanceof Error ? err.message : String(err) },
    };
  }

  try {
    const deadline = Date.now() + GRID_REFRESH_TIMEOUT_MS;
    let grid = await readGrid(page, q);

    /**
     * 갱신 완료 판정 — **두 조건을 모두** 요구한다.
     *
     * ① 표가 직전과 달라졌다(지문 변화). 이것만 보면, 총건수 텍스트는 새 구간으로
     *    바뀌었는데 그리드는 아직 직전 구간 행을 들고 있는 중간 상태를 통과시킨다 —
     *    실제로 `총3 수집10`(수집 > 총건수, 논리적으로 불가능)이 나왔다.
     * ② 표와 총건수가 서로 맞는다: `수집 == min(총건수, 페이지크기)`. 이것만 보면,
     *    **둘 다 직전 값인** 완전 정지 상태를 통과시킨다(`총5 수집5` 로 위장했던 그 사고).
     *
     * 둘을 함께 요구해야 두 실패 모드가 모두 막힌다.
     */
    const agrees = (g: typeof grid) =>
      g.totalCount !== null && g.rows.length === Math.min(g.totalCount, PAGE_SIZE);
    const changed = (g: typeof grid) => before === null || g.signature !== before.signature;
    // 「직전에도 0건, 이번에도 0건」은 지문이 같은 것이 정상 — 그 경우만 ①을 면제한다.
    const settledEmpty = (g: typeof grid) => g.rows.length === 0 && g.totalCount === 0;

    let refreshed = (changed(grid) || settledEmpty(grid)) && agrees(grid);
    while (!refreshed && Date.now() < deadline) {
      await page.waitForTimeout(GRID_POLL_INTERVAL_MS);
      grid = await readGrid(page, q);
      refreshed = (changed(grid) || settledEmpty(grid)) && agrees(grid);
    }

    return {
      ok: true,
      invoices: parseQueryRows(grid.rows),
      totalCount: grid.totalCount,
      // ⛔ 못 기다렸으면 그 사실을 반드시 올린다 — 이 창의 데이터는 직전 구간 것일 수 있다.
      staleWarning: refreshed
        ? null
        : `${range.from}~${range.to}: 조회 후 ${GRID_REFRESH_TIMEOUT_MS / 1000}초 안에 표와 총건수가 일치하지 않았습니다` +
          `(총 ${grid.totalCount ?? "?"}건 / 표 ${grid.rows.length}행) — 직전 구간의 결과가 섞였을 수 있습니다.`,
    };
  } catch (err) {
    return {
      ok: false,
      outcome: { status: "FAILED_AT", step: "parse", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * 한 구간을 조회하고, **수집분이 화면의 총건수에 못 미치면 반으로 쪼개 재귀**한다.
 *
 * ⛔ 왜 페이저를 안 누르고 구간을 쪼개나: 페이지 크기 드롭다운과 「다음」 버튼의 셀렉터가
 * 오너 맵에 없다. 없는 셀렉터를 추측해 넣는 것은 이 도구의 금지 사항이고(추측 셀렉터로
 * 엉뚱한 것을 누르는 위험), 새 클릭 대상을 도입하면 발급·서명 옆에서 클릭 표면이 넓어진다.
 * 기간 분할은 **이미 허용된 입력 두 칸과 조회 버튼만으로** 같은 목적을 이룬다.
 *
 * 총건수를 못 읽으면 쪼개도 판정이 안 되므로 재귀하지 않고 사유만 남긴다 — 이때
 * `complete: false` 가 되어 호출부가 「발행 안 함」을 주장하지 못한다.
 */
async function collectWindow(
  page: Page,
  q: NonNullable<SelectorMap["invoiceQuery"]>,
  range: { from: string; to: string },
  sink: QueriedInvoice[],
  windows: QueryWindowReport[],
  incompleteReasons: string[],
): Promise<QueryOutcome | null> {
  const result = await runOneWindow(page, q, range);
  if (!result.ok) return result.outcome;

  const { invoices, totalCount, staleWarning } = result;
  windows.push({ from: range.from, to: range.to, totalCount, collected: invoices.length });
  if (staleWarning) incompleteReasons.push(staleWarning);

  const truncated = totalCount !== null && totalCount > invoices.length;

  if (!truncated) {
    // 총건수를 못 읽었는데 페이지가 꽉 찼으면 절단일 수 있다 — 조용히 넘기지 않는다.
    if (totalCount === null && invoices.length >= PAGE_SIZE) {
      incompleteReasons.push(
        `${range.from}~${range.to}: 총건수를 읽지 못했고 수집분이 페이지 크기(${PAGE_SIZE})에 도달했습니다 — 절단 여부를 판정할 수 없습니다.`,
      );
    }
    sink.push(...invoices);
    return null;
  }

  const split = bisectRange(range.from, range.to);
  if (!split) {
    // 하루짜리 구간의 발행 건수가 페이지 크기를 넘는 경우 — 기간 분할로는 더 못 줄인다.
    sink.push(...invoices);
    incompleteReasons.push(
      `${range.from}~${range.to}: 총 ${totalCount}건 중 ${invoices.length}건만 읽었습니다 — 하루 단위까지 쪼갰으나 페이지 크기를 넘습니다(페이저 셀렉터 필요).`,
    );
    return null;
  }

  // 절단이면 이 구간의 수집분은 **버린다** — 재귀가 같은 구간을 전부 다시 읽으므로
  // 여기서 넣으면 중복이 된다(`findDuplicateKeys` 가 신호로 잡아 주지만, 애초에
  // 만들지 않는 편이 낫다 — 그 신호는 진짜 결함을 위해 비워 둔다).
  const left = await collectWindow(page, q, split.left, sink, windows, incompleteReasons);
  if (left) return left;
  return collectWindow(page, q, split.right, sink, windows, incompleteReasons);
}
