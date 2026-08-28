/**
 * 홈택스 건별발급 로컬 헬퍼 — 실행 진입점. `npm run hometax:helper`
 *
 * CRM(https://crm.ygrd.kr)의 「홈택스 발행」 버튼이 이 서버로 발행 데이터를 보내면,
 * 오너 Mac 의 Chrome 창에서 홈택스 건별발급 폼을 채우고 **발급 직전에 멈춘다.**
 * 발급·전자서명은 오너가 그 창에서 직접 한다 — `guards.ts` 가 그 경계를 강제한다.
 *
 * 설계 정본: `docs/private/specs/2026-08-05-hometax-local-helper-design.md`
 *
 * ## 엔드포인트
 *
 * - `GET  /health`  — 헬퍼 생존 + 셀렉터 맵 준비 상태
 * - `POST /issue`   — 세금계산서 1건을 폼에 채운다(1회 = 1장)
 * - `POST /inspect` — 지금 열려 있는 화면의 입력·버튼 후보를 덤프한다(셀렉터 실측용)
 *
 * ## 처음 쓸 때 (셀렉터 맵이 없는 상태)
 *
 * 홈택스는 WebSquare SPA 라 요소 id 가 자동 생성이다(`mf_wq_uuid_54`) — 그래서 이
 * 레포는 셀렉터를 소스에 박지 않고 **오너 환경에서 실측해 파일로** 둔다.
 *   1. `npm run hometax:helper` 로 헬퍼를 켠다(창이 뜬다)
 *   2. 그 창에서 홈택스에 로그인하고 **전자세금계산서 건별발급 화면**까지 이동한다
 *   3. `curl -X POST http://127.0.0.1:9410/inspect` — 현재 화면 덤프가
 *      `~/.wag-crm/hometax-inspect-<시각>.json` 에 저장된다
 *   4. 덤프를 보고 `~/.wag-crm/hometax-selectors.json` 을 만든다(형식은 `selectors.ts`)
 * 맵이 없으면 헬퍼는 아무 필드도 채우지 않고 그 사실을 그대로 보고한다 — 추측해서
 * 엉뚱한 칸에 넣지 않는다.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BIND_HOST, DEFAULT_PORT, corsHeaders, isAllowedOrigin } from "./http";
import {
  allowedClickLabels,
  loadSelectorMap,
  HELPER_HOME,
  SELECTOR_MAP_PATH,
  type HometaxFieldKey,
  type SelectorMap,
} from "./selectors";
import {
  closeSession,
  ensureHometaxOpen,
  getSession,
  hasLiveSession,
  looksLoggedOut,
  readLastUserInputAt,
  waitForLoginState,
} from "./browser";
import {
  createActivityLedger,
  IDLE_CHECK_INTERVAL_MS,
  resolveIdleMs,
  shouldShutdownForIdle,
} from "./idle";
import {
  fillInvoiceForm,
  navigateToIssueForm,
  preflightBeforeSubmit,
  submitIssueForm,
  type InvoicePayload,
} from "./fill";
import { ForbiddenClickError, matchesForbiddenPattern } from "./guards";
import { queryIssuedInvoices, type InvoiceQueryKind } from "./query";
import { hasLoginRequiredAlert, navigateToLoginPrompt } from "./login";

const PORT = Number(process.env.HOMETAX_HELPER_PORT ?? DEFAULT_PORT);

/**
 * 상시 기동(LaunchAgent) 모드인가.
 *
 * ⚠️ **기본 운용은 더 이상 상시 기동이 아니다** — CRM 의 「홈택스 발행」 클릭이
 * `hometax-helper://` URL 스킴으로 이 프로세스를 깨우고(`install-url-scheme.sh`),
 * 할 일이 끝나면 아래 유휴 감시가 스스로 내려간다. 이 플래그는 상시 기동으로
 * 되돌린 환경(옛 `install-daemon.sh` 잔존)에서 **기동 시 창을 열지 않기** 위해
 * 남겨 둔다 — 로그인할 때마다 홈택스 창이 튀어나오면 안 되기 때문이다.
 * 스킴으로 깨어난 경우는 반대다: 그 순간이 곧 발행 의사이므로 창을 곧바로 연다.
 */
const IS_DAEMON = process.env.HOMETAX_HELPER_DAEMON === "1";

/**
 * 유휴 자동 종료 한도. 판정 규칙과 근거는 `idle.ts` 에 있다.
 * `HOMETAX_HELPER_IDLE_MINUTES=0` 이면 비활성(상시 기동 탈출구).
 */
const IDLE_MS = resolveIdleMs(process.env.HOMETAX_HELPER_IDLE_MINUTES);

/** 요청 활동 장부 — 유휴 판정의 첫 번째 축(두 번째 축은 창의 사람 입력). */
const activity = createActivityLedger();

/**
 * 정상 종료 — 브라우저 컨텍스트를 닫고 나간다.
 *
 * ⛔ 강제 종료(`kill -9`)하면 Chrome 이 쿠키를 디스크에 쓰지 못해 **홈택스 로그인
 * 세션이 날아간다**(2026-08-06 실측 — 재시작 후 오너가 다시 로그인해야 했다).
 * 영속 프로필을 쓰는 의미가 사라지므로, 종료 신호를 받으면 반드시 닫고 나간다.
 */
