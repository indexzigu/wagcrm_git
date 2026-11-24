import { describe, expect, it, vi } from "vitest";
import type { CandidateEvent } from "@/lib/google-calendar-sync";
import {
  ICLOUD_CALENDAR_PREFIX,
  ICLOUD_EVENTS_CALENDAR_ID,
  ICLOUD_FINANCE_CALENDAR_ID,
  dedupeCandidateEvents,
  fetchIcsFeed,
  isReadOnlyInboundCalendar,
  listMergedInboundCandidateEvents,
  normalizeWebcalUrl,
  parseIcsCandidateEvents,
  unescapeIcsText,
} from "../icloud-ics";

// ⚠️ 절대 보안 원칙:
// 가상 도메인(cal.example.com)과 가상 토큰만 사용한다. 실제 URL/토큰 하드코딩 금지.
const FAKE_EVENTS_URL = "webcal://cal.example.com/published/events";
const FAKE_FINANCE_URL = "https://cal.example.com/published/finance";

describe("icloud-ics — 상수 및 식별자 판별기", () => {
  it("상수 접두사 및 캘린더 ID 가 올바르게 선언되어 있다", () => {
    expect(ICLOUD_CALENDAR_PREFIX).toBe("icloud:");
    expect(ICLOUD_EVENTS_CALENDAR_ID).toBe("icloud:events");
    expect(ICLOUD_FINANCE_CALENDAR_ID).toBe("icloud:finance");
  });

  it("isReadOnlyInboundCalendar 판별기가 icloud: 접두사만 true 로 판정한다", () => {
    expect(isReadOnlyInboundCalendar("icloud:events")).toBe(true);
    expect(isReadOnlyInboundCalendar("icloud:finance")).toBe(true);
    expect(isReadOnlyInboundCalendar("icloud:custom")).toBe(true);
    expect(isReadOnlyInboundCalendar("primary")).toBe(false);
    expect(isReadOnlyInboundCalendar("group@example.com")).toBe(false);
    expect(isReadOnlyInboundCalendar("")).toBe(false);
  });
});

