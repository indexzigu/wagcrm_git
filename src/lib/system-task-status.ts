import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { verifyCronAuth } from "@/lib/cron-auth";

// 시스템 레이더(SystemTaskStatus) 공용 기록기 — 크론 라우트 핸들러를 감싸
// 실행 결과(성공/실패)와 실제 작동 시각을 남긴다. enrich-inbox처럼 라우트가
// 자체적으로 더 풍부한 상태(nextExpectedRunAt, SystemTaskLog)를 기록하면 이
// 래퍼를 쓰지 않는다.

type TaskRunStatus = "SUCCESS" | "ERROR" | "RUNNING";

/**
 * 크론 핸들러가 응답 본문으로 선언하는 실행 결과 계약.
 *
 * ⚠️ **HTTP 200 = 성공이 아니다.** 수집·동기화 크론은 대상 전량이 실패해도 "요청은
 * 처리했다"는 의미로 200을 반환한다(실제 사고: `capture-stories` 가 11일간 전량 실패
 * 하면서 매일 SUCCESS 로 기록됐다 — 2026-07-23). 그런 실질 실패는 **도메인 지식을 가진
 * 핸들러만** 판정할 수 있으므로(래퍼는 "산출 0"이 장애인지 대상 부재인지 모른다),
 * 핸들러가 `failed: true` 로 선언하면 래퍼가 ERROR 로 기록한다.
 *
 * 주의: 개별 항목 실패(`errors[]`)를 곧바로 ERROR 로 승격하지 않는다 — 썸네일 1건
 * 실패 같은 상시 노이즈까지 빨강이 되면 습관화로 신호를 잃는다. 승격 판단은 핸들러가
 * "이번 실행이 통째로 헛돌았는가"를 기준으로 내린다.
 */
type CronOutcomeBody = {
  /** true면 HTTP 200이라도 실행 실패로 기록한다(핸들러의 실질 실패 선언). */
  failed?: boolean;
  /** `failed` 일 때 상태판에 표시할 사유. 없으면 기본 문구. */
  failureReason?: string;
  /** 비정상 응답(4xx·5xx) 본문의 오류 메시지. */
  error?: string;
};

/** `SystemTaskLog.details` 직렬화 상한 — 이력 테이블이 페이로드로 비대해지지 않게 한다. */
const DETAILS_MAX_CHARS = 4_000;

/** 줄인 배열에 최소한 남길 항목 수 — 한 건도 없으면 "무엇이 실패했나"를 아예 못 읽는다. */
const MIN_KEPT_ITEMS = 1;

/** 줄인 문자열에 최소한 남길 길이 — 실패 계열(차단·타임아웃·모양 변경)을 가릴 만큼은 남긴다. */
const MIN_KEPT_CHARS = 200;

/**
 * 저장부가 페이로드를 줄였다는 표시.
 *
 * ⚠️ 이름을 `truncated` 로 두지 않는다 — 잡이 자기 뜻으로 그 이름을 이미 쓸 수 있고
 * (`scan.truncated` 등), 그러면 저장부가 남의 값을 조용히 덮어쓴다.
 */
const TRIMMED_MARKER = "detailsTrimmed";

/**
 * 이 잡들의 화면은 이 짝 필드로 "다 못 보여준다"를 판단한다. 저장부가 목록을 깎았는데
 * 이 표시를 안 세우면 **부분 목록이 전부인 것처럼** 보인다 — `system-task-needs-review.ts`
 * 가 애초에 막으려던 오해가 그것이다.
 */
const CAPPED_FLAG_OF: Record<string, string> = {
  needsReviewDetail: "needsReviewDetailCapped",
};

/**
 * 마지막까지 지키는 요약 필드 — 판정의 근거라 다른 무엇을 다 줄인 뒤에야 손댄다.
 * (그마저도 줄이면 표시를 남기므로 조용히 사라지지는 않는다.)
 */
const SUMMARY_KEYS = new Set(["ok", "failed", "failureReason", "error", "message", "lane"]);

/**
 * 표시(`detailsTrimmed`)가 쓸 수 있는 몫. 줄이는 동안은 이만큼을 미리 떼어 두고, 다 줄인
 * 뒤에 표시를 붙인다.
 *
 * ⚠️ 종전엔 후보마다 자리를 예약했는데, 그러면 **표시 맵이 후보 수만큼 자라** 스스로
 * 예산을 먹었다(실측: 중첩 200그룹에서 표시만 3.1k자, 총 12,920자). 예약을 없애고 몫을
 * 통째로 떼는 편이 단순하고, 아래 항목 수 상한이 그 몫을 실제로 지킨다.
 */
const MARKER_BUDGET_CHARS = 400;

/** 표시에 적을 최대 항목 수 — 그 이상은 개수로 합친다(표시가 예산을 넘지 않게). */
const MAX_TRIMMED_ENTRIES = 12;

/**
 * 진단 배열 — 사고의 "왜"가 여기 담긴다. 다른 곳을 다 줄이고도 모자랄 때 손댄다.
 *
 * ⚠️ 크기순으로만 줄이면 **가장 값진 것을 먼저 잃는다.** 합성 페이로드로 재현한 결과, 대상
 * 전량 실패 회차에서 `errors` 가 몇 건까지 깎이는 동안 진단 가치가 없는 대상 이름 목록(그
 * 이름은 각 `errors` 문자열 안에 이미 있다)이 전량 살아남아 예산의 대부분을 점유했다.
 * (수치는 합성 입력 기준이다 — 프로덕션 실측이 아니다.)
 */
const DIAGNOSTIC_KEYS = new Set(["errors", "failures"]);