// SIGHUP: Terminal 가시 실행(2026-08-09 오너 제안)에서 **창을 닫으면** 오는 신호다 —
// 안 잡으면 즉사해 쿠키가 날아간다(위 주석의 그 사고를 창 닫기가 재현하게 된다).
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    void closeSession().finally(() => process.exit(0));
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>) {
  res.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 화면 덤프 — 입력칸과 버튼의 **구조 정보만** 모은다. ⛔ `value`(화면에 이미 떠 있는
 * 사업자번호 등)는 담지 않는다: 덤프 파일이 오너 기기에만 있더라도, 습관적으로 붙여
 * 넣다 public 레포에 들어가면 그 자체가 P0 사고다.
 */
/**
 * ⚠️ 이 스크립트를 **함수가 아니라 문자열**로 넘기는 것은 의도다(2026-08-05 실측).
 * 이 헬퍼는 `tsx`(esbuild)로 실행되는데, esbuild 는 이름 보존을 위해 함수에 `__name`
 * 헬퍼 호출을 주입한다. 그 함수를 `page.evaluate` 로 넘기면 브라우저 컨텍스트에는
 * `__name` 이 없어 `ReferenceError: __name is not defined` 로 죽는다(실제로 죽었다).
 * 문자열은 변환 대상이 아니라 그대로 전달된다 — 타입 체크를 잃는 대신 실행이 된다.
 */
const INSPECT_SCRIPT = `(() => {
  const clean = (v) => ((v || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 60) || null;

  /**
   * 라벨 후보를 여러 경로로 모은다. ⚠️ WebSquare 는 label[for] 를 거의 쓰지 않아
   * (2026-08-05 실측: 홈택스 메인의 입력 31개 전부 label 이 null 이었다) 그 하나만
   * 보면 덤프가 "id 만 있고 무슨 칸인지 모르는" 쓸모없는 목록이 된다. title ·
   * aria-labelledby · 인접 셀 텍스트까지 긁어야 사람이 칸을 식별할 수 있다.
   */
  const labelsOf = (el) => {
    const out = [];
    out.push(el.getAttribute('aria-label'));
    out.push(el.getAttribute('title'));
    out.push(el.getAttribute('placeholder'));
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      labelledBy.split(/\\s+/).forEach((id) => {
        const ref = document.getElementById(id);
        if (ref) out.push(ref.textContent);
      });
    }
    if (el.id) {
      const forLabel = document.querySelector('label[for="' + el.id + '"]');
      if (forLabel) out.push(forLabel.textContent);
    }
    // 표 기반 폼(홈택스가 즐겨 쓰는 구조): 같은 행의 머리글 셀, 또는 앞 셀 텍스트.
    const cell = el.closest('td,th');
    if (cell) {
      const row = cell.closest('tr');
      if (row) {
        const header = row.querySelector('th');
        if (header) out.push(header.textContent);
      }
      const prev = cell.previousElementSibling;
      if (prev) out.push(prev.textContent);
    }
    return Array.from(new Set(out.map(clean).filter(Boolean)));
  };

  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    name: el.name || null,
    type: el.type || null,
    labels: labelsOf(el),
    text: clean(el.value && el.type === 'button' ? el.value : el.textContent),
    // 보이는가. 홈택스는 전체메뉴 트리를 **DOM 에 두고 숨기므로**, 이 값이 없으면
    // 덤프만 보고 "화면에 있다"고 오판한다(2026-08-07 로그인 판정 오진 조사에서 추가).
    visible: !!(el.offsetParent || el.getClientRects().length),
  });

  return {
    url: location.href,
    capturedNote: 'labels 는 후보 목록이다 — 사람이 보고 셀렉터 맵을 만든다. value(화면에 떠 있는 값)는 담지 않는다.',
    inputs: Array.from(document.querySelectorAll('input,textarea,select')).map(describe),
    buttons: Array.from(document.querySelectorAll('button,a[role=button],input[type=button],input[type=submit]')).map(describe),
    // 메뉴는 <a>·<li> 로 그려져서 위 buttons 셀렉터에 안 걸린다(2026-08-06 실측 —
    // 그래서 메뉴 이동 셀렉터를 찾지 못했다). 보이고 텍스트가 있는 것만 모은다.
    links: Array.from(document.querySelectorAll('a,li[role=menuitem],[class*=menu] a'))
      .map(describe)
      .filter((el) => el.text && el.text.length > 1)
      .slice(0, 400),
    /**
     * **아이콘 컨트롤** — 라벨이 텍스트 노드가 아니라 alt·title·aria-label 에만 있는 것들.
     *
     * 🪤 2026-08-08 실측: 인증서 선택창(MagicLine)의 탭(브라우저/금융인증서/…)이 위
     * 세 목록 어디에도 안 잡혀서, 덤프만 보면 **화면에 뻔히 보이는 탭이 존재하지 않는
     * 것처럼** 보였다(그 프레임은 링크가 0개다). 걷기가 왜 못 찾는지 판단할 근거가
     * 없어 추측만 하게 되므로, 라벨을 가진 요소는 태그를 가리지 않고 모은다.
     */
    iconControls: Array.from(document.querySelectorAll('[alt],[title],[aria-label],li,[role=tab]'))
      .map(describe)
      .filter((el) => (el.labels && el.labels.length > 0) || (el.text && el.text.length > 1))
      .slice(0, 300),
    /**
     * 표 **구조**. 결과 목록(거래처 조회 팝업 · 발급 목록조회)은 input 도 button 도
     * 아니라 표라서, 위 세 목록만으로는 행 셀렉터를 영영 못 찾는다(2026-08-06 실측 —
     * 두 기능이 같은 이유로 막혔다).
     *
     * ⛔ **셀 값은 담지 않는다.** 이 표에는 거래처 실명·대표자 실명·금액이 실린다.
     * 덤프는 레포 밖(~/.wag-crm)에 저장되지만, 값을 담기 시작하면 그 파일이 실수로
     * 공유될 때의 피해가 달라진다 — 머리글(라벨)과 개수만으로 열 구조는 충분히
     * 판별된다. 위 'value 는 담지 않는다' 원칙과 같은 이유다.
     */
    tables: Array.from(document.querySelectorAll('table'))
      .map((t) => {
        const headerCells = Array.from(t.querySelectorAll('thead th, thead td'));
        const bodyRows = Array.from(t.querySelectorAll('tbody tr'));
        const firstRow = bodyRows[0];
        return {
          id: t.id || null,
          // 그리드 컨테이너의 id — WebSquare 는 표를 감싼 div 에 논리 id 를 준다
          // (예: ..._grdResult). 행 셀렉터를 그 id 기준으로 쓰게 된다.
          containerId: ((t.parentElement && t.parentElement.closest('[id]')) || {}).id || null,
          headers: headerCells.map((c) => clean(c.textContent)).filter(Boolean),
          bodyRowCount: bodyRows.length,
          columnCount: firstRow ? firstRow.querySelectorAll('td,th').length : headerCells.length,
        };
      })
      .filter((t) => t.headers.length > 0 || t.bodyRowCount > 0)
      .slice(0, 40),
  };
})()`;

async function captureInspection(): Promise<{ path: string; draft: string; url: string }> {
  const { page } = await getSession();
  // 방금 띄운 세션의 첫 페이지는 about:blank 라 덤프가 빈 채로 나온다(실측) — 홈택스가
  // 아직 안 열려 있으면 열어 준다. 이미 홈택스 안(오너가 진행 중인 화면 포함)이면
  // `ensureHometaxOpen` 이 아무것도 하지 않으므로 작업을 되돌리지 않는다.
  await ensureHometaxOpen(page);
  // SPA 가 이동 중이면 실행 컨텍스트가 파괴돼 evaluate 가 죽는다 — 한 번만 다시
  // 시도한다(무한 재시도는 오너를 기다리게만 한다).
  let snapshot: unknown;
  try {
    snapshot = await page.evaluate(INSPECT_SCRIPT);
  } catch {
    await page.waitForTimeout(2_000);
    snapshot = await page.evaluate(INSPECT_SCRIPT);
  }

  /**
   * 🪤 **iframe 안도 덤프한다**(2026-08-07 실측). 인증서 선택창은 iframe 안에 있어서
   * 메인 프레임만 훑던 종전 덤프에는 **한 개도 잡히지 않았다**(같은 시점 메인 요소
   * 452개 중 0개). 그 사각 때문에 "화면에는 보이는데 덤프에는 없다"가 되어, 로그인
   * 2단계가 왜 멈추는지 한참 못 찾았다. 프레임별로 나눠 담아 어디 것인지 알 수 있게 한다.
   */
  const frames: unknown[] = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const part = (await frame.evaluate(INSPECT_SCRIPT)) as InspectSnapshot;
      const hasAny =
        part.inputs.length > 0 || part.buttons.length > 0 || (part.links?.length ?? 0) > 0;
      if (hasAny) frames.push({ frameUrl: frame.url(), ...part });
    } catch {
      // 프레임이 이동 중이거나 교차 출처면 못 읽는다 — 그 사실만 남기고 계속한다.
      frames.push({ frameUrl: frame.url(), unreadable: true });
    }
  }
  if (frames.length > 0) (snapshot as { frames?: unknown[] }).frames = frames;

  await mkdir(HELPER_HOME, { recursive: true });
  const path = join(HELPER_HOME, `hometax-inspect-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(snapshot, null, 2), "utf8");

  const draft = await writeSelectorDraft(snapshot as InspectSnapshot);
  return { path, draft, url: (snapshot as InspectSnapshot).url };
}

type InspectedElement = {
  tag: string; id: string | null; name: string | null; type: string | null;
  labels: string[]; text: string | null;
};
/** 표 **구조**만 담는다 — 셀 값은 담지 않는다(위 INSPECT_SCRIPT 주석의 P0 사유). */
type InspectedTable = {
  id: string | null;
  containerId: string | null;
  headers: string[];
  bodyRowCount: number;
  columnCount: number;
};
type InspectSnapshot = {
  url: string;
  inputs: InspectedElement[];
  buttons: InspectedElement[];
  links?: InspectedElement[];
  tables?: InspectedTable[];
};

/**
 * 필드 추정 규칙 — **id 가 결정하고 라벨은 후보를 좁히는 데만 쓴다.**
 *
 * ⛔ 라벨 우선 추정은 실패한다(2026-08-06 실측). 홈택스 폼은 공급자·공급받는자·품목
 * 여러 행이 「상호」·「공급가액」 같은 라벨을 공유해서, 「라벨이 겹치면 마지막 것」
 * 규칙이 사업자등록번호 자리에 **주민번호 뒷자리**를, 주소 자리에 **이메일 아이디**를,
 * 품목 자리에 **4행**을 넣은 초안을 냈다.
 *
 * id 규칙(실측): `Dmnr`=공급받는자 · `Splr`=공급자 · `Bsno`=사업자번호 ·
 * `TnmNm`=상호 · `RprsFnm`=대표자 성명 · `PfbAdr`=사업장주소 · `BcNm`=업태 ·
 * `ItmNm`=종목 · `MchrgEml`=주담당 이메일 · `genEtxivLsatTop_0_`=품목 1행.
 * 홈택스 개편으로 이 규칙이 깨지면 해당 필드는 **비운 채 사유를 남긴다** — 추측해서
 * 채우는 것이 이 도구에서 가장 비싼 실수이기 때문이다.
 */
const FIELD_HINTS: Array<[HometaxFieldKey, RegExp, RegExp]> = [
  // [필드, 라벨 정규식, id 정규식] — id 가 결정적이고 라벨은 보조다.
  ["buyerBusinessNumber", /등록번호/, /edtDmnrBsnoTop$/],
  ["buyerName", /상호/, /edtDmnrTnmNmTop$/],
  ["buyerCeo", /성명/, /edtDmnrRprsFnmTop$/],
  ["buyerAddress", /사업장|주소/, /edtDmnrPfbAdrTop$/],
  ["buyerBusinessType", /업태/, /edtDmnrBcNmTop$/],
  ["buyerBusinessItem", /종목/, /edtDmnrItmNmTop$/],
  ["buyerEmailId", /이메일/, /edtDmnrMchrgEmlIdTop$/],
  ["buyerEmailDomain", /이메일/, /edtDmnrMchrgEmlDmanTop$/],
  // 거래일자의 **일**만 잡는다. 월 칸(`edtLsatSplMmTop`)은 DOM 에 있지만 disabled 라
  // 채울 수 없다(2026-08-06 실측) — 초안에 넣으면 채울 수 없는 칸을 넣게 된다.
  ["itemDay", /1행.*일|일/, /_0_edtLsatSplDdTop$/],
  ["itemName", /1행.*품목|품목/, /_0_edtLsatNmTop$/],
  ["itemSupplyAmount", /1행.*공급가액|공급가액/, /_0_edtLsatSplCftTop$/],
  ["itemTaxAmount", /1행.*세액|세액/, /_0_edtLsatTxamtTop$/],
  ["remark", /1행.*비고|비고/, /_0_edtLsatRmrkCntnTop$/],
];

function toSelector(el: InspectedElement): string | null {
  if (el.id) return `#${el.id.replace(/([:.[\]])/g, "\\$1")}`;
  if (el.name) return `[name="${el.name}"]`;
  return null;
}