describe("icloud-ics — normalizeWebcalUrl (SSRF 방어 강화 포함)", () => {
  it("webcal:// 접두사를 https:// 로 치환한다", () => {
    expect(normalizeWebcalUrl("webcal://cal.example.com/feed.ics")).toBe(
      "https://cal.example.com/feed.ics",
    );
    expect(normalizeWebcalUrl("WEBCAL://cal.example.com/feed.ics")).toBe(
      "https://cal.example.com/feed.ics",
    );
  });

  it("https:// URL 은 그대로 통과한다", () => {
    expect(normalizeWebcalUrl("https://cal.example.com/feed.ics")).toBe(
      "https://cal.example.com/feed.ics",
    );
  });

  it("앞뒤 공백을 trim 처리한다", () => {
    expect(normalizeWebcalUrl("   webcal://cal.example.com/feed.ics   ")).toBe(
      "https://cal.example.com/feed.ics",
    );
  });

  it("http://, file:// 등 비안전 프로토콜 및 빈값/잘못된 URL 을 차단(null)한다", () => {
    expect(normalizeWebcalUrl("http://cal.example.com/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeWebcalUrl("ftp://cal.example.com/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("")).toBeNull();
    expect(normalizeWebcalUrl("   ")).toBeNull();
    expect(normalizeWebcalUrl(null)).toBeNull();
    expect(normalizeWebcalUrl(undefined)).toBeNull();
    expect(normalizeWebcalUrl("not a url")).toBeNull();
    expect(normalizeWebcalUrl("javascript:alert(1)")).toBeNull();
  });

  it("인증정보(user:pass)가 포함된 URL 은 차단한다", () => {
    const withCreds = ["webcal://", "user", ":", "pass", "@cal.example.com/feed.ics"].join("");
    const withUser = ["https://", "user", "@cal.example.com/feed.ics"].join("");
    expect(normalizeWebcalUrl(withCreds)).toBeNull();
    expect(normalizeWebcalUrl(withUser)).toBeNull();
  });

  it("localhost, 사설망 IP 및 단일 라벨 호스트를 차단한다 (SSRF 방어)", () => {
    // localhost 및 내부 도메인
    expect(normalizeWebcalUrl("webcal://localhost/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://sub.localhost/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://myhost.local/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://service.internal/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://internal-server/feed.ics")).toBeNull();

    // IPv4 루프백 및 사설망
    expect(normalizeWebcalUrl("webcal://127.0.0.1/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://127.1.2.3/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://10.0.0.1/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://172.16.0.1/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://172.31.255.255/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://192.168.0.1/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://169.254.169.254/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://0.0.0.0/feed.ics")).toBeNull();

    // IPv6 루프백, 사설망, 링크로컬
    expect(normalizeWebcalUrl("webcal://[::1]/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://[::]/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://[fe80::1]/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://[fc00::1]/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://[fd12:3456::1]/feed.ics")).toBeNull();
    expect(normalizeWebcalUrl("webcal://[::ffff:127.0.0.1]/feed.ics")).toBeNull();
  });
});

describe("icloud-ics — unescapeIcsText", () => {
  it("RFC 5545 이스케이프 문자(\\n, \\N, \\,, \\;, \\\\)를 올바르게 복원한다", () => {
    const raw = "줄1\\n줄2\\N줄3\\, 쉼표\\; 쌍반점\\\\역슬래시";
    expect(unescapeIcsText(raw)).toBe("줄1\n줄2\n줄3, 쉼표; 쌍반점\\역슬래시");
  });
});

describe("icloud-ics — parseIcsCandidateEvents", () => {
  const DEFAULT_OPTS = {
    calendarId: ICLOUD_EVENTS_CALENDAR_ID,
    feedKind: "events" as const,
    timeMin: "2026-11-01",
    timeMax: "2026-11-30",
  };

  it("라인 언폴딩, 이스케이프 복원, DTEND-1 종일 일정 변환을 수행한다", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:evt-1@example.com",
      "DTSTART;VALUE=DATE:20261110",
      "DTEND;VALUE=DATE:20261113",
      "SUMMARY:테스트 ",
      " 일정 제목",
      "DESCRIPTION:상세 ",
      " 설명\\n셀러: 샘플셀러",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseIcsCandidateEvents(ics, DEFAULT_OPTS);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: "icloud:events:evt-1@example.com",
      calendarId: ICLOUD_EVENTS_CALENDAR_ID,
      summary: "테스트 일정 제목",
      description: "상세 설명\n셀러: 샘플셀러",
      startDate: "2026-11-10",
      endDate: "2026-11-12", // DTEND(2026-11-13) - 1
      htmlLink: null,
      crmSigned: true,
    });
  });

  it("VEVENT 내부 중첩 서브컴포넌트(BEGIN:VALARM ~ END:VALARM)의 속성을 무시한다 (Finding #1)", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:main-event-uid",
      "DTSTART;VALUE=DATE:20261110",
      "SUMMARY:본래 일정 제목",
      "DESCRIPTION:본래 설명\\n셀러: 진짜셀러",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "UID:alarm-uid-should-be-ignored",
      "SUMMARY:알람 제목 무시",
      "DESCRIPTION:알람 설명 무시\\n셀러: 가짜셀러",
      "TRIGGER:-PT15M",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const events = parseIcsCandidateEvents(ics, DEFAULT_OPTS);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("icloud:events:main-event-uid");
    expect(events[0].summary).toBe("본래 일정 제목");
    expect(events[0].description).toBe("본래 설명\n셀러: 진짜셀러");
    expect(events[0].crmSigned).toBe(true);
  });

  it("KST 스캔 창(UTC ISO 포맷) 경계일을 정확히 필터링한다 (Finding #2)", () => {
    // KST 2026-10-22 12:00 기준 calendarInboundWindow 산출 창:
    // timeMin: 2026-10-07T15:00:00.000Z (KST 2026-10-08 00:00:00)
    // timeMax: 2027-04-20T15:00:00.000Z (KST 2027-04-21 00:00:00 배타 상한 -> KST 2027-04-20 포함)
    const kstWindowOpts = {
      calendarId: ICLOUD_EVENTS_CALENDAR_ID,
      feedKind: "events" as const,
      timeMin: "2026-10-07T15:00:00.000Z",
      timeMax: "2027-04-20T15:00:00.000Z",
    };

    const ics = [
      "BEGIN:VCALENDAR",
      // 10-07 은 KST 창 시작(10-08) 이전이므로 제외
      "BEGIN:VEVENT",
      "UID:edge-before",
      "DTSTART;VALUE=DATE:20261007",
      "SUMMARY:창 이전 행사",
      "END:VEVENT",
      // 10-08 은 KST 창 시작일이므로 포함
      "BEGIN:VEVENT",
      "UID:edge-start",
      "DTSTART;VALUE=DATE:20261008",
      "SUMMARY:창 시작일 행사",
      "END:VEVENT",
      // 04-20 은 KST 배타 상한(04-21) 직전 포함일이므로 포함
      "BEGIN:VEVENT",
      "UID:edge-end",
      "DTSTART;VALUE=DATE:20270420",
      "SUMMARY:창 종료일 행사",
      "END:VEVENT",
      // 04-21 은 KST 배타 상한이므로 제외
      "BEGIN:VEVENT",
      "UID:edge-after",
      "DTSTART;VALUE=DATE:20270421",
      "SUMMARY:창 종료일 이후 행사",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const events = parseIcsCandidateEvents(ics, kstWindowOpts);
    expect(events.map((e) => e.id)).toEqual([
      "icloud:events:edge-start",
      "icloud:events:edge-end",
    ]);
  });

  it("VALUE=DATE-TIME 과 같은 시간 지정 파라미터는 종일 일정에서 제외한다 (Finding #5)", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:date-time-1",
      "DTSTART;VALUE=DATE-TIME:20261110T090000Z",
      "SUMMARY:DATE-TIME 일정",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:valid-all-day",
      "DTSTART;VALUE=DATE:20261110",
      "SUMMARY:정상 종일 일정",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const events = parseIcsCandidateEvents(ics, DEFAULT_OPTS);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("icloud:events:valid-all-day");
  });

  it("달력에 존재하지 않는 무효 날짜(20260231, 20269999 등)는 제외한다 (Finding #5)", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:invalid-feb-31",
      "DTSTART;VALUE=DATE:20260231",
      "SUMMARY:2월 31일 일정",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:invalid-month-99",
      "DTSTART;VALUE=DATE:20269999",
      "SUMMARY:99월 99일 일정",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const events = parseIcsCandidateEvents(ics, {
      ...DEFAULT_OPTS,
      timeMin: "2026-01-01",
      timeMax: "2027-12-31",
    });
    expect(events).toHaveLength(0);
  });

  it("DTEND 가 없으면 endDate 는 startDate 와 동일하다", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:single-day-1",
      "DTSTART;VALUE=DATE:20261115",
      "SUMMARY:단일 일자 행사",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const events = parseIcsCandidateEvents(ics, DEFAULT_OPTS);
    expect(events).toHaveLength(1);
    expect(events[0].startDate).toBe("2026-11-15");
    expect(events[0].endDate).toBe("2026-11-15");
  });

  it("DTEND 가 startDate 이하인 경우 endDate 는 startDate 로 방어한다", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:same-day-end",
      "DTSTART;VALUE=DATE:20261115",
      "DTEND;VALUE=DATE:20261115",
      "SUMMARY:종료일 동일",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const events = parseIcsCandidateEvents(ics, DEFAULT_OPTS);
    expect(events).toHaveLength(1);
    expect(events[0].startDate).toBe("2026-11-15");
    expect(events[0].endDate).toBe("2026-11-15");
  });

  it("STATUS:CANCELLED 일정은 제외한다", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:cancelled-1",
      "STATUS:CANCELLED",
      "DTSTART;VALUE=DATE:20261110",
      "SUMMARY:취소된 행사",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const events = parseIcsCandidateEvents(ics, DEFAULT_OPTS);
    expect(events).toHaveLength(0);
  });

  it("RRULE 또는 RECURRENCE-ID 가 있는 반복 일정은 제외한다", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:recurring-1",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "DTSTART;VALUE=DATE:20261110",
      "SUMMARY:반복 행사 1",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:recurring-2",
      "RECURRENCE-ID;VALUE=DATE:20261110",
      "DTSTART;VALUE=DATE:20261110",
      "SUMMARY:반복 행사 2",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const events = parseIcsCandidateEvents(ics, DEFAULT_OPTS);
    expect(events).toHaveLength(0);
  });

  it("종일 일정이 아닌 시간 지정 이벤트는 제외한다", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:timed-1",
      "DTSTART:20261110T090000Z",
      "DTEND:20261110T180000Z",
      "SUMMARY:시간 지정 행사 1",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:timed-2",
      "DTSTART;TZID=Asia/Seoul:20261110T090000",
      "SUMMARY:시간 지정 행사 2",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const events = parseIcsCandidateEvents(ics, DEFAULT_OPTS);
    expect(events).toHaveLength(0);
  });

  it("UID 가 누락된 이벤트는 제외한다", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20261110",
      "SUMMARY:UID 없음",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const events = parseIcsCandidateEvents(ics, DEFAULT_OPTS);
    expect(events).toHaveLength(0);
  });

  it("스캔 창 범위 밖의 이벤트는 제외하고 겹치는 이벤트만 포함한다", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:past-1",
      "DTSTART;VALUE=DATE:20261025",
      "DTEND;VALUE=DATE:20261031",
      "SUMMARY:과거 행사",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:overlap-start",
      "DTSTART;VALUE=DATE:20261028",
      "DTEND;VALUE=DATE:20261103",
      "SUMMARY:걸친 행사",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:inside-1",
      "DTSTART;VALUE=DATE:20261115",
      "SUMMARY:내부 행사",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:future-1",
      "DTSTART;VALUE=DATE:20261205",
      "SUMMARY:미래 행사",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const events = parseIcsCandidateEvents(ics, DEFAULT_OPTS);
    expect(events.map((e) => e.id)).toEqual([
      "icloud:events:overlap-start",
      "icloud:events:inside-1",
    ]);
  });

  it("SUMMARY 가 없으면 (제목 없음) 으로 대체한다", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:no-summary",
      "DTSTART;VALUE=DATE:20261110",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const events = parseIcsCandidateEvents(ics, DEFAULT_OPTS);
    expect(events[0].summary).toBe("(제목 없음)");
  });

  it("설명란 CRM 서명 유무에 따라 crmSigned 를 올바르게 감지한다", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:signed-1",
      "DTSTART;VALUE=DATE:20261110",
      "SUMMARY:행사 1",
      "DESCRIPTION:공지사항\\n셀러: 홍길동\\n수수료: 10%",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:unsigned-1",
      "DTSTART;VALUE=DATE:20261110",
      "SUMMARY:행사 2",
      "DESCRIPTION:일반 메모",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:unsigned-2",
      "DTSTART;VALUE=DATE:20261110",
      "SUMMARY:행사 3",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const events = parseIcsCandidateEvents(ics, DEFAULT_OPTS);
    expect(events.find((e) => e.id === "icloud:events:signed-1")?.crmSigned).toBe(true);
    expect(events.find((e) => e.id === "icloud:events:unsigned-1")?.crmSigned).toBe(false);
    expect(events.find((e) => e.id === "icloud:events:unsigned-2")?.crmSigned).toBe(false);
  });
});