/**
 * 짝 표시가 걸린 목록 — 최후 수단이 비우지 않는 자리다(`CAPPED_FLAG_OF` 파생).
 *
 * ⚠️ 순위에서도 같이 지킨다. 최후 수단만 지키고 주 루프가 안 지키면, 아래 하한 포기가
 * 이 목록을 통째로 비워 **같은 함수의 두 곳이 서로 다른 것을 보호**하게 된다(화면이
 * 300건을 "없음"으로 그린 그 사고를 다른 문으로 되사는 셈이다).
 */
const PAIRED_LIST_KEYS = new Set(Object.keys(CAPPED_FLAG_OF));

/** 줄이기 반복 상한 — 한 번에 한 자리씩 줄이므로 무한 반복을 막는 안전장치다. */
const MAX_TRIM_ROUNDS = 40;

/** 줄일 수 있는 자리 하나. */
type Shrinkable = {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  path: string;
  rank: number;
};

function readAt(s: Shrinkable): unknown {
  return (s.parent as Record<string | number, unknown>)[s.key];
}
function writeAt(s: Shrinkable, value: unknown): void {
  (s.parent as Record<string | number, unknown>)[s.key] = value;
}

/**
 * 이 자리의 순위. 뒤로 미룰수록 큰 순위 — 요약(2) > 진단·짝목록(1) > 나머지(0).
 *
 * ⚠️ 요약 순위는 **최상위에서만** 준다. 중첩된 `error`·`message` 는 요약이 아니라 진단
 * 내용 자체다 — 그것에 요약 자격을 주면 상위 진단 배열이 먼저 깎인다.
 * ⚠️ 그 외에는 **부모 순위를 물려받는다.** 이름만으로 매기면 `errors[0]` 같은 진단
 * **내용물**이 순위 0 이 되어, 아래 「하한 포기」가 지켜야 할 것을 지우는 문이 된다.
 *
 * ⚠️ **여기서는 이름만 본다 — `holdsDiagnostic` 의 값 종류 검사를 옮겨오지 말 것.**
 * 두 함수가 묻는 것이 다르다: 저쪽은 "지킬 진단 **내용**이 안에 있는가"(그래서 배열이어야
 * 한다)이고, 이쪽은 "이 자리가 진단으로 **불리는가**"다. 긴 `errors: "…"` 문자열은 이름이
 * 곧 내용이라, 여기에 `Array.isArray` 를 걸면 진짜 진단 문자열이 순위 0 으로 떨어진다.
 * (최후 수단의 `protectedKeys` 도 같은 이유로 이름만 본다.)
 */
function rankOf(key: string, prefix: string, parentRank: number): number {
  if (!prefix && SUMMARY_KEYS.has(key)) return 2;
  if (DIAGNOSTIC_KEYS.has(key)) return 1;
  if (!prefix && PAIRED_LIST_KEYS.has(key)) return 1;
  return parentRank;
}

/**
 * 이 문자열을 후보로 셀지 — 남길 하한보다 길어야 줄일 여지가 있다.
 *
 * `lowRankStringFloor` 는 **순위 0 에만** 적용된다. 주 루프는 언제나 `MIN_KEPT_CHARS`
 * 를 넘기므로 하한까지 깎인 문자열은 후보에서 빠지고, **아래 일괄 포기만** 0 을 넘겨
 * 그것들까지 훑는다(안 그러면 포기를 선언해도 손댈 자리가 없다).
 * ⛔ 주 루프에서 0 을 쓰지 말 것 — 두어 글자짜리 문자열이 전부 후보가 되어 회차 예산을
 * 먹는다(아래 주 루프의 같은 경고).
 */
function isShrinkableString(value: unknown, rank: number, lowRankStringFloor: number): boolean {
  return typeof value === "string" && value.length > (rank === 0 ? lowRankStringFloor : MIN_KEPT_CHARS);
}

/**
 * 페이로드를 훑어 줄일 수 있는 자리(배열·긴 문자열)를 모은다. 깊이·배열 안쪽 모두 센다.
 *
 * ⚠️ 결과는 **한 번 줄일 때마다 버린다.** 배열을 줄이면 새 배열이 생겨 그 안쪽 자리들의
 * 부모 참조가 끊기기 때문이다(끊긴 자리에 써 봐야 결과에 반영되지 않는다 — 실측).
 */
function collectShrinkables(
  node: unknown,
  prefix: string,
  found: Shrinkable[],
  lowRankStringFloor: number,
  parentRank = 0,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      const path = `${prefix}[${index}]`;
      if (Array.isArray(item) || isShrinkableString(item, parentRank, lowRankStringFloor)) {
        found.push({ parent: node, key: index, path, rank: parentRank });
      }
      collectShrinkables(item, path, found, lowRankStringFloor, parentRank);
    });
    return;
  }
  if (node == null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const rank = rankOf(key, prefix, parentRank);
    if (Array.isArray(value) || isShrinkableString(value, rank, lowRankStringFloor)) {
      found.push({ parent: obj, key, path, rank });
    }
    collectShrinkables(value, path, found, lowRankStringFloor, rank);
  }
}

/** 이 값 어딘가에 진단 배열이 들어 있는가 — 있으면 부모째 비우지 않는다. */
function holdsDiagnostic(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(holdsDiagnostic);
  if (node == null || typeof node !== "object") return false;
  return Object.entries(node as Record<string, unknown>).some(
    // ⚠️ 이름만 보지 않는다 — 잡이 `errors: 3` 처럼 **집계 수치**에 같은 이름을 쓰면,
    // 지킬 진단 내용이 하나도 없는 부모가 보호 순위를 얻어 뒤로 밀리고 정작 진단 배열을
    // 품은 쪽이 먼저 비워진다. 지키는 대상은 이름이 아니라 **배열**이다.
    ([key, value]) => (DIAGNOSTIC_KEYS.has(key) && Array.isArray(value)) || holdsDiagnostic(value),
  );
}