/**
 * 덤프에서 셀렉터 맵 **초안**을 만들어 저장한다. 오너가 빈 파일을 손으로 채우는 대신
 * 초안을 검토·수정만 하면 되게 하는 것이 목적이다 — 그래도 확인은 사람이 한다
 * (엉뚱한 칸에 사업자번호를 넣는 것이 이 도구에서 가장 비싼 실수다).
 *
 * ⛔ 확정 파일(`hometax-selectors.json`)을 덮어쓰지 않는다. 초안은 `.draft.json` 으로만
 * 쓰고, 오너가 확인한 뒤 이름을 바꾸는 절차를 남긴다.
 */
async function writeSelectorDraft(snapshot: InspectSnapshot): Promise<string> {
  const candidates = snapshot.inputs.filter(
    (el) => el.tag !== "select" && el.type !== "button" && el.type !== "checkbox" && el.labels.length > 0,
  );

  const fields: Partial<Record<HometaxFieldKey, string>> = {};
  const notes: string[] = [];
  for (const [key, labelRe, idRe] of FIELD_HINTS) {
    // ⛔ 라벨만으로 고르지 않는다. 첫 구현이 「라벨이 겹치면 마지막 것」 규칙을 썼다가
    // 사업자등록번호 자리에 **주민번호 뒷자리**를, 주소 자리에 **이메일 아이디**를
    // 넣는 초안을 냈다(2026-08-06 실측). 홈택스 폼은 공급자/공급받는자/여러 품목 행이
    // 같은 라벨을 공유해서, 라벨은 후보를 좁히는 데만 쓰고 **결정은 id 로** 한다.
    const byId = candidates.find((el) => el.id && idRe.test(el.id));
    if (byId) {
      const selector = toSelector(byId);
      if (selector) fields[key] = selector;
      continue;
    }
    // id 규칙이 안 맞으면(화면 개편 등) 라벨로 후보를 좁혀 **보류**로 남긴다 —
    // 추측해서 채우면 엉뚱한 칸에 사업자번호를 넣게 된다.
    const byLabel = candidates.filter((el) => el.labels.some((l) => labelRe.test(l)));
    if (byLabel.length === 0) {
      notes.push(`${key}: 후보를 찾지 못했습니다 — 화면이 바뀌었을 수 있습니다.`);
      continue;
    }
    notes.push(
      `${key}: 알려진 id 규칙과 맞는 칸이 없어 비워 뒀습니다. 라벨이 비슷한 후보 ${byLabel.length}개 — ` +
        byLabel.slice(0, 3).map((el) => el.id ?? el.name ?? "(id 없음)").join(", "),
    );
  }

  // 사업자등록번호 「확인」 버튼 — 이 클릭이 상호·대표자·주소를 홈택스가 채우게 한다.
  const confirmBtn = snapshot.inputs
    .concat(snapshot.buttons)
    .find((el) => el.id && /btnDmnrBsnoCnfrTop$/.test(el.id));

  // 「거래처 조회」 버튼 — 오너가 평소 쓰는 1순위 경로의 입구다. **여는 버튼까지만**
  // 초안이 잡을 수 있다: 팝업 안의 검색칸·결과 행은 팝업이 떠 있어야 DOM 에 있으므로,
  // 오너가 팝업을 연 상태에서 /inspect 를 한 번 더 돌려야 한다(아래 note 로 안내).
  const lookupBtn = snapshot.inputs
    .concat(snapshot.buttons)
    .find((el) => /거래처\s*조회/.test(el.text ?? "") || el.labels.some((l) => /거래처\s*조회/.test(l)));
  if (lookupBtn) {
    notes.push(
      "counterpartyLookup: 「거래처 조회」 버튼을 찾았습니다. 팝업 안의 검색칸·결과 행 셀렉터는 " +
        "**팝업을 연 상태에서 /inspect 를 한 번 더** 돌려야 잡힙니다(searchInput · resultRow · confirm).",
    );
  } else {
    notes.push("counterpartyLookup: 「거래처 조회」 버튼을 못 찾아 비워 뒀습니다 — 사업자번호 경로로 동작합니다.");
  }

  // 발급 목록조회 메뉴 — 덤프에 메뉴 트리가 통째로 잡히므로 **이동 경로는 미리 채운다.**
  // ⛔ 라벨을 홈택스 원문(「발급 목록조회」)으로 쓰면 가드가 막는다(「발급」이 금지어).
  //    그래서 초안이 **개명된 라벨**을 넣는다 — 오너가 그 함정을 밟지 않게 하는 것이
  //    이 자동화의 요점이다. 셀렉터는 그대로다.
  const queryMenu = snapshot.links?.find((el) => el.id === "menuAtag_4609050100");
  const queryParentMenu = snapshot.links?.find((el) => el.id === "menuAtag_4609050000");
  if (queryMenu) {
    notes.push(
      "invoiceQuery: 목록조회 메뉴를 찾아 navigation 을 채웠습니다(라벨은 가드를 통과하도록 개명). " +
        "기간 칸(dateFrom·dateTo)·결과 행(resultRow)·조회 버튼(search)은 **그 화면을 연 상태에서 /inspect** 를 한 번 더 돌려야 잡힙니다.",
    );
  }

  const draft: SelectorMap & { _확인필요?: string[] } = {
    issueFormUrl: snapshot.url,
    invoiceQuery: queryMenu
      ? {
          navigation: {
            ...(queryParentMenu ? { "조회 메뉴": `#${queryParentMenu.id}` } : {}),
            "목록 화면": `#${queryMenu.id}`,
          },
          // ⚠️ 아래 셋은 자리표시자가 아니라 **실측값**이어야 한다 — 비어 있으면
          //    `queryIssuedInvoices` 가 아예 시작하지 않고 무엇이 비었는지 보고한다.
          dateFrom: "",
          dateTo: "",
          search: { label: "조회", selector: "" },
          resultRow: "",
        }
      : undefined,
    confirmBusinessNumber: confirmBtn?.id
      ? { label: "등록번호 확인", selector: `#${confirmBtn.id}` }
      : undefined,
    counterpartyLookup:
      lookupBtn?.id
        ? {
            open: { label: "거래처 조회", selector: `#${lookupBtn.id}` },
            // ⚠️ 아래 둘은 **자리표시자가 아니라 실측값**이어야 한다. 팝업을 연 상태의
            //    /inspect 결과로 채우기 전까지는 이 블록을 지워 두는 편이 안전하다 —
            //    틀린 셀렉터로 팝업을 헤매느니 사업자번호 경로가 낫다.
            searchInput: "",
            resultRow: "",
          }
        : undefined,
    capturedAt: new Date().toISOString().slice(0, 10),
    fields,
    _확인필요: notes.length > 0 ? notes : undefined,
  };

  const path = join(HELPER_HOME, "hometax-selectors.draft.json");
  await writeFile(path, JSON.stringify(draft, null, 2), "utf8");
  return path;
}

