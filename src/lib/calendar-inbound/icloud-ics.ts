// [캘린더수집] iCloud 공개 캘린더(webcal/ICS) 인바운드 수집 모듈.
// 행사 일정(events) 및 회계·정산 일정(finance) ICS 피드를 파싱·정규화하여
// 기존 구글 캘린더 인바운드 수집 파이프라인과 통합한다.
//
// ⚠️ 보안 및 안전 제약:
// 1. 이 레포는 PUBLIC 저장소이므로 실제 iCloud URL이나 토큰 문자열을 절대 하드코딩하지 않는다.
// 2. 에러 메시지나 콘솔 로그에 URL 원문이나 토큰이 노출되지 않도록 철저히 차단한다.
// 3. SSRF 방지를 위해 webcal:// 및 https:// 프로토콜만 허용하고, 사설망·루프백·인증정보를 차단한다.

import { toKstYmd } from "@/lib/date-utils";
import {
  CANDIDATE_LIST_REQUEST_TIMEOUT_MS,
  hasCrmDescriptionSignature,
  listAllDayCandidateEvents,
  type CandidateEvent,
  type CandidateListResult,
} from "@/lib/google-calendar-sync";
import { normalizeForCompare } from "@/lib/text-normalize";

export const ICLOUD_CALENDAR_PREFIX = "icloud:";
export const ICLOUD_EVENTS_CALENDAR_ID = "icloud:events";
export const ICLOUD_FINANCE_CALENDAR_ID = "icloud:finance";

/**
 * 캘린더 ID가 읽기 전용 인바운드 캘린더(iCloud 피드 등)인지 여부를 판별한다.
 * 읽기 전용 캘린더에서 온 이벤트는 기안 승인 시 CRM 장부 넘겨받기(adoptCalendarEventIntoLedger)를
 * 실행하지 않고 markInboundAdopted 로만 깔끔하게 처리된다.
 */
export function isReadOnlyInboundCalendar(calendarId: string): boolean {
  return calendarId.startsWith(ICLOUD_CALENDAR_PREFIX);
}

/**
 * 호스트가 사설 IPv4 대역(10/8, 172.16/12, 192.168/16), 루프백(127/8), 링크로컬(169.254/16), 미지정(0/8)인지 검사한다.
 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;

  const [a, b] = nums;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  return false;
}

/**
 * SSRF 방어를 위해 호스트가 로컬호스트, 사설망, 루프백, 링크로컬, 점 없는 단일 호스트인지 검사한다.
 */
function isBlockedHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  // 점 없는 단일 라벨 호스트명 (단, IPv6는 콜론 포함)
  if (!host.includes(".")) {
    if (!host.includes(":")) return true;
  }

  // IPv6 검사
  if (host.includes(":")) {
    if (
      host === "::1" ||
      host === "::" ||
      host === "0:0:0:0:0:0:0:1" ||
      host === "0:0:0:0:0:0:0:0"
    ) {
      return true;
    }
    if (
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb")
    ) {
      return true; // fe80::/10 link-local
    }
    if (host.startsWith("fc") || host.startsWith("fd")) {
      return true; // fc00::/7 unique local
    }
    if (host.startsWith("::ffff:") || host.startsWith("::ffff")) {
      return true;
    }
    return false;
  }

  // IPv4 검사
  return isPrivateIpv4(host);
}

/**
 * webcal:// 또는 https:// URL을 안전한 https:// URL 문자열로 정규화한다.
 * http://, file://, javascript:, 사설망/루프백/단일호스트/인증정보 포함 URL은 차단(null)한다.
 */