/**
 * 표시를 얹을 빈 자리를 찾는다 — 잡이 이미 그 이름을 쓰고 있으면 접미를 늘린다.
 * (후보를 하나만 두면 그것마저 쓰일 때 남의 값을 지운다 — 리뷰 실측.)
 */
function freeMarkerKey(out: Record<string, unknown>): string {
  let key = TRIMMED_MARKER;
  for (let n = 2; key in out; n += 1) key = `${TRIMMED_MARKER}${n}`;
  return key;
}

/**
 * 이력에 남길 페이로드를 **줄일 수 있는 만큼 값어치 순으로** 줄인다(순수 함수 — DB 없이
 * 검증 가능).
 *
 * ⚠️ **문자열을 통째로 자르지 않는다.** 종전 구현은 직렬화 결과를 상한 자리에서 싹둑
 * 잘랐는데, 그러면 ①남은 조각이 JSON 중간에서 끊겨 기계로 못 읽고 ②뒤쪽 **요약 필드
 * (실패 여부·사유·집계)가 통째로 사라진다** — 판정할 때 가장 먼저 보는 값들이다.
 *
 * 한 번에 **한 자리씩** 줄이고 그때마다 후보를 다시 모은다. 줄이는 순서는 진단 가치가
 * 낮은 것부터다: 나머지 → 진단 배열 → 요약. 같은 순위 안에서는 덩치 큰 것부터.
 *
 * ⚠️ **상한을 언제나 지킨다고 약속하지 않는다.** 값을 줄여서는 못 줄이는 모양이 있다 —
 * 요약 스칼라만으로 초과하거나, 남은 덩치가 키 이름 자체인 경우다. 그때는 줄이지 않고
 * **넘쳤다는 사실과 실제 크기를 표시로 남긴다**(조용한 초과는 만들지 않는다).
 * 실제 잡이 내는 모양은 전부 상한 안에 든다.
 */