/**
 * 로그인 안내 문구 — **오너가 지금 무엇을 하면 되는지**만 말한다.
 *
 * 어디까지 갔는지에 따라 할 일이 다르다: 비밀번호 창까지 갔으면 여섯 자리를 누르면
 * 되고, 중간에 멈췄으면 그 화면부터 손으로 이어가야 한다.
 */
function describeLoginPrompt(prompt: Awaited<ReturnType<typeof navigateToLoginPrompt>> | null): string {
  const base = "홈택스 로그인이 필요합니다";
  if (!prompt || prompt.notConfigured) {
    return `${base} — 열린 창에서 로그인한 뒤 다시 시도하세요.`;
  }
  if (prompt.stoppedAt) {
    // 알림을 닫았는지까지 알려 준다 — 「막혀서 못 갔다」와 「막힌 건 치웠는데 그 다음이
    // 다르다」는 오너가 할 일이 다르다(전자는 재시도, 후자는 화면 확인).
    const alertNote = prompt.dismissedAlert ? "로그인 안내창은 닫았습니다. " : "";
    return `${base} — ${alertNote}「${prompt.stoppedAt}」을(를) 화면에서 찾지 못해 거기서 멈췄습니다. 열린 창에서 이어서 로그인하세요.`;
  }
  return `${base} — 인증서 비밀번호 창까지 열어 뒀습니다. 열린 창에서 비밀번호만 누르세요(비밀번호는 자동화하지 않습니다).`;
}

