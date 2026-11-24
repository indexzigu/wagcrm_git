// [회계캘린더] iCloud 공개 회계 캘린더(webcal/ICS) 읽기 전용 조회·병합 모듈.
// 환경변수 ICLOUD_FINANCE_CALENDAR_URL (PR #320 인바운드 스캔과 동일 키)에서 피드를 읽어
// 홈「다가올 14일 일정」과 /calendar 월간 달력에 기존 CRM 정산 일정과 중복을 제외하고 합친다.
//
// ⚠️ 보안 제약 (PUBLIC 저장소):
// - 실제 webcal URL·토큰을 소스·테스트·로그에 절대 노출하지 않는다.
// - SSRF 방지: webcal:// 또는 https:// 공개 호스트만 허용, 사설망·루프백·인증정보 차단.

import { toKstYmd } from "@/lib/date-utils";
import { normalizeForCompare } from "@/lib/text-normalize";

export type IcloudFinanceEvent = {
  id: string;
  /** YYYY-MM-DD (KST 기준) */
  date: string;
  /** YYYY-MM-DD (종료일, 당일이면 date와 동일) */
  endDate: string;
  title: string;
  description: string | null;
};

const FETCH_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedIcs: { url: string; fetchedAt: number; text: string } | null = null;

export function clearIcloudFinanceCacheForTest(): void {
  cachedIcs = null;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

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
  if (!host.includes(".") && !host.includes(":")) return true;
  if (host.includes(":")) {
    return (
      host === "::1" ||
      host === "::" ||
      host === "0:0:0:0:0:0:0:1" ||
      host === "0:0:0:0:0:0:0:0" ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb") ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("::ffff:")
    );
  }
  return isPrivateIpv4(host);
}

export function normalizeFinanceWebcalUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withHttps = trimmed.replace(/^webcal:\/\//i, "https://");
  try {
    const parsed = new URL(withHttps);
    if (parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    if (parsed.username || parsed.password) return null;
    if (isBlockedHost(parsed.hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function unescapeIcsText(text: string): string {
  return text.replace(/\\([nN,;\\])/g, (_, ch: string) =>
    ch === "n" || ch === "N" ? "\n" : ch,
  );
}

function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseYmd8(raw8: string): string | null {
  if (!/^\d{8}$/.test(raw8)) return null;
  const y = Number(raw8.slice(0, 4));
  const m = Number(raw8.slice(4, 6));
  const d = Number(raw8.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  const ymd = `${raw8.slice(0, 4)}-${raw8.slice(4, 6)}-${raw8.slice(6, 8)}`;
  return dt.toISOString().slice(0, 10) === ymd ? ymd : null;
}

/**
 * ICS DTSTART / DTEND 값(종일 YYYYMMDD 또는 시간 포함 YYYYMMDDTHHMMSS[Z])을 KST YYYY-MM-DD 로 변환한다.
 */
function parseIcsDateOrDateTime(rawValue: string): { ymd: string; isAllDay: boolean } | null {
  const value = rawValue.trim();
  // 종일: 20261125
  if (/^\d{8}$/.test(value)) {
    const ymd = parseYmd8(value);
    return ymd ? { ymd, isAllDay: true } : null;
  }
  // UTC 타임스탬프: 20261125T000000Z
  const utcMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(value);
  if (utcMatch) {
    const [, y, m, d, hh, mm, ss] = utcMatch;
    const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)));
    if (Number.isNaN(dt.getTime())) return null;
    return { ymd: toKstYmd(dt), isAllDay: false };
  }
  // 로컬/TZID 타임스탬프: 20261125T090000
  const localMatch = /^(\d{8})T\d{6}$/i.exec(value);
  if (localMatch) {
    const ymd = parseYmd8(localMatch[1]);
    return ymd ? { ymd, isAllDay: false } : null;
  }
  return null;
}

/**
 * ICS 텍스트에서 [windowStart, windowEnd] 범위의 회계 일정을 파싱한다.
 * - STATUS:CANCELLED 제외
 * - VALARM 등 서브컴포넌트 무시
 * - 피드 내 동일 (date, 정규화 제목) 중복 제거
 */
export function parseFinanceIcsEvents(
  icsText: string,
  windowStart: string,
  windowEnd: string,
): IcloudFinanceEvent[] {
  const unfolded = icsText.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  const events: IcloudFinanceEvent[] = [];
  const seenKeys = new Set<string>();

  let insideVevent = false;
  let subDepth = 0;
  let uid: string | null = null;
  let summary: string | null = null;
  let description: string | null = null;
  let dtstartRaw: string | null = null;
  let dtendRaw: string | null = null;
  let status: string | null = null;

  const reset = () => {
    uid = null;
    summary = null;
    description = null;
    dtstartRaw = null;
    dtendRaw = null;
    status = null;
  };

  const flush = () => {
    if (!insideVevent) return;
    insideVevent = false;
    subDepth = 0;

    if (status === "CANCELLED") return;
    if (!dtstartRaw) return;
    const start = parseIcsDateOrDateTime(dtstartRaw);
    if (!start) return;

    let endDate = start.ymd;
    if (dtendRaw) {
      const parsedEnd = parseIcsDateOrDateTime(dtendRaw);
      if (parsedEnd) {
        if (parsedEnd.isAllDay) {
          const shifted = shiftYmd(parsedEnd.ymd, -1);
          endDate = shifted < start.ymd ? start.ymd : shifted;
        } else {
          endDate = parsedEnd.ymd < start.ymd ? start.ymd : parsedEnd.ymd;
        }
      }
    }

    if (!(endDate >= windowStart && start.ymd <= windowEnd)) return;

    const title = summary ? unescapeIcsText(summary).trim() : "";
    if (!title) return;

    const dedupeKey = `${start.ymd}::${normalizeForCompare(title)}`;
    if (seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);

    events.push({
      id: `icloud-finance:${uid ?? dedupeKey}`,
      date: start.ymd,
      endDate,
      title,
      description: description !== null ? unescapeIcsText(description).trim() || null : null,
    });
  };

  for (const rawLine of lines) {
    const colonIdx = rawLine.indexOf(":");
    if (colonIdx === -1) continue;
    const nameAndParams = rawLine.slice(0, colonIdx).trim();
    const value = rawLine.slice(colonIdx + 1);
    const upperName = nameAndParams.split(";")[0].toUpperCase();

    if (upperName === "BEGIN") {
      const comp = value.trim().toUpperCase();
      if (comp === "VEVENT") {
        insideVevent = true;
        subDepth = 0;
        reset();
      } else if (insideVevent) {
        subDepth += 1;
      }
      continue;
    }

    if (upperName === "END") {
      const comp = value.trim().toUpperCase();
      if (comp === "VEVENT") {
        flush();
      } else if (insideVevent && subDepth > 0) {
        subDepth -= 1;
      }
      continue;
    }

    if (!insideVevent || subDepth > 0) continue;

    if (upperName === "UID") uid = value.trim();
    else if (upperName === "SUMMARY") summary = value;
    else if (upperName === "DESCRIPTION") description = value;
    else if (upperName === "DTSTART") dtstartRaw = value.trim();
    else if (upperName === "DTEND") dtendRaw = value.trim();
    else if (upperName === "STATUS") status = value.trim().toUpperCase();
  }

  return events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, "ko"));
}

function toYmdKey(dateOrIso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateOrIso)) return dateOrIso;
  const d = new Date(dateOrIso);
  if (Number.isNaN(d.getTime())) return dateOrIso.slice(0, 10);
  return toKstYmd(d);
}