export function capDetailsForLog(details: unknown): unknown {
  if (details == null || typeof details !== "object" || Array.isArray(details)) return details;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(details);
  } catch {
    return null; // 순환 참조 등 — 이력에 남길 수 없다(상태 기록 자체는 막지 않는다)
  }
  if (serialized == null) return null;
  if (serialized.length <= DETAILS_MAX_CHARS) return details;

  const size = (value: unknown) => JSON.stringify(value)?.length ?? 0;
  // 원본을 건드리지 않도록 사본에서 작업한다(호출자가 같은 객체를 계속 쓴다).
  const out = JSON.parse(serialized) as Record<string, unknown>;
  // 표시가 쓸 몫을 미리 떼어 둔다 — 다 줄인 뒤 표시를 붙이다가 다시 넘기지 않도록.
  const workingCap = DETAILS_MAX_CHARS - MARKER_BUDGET_CHARS;
  const trimmed: Record<string, number> = {};
  // ⚠️ 문자 수와 항목 수를 **한 자리에 합치지 않는다.** 합쳐 놓고 이름을 "항목"이라 붙이면
  // 9,000자 손실을 9,000건으로 발표하게 된다 — 이 파일이 다른 곳에서 규탄하는 바로 그
  // 잘못("숫자가 틀리면 없는 것보다 나쁘다")을 표시 자신이 저지르는 셈이다.
  const overflow = { items: 0, chars: 0 };
  const note = (path: string, amount: number, unit: "items" | "chars") => {
    // ⚠️ 같은 자리를 여러 회차에 걸쳐 줄이므로 **누적**한다. 덮어쓰면 마지막 회차 몫만 남아
    // 실제 손실을 크게 축소해 알린다(실측: 149건을 잃고 1건이라 적었다). 표시가 있으되
    // 숫자가 틀리면 없는 것보다 나쁘다 — 읽는 사람이 거의 다 남았다고 믿는다.
    if (path in trimmed) {
      trimmed[path] = (trimmed[path] ?? 0) + amount;
    } else if (Object.keys(trimmed).length < MAX_TRIMMED_ENTRIES) {
      trimmed[path] = amount;
    } else {
      // 표시 자리가 다 찼다 — 경로는 못 적어도 **잃은 양은 합쳐서** 알린다. 종전엔 경로 수만
      // 세어, 13건이 사라져도 표시에 아무 숫자도 안 남았다(실측).
      overflow[unit] += amount;
    }
    // 화면이 "일부만"을 판단하는 짝 표시를 함께 세운다 — 깎인 자리가 그 목록 **안쪽**이어도.
    for (const [listKey, flag] of Object.entries(CAPPED_FLAG_OF)) {
      if (path === listKey || path.startsWith(`${listKey}[`) || path.startsWith(`${listKey}.`)) {
        out[flag] = true;
      }
    }
  };

  // 줄여 봐야 진전이 없던 자리 — 다시 고르지 않는다(같은 자리를 붙잡고 맴돌지 않게).
  const exhausted = new Set<string>();

  /**
   * 값 낮은 자리(순위 0)의 최소 보존량을 포기했는가.
   *
   * ⚠️ **순위는 하한보다 위다.** 하한은 자리마다 주는 약속인데 예산은 전체가 하나라,
   * 값 낮은 자리가 여럿이면 그 하한들의 **합**이 예산을 먼저 먹고 적자는 순위 높은
   * 진단 배열이 혼자 떠안는다(합성 재현: 사유 40건이 1건까지 깎이는 동안 값 낮은
   * 문자열들은 저마다 하한만큼 온전히 살아남았다). 그래서 순위 높은 자리를 깎으러
   * 가기 **전에** 값 낮은 자리의 하한을 먼저 내놓는다.
   * ⚠️ 포기는 **한 번뿐이고 순위 0 에만** 적용한다 — 진단·짝목록(1)·요약(2)의 하한까지
   * 풀면 "무엇이 실패했나를 한 건은 읽게 한다"는 보장이 사라진다. 다 내놓고도 모자라면
   * 그때는 진짜 적자이므로 종전대로 순위 순서를 따라 깎는다.
   */
  let lowRankFloorsRelaxed = false;

  for (let round = 0; round < MAX_TRIM_ROUNDS && size(out) > workingCap; round += 1) {
    const candidates: Shrinkable[] = [];
    // ⚠️ **주 루프의 문자열 문턱은 언제나 `MIN_KEPT_CHARS` 다 — 포기했다고 0 으로 낮추지
    // 말 것.** 낮추면 `값1` 같은 **두어 글자짜리 문자열까지 전부 후보**가 되고, 순위 0 이라
    // 정렬에서 맨 앞에 선다. 자리마다 한 회차씩 먹으므로 잡다한 필드가 수십 개만 있어도
    // 회차 예산이 거기서 끝나고, 정작 순위 높은 자리는 큰 채로 남아 **종전 구현에서는
    // 상한 안에 들던 페이로드가 넘친다**(합성 표본 400개 차분 실측 12건, 예: 3,767자 →
    // 6,799자). 하한 아래 문자열은 **아래 일괄 포기가 이미 처리했다** — 여기서 다시
    // 훑을 이유가 없다.
    collectShrinkables(out, "", candidates, MIN_KEPT_CHARS);
    candidates.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : size(readAt(b)) - size(readAt(a))));
    // ⚠️ **이미 하한에 닿은 자리를 고르지 않는다.** 종전엔 그런 자리도 한 번 골라 보고
    // "진전 없음"을 확인한 뒤에야 소진 처리했는데, 그 확인에 **자리마다 회차 하나**가
    // 든다. 잡다한 배열이 열 개만 있어도 회차 예산의 4분의 1이 아무것도 못 줄이고
    // 사라지고, 그만큼 순위 높은 자리에 닿기 전에 예산이 끝난다(실측 트레이스: 배열
    // 11개가 회차 10개를 그렇게 태웠다). 줄일 수 있는지는 값만 보면 바로 안다.
    const canShrink = (c: Shrinkable) => {
      const value = readAt(c);
      const relaxedHere = lowRankFloorsRelaxed && c.rank === 0;
      if (Array.isArray(value)) return value.length > (relaxedHere ? 0 : MIN_KEPT_ITEMS);
      return typeof value === "string" && value.length > (relaxedHere ? 0 : MIN_KEPT_CHARS);
    };
    let target = candidates.find((c) => !exhausted.has(c.path) && canShrink(c));
    if (!target) break;

    // ⚠️ **회차가 바닥나기 전에도 반드시 한 번은 내놓는다.** 순위 상승은 "값 낮은 쪽을
    // 다 훑었다"는 신호일 뿐인데, 값 낮은 문자열이 회차 수보다 많으면 **하한까지 깎는
    // 데만 예산이 다 들어가 그 신호가 영영 오지 않는다**(자리마다 한 회차씩 쓴다).
    // 실측: 하한보다 긴 문구가 `MAX_TRIM_ROUNDS` 개를 넘으면 이 분기가 발동조차 못 해
    // 사유가 1건까지 깎인 채 상한도 못 맞췄다 — 티켓이 든 바로 그 모양이다.
    // 회차 소진도 순위 상승과 같은 신호로 본다.
    const lastRound = round === MAX_TRIM_ROUNDS - 1;
    if (!lowRankFloorsRelaxed && (target.rank > 0 || lastRound)) {
      // 순위 높은 자리로 넘어가려는 참이다 — 그 전에 값 낮은 자리의 하한을 내놓는다.
      //
      // ⚠️ **"값 낮은 후보가 남아 있으면"으로 조건을 달지 말 것** — 하한까지 이미 깎인
      // (또는 애초에 하한보다 짧은) 문자열은 **평시 문턱에서 후보로 보이지도 않는다.**
      // 그것들이 정확히 예산을 붙들고 있는 자리인데 보이는 후보로 조건을 걸면 이 분기가
      // 영영 발동하지 않는다(초판이 그랬다 — 사유 40건 중 1건만 남는 모양 그대로였다).
      //
      // ⚠️ **포기는 한 회차에 몰아서 한다.** 한 자리씩 돌면 회차 예산이 자잘한 문자열에
      // 다 소진돼 정작 순위 높은 자리는 손도 못 댄 채 최후 수단으로 넘어간다(실측: 4자
      // 짜리 문자열 300개가 40회차를 전부 먹고, 최후 수단이 진단 배열을 품은 부모를
      // 비웠다 — 고치려던 것을 고치는 과정에서 되사는 셈이다).
      // 문자열과 배열을 **따로** 훑는 것도 계약이다 — 배열을 줄이면 새 배열이 생겨 이
      // 목록에 담긴 다른 자리의 부모 참조가 끊기므로, 문자열을 다 훑은 **뒤에** 배열을
      // 손대고 배열 쪽은 자기 목록을 따로 모은다.
      lowRankFloorsRelaxed = true;
      const lowRankSites: Shrinkable[] = [];
      collectShrinkables(out, "", lowRankSites, 0);
      // 🪤 비교자 안에서 `size()` 를 부르지 말 것 — 정렬은 비교를 O(n log n) 번 하는데
      // 그때마다 **페이로드 전체를 다시 직렬화**한다. 길이를 미리 재서 그 수로 정렬한다.
      const lowRankStrings = lowRankSites
        .filter((c) => c.rank === 0 && typeof readAt(c) === "string")
        .map((c) => ({ site: c, len: (readAt(c) as string).length }))
        .sort((a, b) => b.len - a.len)
        .map((x) => x.site);
      for (const site of lowRankStrings) {
        if (size(out) <= workingCap) break;
        const original = readAt(site) as string;
        const kept = Math.max(0, original.length - (size(out) - workingCap));
        if (kept < original.length) {
          writeAt(site, original.slice(0, kept));
          note(site.path, original.length - kept, "chars");
        }
      }
      // 값 낮은 **배열**의 개수 하한도 같은 자리에서 내놓는다.
      // ⚠️ **이것을 주 루프에 맡기지 말 것(= `exhausted` 를 비워 다시 태우지 말 것).**
      // 배열 하나를 비우는 데 회차 하나가 드는데, 잡다한 배열은 열 개 스무 개씩 있고
      // 한 번 비워 봐야 십수 자밖에 안 준다. 실측(합성 seed): 배열 11개를 되돌렸더니
      // **회차 40개 중 22개**를 거기서 태우고 154자를 벌었으며, 정작 요약·진단은 손도
      // 못 댄 채 예산이 끝나 **베이스에서는 상한 안에 들던 페이로드가 넘쳤다**(400개
      // 표본 중 12건). 회차를 쓰지 않는 이 자리에서 한 번에 비운다.
      // 배열을 비우면 그 안쪽 자리의 부모 참조가 끊기므로 **매번 다시 모아** 고른다
      // (끊긴 자리에 써 봐야 결과에 반영되지 않는다 — 이 파일 위쪽의 같은 경고).
      // ⚠️ 넘칠 때만 모으고 정렬한다 — 문자열만으로 이미 상한 안에 들었으면 이 아래는
      // 통째로 헛일이고, 정렬 자체가 싸지 않다(위 🪤).
      const lowRankArrays: Shrinkable[] = [];
      if (size(out) > workingCap) {
        const arraySites: Shrinkable[] = [];
        collectShrinkables(out, "", arraySites, MIN_KEPT_CHARS);
        lowRankArrays.push(
          ...arraySites
            .filter((c) => c.rank === 0 && Array.isArray(readAt(c)))
            .map((c) => ({ site: c, bulk: size(readAt(c)) }))
            .sort((a, b) => b.bulk - a.bulk)
            .map((x) => x.site),
        );
      }
      // 🪤 큰 것부터 비우므로 **바깥 배열을 먼저 비우면 그 안쪽 자리는 떨어져 나간다.**
      // ⚠️ 떨어진 자리를 값 재확인으로 거를 수 없다 — 참조가 같은 (낡은) 부모를 거치므로
      // **언제나 살아 있는 것처럼 보인다.** 그대로 두면 쓰기는 결과에 반영되지 않으면서
      // 표시에만 숫자가 남아, 바깥을 비울 때 이미 센 항목을 **이 회차에서 한 번 더
      // 센다.** 그래서 비운 **경로 아래**는 건너뛴다.
      // ℹ️ 앞선 회차가 안쪽을 줄이며 남긴 숫자까지 지우지는 못한다(그때는 실제 손실이
      // 맞았고, 그 누적 보고는 베이스도 같다) — 여기서 막는 것은 **같은 회차의 중복**이다.
      const emptiedPaths: string[] = [];
      for (const site of lowRankArrays) {
        if (size(out) <= workingCap) break;
        if (emptiedPaths.some((prefix) => site.path.startsWith(prefix))) continue;
        const held = readAt(site);
        if (!Array.isArray(held) || held.length === 0) continue;
        writeAt(site, []);
        // ⛔ **앞선 회차가 안쪽에 남긴 기록을 지우지 말 것.** 결과에 없는 경로를 가리켜
        // 어색해 보이지만, 그 손실은 **실제로 일어났다**(주 루프가 안쪽을 줄일 때 그
        // 자리는 살아 있었다). 지우면 총 손실이 실제보다 작게 보고된다 — 이 파일이
        // 「149건을 잃고 1건이라 적었다」로 규탄하는 축소 보고를 되사는 셈이다.
        // 실측: 안쪽에서 4,009자를 잃은 기록이 통째로 사라졌다.
        // 막아야 하는 것은 **같은 회차의 중복 계수**뿐이고, 그건 위 `emptiedPaths` 가
        // 이미 막는다(떨어져 나간 자리를 다시 세지 않는다).
        note(site.path, held.length, "items");
        emptiedPaths.push(`${site.path}[`, `${site.path}.`);
      }

      // ⚠️ **이 회차를 버리지 않는다 — 같은 회차에서 다시 고른다.** 종전엔 여기서
      // `continue` 했는데, 내놓을 문자열이 없는 모양(순위 0 문자열이 아예 없고 순위 1
      // 후보만 남은 경우)에서는 **아무것도 바꾸지 않은 채 회차만 태웠다.** 그 한 회차가
      // 모자라 순위 높은 배열을 한 번 덜 줄이게 되어, **종전 구현에서는 상한 안에 들던
      // 페이로드가 넘쳤다**(합성 표본 400개 차분 실측: 12건이 그렇게 회귀했다).
      // ⛔ 대신 그냥 아래로 흘려보내지도 말 것 — 방금 하한이 풀려 **더 값싼 자리가
      // 생겼을 수 있는데** relax 이전에 고른 순위 높은 target 을 그대로 깎으면 순위가
      // 뒤집힌다. 반드시 낮춘 문턱으로 **다시 모아 다시 고른다.**
      if (size(out) <= workingCap) break;
      const relaxedCandidates: Shrinkable[] = [];
      collectShrinkables(out, "", relaxedCandidates, MIN_KEPT_CHARS);
      relaxedCandidates.sort((a, b) =>
        a.rank !== b.rank ? a.rank - b.rank : size(readAt(b)) - size(readAt(a)),
      );
      const next = relaxedCandidates.find((c) => !exhausted.has(c.path) && canShrink(c));
      if (!next) break;
      target = next;
    }

    // ⚠️ **컨테이너는 자기 내용물보다 언제나 크다 — 크기순만 쓰면 원소가 영영 안 걸린다.**
    // 순위를 부모에서 물려받게 한 뒤로 `errors` 와 `errors[0]` 이 같은 순위가 되는데,
    // 배열 크기 = 원소들의 합이라 정렬은 **항상 배열을 먼저** 집는다. 그러면 거대한 원소
    // 하나 때문에 배열이 깎여 **멀쩡한 짧은 진단이 통째로 사라지고**(실측:
    // `["거대한 사유…", "네트워크 끊김", "인증 만료"]` 에서 뒤 둘이 없어졌다) 정작 덩치는
    // 그 원소에 남아 있어 크기도 거의 안 준다.
    // 그래서 **덩치의 대부분이 원소 하나에 몰려 있을 때만** 그 원소로 겨냥을 옮긴다.
    // ⛔ 깊이를 무조건 우선하는 규칙으로 바꾸지 말 것 — 얕고 큰 배열 하나보다 깊고 작은
    // 후보가 수십 개인 모양(확인필요 목록의 `reasons` 60개)에서 회차 예산이 그 수십 개에
    // 다 소진돼 배열은 손도 못 댄다(실측: 계약 2건이 그렇게 깨졌다).
    // ⚠️ 한 갈래로 **끝까지 내려간다.** 덩치가 원소 하나에 몰려 있어도 그 원소가 또
    // 배열이면(항목 1개짜리 배열 등) 거기서 멈춰선 안 된다 — 그 원소는 하한에 잠겨
    // 못 줄이므로 겨냥이 도로 바깥 배열로 돌아가고, 결국 **배열을 깎아 짧은 진단을
    // 버린다**(실측: `errors: [[거대한 문자열], "네트워크 끊김", "인증 만료"]` 에서
    // 베이스는 3건을 지키는데 뒤 둘이 사라졌다). 줄일 수 있는 가장 깊은 자리를 잡는다.
    let probe: Shrinkable | undefined = target;
    while (probe) {
      const held = readAt(probe);
      if (!Array.isArray(held)) break;
      const inner: Shrinkable | undefined = candidates.find(
        (c) => c !== probe && c.parent === held && size(readAt(c)) * 2 > size(held),
      );
      if (!inner) break;
      if (canShrink(inner)) target = inner;
      probe = inner;
    }

    // ℹ️ 주 루프는 하한을 그대로 지킨다. 값 낮은 자리의 하한 포기는 **위 일괄 처리가
    // 전부 끝낸다** — 종전엔 여기에도 `relaxed ? 0 : …` 분기를 뒀지만 합성 3,200 표본에서
    // 한 번도 발화하지 않았다(포기 뒤 순위 0 배열은 이미 비어 있고, 문자열은 위에서
    // 훑었으며, `canShrink` 가 하한에 닿은 자리를 애초에 거른다). 안 도는 갈래를 남기면
    // 다음 사람이 그 갈래가 뭔가를 지키는 줄로 읽는다.
    const keepItems = MIN_KEPT_ITEMS;
    const keepChars = MIN_KEPT_CHARS;
    const before = size(out);
    const value = readAt(target);

    if (Array.isArray(value)) {
      let low = keepItems;
      let high = value.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        writeAt(target, value.slice(0, mid));
        if (size(out) <= workingCap) low = mid;
        else high = mid - 1;
      }
      writeAt(target, value.slice(0, low));
      if (low < value.length) note(target.path, value.length - low, "items");
    } else {
      const original = value as string;
      const kept = Math.max(keepChars, original.length - (size(out) - workingCap));
      if (kept < original.length) {
        writeAt(target, original.slice(0, kept));
        note(target.path, original.length - kept, "chars");
      }
    }

    // ⚠️ 진전이 없다고 **멈추지 않는다.** 이 자리만 못 줄이는 것일 수 있다(항목 하나뿐인
    // 배열 안에 또 배열이 있는 모양이 그렇다 — 실측으로 겪었다). 이 자리만 빼고 계속한다.
    if (size(out) >= before) exhausted.add(target.path);
  }

  // 마지막 수단 — 줄일 자리를 다 써도 넘치면 **값이 낮은** 큰 필드를 비운다.
  //
  // ⚠️ 지켜야 할 것을 지운 적이 있다(리뷰 실측). 순위를 안 보고 지워 진단 배열이 전멸했고,
  // 확인필요 목록을 지워 화면이 300건을 "없음"으로 그렸다 — **고치기 전보다 나빴다.**
  // 그래서 요약·진단·짝 표시가 걸린 목록은 건드리지 않고, **타입도 유지**한다(배열은 빈
  // 배열로). 소비처가 `errors.map()` 처럼 쓰는데 문자열로 바꾸면 그 자리에서 터진다.
  const protectedKeys = new Set([...SUMMARY_KEYS, ...DIAGNOSTIC_KEYS, ...Object.keys(CAPPED_FLAG_OF)]);
  const emptiable = Object.keys(out)
    .filter((k) => !protectedKeys.has(k) && out[k] != null && typeof out[k] === "object")
    // ⚠️ 진단 배열이 **비보호 부모 아래**에 있으면 부모째 비워져 사라진다(실제로 그런 모양을
    // 내는 잡이 있다 — 수집 결과를 한 겹 감싼 뒤 그 안에 `errors` 를 둔다). 그렇다고 절대
    // 금지로 두면 그런 부모만 잔뜩인 페이로드에서 상한을 아예 못 맞춘다. 주 루프와 같이
    // **후순위**로 둔다 — 진단을 품지 않은 것부터 비우고, 모자랄 때만 그쪽으로 넘어간다.
    .sort((a, b) => {
      const da = holdsDiagnostic(out[a]) ? 1 : 0;
      const db = holdsDiagnostic(out[b]) ? 1 : 0;
      return da !== db ? da - db : size(out[b]) - size(out[a]);
    });
  for (const key of emptiable) {
    if (size(out) <= workingCap) break;
    const value = out[key];
    const dropped = Array.isArray(value) ? value.length : Object.keys(value as object).length;
    if (dropped === 0) continue;
    out[key] = Array.isArray(value) ? [] : {};
    note(key, dropped, "items");
  }

  if (overflow.items > 0) trimmed.andMoreItems = overflow.items;
  if (overflow.chars > 0) trimmed.andMoreChars = overflow.chars;

  if (Object.keys(trimmed).length > 0 || size(out) > DETAILS_MAX_CHARS) {
    out[freeMarkerKey(out)] = trimmed;
    // 여기까지 와서도 넘치면 이 함수가 다루지 못한 덩치가 남은 것이다(최소 보존분만으로 초과
    // 하거나, 남은 덩치가 키 이름 자체라 어떤 값 축소로도 못 줄이는 모양).
    // ⚠️ 표시를 **붙인 뒤에** 잰다. 붙이기 전에 재면 자기 무게가 빠져 실제보다 작게 적는다 —
    // 정직하려고 만든 유일한 필드가 축소 보고를 한다(리뷰 실측: 26,830 을 26,795 로).
    if (size(out) > DETAILS_MAX_CHARS) trimmed.overCap = size(out);
  }
  return out;
}