export function normalizeWebcalUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withHttps = trimmed.replace(/^webcal:\/\//i, "https://");
  try {
    const parsed = new URL(withHttps);
    if (parsed.protocol !== "https:") return null;
    if (!parsed.hostname || parsed.hostname.length === 0) return null;
    // 인증정보(user:pass) 차단
    if (parsed.username || parsed.password) return null;
    // 사설망 / 루프백 / 단일 호스트 차단
    if (isBlockedHost(parsed.hostname)) return null;

    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * RFC 5545 텍스트 언이스케이프 (\n, \N, \,, \;, \\ 복원)
 */
export function unescapeIcsText(text: string): string {
  return text.replace(/\\([nN,;\\])/g, (_, ch: string) => {
    if (ch === "n" || ch === "N") return "\n";
    return ch;
  });
}

/** YYYY-MM-DD 에 일수를 더하거나 뺀다 (UTC 문자열 산술). */
function shiftDateStr(dateStr: string, days: number): string {
  if (!dateStr) return dateStr;
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 8자리 YYYYMMDD 문자열을 검증하여 유효한 달력 날짜인 경우 YYYY-MM-DD 로 반환한다.
 * 20260231, 20269999 등 유효하지 않은 날짜는 null 을 반환한다.
 */
function parseIcsDate(raw: string): string | null {
  if (!/^\d{8}$/.test(raw)) return null;
  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(4, 6));
  const d = Number(raw.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) return null;
  const ymd = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (date.toISOString().slice(0, 10) !== ymd) return null;
  return ymd;
}

/**
 * 스캔 창 timeMin / timeMax 를 KST 날짜(YYYY-MM-DD)로 변환한다.
 * timeMax 가 ISO 문자열인 경우 구글 캘린더 배타 상한(timeMax) 계약에 맞춰 1ms 이전 시점을 KST 날짜로 변환한다.
 */
function resolveWindowBound(dateStr: string, isEnd: boolean): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr.slice(0, 10);
  if (isEnd) {
    return toKstYmd(new Date(d.getTime() - 1));
  }
  return toKstYmd(d);
}

export type ParseIcsOptions = {
  calendarId: string;
  feedKind: "events" | "finance";
  timeMin: string;
  timeMax: string;
};

/**
 * ICS 텍스트를 파싱하여 종일·비반복 후보 이벤트 목록(CandidateEvent[])으로 변환한다.
 * 구글 캘린더 listAllDayCandidateEvents 계약과 동일한 제외 조건을 적용한다:
 * - STATUS:CANCELLED 제외
 * - 반복 일정 (RRULE 또는 RECURRENCE-ID 존재) 제외
 * - 종일 일정이 아닌 시간 지정 이벤트 제외 (VALUE=DATE 지정 또는 8자리 YYYYMMDD 가 아닌 것)
 * - UID 누락 제외
 * - VEVENT 내부 서브컴포넌트(VALARM 등)의 속성이 VEVENT 를 덮어쓰지 않도록 무시
 * - 스캔 창(KST timeMin ~ timeMax)과 겹치지 않는 일정 제외
 */
export function parseIcsCandidateEvents(
  icsText: string,
  opts: ParseIcsOptions,
): CandidateEvent[] {
  // RFC 5545 §3.1 라인 언폴딩: CRLF 또는 LF 바로 뒤 공백/탭 문자 제거
  const unfolded = icsText.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  const windowStart = resolveWindowBound(opts.timeMin, false);
  const windowEnd = resolveWindowBound(opts.timeMax, true);

  const events: CandidateEvent[] = [];

  let insideVevent = false;
  let subComponentDepth = 0;
  let uid: string | null = null;
  let summary: string | null = null;
  let description: string | null = null;
  let dtstartRaw: string | null = null;
  let dtstartParams: string[] = [];
  let dtendRaw: string | null = null;
  let dtendParams: string[] = [];
  let status: string | null = null;
  let isRecurring = false;

  const flushEvent = () => {
    if (!insideVevent) return;
    insideVevent = false;
    subComponentDepth = 0;

    // 1. UID 필수
    if (!uid) return;

    // 2. 취소된 일정 제외
    if (status === "CANCELLED") return;

    // 3. 반복 일정 제외
    if (isRecurring) return;

    // 4. 종일 일정이 아닌 것 제외 (VALUE= 파라미터가 있다면 정확히 VALUE=DATE 여야 함)
    const valParam = dtstartParams.find((p) => p.startsWith("VALUE="));
    if (valParam && valParam !== "VALUE=DATE") return;

    const startDate = parseIcsDate(dtstartRaw ?? "");
    if (!startDate) return;

    // 5. DTEND 처리: DTEND가 있으면 배타적 종료일에서 1일 차감, 없으면 startDate
    let endDate = startDate;
    if (dtendRaw) {
      const endValParam = dtendParams.find((p) => p.startsWith("VALUE="));
      if (!endValParam || endValParam === "VALUE=DATE") {
        const parsedDtend = parseIcsDate(dtendRaw);
        if (parsedDtend) {
          const shifted = shiftDateStr(parsedDtend, -1);
          endDate = shifted < startDate ? startDate : shifted;
        }
      }
    }

    // 6. 스캔 창 필터: [windowStart, windowEnd] 와 [startDate, endDate] 가 겹쳐야 함
    if (!(endDate >= windowStart && startDate <= windowEnd)) {
      return;
    }

    const unescapedSummary = summary ? unescapeIcsText(summary).trim() : "";
    const finalSummary = unescapedSummary || "(제목 없음)";
    const finalDescription = description !== null ? unescapeIcsText(description) : null;

    events.push({
      id: `icloud:${opts.feedKind}:${uid}`,
      calendarId: opts.calendarId,
      summary: finalSummary,
      description: finalDescription,
      startDate,
      endDate,
      htmlLink: null,
      crmSigned: hasCrmDescriptionSignature(finalDescription),
    });
  };

  for (const rawLine of lines) {
    const colonIdx = rawLine.indexOf(":");
    if (colonIdx === -1) {
      const trimmed = rawLine.trim().toUpperCase();
      if (trimmed === "BEGIN:VEVENT") {
        insideVevent = true;
        subComponentDepth = 0;
        uid = null;
        summary = null;
        description = null;
        dtstartRaw = null;
        dtstartParams = [];
        dtendRaw = null;
        dtendParams = [];
        status = null;
        isRecurring = false;
      } else if (trimmed === "END:VEVENT") {
        flushEvent();
      }
      continue;
    }

    const nameAndParams = rawLine.slice(0, colonIdx).trim();
    const value = rawLine.slice(colonIdx + 1);

    const compName = value.trim().toUpperCase();
    if (nameAndParams.toUpperCase() === "BEGIN") {
      if (compName === "VEVENT") {
        insideVevent = true;
        subComponentDepth = 0;
        uid = null;
        summary = null;
        description = null;
        dtstartRaw = null;
        dtstartParams = [];
        dtendRaw = null;
        dtendParams = [];
        status = null;
        isRecurring = false;
        continue;
      } else if (insideVevent) {
        subComponentDepth++;
        continue;
      }
    }

    if (nameAndParams.toUpperCase() === "END") {
      if (compName === "VEVENT") {
        flushEvent();
        continue;
      } else if (insideVevent) {
        subComponentDepth = Math.max(0, subComponentDepth - 1);
        continue;
      }
    }

    if (!insideVevent) continue;
    // VEVENT 내부의 서브컴포넌트(VALARM 등)의 속성은 무시한다
    if (subComponentDepth > 0) continue;

    const parts = nameAndParams.split(";");
    const propName = parts[0].trim().toUpperCase();
    const params = parts.slice(1).map((p) => p.trim().toUpperCase());

    if (propName === "UID") {
      uid = value.trim();
    } else if (propName === "STATUS") {
      status = value.trim().toUpperCase();
    } else if (propName === "RRULE" || propName === "RECURRENCE-ID") {
      isRecurring = true;
    } else if (propName === "DTSTART") {
      dtstartRaw = value.trim();
      dtstartParams = params;
    } else if (propName === "DTEND") {
      dtendRaw = value.trim();
      dtendParams = params;
    } else if (propName === "SUMMARY") {
      summary = value;
    } else if (propName === "DESCRIPTION") {
      description = value;
    }
  }

  return events;
}

/**
 * 이벤트 ID(ev.id) 및 정규화 키(NFC + 공백제거 + 소문자화 + startDate + endDate) 기준으로 중복을 제거한다.
 * 배열 앞쪽 이벤트가 우선하므로 (구글 -> icloud:events -> icloud:finance) 순서가 유지된다.
 */
export function dedupeCandidateEvents(events: CandidateEvent[]): CandidateEvent[] {
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  const deduped: CandidateEvent[] = [];

  for (const ev of events) {
    if (seenIds.has(ev.id)) continue;
    const key = `${normalizeForCompare(ev.summary)}|${ev.startDate}|${ev.endDate}`;
    if (seenKeys.has(key)) continue;

    seenIds.add(ev.id);
    seenKeys.add(key);
    deduped.push(ev);
  }

  return deduped;
}

/**
 * ICS 피드 URL을 가져온다.
 * ⚠️ URL 원문 및 쿼리 파라미터는 에러 메시지에 절대 노출하지 않는다.
 */
export async function fetchIcsFeed(
  url: string,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<string> {
  const fetchFn = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? CANDIDATE_LIST_REQUEST_TIMEOUT_MS;

  try {
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("iCloud 캘린더 피드 요청 시간 초과");
    }
    if (error instanceof Error && error.message.startsWith("HTTP ")) {
      throw new Error(`iCloud 캘린더 피드 요청 실패: ${error.message}`);
    }
    throw new Error("iCloud 캘린더 피드 요청 실패 (네트워크 오류)");
  }
}

export type MergedInboundDeps = {
  listGoogleCandidates?: (range: { timeMin: string; timeMax: string }) => Promise<CandidateListResult>;
  fetchIcs?: (url: string, opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }) => Promise<string>;
  env?: {
    ICLOUD_EVENTS_CALENDAR_URL?: string;
    ICLOUD_FINANCE_CALENDAR_URL?: string;
  };
};