/**
 * 기존 CRM 정산·캠페인 일정과 같은 날 같은(또는 포함 관계) 제목을 가진 회계 일정을 제외한다.
 */
export function dedupeFinanceEventsAgainstCrm<T extends { date: string; title: string }>(
  financeEvents: T[],
  crmEntries: Array<{ date: string; label: string }>,
): T[] {
  if (financeEvents.length === 0 || crmEntries.length === 0) return financeEvents;

  const crmByDate = new Map<string, string[]>();
  for (const entry of crmEntries) {
    const ymd = toYmdKey(entry.date);
    const norm = normalizeForCompare(entry.label);
    if (!norm) continue;
    const list = crmByDate.get(ymd);
    if (list) list.push(norm);
    else crmByDate.set(ymd, [norm]);
  }

  return financeEvents.filter((ev) => {
    const crmLabels = crmByDate.get(toYmdKey(ev.date));
    if (!crmLabels || crmLabels.length === 0) return true;
    const normFin = normalizeForCompare(ev.title);
    if (!normFin) return false;
    return !crmLabels.some(
      (normCrm) =>
        normFin === normCrm ||
        (normCrm.length >= 2 && normFin.includes(normCrm)) ||
        (normFin.length >= 2 && normCrm.includes(normFin)),
    );
  });
}

export async function fetchIcloudFinanceEvents(
  windowStart: string,
  windowEnd: string,
  opts?: {
    envUrl?: string;
    fetchImpl?: typeof fetch;
    nowMs?: number;
  },
): Promise<IcloudFinanceEvent[]> {
  const rawUrl = opts?.envUrl !== undefined ? opts.envUrl : process.env.ICLOUD_FINANCE_CALENDAR_URL;
  const safeUrl = normalizeFinanceWebcalUrl(rawUrl);
  if (!safeUrl) {
    if (rawUrl && rawUrl.trim().length > 0) {
      console.warn("[icloud-finance] ICLOUD_FINANCE_CALENDAR_URL 형식이 유효하지 않아 건너뜁니다");
    }
    return [];
  }

  const nowMs = opts?.nowMs ?? Date.now();
  let icsText: string;

  if (cachedIcs && cachedIcs.url === safeUrl && nowMs - cachedIcs.fetchedAt < CACHE_TTL_MS) {
    icsText = cachedIcs.text;
  } else {
    const fetchFn = opts?.fetchImpl ?? fetch;
    try {
      const res = await fetchFn(safeUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.warn(`[icloud-finance] 회계 피드 조회 실패: HTTP ${res.status}`);
        return [];
      }
      icsText = await res.text();
      cachedIcs = { url: safeUrl, fetchedAt: nowMs, text: icsText };
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "시간 초과" : "네트워크 오류";
      console.warn(`[icloud-finance] 회계 피드 조회 실패 (${reason})`);
      return [];
    }
  }

  return parseFinanceIcsEvents(icsText, windowStart, windowEnd);
}