/**
 * 응답 본문을 이력에 남길 형태로 정규화한다. 파싱 불가(JSON 아님)면 null —
 * details 기록 실패가 상태 기록 자체를 막지 않는다.
 */
function toDetails(body: unknown): unknown {
  if (body == null || typeof body !== "object") return null;
  // 직렬화 불가(순환 참조 등)면 남기지 않는다 — details 기록 실패가 상태 기록을 막지 않는다.
  if (JSON.stringify(body) == null) return null;
  // ⚠️ 여기서 자르지 않는다. 상한은 `recordSystemTaskRun`(쓰는 지점)이 걸어 두 레인이
  // 같은 규칙을 따르게 한다 — 이 자리에만 두면 로컬 러너 레인이 통째로 빠진다.
  return body;
}

/** 크론 응답 본문을 안전하게 읽는다(비-JSON·본문 없음 모두 null). */
async function readOutcomeBody(response: Response): Promise<CronOutcomeBody | null> {
  try {
    const body = (await response.clone().json()) as unknown;
    return body != null && typeof body === "object" ? (body as CronOutcomeBody) : null;
  } catch {
    return null;
  }
}

/**
 * `details` 에 실행 소요시간을 얹는다. `durationMs` 는 항상 유한한 정수라 —
 * `DETAILS_MAX_CHARS` 상한이 막으려는 "핸들러가 임의로 큰 값을 돌려줘 이력 테이블이
 * 비대해지는" 위험을 재도입하지 않는다. 그래서 여기서는 크기를 재지 않고 그대로 얹는다 —
 * 상한은 이 결과를 받는 `capDetailsForLog` 가 건다(소요시간까지 포함해 총량이 보장된다).
 *
 * ⚠️ `details` 가 배열이면 병합하지 않고 `durationMs` 만 남긴다(배열 내용은 버려진다) —
 * 현재 크론 핸들러는 전부 `{ ok, ... }` 형태의 객체만 응답 본문으로 돌려주므로
 * 도달하지 않는 경로다. 배열 응답을 돌려주는 핸들러가 생기면 이 분기부터 손본다.
 */
