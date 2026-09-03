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

/** 줄일 수 있는 자리 하나 — 깊이에 상관없이 같은 줄에 세워 큰 것부터 처리한다. */
type Shrinkable = { parent: Record<string, unknown>; key: string; path: string; summary: boolean };

/** 페이로드 전체를 훑어 줄일 수 있는 자리를 모은다(배열·긴 문자열). 중첩도 같은 자격이다. */
function collectShrinkables(node: unknown, prefix: string, found: Shrinkable[]): void {
  if (node == null || typeof node !== "object" || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (key === TRIMMED_MARKER) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const summary = !prefix && SUMMARY_KEYS.has(key);
    if (Array.isArray(value)) {
      found.push({ parent: obj, key, path, summary });
      for (const [i, item] of value.entries()) collectShrinkables(item, `${path}[${i}]`, found);
    } else if (typeof value === "string" && value.length > MIN_KEPT_CHARS) {
      found.push({ parent: obj, key, path, summary });
    } else {
      collectShrinkables(value, path, found);
    }
  }
}

/**
 * 이력에 남길 페이로드를 상한 안으로 줄인다(순수 함수 — DB 없이 검증 가능).
 *
 * ⚠️ **문자열을 통째로 자르지 않는다.** 종전 구현은 직렬화 결과를 상한 자리에서 싹둑
 * 잘랐는데, 그러면 ①남은 조각이 JSON 중간에서 끊겨 기계로 못 읽고 ②뒤쪽 **요약 필드
 * (실패 여부·사유·집계)가 통째로 사라진다** — 판정할 때 가장 먼저 보는 값들이다.
 *
 * 줄일 수 있는 자리(배열·긴 문자열)를 **깊이에 상관없이 한 줄로 세워 큰 것부터** 줄인다.
 * 중첩 배열도 같은 자격이다 — 한 겹 아래에 있다는 이유로 통째로 버리면 필요 이상을 잃는다.
 * 요약 필드는 **맨 뒤로 미룬다**: 다른 것을 다 줄이고도 모자랄 때만 손댄다.
 *
 * ⚠️ **줄이지 못하는 모양이어도 조용히 넘기지 않는다.** 마지막에 그 사실을 표시로 남긴다.
 */
export function capDetailsForLog(details: unknown): unknown {
  if (details == null || typeof details !== "object" || Array.isArray(details)) return details;
  const size = (value: unknown) => JSON.stringify(value)?.length ?? 0;
  if (size(details) <= DETAILS_MAX_CHARS) return details;

  // 원본을 건드리지 않도록 깊은 사본에서 작업한다(호출자가 같은 객체를 계속 쓴다).
  const out = JSON.parse(JSON.stringify(details)) as Record<string, unknown>;
  const trimmed: Record<string, number> = {};
  // ⚠️ 표시를 **미리** 얹어 둔다. 다 줄인 뒤에 붙이면 그 표시의 무게 때문에 다시 상한을
  // 넘는다(실측: 4,007자). 같은 객체를 계속 채우므로 `size(out)` 이 늘 표시까지 센다.
  out[TRIMMED_MARKER] = trimmed;

  const candidates: Shrinkable[] = [];
  collectShrinkables(out, "", candidates);
  // 요약은 맨 뒤, 그 안에서는 덩치 큰 것부터.
  candidates.sort((a, b) => {
    if (a.summary !== b.summary) return a.summary ? 1 : -1;
    return size(b.parent[b.key]) - size(a.parent[a.key]);
  });

  for (const { parent, key, path } of candidates) {
    if (size(out) <= DETAILS_MAX_CHARS) break;
    const value = parent[key];
    // 표시에 들어갈 자리를 **줄이기 전에** 예약한다 — 줄인 뒤에 적으면 그 숫자의 무게로
    // 다시 상한을 넘는다(실측).
    trimmed[path] = Array.isArray(value) ? value.length : (value as string).length;

    if (Array.isArray(value)) {
      // 남길 개수는 이분 탐색으로 정한다 — 한 건씩 줄이며 매번 전체를 직렬화하면 항목이
      // 많을 때 크론 쓰기 경로를 초 단위로 붙잡는다.
      let low = MIN_KEPT_ITEMS;
      let high = value.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        parent[key] = value.slice(0, mid);
        if (size(out) <= DETAILS_MAX_CHARS) low = mid;
        else high = mid - 1;
      }
      parent[key] = value.slice(0, low);
      if (low < value.length) {
        trimmed[path] = value.length - low;
        const cappedFlag = CAPPED_FLAG_OF[key];
        if (cappedFlag) parent[cappedFlag] = true;
      } else {
        delete trimmed[path];
      }
      continue;
    }

    const original = value as string;
    const kept = Math.max(MIN_KEPT_CHARS, original.length - (size(out) - DETAILS_MAX_CHARS));
    if (kept >= original.length) {
      delete trimmed[path];
      continue;
    }
    parent[key] = original.slice(0, kept);
    trimmed[path] = original.length - kept;
  }

  // 여기까지 와서도 넘치면 줄일 수 있는 자리가 없다는 뜻이다(스칼라 요약만으로 초과).
  // 그건 줄여서는 안 된다 — 요약이 곧 판정 근거다. 넘쳤다는 사실만 남긴다.
  if (size(out) > DETAILS_MAX_CHARS) trimmed.overCap = size(out);
  // 아무것도 줄이지 않았으면 표시를 남기지 않는다(위에서 미리 얹어 둔 자리를 걷는다).
  if (Object.keys(trimmed).length === 0) delete out[TRIMMED_MARKER];
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