/**
 * 구글 캘린더 및 설정된 iCloud 피드(행사 일정, 회계 일정)를 병렬 조회하여 병합·중복 제거한 후보 목록을 반환한다.
 * - 구글 캘린더가 미연결이더라도 iCloud 피드가 하나 이상 성공하면 ok: true
 * - 모든 소스가 미설정이면 ok: false, skipped: "not_connected"
 * - 구글 캘린더 실패 시 또는 일부 피드 실패 시 console.error에 사유만 로깅(URL/토큰 제외)하고 계속 진행
 * - 설정된 모든 소스가 실패하면 ok: false, error 반환
 * - 최종 events에는 dedupeCandidateEvents 적용
 */
export async function listMergedInboundCandidateEvents(
  range: { timeMin: string; timeMax: string },
  deps?: MergedInboundDeps,
): Promise<CandidateListResult> {
  const listGoogle = deps?.listGoogleCandidates ?? listAllDayCandidateEvents;
  const fetchIcs = deps?.fetchIcs ?? fetchIcsFeed;

  const rawEventsUrl = deps?.env?.ICLOUD_EVENTS_CALENDAR_URL ?? process.env.ICLOUD_EVENTS_CALENDAR_URL;
  const rawFinanceUrl = deps?.env?.ICLOUD_FINANCE_CALENDAR_URL ?? process.env.ICLOUD_FINANCE_CALENDAR_URL;

  const eventsUrl = normalizeWebcalUrl(rawEventsUrl);
  const financeUrl = normalizeWebcalUrl(rawFinanceUrl);

  // 환경변수가 채워져 있으나 URL 형식이 유효하지 않은 경우 로깅 (URL 원문 비노출)
  let invalidEventsUrl = false;
  if (rawEventsUrl && rawEventsUrl.trim().length > 0 && !eventsUrl) {
    invalidEventsUrl = true;
    console.error("[icloud-ics] events 피드 URL 형식이 유효하지 않아 건너뜁니다");
  }

  let invalidFinanceUrl = false;
  if (rawFinanceUrl && rawFinanceUrl.trim().length > 0 && !financeUrl) {
    invalidFinanceUrl = true;
    console.error("[icloud-ics] finance 피드 URL 형식이 유효하지 않아 건너뜁니다");
  }

  const googlePromise = (async (): Promise<CandidateListResult> => {
    try {
      return await listGoogle(range);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        events: [],
        referencedIds: new Set<string>(),
      };
    }
  })();

  const eventsPromise = eventsUrl
    ? (async () => {
        const text = await fetchIcs(eventsUrl);
        return parseIcsCandidateEvents(text, {
          calendarId: ICLOUD_EVENTS_CALENDAR_ID,
          feedKind: "events",
          timeMin: range.timeMin,
          timeMax: range.timeMax,
        });
      })()
    : null;

  const financePromise = financeUrl
    ? (async () => {
        const text = await fetchIcs(financeUrl);
        return parseIcsCandidateEvents(text, {
          calendarId: ICLOUD_FINANCE_CALENDAR_ID,
          feedKind: "finance",
          timeMin: range.timeMin,
          timeMax: range.timeMax,
        });
      })()
    : null;

  const [googleResult, eventsSettled, financeSettled] = await Promise.all([
    googlePromise,
    eventsPromise
      ? eventsPromise
          .then((evs) => ({ ok: true as const, events: evs }))
          .catch((err) => {
            const rawMsg = err instanceof Error ? err.message : String(err);
            const safeMsg = rawMsg
              .replace(/https?:\/\/[^\s]+/gi, "[REDACTED]")
              .replace(/webcal:\/\/[^\s]+/gi, "[REDACTED]");
            console.error(`[icloud-ics] events 피드 조회 실패: ${safeMsg}`);
            return { ok: false as const, error: safeMsg };
          })
      : invalidEventsUrl
        ? Promise.resolve({ ok: false as const, error: "유효하지 않은 events 피드 URL" })
        : Promise.resolve(null),
    financePromise
      ? financePromise
          .then((evs) => ({ ok: true as const, events: evs }))
          .catch((err) => {
            const rawMsg = err instanceof Error ? err.message : String(err);
            const safeMsg = rawMsg
              .replace(/https?:\/\/[^\s]+/gi, "[REDACTED]")
              .replace(/webcal:\/\/[^\s]+/gi, "[REDACTED]");
            console.error(`[icloud-ics] finance 피드 조회 실패: ${safeMsg}`);
            return { ok: false as const, error: safeMsg };
          })
      : invalidFinanceUrl
        ? Promise.resolve({ ok: false as const, error: "유효하지 않은 finance 피드 URL" })
        : Promise.resolve(null),
  ]);

  // 구글 캘린더 실패 시 로깅 (not_connected 제외)
  if (!googleResult.ok && googleResult.skipped !== "not_connected") {
    console.error(`[icloud-ics] 구글 캘린더 조회 실패: ${googleResult.error ?? "원인 불명"}`);
  }

  const hasIcloudConfigured = Boolean(
    eventsUrl || financeUrl || invalidEventsUrl || invalidFinanceUrl,
  );
  const isGoogleNotConnected = googleResult.skipped === "not_connected";

  // 구글과 iCloud 모두 미설정된 상태
  if (isGoogleNotConnected && !hasIcloudConfigured) {
    return {
      ok: false,
      skipped: "not_connected",
      events: [],
      referencedIds: new Set<string>(),
    };
  }

  const anySucceeded =
    googleResult.ok || eventsSettled?.ok === true || financeSettled?.ok === true;

  // 설정된 모든 소스가 실패한 경우
  if (!anySucceeded) {
    const errorDetails: string[] = [];
    if (!googleResult.ok && googleResult.error) {
      errorDetails.push(`구글: ${googleResult.error}`);
    }
    if (eventsSettled && !eventsSettled.ok) {
      errorDetails.push(`iCloud 행사: ${eventsSettled.error}`);
    }
    if (financeSettled && !financeSettled.ok) {
      errorDetails.push(`iCloud 회계: ${financeSettled.error}`);
    }
    return {
      ok: false,
      error: `모든 캘린더 소스 조회 실패 (${errorDetails.join(", ") || "원인 불명"})`,
      events: [],
      referencedIds: googleResult.referencedIds ?? new Set<string>(),
    };
  }

  // 성공한 소스들의 이벤트를 구글 -> iCloud 행사 -> iCloud 회계 순서로 병합
  const mergedRawEvents: CandidateEvent[] = [
    ...(googleResult.ok ? googleResult.events : []),
    ...(eventsSettled?.ok ? eventsSettled.events : []),
    ...(financeSettled?.ok ? financeSettled.events : []),
  ];

  const deduped = dedupeCandidateEvents(mergedRawEvents);

  return {
    ok: true,
    events: deduped,
    referencedIds: googleResult.referencedIds ?? new Set<string>(),
  };
}