function withDuration(details: unknown, durationMs: number | undefined): unknown {
  if (durationMs == null) return details;
  if (details != null && typeof details === "object" && !Array.isArray(details)) {
    return { ...(details as Record<string, unknown>), durationMs };
  }
  return { durationMs };
}

/**
 * 실행 결과를 레이더(SystemTaskStatus)와 이력(SystemTaskLog)에 남긴다.
 *
 * export 하는 이유: **로컬 레인 잡**(맥에서 도는 러너)은 HTTP 라우트를 거치지 않아
 * `withSystemTaskStatus` 를 탈 수 없다. 러너가 이 기록기를 직접 부르지 않으면 그 잡은
 * 레이더에서 영원히 눈이 먼다 — 방금 고친 무음 실패를 실행 위치만 바꿔 되사는 셈이다.
 */
export async function recordSystemTaskRun(
  jobKey: string,
  status: TaskRunStatus,
  // undefined면 기존 lastErrorMessage를 건드리지 않는다(RUNNING 시작 마커용)
  errorMessage: string | null | undefined,
  // 종결 상태의 실행 결과 페이로드 — 무음 실패를 사후에 추적할 유일한 단서다
  details?: unknown,
  // 핸들러 실행 소요시간(ms) — Vercel Hobby 플랜의 함수 실행 60초 제한 판단 근거(2026-08-06).
  // RUNNING 시작 마커에는 아직 알 수 없으므로 전달하지 않는다.
  durationMs?: number,
) {
  try {
    const prisma = getPrisma();
    await prisma.systemTaskStatus.upsert({
      where: { jobKey },
      create: { jobKey, status, lastRunAt: new Date(), lastErrorMessage: errorMessage ?? null },
      update: { status, lastRunAt: new Date(), lastErrorMessage: errorMessage },
    });
    // 종결 상태(SUCCESS/ERROR)는 실행 이력(SystemTaskLog)에도 append한다 — 시스템 레이더
    // 클릭 인박스가 "언제 무엇이 됐나"를 보여줄 소스다(오너 2026-07-13). RUNNING 시작
    // 마커는 append하지 않는다(완주 전 중간 상태라 이력 노이즈). enrich-inbox는 이 래퍼를
    // 쓰지 않고 자체적으로 더 풍부한 details 로그를 남기므로 이중 기록되지 않는다.
    if (status !== "RUNNING") {
      // 응답 본문 + durationMs를 함께 남긴다 — 이게 없으면 "SUCCESS인데 산출 0"의 원인을
      // 사후에 알 방법이 없다(11일 무음 실패 때 실제로 단서가 0이었다). durationMs는
      // 본문 형식(JSON 여부)과 무관하게 항상 남는다 — 계측이 응답 파싱에 얹혀가지 않는다.
      // ⚠️ 상한은 **여기서** 건다. 종전엔 `toDetails`(HTTP 응답 해석부)에만 있어서, 이
      // 함수를 직접 부르는 로컬 러너 레인은 상한을 아예 거치지 않았다 — 같은 잡인데
      // 레인에 따라 저장 규칙이 달랐다. 소요시간을 얹은 뒤에 재므로 총량이 보장된다.
      const mergedDetails = capDetailsForLog(withDuration(details, durationMs));
      await prisma.systemTaskLog.create({
        data: {
          jobKey,
          status,
          message: errorMessage ?? "정상 완료",
          details: mergedDetails == null ? undefined : (mergedDetails as Prisma.InputJsonValue),
        },
      });
    }
  } catch (error) {
    // 상태 기록 실패가 크론 본연의 작업까지 실패시키면 안 된다 — 로그로만 표면화
    console.error(`[SystemTaskStatus] ${jobKey} 상태 기록 실패:`, error);
  }
}