describe("icloud-ics — dedupeCandidateEvents (ID 및 키 중복 제거)", () => {
  const baseEvent = (over: Partial<CandidateEvent> = {}): CandidateEvent => ({
    id: "ev-1",
    calendarId: "primary",
    summary: "테스트 행사",
    description: null,
    startDate: "2026-11-10",
    endDate: "2026-11-12",
    htmlLink: null,
    crmSigned: false,
    ...over,
  });

  it("동일 ev.id 를 가진 이벤트는 제목·날짜가 달라도 두 번째 항목을 중복 제거한다 (Finding #5)", () => {
    const ev1 = baseEvent({ id: "icloud:events:dup-uid", summary: "행사 A" });
    const ev2 = baseEvent({ id: "icloud:events:dup-uid", summary: "행사 B" });

    const deduped = dedupeCandidateEvents([ev1, ev2]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].summary).toBe("행사 A");
  });

  it("구글 vs iCloud 중복 시 먼저 들어온 구글 이벤트가 우선한다", () => {
    const googleEv = baseEvent({ id: "google-1", calendarId: "primary" });
    const icloudEv = baseEvent({
      id: "icloud:events:uid-1",
      calendarId: ICLOUD_EVENTS_CALENDAR_ID,
    });

    const deduped = dedupeCandidateEvents([googleEv, icloudEv]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("google-1");
    expect(deduped[0].calendarId).toBe("primary");
  });

  it("icloud:events vs icloud:finance 중복 시 events 가 우선한다", () => {
    const eventsEv = baseEvent({
      id: "icloud:events:uid-1",
      calendarId: ICLOUD_EVENTS_CALENDAR_ID,
    });
    const financeEv = baseEvent({
      id: "icloud:finance:uid-1",
      calendarId: ICLOUD_FINANCE_CALENDAR_ID,
    });

    const deduped = dedupeCandidateEvents([eventsEv, financeEv]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("icloud:events:uid-1");
  });

  it("공백 및 대소문자, NFC 차이를 정규화하여 중복을 제거한다", () => {
    const ev1 = baseEvent({ id: "ev-1", summary: "봄맞이  특가 행사" });
    const ev2 = baseEvent({ id: "ev-2", summary: "봄맞이 특가행사" });
    const ev3 = baseEvent({ id: "ev-3", summary: "Spring Sale" });
    const ev4 = baseEvent({ id: "ev-4", summary: "spring  sale" });

    const deduped = dedupeCandidateEvents([ev1, ev2, ev3, ev4]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].id).toBe("ev-1");
    expect(deduped[1].id).toBe("ev-3");
  });
});