async function handleIssue(payload: InvoicePayload) {
  const map = await loadSelectorMap();
  const { page, usedBundledChromium } = await getSession();
  await ensureHometaxOpen(page);

  // 🪤 알림이 떠 있으면 그것이 **단정적** 로그아웃 신호다 — `looksLoggedOut` 의 문구
  //    추정보다 강하고, 무엇보다 이 알림은 화면을 덮어 **다음 단계를 전부 막는다.**
  //    먼저 보지 않으면 발급 폼으로 진입하려다 그 모달 앞에서 조용히 헛돈다.
  if ((await hasLoginRequiredAlert(page)) || (await looksLoggedOut(page))) {
    // 로그인 화면까지 데려다 놓는다 — 오너는 여섯 자리만 누르면 된다.
    // ⛔ 비밀번호는 자동화하지 않는다(`login.ts` — 타이핑 호출이 한 줄도 없다).
    const prompt = await navigateToLoginPrompt(page, await loadSelectorMap()).catch((err) => {
      // ⛔ 삼키지 않는다(P0) — 로그인 유도가 왜 멈췄는지는 이 한 줄이 유일한 단서다.
      console.error("[hometax-helper] 로그인 유도 실패:", err instanceof Error ? err.message : String(err));
      return null;
    });
    return {
      status: "NEED_LOGIN" as const,
      message: describeLoginPrompt(prompt),
      usedBundledChromium,
    };
  }

  try {
    await navigateToIssueForm(page, map);
  } catch (err) {
    if (err instanceof ForbiddenClickError) {
      // 금지선에 걸린 것은 설정 실수(발급 버튼을 navigation 에 적었다)이므로 그대로
      // 드러낸다 — 조용히 건너뛰면 다음 사람이 "왜 안 눌리지"를 영원히 모른다.
      return { status: "FAILED_AT" as const, step: "navigate", message: err.message };
    }
    return {
      status: "FAILED_AT" as const,
      step: "navigate",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const outcome = await fillInvoiceForm(page, map, payload);
    // 채운 필드가 하나도 없으면 "성공"이라고 말하지 않는다 — 오너가 창을 보고 빈 폼을
    // 발급하는 사고를 막는다.
    //
    // ⛔ 사유를 가려서 보고한다(2026-08-06 실사고). 종전에는 무조건 「셀렉터 맵을
    // 먼저 만드세요」라고 했는데, 실제 원인은 **홈택스 30분 무활동 자동 로그아웃**
    // 이었다 — 맵은 멀쩡히 있는데 엉뚱한 곳을 고치라고 안내한 셈이다. 진입 시점의
    // 로그인 판정만으로는 못 잡는다(그때는 살아 있다가 메뉴 이동 중에 끊긴다).
    // ⚠️ 「거래처 조회」로 공급받는자가 들어온 경우는 제외한다 — 그 경로는 홈택스가
    //    칸을 채우므로 우리 `filled` 가 비어도 폼은 채워진 상태일 수 있다. 성공한
    //    경로를 실패로 보고하면 오너가 멀쩡한 폼을 버린다.
    if (outcome.filled.length === 0 && outcome.counterparty.method !== "lookup") {
      const mapIsEmpty = Object.keys(map.fields).length === 0;
      if (mapIsEmpty) {
        return {
          status: "FAILED_AT" as const,
          step: "fill",
          message:
            `채울 수 있는 필드가 없습니다 — 셀렉터 맵(${SELECTOR_MAP_PATH})을 먼저 만드세요. ` +
            `POST /inspect 로 현재 화면을 덤프할 수 있습니다.`,
        };
      }
      // 맵이 있는데 하나도 못 채웠다면 화면이 예상과 다르다 — 가장 흔한 원인이
      // 세션 만료이므로 지금 상태를 다시 확인해 정확히 알린다.
      if ((await hasLoginRequiredAlert(page)) || (await looksLoggedOut(page))) {
        // 여기서도 로그인 화면까지 데려다 놓는다 — 진입 시점엔 살아 있다가 폼을 채우는
        // 동안 끊긴 경우이고, 오너가 할 일은 진입 시점 로그아웃과 똑같다.
        const prompt = await navigateToLoginPrompt(page, map).catch((err) => {
      // ⛔ 삼키지 않는다(P0) — 로그인 유도가 왜 멈췄는지는 이 한 줄이 유일한 단서다.
      console.error("[hometax-helper] 로그인 유도 실패:", err instanceof Error ? err.message : String(err));
      return null;
    });
        return {
          status: "NEED_LOGIN" as const,
          message: `홈택스 로그인이 풀렸습니다(무활동 자동 로그아웃) — ${describeLoginPrompt(prompt)}`,
          ...outcome,
        };
      }
      return {
        status: "FAILED_AT" as const,
        step: "fill",
        message:
          "건별발급 폼을 찾지 못했습니다 — 화면이 예상과 다릅니다. 열린 창의 상태를 확인하세요. " +
          `(셀렉터 맵 필드 ${Object.keys(map.fields).length}개는 정상 로드됨)`,
        ...outcome,
      };
    }
    // ⛔ 넣은 값이 화면에 그대로 반영되지 않았으면 **성공이라고 말하지 않는다.**
    // 2026-08-06 사고: 세액이 기존 값에 덧붙어 100,000 → 100,000,100,000 이 됐는데
    // 응답은 `FILLED` 였다. 오너가 그 말을 믿고 발급했다면 1000억짜리 계산서가
    // 나갔을 것이다. 금액이 걸린 도구에서 "채웠다"는 보고는 대조를 통과했을 때만
    // 할 수 있다.
    if (outcome.mismatched.length > 0) {
      return {
        status: "FAILED_AT" as const,
        step: "verify",
        message:
          `입력한 값이 화면에 그대로 들어가지 않았습니다 — 발급하지 마세요. ` +
          outcome.mismatched
            .map((m) => `${m.field}: 넣은 값 "${m.expected}" / 화면 값 "${m.actual}"`)
            .join(" · "),
        ...outcome,
      };
    }
    // 사람이 골라야 하는 창(종사업장 선택 등)이 떠 있으면 「채웠다」로 끝내지 않는다 —
    // 그 선택이 끝나야 공급받는자 정보가 확정되기 때문이다(2026-08-06 실측).
    if (outcome.pendingUserChoice) {
      return {
        status: "NEEDS_CHOICE" as const,
        message:
          `홈택스가 「${outcome.pendingUserChoice}」 창을 띄웠습니다 — 화면에서 직접 선택해 주세요. ` +
          `거래 실질에 따른 판단이라 헬퍼가 대신 고르지 않습니다. 나머지 칸은 채워 뒀습니다.`,
        ...outcome,
        usedBundledChromium,
      };
    }
    // 어느 경로로 공급받는자를 채웠는지 한 줄로 알린다. 폴백했다면 **왜** 폴백했는지가
    // 곧 오너의 할 일이다 — 미등록이면 거래처로 등록해 두면 다음부터 1순위 경로를 탄다.
    const counterpartyMessage =
      outcome.counterparty.method === "lookup"
        ? "공급받는자는 「거래처 조회」로 채웠습니다."
        : outcome.counterparty.method === "businessNumber"
          ? `공급받는자는 사업자번호 확인으로 채웠습니다${
              outcome.counterparty.note ? ` (거래처 조회 폴백: ${outcome.counterparty.note})` : ""
            }.`
          : `공급받는자를 채우지 못했습니다${
              outcome.counterparty.note ? ` (${outcome.counterparty.note})` : ""
            }.`;
    /**
     * 「발급하기」까지 누른다(오너 승인 2026-08-08 — 「채우자마자 발행까지 자동」).
     *
     * ⛔ **여기가 마지막 관문이 아니다** — 이 클릭은 확인 팝업을 띄우는 데까지이고,
     * 그 팝업의 「확인(인증 화면 이동)」과 전자서명은 사람이 한다(`guards.ts`).
     *
     * 🪤 **순서가 안전장치다.** 위 세 검사(채운 필드 0 · 값 대조 불일치 · 사람이 골라야
     * 하는 창)를 **전부 통과한 뒤에만** 여기 온다 — 그 검사들이 걸리면 이미 return 했다.
     * 이 호출을 위로 올리면 2026-08-06 의 「세액이 덧붙어 1000억」 같은 값이 검증 전에
     * 발급 확인창까지 올라간다. 계약 테스트가 이 순서를 소스로 고정한다.
     */
    /**
     * **발행 전 자체 검토**(오너 지시 2026-08-08). 헬퍼가 발급 버튼을 누르게 되면서
     * 오너가 폼을 눈으로 보는 단계가 사라졌으므로, 그 자리를 기계 대조가 대신한다.
     * 하나라도 걸리면 **누르지 않고** 사유를 돌려준다 — 폼은 채워진 채 남으므로
     * 오너가 화면에서 고쳐 이어갈 수 있다.
     */
    const problems = await preflightBeforeSubmit(page, map, payload);
    if (problems.length > 0) {
      const detail = problems.map((p) => `${p.field}: ${p.reason}`).join(" · ");
      console.log(`[hometax-helper] 발행 전 검토에서 멈춤 — ${detail}`);
      return {
        status: "FILLED" as const,
        message: `발행 전 검토에서 걸려 발급 버튼을 누르지 않았습니다 — ${detail}`,
        ...outcome,
        usedBundledChromium,
      };
    }

    const submitted = await submitIssueForm(page, map).catch((err) => ({
      outcome: "SUBMIT_SKIPPED" as const,
      note: err instanceof Error ? err.message : String(err),
    }));

    if (submitted.outcome === "AWAITING_SIGNATURE") {
      // 이 도구가 멈추는 **최종 지점**이다. 남은 것은 오너가 여섯 자리를 누르는 것뿐.
      return {
        status: "AWAITING_SIGNATURE" as const,
        message:
          `${counterpartyMessage} 인증서 비밀번호 창까지 진행했습니다 — 비밀번호를 눌러 발급을 마치세요. ` +
          `(비밀번호·전자서명은 헬퍼가 누르지 않습니다)`,
        ...outcome,
        usedBundledChromium,
      };
    }
    if (submitted.outcome === "AWAITING_CONFIRM") {
      return {
        status: "AWAITING_CONFIRM" as const,
        message:
          `${counterpartyMessage} 발급 확인 창이 떴습니다 — 내용을 확인하고 직접 발급하세요. ` +
          `(확인·전자서명은 헬퍼가 누르지 않습니다)`,
        ...outcome,
        usedBundledChromium,
      };
    }
    if (submitted.outcome === "AUTH_STOPPED") {
      // 확인 팝업은 이미 지나왔다 — 어디서 멈췄는지가 곧 오너가 이어받을 지점이다.
      return {
        status: "AWAITING_CONFIRM" as const,
        message:
          `${counterpartyMessage} 인증 단계 「${submitted.stoppedAt}」에서 멈췄습니다 — ` +
          `열린 창에서 그 단계부터 이어서 진행하세요.`,
        ...outcome,
        usedBundledChromium,
      };
    }
    // 못 눌렀거나 확인 창을 못 봤으면 **눌렀다고 말하지 않는다** — 폼은 채워져 있으므로
    // 오너가 이어받을 수 있고, 사유가 곧 오너가 할 일이다.
    return {
      status: "FILLED" as const,
      message: `${counterpartyMessage} ${submitted.note}`,
      ...outcome,
      usedBundledChromium,
    };
  } catch (err) {
    return {
      status: "FAILED_AT" as const,
      step: "fill",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

const server = createServer((req, res) => {
  void (async () => {
    // 처리 중에는 유휴 종료가 발화하지 않는다 — 폼을 채우는 도중에 나가면 반쯤 채워진
    // 화면이 남는다(`idle.ts` 의 ⛔ 항목).
    //
    // ⛔ **`/health` 는 활동으로 세지 않는다**(2026-08-07 실측). 생존 확인은 일이 아니라
    // 관찰인데, 이것을 활동으로 세면 **폴링하는 쪽이 있는 한 헬퍼가 영원히 산다** —
    // 실제로 첫 유휴 테스트가 15초 간격 health 폴링 때문에 3분이 지나도 안 내려갔고,
    // 원인을 한참 못 찾았다. CRM 은 클릭 시점에만 부르지만(설계상 상시 폴링 없음),
    // 미래에 감시 스크립트가 하나 붙는 것만으로 온디맨드가 조용히 무효가 된다.
    const counted = !(req.method === "GET" && req.url === "/health");
    if (counted) activity.begin();
    /**
     * ⛔ **요청의 시작·진행·끝을 전부 남긴다**(P0, 2026-08-08 오너 지적).
     *
     * 종전에는 `handleIssue` 의 **일부 분기만** 로그를 남겨서, 조용함이 두 가지를
     * 동시에 뜻했다 — 「아직 도는 중」과 「이미 끝났는데 안 알려줌」. 실사용에서
     * 정확히 그 상태가 나왔다: 로그인 재개 후 요청이 끝났는데 로그가 한 줄도 없어
     * 무슨 일이 일어났는지 아무도 몰랐다("작동이 멈춰있는데?").
     *
     * 그래서 여기서 요청 단위로 감싼다. 이 자리는 **모든 엔드포인트가 반드시 지나는
     * 한 곳**이라, 미래에 분기가 늘어도 로그가 비지 않는다(분기마다 로그를 심는
     * 방식이 실패한 이유가 그것이다).
     *
     * 진행 중 하트비트는 **오래 걸리는 것과 멈춘 것을 가른다** — 이 도구는 30초씩
     * 기다리는 단계가 여럿이라(인증서 창 대기 등) 무응답이 곧 이상은 아니다.
     */
    const label = `${req.method} ${(req.url ?? "").split("?")[0]}`;
    const startedAt = Date.now();
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    if (counted) {
      console.log(`[hometax-helper] ▶ ${label}`);
      heartbeat = setInterval(() => {
        console.log(`[hometax-helper] … ${label} 진행 중 (${Math.round((Date.now() - startedAt) / 1000)}초 경과)`);
      }, 15_000);
    }
    try {
      await handleRequest(req, res);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (counted) {
        console.log(`[hometax-helper] ◀ ${label} 완료 (${Math.round((Date.now() - startedAt) / 1000)}초)`);
      }
      if (counted) activity.end();
    }
  })();
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  {
    const origin = req.headers.origin;
    // 오리진 없는 요청(curl 등)은 브라우저발이 아니므로 CORS 헤더가 필요 없다 —
    // /inspect 를 터미널에서 부르는 경로가 그것이다. 브라우저에서 온 요청은 반드시
    // 화이트리스트를 통과해야 한다.
    if (origin && !isAllowedOrigin(origin)) {
      send(res, 403, { error: "허용되지 않은 오리진입니다." }, {});
      return;
    }
    const headers = origin ? corsHeaders(origin) : {};

    // 경로와 쿼리를 갈라 둔다 — 아래 분기들이 `req.url` 을 통째로 비교하면 쿼리가
    // 붙는 순간(`/login-status?waitMs=…`) 아무 데도 걸리지 않고 404 가 된다.
    const requestUrl = new URL(req.url ?? "/", `http://${BIND_HOST}`);
    const pathname = requestUrl.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && req.url === "/health") {
        const map = await loadSelectorMap();
        const fieldCount = Object.keys(map.fields).length;
        send(
          res,
          200,
          {
            ok: true,
            selectorMap: fieldCount > 0 ? "ready" : "missing",
            fieldCount,
            navigationCount: allowedClickLabels(map).length,
            capturedAt: map.capturedAt ?? null,
            // 유휴 자동 종료의 현재 상태 — "왜 아직 살아 있나 / 왜 내려갔나"를 사람이
            // 물어볼 수 있어야 한다(2026-08-07 실측: 이 값이 없어 원인 판정을 못 했다).
            idle: {
              limitMinutes: IDLE_MS === null ? null : Math.round(IDLE_MS / 60_000),
              lastRequestAgoSec: Math.round((Date.now() - activity.lastRequestAt) / 1000),
              lastInputAgoSec: await readLastUserInputAt().then((at) =>
                at === null ? null : Math.round((Date.now() - at) / 1000),
              ),
              hasWindow: hasLiveSession(),
              // 처리 중인 요청 수 — 「아직 도는 중」과 「끝났는데 조용함」을 가른다.
              // 이게 없어서 검증 중에 진행 중인 요청을 완료로 오판했다(2026-08-07).
              inFlight: activity.inFlight,
            },
          },
          headers,
        );
        return;
      }

      /**
       * 로그인 상태 조회 — **읽기 전용**. 오너가 로그인을 끝냈는지 CRM 이 지켜보다가
       * 발행을 자동 재개하기 위한 것이다.
       *
       * `?waitMs=<ms>` 를 주면 **그 시간까지 기다렸다가** 답한다(long-poll). 되묻는
       * 간격이 곧 지연이던 것을 없애기 위한 것이다 — 로그인이 끝나 홈택스가 페이지를
       * 이동하면 그 즉시 깨어나 응답한다(`waitForLoginState` 주석). 값이 없으면
       * 종전처럼 지금 상태를 즉시 답한다.
       *
       * ⛔ 여기서 창을 열지도, 아무것도 클릭하지도 않는다. 이 요청이 도는 동안 오너는
       * 인증서 비밀번호를 누르고 있다 — 부수효과가 하나라도 있으면 그걸 날린다.
       * 창이 없으면 열지 않고 `UNKNOWN` 으로 답한다(그 판단은 CRM 이 한다).
       */
      if (req.method === "GET" && pathname === "/login-status") {
        // 상한을 두는 이유: 무한정 붙잡고 있으면 헬퍼 종료·재기동이 그만큼 늦어지고,
        // 프록시·브라우저가 먼저 끊으면 그 실패가 「로그인 안 됨」으로 오독된다.
        const requested = Number(requestUrl.searchParams.get("waitMs") ?? 0);
        const waitMs = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 30_000) : 0;
        send(res, 200, { state: await waitForLoginState(waitMs) }, headers);
        return;
      }

      if (req.method === "POST" && req.url === "/issue") {
        const body = (await readJsonBody(req)) as { invoice?: InvoicePayload };
        if (!body?.invoice) {
          send(res, 400, { error: "invoice 가 필요합니다." }, headers);
          return;
        }
        const result = await handleIssue(body.invoice);
        // ⛔ **결과를 반드시 남긴다**(P0). 응답은 CRM 으로만 가므로, 여기 로그가 없으면
        //    "요청은 끝났는데 무슨 일이 있었는지 아무도 모르는" 상태가 된다 —
        //    2026-08-08 실사용에서 정확히 그렇게 됐다. status 와 사유를 한 줄로 남긴다.
        const detail =
          "message" in result && result.message
            ? result.message
            : "step" in result
              ? `단계: ${result.step}`
              : "";
        console.log(`[hometax-helper] /issue 결과: ${result.status}${detail ? ` — ${detail}` : ""}`);
        send(res, 200, result, headers);
        return;
      }

      /**
       * 발급 목록조회 — **읽기 전용**. 「우리가 실제로 발행했는가」의 정본은 홈택스이고
       * 메일이 아니다(메일 커버리지가 100% 가 아님이 실측됐다).
       *
       * ⚠️ 로그인 여부를 먼저 본다 — 목록이 0건인 것과 로그인이 풀린 것은 전혀 다른
       * 사실인데, 둘 다 「빈 표」로 보이면 오너가 **발행 안 했다고 오판**한다.
       */
      if (req.method === "POST" && req.url === "/query") {
        const body = (await readJsonBody(req)) as { from?: string; to?: string; kind?: string };
        if (!body?.from || !body?.to) {
          send(res, 400, { error: "from·to(YYYY-MM-DD) 가 필요합니다." }, headers);
          return;
        }
        // 기본은 발행분(매출). 알 수 없는 값은 조용히 기본값으로 떨어뜨리지 않는다 —
        // 오타 하나로 「수취를 물었는데 발행을 받는」 방향 역전이 생긴다.
        if (body.kind !== undefined && body.kind !== "SALES" && body.kind !== "PURCHASE") {
          send(res, 400, { error: 'kind 는 "SALES"(발행) 또는 "PURCHASE"(수취) 여야 합니다.' }, headers);
          return;
        }
        const kind = (body.kind ?? "SALES") as InvoiceQueryKind;
        const { page } = await getSession();
        await ensureHometaxOpen(page);
        if ((await hasLoginRequiredAlert(page)) || (await looksLoggedOut(page))) {
          const prompt = await navigateToLoginPrompt(page, await loadSelectorMap()).catch((err) => {
      // ⛔ 삼키지 않는다(P0) — 로그인 유도가 왜 멈췄는지는 이 한 줄이 유일한 단서다.
      console.error("[hometax-helper] 로그인 유도 실패:", err instanceof Error ? err.message : String(err));
      return null;
    });
          send(res, 200, { status: "NEED_LOGIN", message: describeLoginPrompt(prompt) }, headers);
          return;
        }
        const map = await loadSelectorMap();
        const outcome = await queryIssuedInvoices(page, map, { from: body.from, to: body.to }, kind);
        // 🪤 **모달은 메뉴 이동 뒤에 뜬다**(2026-08-07 실측). 진입 시점 판정만으로는
        //    못 잡으므로, 실패했으면 지금 상태를 다시 본다 — 안 그러면 오너에게
        //    「셀렉터를 못 찾는다」로 보고돼 엉뚱한 곳(맵)을 고치게 된다. 실제로
        //    이 경로가 `locator.fill 타임아웃`을 냈고 원인은 로그아웃이었다.
        if (outcome.status !== "OK" && (await hasLoginRequiredAlert(page))) {
          const prompt = await navigateToLoginPrompt(page, map).catch((err) => {
      // ⛔ 삼키지 않는다(P0) — 로그인 유도가 왜 멈췄는지는 이 한 줄이 유일한 단서다.
      console.error("[hometax-helper] 로그인 유도 실패:", err instanceof Error ? err.message : String(err));
      return null;
    });
          send(res, 200, { status: "NEED_LOGIN", message: describeLoginPrompt(prompt) }, headers);
          return;
        }
        send(res, 200, outcome, headers);
        return;
      }

      // 화면 캡처 — 좌표 클릭을 하려면 사람(또는 에이전트)이 화면을 봐야 한다.
      if (req.method === "POST" && req.url === "/screenshot") {
        const { page } = await getSession();
        await mkdir(HELPER_HOME, { recursive: true });
        const shot = join(HELPER_HOME, `hometax-shot-${Date.now()}.png`);
        await page.screenshot({ path: shot, fullPage: false });
        send(res, 200, { ok: true, path: shot, url: page.url() }, headers);
        return;
      }

      /**
       * 좌표 클릭. 메뉴처럼 셀렉터를 잡기 어려운 요소를 누르기 위한 경로다.
       *
       * ⛔ **금지선은 좌표에서도 유지된다.** 좌표만으로 누르면 라벨을 모르니 가드가
       * 무력화되고, 발급 버튼 좌표를 누르는 것을 막을 수 없다 — 그래서 클릭 전에
       * `elementFromPoint` 로 그 지점의 텍스트를 읽어 금지 패턴을 검사한다.
       * 허용 목록은 요구하지 않는다(좌표 클릭의 용도가 미지의 메뉴 탐색이므로).
       */
      if (req.method === "POST" && req.url === "/click") {
        const body = (await readJsonBody(req)) as { x?: number; y?: number };
        if (typeof body.x !== "number" || typeof body.y !== "number") {
          send(res, 400, { error: "x, y 좌표가 필요합니다." }, headers);
          return;
        }
        const { page } = await getSession();
        const label = (await page.evaluate(
          `(() => { const el = document.elementFromPoint(${body.x}, ${body.y});
             if (!el) return "";
             return ((el.textContent || el.value || el.getAttribute('title') || '') + '').replace(/\\s+/g,' ').trim().slice(0, 60); })()`,
        )) as string;

        if (matchesForbiddenPattern(label)) {
          send(
            res,
            403,
            {
              error: `금지된 클릭 대상입니다(발급·서명 계열): "${label}" — 좌표로도 누를 수 없습니다.`,
              label,
            },
            headers,
          );
          return;
        }

        await page.mouse.click(body.x, body.y);
        await page.waitForTimeout(1_200);
        send(res, 200, { ok: true, clickedLabel: label, url: page.url() }, headers);
        return;
      }

      /**
       * 「발급하기」만 다시 누른다 — **폼은 건드리지 않는다.**
       *
       * 왜 별도 경로인가: `/issue` 는 매번 폼을 처음부터 채운다. 오너가 화면에서 손으로
       * 고친 값(예: 홈택스 상한에 걸린 품목비고를 지운 것)이 그 재입력에 **덮인다** —
       * 고치고 다시 누르는 것이 불가능해진다.
       *
       * ⚠️ 이 경로에는 `/issue` 의 검증 3종(채운 필드·값 대조·선택 대기)이 없다. 그래도
       * 되는 이유는 **사람이 화면을 보고 있는 상태에서 요청하는 재시도**이기 때문이다 —
       * 오너가 직접 버튼을 누르는 것과 같고, 자동 흐름보다 오히려 눈이 하나 더 있다.
       * ⛔ 이 엔드포인트를 자동 흐름에서 부르지 말 것(그러면 검증을 우회하는 통로가 된다).
       *
       * 금지선은 그대로다 — 셀렉터 맵의 `issueSubmit` 하나만 눌리고, 확인 팝업과
       * 전자서명은 사람이 한다.
       */
      if (req.method === "POST" && req.url === "/submit") {
        const map = await loadSelectorMap();
        const { page } = await getSession();
        send(res, 200, await submitIssueForm(page, map), headers);
        return;
      }

      if (req.method === "POST" && req.url === "/inspect") {
        const { path, draft, url } = await captureInspection();
        send(
          res,
          200,
          {
            ok: true,
            현재화면: url,
            덤프: path,
            셀렉터맵초안: draft,
            다음할일: `초안을 확인한 뒤 ${SELECTOR_MAP_PATH} 로 이름을 바꾸면 적용됩니다.`,
          },
          headers,
        );
        return;
      }

      send(res, 404, { error: "Not found" }, headers);
    } catch (err) {
      // 실패를 삼키지 않는다(P0) — 콘솔과 응답 양쪽에 남긴다.
      const message = err instanceof Error ? err.message : String(err);
      console.error("[hometax-helper]", message);
      send(res, 500, { error: message }, headers);
    }
  }
}

/**
 * 유휴 감시 — 일정 시간 아무 요청도 없고 오너가 창을 만지지도 않으면 **스스로 나간다.**
 *
 * ⛔ `process.exit` 전에 반드시 `closeSession()` 을 기다린다. 강제 종료하면 Chrome 이
 * 쿠키를 디스크에 쓰지 못해 **홈택스 로그인 세션이 날아간다**(2026-08-06 실측) —
 * 온디맨드 전환의 전제가 "다음에 깨어나도 로그인이 살아 있다" 이므로, 여기서 세션을
 * 날리면 전환 자체가 손해가 된다.
 */
function startIdleWatchdog(): void {
  if (IDLE_MS === null) {
    console.log("[hometax-helper] 유휴 자동 종료 비활성(HOMETAX_HELPER_IDLE_MINUTES=0).");
    return;
  }
  console.log(`[hometax-helper] 유휴 ${Math.round(IDLE_MS / 60_000)}분이면 스스로 종료합니다.`);
  let closing = false;
  const timer = setInterval(() => {
    void (async () => {
      if (closing) return;
      const decision = shouldShutdownForIdle({
        idleMs: IDLE_MS,
        lastRequestAt: activity.lastRequestAt,
        lastUserInputAt: await readLastUserInputAt(),
        inFlight: activity.inFlight,
        hasWindow: hasLiveSession(),
        now: Date.now(),
      });
      if (!decision) return;
      closing = true;
      console.log("[hometax-helper] 유휴 상태라 종료합니다 — 다음 발행 때 다시 깨어납니다.");
      await closeSession();
      // 🪤 판정과 종료 사이에 요청이 도착할 수 있다(`closeSession` 은 Chrome 을 정상
      // 종료하느라 시간이 걸린다). 그 창을 무시하고 나가면 **처리 중에 죽는다** — 이
      // 기능이 막으려던 바로 그 실패다. 도착했으면 종료를 취소하고 계속 산다(그 요청이
      // `getSession()` 으로 창을 다시 연다).
      if (activity.inFlight > 0) {
        closing = false;
        console.log("[hometax-helper] 종료 직전에 요청이 도착해 취소했습니다.");
        return;
      }
      clearInterval(timer);
      process.exit(0);
    })();
  }, IDLE_CHECK_INTERVAL_MS);
}

/**
 * 이미 다른 인스턴스가 그 포트를 잡고 있으면 **조용히 물러난다**(exit 0).
 *
 * 온디맨드 전환으로 기동 경로가 둘이 됐다 — 오너의 `npm run hometax:helper` 와 CRM
 * 클릭이 여는 URL 스킴. 둘이 겹치면 나중 프로세스가 `EADDRINUSE` 로 죽는데, 그것을
 * 오류로 요란하게 보고하면 **멀쩡한 상태(헬퍼는 이미 떠 있다)를 사고로 오독**하게
 * 된다. 다른 오류는 그대로 드러낸다(P0 — 실패를 삼키지 않는다).
 */
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.log(`[hometax-helper] 이미 ${BIND_HOST}:${PORT} 에서 다른 인스턴스가 돌고 있습니다 — 종료합니다.`);
    process.exit(0);
  }
  console.error("[hometax-helper]", err.message);
  process.exit(1);
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`[hometax-helper] http://${BIND_HOST}:${PORT} — 발급·서명은 사람이 합니다.`);
  console.log(`[hometax-helper] 셀렉터 맵: ${SELECTOR_MAP_PATH}`);
  startIdleWatchdog();

  // 기동과 동시에 홈택스 창을 연다 — **손으로 켰을 때만.**
  //
  // ⛔ 예전에는 첫 요청이 올 때까지 창을 열지 않았다 — 그런데 이 도구의 첫 작업은
  // **오너가 그 창에서 로그인하는 것**이라(셀렉터 실측·발급 모두 로그인이 전제),
  // 창이 없으면 오너는 "켰는데 아무 일도 안 일어난다"에서 멈춘다(2026-08-05 실제
  // 발생 — 안내와 동작이 어긋나 오너가 진행하지 못했다). 그래서 `npm run
  // hometax:helper` 로 켤 때는 기동 = 창 열기다.
  //
  // 🪤 그런데 **데몬으로 항상 띄우면 그 규칙이 해가 된다**(2026-08-06 오너 지시로
  // LaunchAgent 도입) — 로그인할 때마다 홈택스 창이 튀어나온다. 데몬 모드에서는
  // 창을 열지 않고 **첫 발행 요청 때** 연다. 오너 체감은 「발행을 누르면 창이 뜨고
  // 채워진다」가 되고, 그게 원래 의도한 흐름이다.
  if (IS_DAEMON) {
    console.log("[hometax-helper] 데몬 모드 — 창은 첫 발행 요청 때 엽니다.");
    return;
  }

  // 실패해도 서버는 계속 산다 — 창은 첫 요청 때 `getSession()` 이 다시 시도한다.
  void (async () => {
    try {
      const { page, usedBundledChromium } = await getSession();
      await ensureHometaxOpen(page);
      console.log("[hometax-helper] 홈택스 창을 열었습니다 — 이 창에서 로그인하세요.");
      if (usedBundledChromium) {
        console.log(
          "[hometax-helper] ⚠ 실제 Chrome 을 찾지 못해 번들 Chromium 으로 열었습니다 — 인증서·보안 모듈이 동작하지 않을 수 있습니다.",
        );
      }
    } catch (err) {
      console.error(
        `[hometax-helper] 창을 열지 못했습니다(${err instanceof Error ? err.message : String(err)}) — 요청이 오면 다시 시도합니다.`,
      );
    }
  })();
});