export function withSystemTaskStatus(
  jobKey: string,
  handler: (request: Request) => Promise<Response>,
) {
  return async (request: Request): Promise<Response> => {
    // 프리렌더 중에는 이 headers 접근 자체가 dynamic bailout 예외를 던져(기록 로직 도달 전)
    // 라우트가 동적으로 처리된다. bailout 예외를 ERROR로 오기록하던 문제의 근본 차단.
    const authHeader = request.headers.get("authorization");

    // Vercel 크론은 CRON_SECRET이 설정된 경우에만 Authorization: Bearer <CRON_SECRET>을
    // 보낸다. 시크릿까지 일치하는 진짜 크론 호출만 기록한다 — 빌드 프리렌더(헤더 없음)와
    // 무단·오설정 접근(핸들러가 401로 거절)이 상태를 오염시키지 않는다.
    //
    // 판정은 `@/lib/cron-auth` SSOT에 위임한다. 여기는 **인증 게이트가 아니라 기록 게이트**라
    // (불일치 시 거절이 아니라 기록만 건너뛰고 핸들러로 넘긴다) 종전에는 비교를 손으로 들고
    // 있었는데, 그 사본이 라우트 18개와 같은 부류의 드리프트 위험이었다(2026-08-05 정리에서
    // 소스 스캔이 잡아냈다). SSOT는 시크릿 미설정 시 false이므로 종전 `expected == null`
    // 분기와 의미가 같고, 비교가 상수 시간이 되는 이득만 추가된다.
    if (authHeader == null || !verifyCronAuth(request)) {
      return handler(request);
    }

    // 시작 마커 — 핸들러가 플랫폼 타임아웃/강제종료로 완주하지 못해도 RUNNING 행이 남아,
    // "호출 자체가 없었음"(행 없음)과 "호출됐지만 미완주"(RUNNING 고착)를 구분할 수 있다.
    await recordSystemTaskRun(jobKey, "RUNNING", undefined);

    // Vercel Hobby 플랜의 함수 실행 60초 제한이 실제 걸림돌인지 판단할 유일한 실측
    // 창구다(2026-08-06) — 마커 upsert 이후·핸들러 실행 전부터 재서 기록 자체의 지연은
    // 계측에 섞이지 않게 한다.
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await handler(request);
    } catch (error) {
      await recordSystemTaskRun(
        jobKey,
        "ERROR",
        error instanceof Error ? error.message : String(error),
        undefined,
        Date.now() - startedAt,
      );
      throw error;
    }

    const durationMs = Date.now() - startedAt;

    if (response.ok) {
      // 2xx여도 핸들러가 실질 실패를 선언했으면 ERROR다 — 이 분기가 없으면 "전량 실패
      // 했지만 요청은 처리됨"이 영원히 초록으로 남는다(CronOutcomeBody 주석의 실사고).
      const body = await readOutcomeBody(response);
      const details = toDetails(body);
      if (body?.failed === true) {
        await recordSystemTaskRun(
          jobKey,
          "ERROR",
          body.failureReason || "실행은 끝났으나 산출이 없습니다(핸들러 실패 선언).",
          details,
          durationMs,
        );
      } else {
        await recordSystemTaskRun(jobKey, "SUCCESS", null, details, durationMs);
      }
    } else {
      // 시크릿이 일치한 시점 이후의 비정상 응답(401 포함)은 전부 크론 실행 실패로 기록한다
      // — RUNNING 마커를 남긴 채 침묵하면 '실행 중' 고착으로 오독된다.
      const body = await readOutcomeBody(response);
      const message = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
      await recordSystemTaskRun(jobKey, "ERROR", message, toDetails(body), durationMs);
    }
    return response;
  };
}