describe("icloud-ics — fetchIcsFeed 에러 메시지 보안", () => {
  it("HTTP 실패 시 URL 원문이나 토큰을 에러 메시지에 노출하지 않는다", async () => {
    const secretUrl = "https://cal.example.com/feed?token=supersecret123";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    await expect(fetchIcsFeed(secretUrl, { fetchImpl: mockFetch as unknown as typeof fetch })).rejects.toThrow(
      "iCloud 캘린더 피드 요청 실패: HTTP 404",
    );

    try {
      await fetchIcsFeed(secretUrl, { fetchImpl: mockFetch as unknown as typeof fetch });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("supersecret123");
      expect(msg).not.toContain("cal.example.com");
    }
  });

  it("네트워크 오류 발생 시에도 URL 을 에러 메시지에 노출하지 않는다", async () => {
    const secretUrl = "https://cal.example.com/feed?token=supersecret123";
    const mockFetch = vi.fn().mockRejectedValue(new TypeError(`Failed to fetch ${secretUrl}`));

    try {
      await fetchIcsFeed(secretUrl, { fetchImpl: mockFetch as unknown as typeof fetch });
      expect.unreachable();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("supersecret123");
      expect(msg).not.toContain("cal.example.com");
      expect(msg).toContain("네트워크 오류");
    }
  });
});

describe("icloud-ics — listMergedInboundCandidateEvents (오류 로깅 및 내결함성)", () => {
  const RANGE = { timeMin: "2026-11-01", timeMax: "2026-11-30" };

  const makeSampleIcs = (uid: string, summary: string, date: string) => `
BEGIN:VCALENDAR
BEGIN:VEVENT
UID:${uid}
DTSTART;VALUE=DATE:${date}
SUMMARY:${summary}
END:VEVENT
END:VCALENDAR
`.trim();

  it("구글 캘린더와 iCloud 피드를 병렬 조회하여 중복 제거 후 병합한다", async () => {
    const googleEvent: CandidateEvent = {
      id: "g-1",
      calendarId: "primary",
      summary: "공통 행사",
      description: null,
      startDate: "2026-11-10",
      endDate: "2026-11-10",
      htmlLink: "https://calendar.google.com/g-1",
      crmSigned: false,
    };

    const deps = {
      listGoogleCandidates: vi.fn().mockResolvedValue({
        ok: true,
        events: [googleEvent],
        referencedIds: new Set(["ref-1"]),
      }),
      fetchIcs: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("events")) {
          return [
            makeSampleIcs("ic-ev-1", "공통 행사", "20261110"),
            makeSampleIcs("ic-ev-2", "iCloud 전용 행사", "20261115"),
          ].join("\n");
        }
        if (url.includes("finance")) {
          return makeSampleIcs("ic-fin-1", "iCloud 정산 일정", "20261120");
        }
        return "";
      }),
      env: {
        ICLOUD_EVENTS_CALENDAR_URL: FAKE_EVENTS_URL,
        ICLOUD_FINANCE_CALENDAR_URL: FAKE_FINANCE_URL,
      },
    };

    const res = await listMergedInboundCandidateEvents(RANGE, deps);
    expect(res.ok).toBe(true);
    expect(res.events).toHaveLength(3);
    // 1) 구글 이벤트 우선
    expect(res.events[0].id).toBe("g-1");
    // 2) iCloud 행사
    expect(res.events[1].id).toBe("icloud:events:ic-ev-2");
    // 3) iCloud 회계
    expect(res.events[2].id).toBe("icloud:finance:ic-fin-1");
    expect(res.referencedIds.has("ref-1")).toBe(true);
  });

  it("구글 캘린더가 not_connected 여도 iCloud 피드가 성공하면 ok: true 로 반환한다", async () => {
    const deps = {
      listGoogleCandidates: vi.fn().mockResolvedValue({
        ok: false,
        skipped: "not_connected" as const,
        events: [],
        referencedIds: new Set<string>(),
      }),
      fetchIcs: vi.fn().mockResolvedValue(makeSampleIcs("ic-1", "iCloud 단독 일정", "20261110")),
      env: {
        ICLOUD_EVENTS_CALENDAR_URL: FAKE_EVENTS_URL,
      },
    };

    const res = await listMergedInboundCandidateEvents(RANGE, deps);
    expect(res.ok).toBe(true);
    expect(res.events).toHaveLength(1);
    expect(res.events[0].id).toBe("icloud:events:ic-1");
  });

  it("구글 캘린더 실패 시 console.error 로 로깅하고 iCloud 성공 일정은 유지한다 (Finding #4)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const deps = {
      listGoogleCandidates: vi.fn().mockResolvedValue({
        ok: false,
        error: "구글 OAuth 인증 만료",
        events: [],
        referencedIds: new Set<string>(),
      }),
      fetchIcs: vi.fn().mockResolvedValue(makeSampleIcs("ic-1", "iCloud 단독 일정", "20261110")),
      env: {
        ICLOUD_EVENTS_CALENDAR_URL: FAKE_EVENTS_URL,
      },
    };

    const res = await listMergedInboundCandidateEvents(RANGE, deps);
    expect(res.ok).toBe(true);
    expect(res.events).toHaveLength(1);

    expect(errorSpy).toHaveBeenCalled();
    const loggedStr = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(loggedStr).toContain("[icloud-ics] 구글 캘린더 조회 실패: 구글 OAuth 인증 만료");

    errorSpy.mockRestore();
  });

  it("유효하지 않은 URL 이 환경변수에 설정된 경우 원문 미노출 에러를 로깅한다 (Finding #4)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const deps = {
      listGoogleCandidates: vi.fn().mockResolvedValue({
        ok: false,
        skipped: "not_connected" as const,
        events: [],
        referencedIds: new Set<string>(),
      }),
      env: {
        ICLOUD_EVENTS_CALENDAR_URL: "http://malicious-or-invalid.example.com/cal?token=secret123",
      },
    };

    const res = await listMergedInboundCandidateEvents(RANGE, deps);
    // 설정된 유일한 소스가 실패했으므로 ok: false
    expect(res.ok).toBe(false);
    expect(res.error).toContain("모든 캘린더 소스 조회 실패");

    expect(errorSpy).toHaveBeenCalled();
    const loggedStr = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(loggedStr).toContain("[icloud-ics] events 피드 URL 형식이 유효하지 않아 건너뜁니다");
    // URL 원문 및 토큰 비노출 검증
    expect(loggedStr).not.toContain("secret123");
    expect(loggedStr).not.toContain("malicious-or-invalid");

    errorSpy.mockRestore();
  });

  it("일부 iCloud 피드가 실패해도 성공한 피드는 정상 반환되고 console.error 로 로깅된다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const deps = {
      listGoogleCandidates: vi.fn().mockResolvedValue({
        ok: false,
        skipped: "not_connected" as const,
        events: [],
        referencedIds: new Set<string>(),
      }),
      fetchIcs: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("events")) {
          throw new Error("HTTP 500");
        }
        return makeSampleIcs("fin-1", "회계 일정만 성공", "20261120");
      }),
      env: {
        ICLOUD_EVENTS_CALENDAR_URL: FAKE_EVENTS_URL,
        ICLOUD_FINANCE_CALENDAR_URL: FAKE_FINANCE_URL,
      },
    };

    const res = await listMergedInboundCandidateEvents(RANGE, deps);
    expect(res.ok).toBe(true);
    expect(res.events).toHaveLength(1);
    expect(res.events[0].id).toBe("icloud:finance:fin-1");
    expect(errorSpy).toHaveBeenCalled();
    const loggedStr = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(loggedStr).toContain("[icloud-ics] events 피드 조회 실패");

    errorSpy.mockRestore();
  });

  it("구글과 iCloud 모두 미설정이면 ok: false, skipped: not_connected 를 반환한다", async () => {
    const deps = {
      listGoogleCandidates: vi.fn().mockResolvedValue({
        ok: false,
        skipped: "not_connected" as const,
        events: [],
        referencedIds: new Set<string>(),
      }),
      env: {},
    };

    const res = await listMergedInboundCandidateEvents(RANGE, deps);
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe("not_connected");
    expect(res.events).toEqual([]);
  });

  it("설정된 모든 캘린더 소스가 실패하면 ok: false, error 를 반환한다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const deps = {
      listGoogleCandidates: vi.fn().mockResolvedValue({
        ok: false,
        error: "구글 토큰 만료",
        events: [],
        referencedIds: new Set<string>(),
      }),
      fetchIcs: vi.fn().mockRejectedValue(new Error("네트워크 단절")),
      env: {
        ICLOUD_EVENTS_CALENDAR_URL: FAKE_EVENTS_URL,
      },
    };

    const res = await listMergedInboundCandidateEvents(RANGE, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("모든 캘린더 소스 조회 실패");
    expect(res.events).toEqual([]);

    errorSpy.mockRestore();
  });
});
