import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearIcloudFinanceCacheForTest,
  dedupeFinanceEventsAgainstCrm,
  fetchIcloudFinanceEvents,
  normalizeFinanceWebcalUrl,
  parseFinanceIcsEvents,
} from "../icloud-finance-schedule";
import { mergeUpcomingWithFinanceEvents } from "../desktop-dashboard";

describe("icloud-finance-schedule", () => {
  beforeEach(() => {
    clearIcloudFinanceCacheForTest();
  });

  describe("normalizeFinanceWebcalUrl", () => {
    it("webcal:// 공개 호스트를 https://로 변환한다", () => {
      expect(normalizeFinanceWebcalUrl("webcal://caldav.example.com/published/test")).toBe(
        "https://caldav.example.com/published/test",
      );
      expect(normalizeFinanceWebcalUrl("https://caldav.example.com/feed.ics")).toBe(
        "https://caldav.example.com/feed.ics",
      );
    });

    it("비공개 호스트·http·인증정보 포함 URL을 차단한다", () => {
      expect(normalizeFinanceWebcalUrl("http://caldav.example.com/feed.ics")).toBeNull();
      expect(normalizeFinanceWebcalUrl("https://localhost/feed.ics")).toBeNull();
      expect(normalizeFinanceWebcalUrl("https://127.0.0.1/feed.ics")).toBeNull();
      expect(normalizeFinanceWebcalUrl("https://192.168.0.10/feed.ics")).toBeNull();
      expect(normalizeFinanceWebcalUrl("https://user:pass@caldav.example.com/feed.ics")).toBeNull();
      expect(normalizeFinanceWebcalUrl("https://internal/feed.ics")).toBeNull();
    });
  });

  describe("parseFinanceIcsEvents", () => {
    const sampleIcs = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:ev-1",
      "DTSTART;VALUE=DATE:20261125",
      "DTEND;VALUE=DATE:20261126",
      "SUMMARY:부가세 예정 고지 납부",
      "DESCRIPTION:홈택스 납부\\n계좌이체",
      "BEGIN:VALARM",
      "TRIGGER:-PT1H",
      "DESCRIPTION:알람 설명이 본문을 덮어쓰면 안됨",
      "END:VALARM",
      "END:VEVENT",
      // 피드 내부 중복 (공백만 다름)
      "BEGIN:VEVENT",
      "UID:ev-1-dup",
      "DTSTART;VALUE=DATE:20261125",
      "SUMMARY:부가세예정고지납부",
      "END:VEVENT",
      // UTC 2026-11-26 16:00Z = KST 2026-11-27 01:00
      "BEGIN:VEVENT",
      "UID:ev-2",
      "DTSTART:20261126T160000Z",
      "SUMMARY:원천세 신고",
      "END:VEVENT",
      // 취소된 일정 제외
      "BEGIN:VEVENT",
      "UID:ev-3",
      "DTSTART;VALUE=DATE:20261128",
      "SUMMARY:취소된 회계 일정",
      "STATUS:CANCELLED",
      "END:VEVENT",
      // 범위 밖 일정 제외
      "BEGIN:VEVENT",
      "UID:ev-4",
      "DTSTART;VALUE=DATE:20261215",
      "SUMMARY:다음달 일정",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    it("범위 내 유효 일정만 파싱하고 취소·서브컴포넌트·내부 중복을 정리한다", () => {
      const events = parseFinanceIcsEvents(sampleIcs, "2026-11-01", "2026-11-30");
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        id: "icloud-finance:ev-1",
        date: "2026-11-25",
        endDate: "2026-11-25",
        title: "부가세 예정 고지 납부",
        description: "홈택스 납부\n계좌이체",
      });
      expect(events[1]).toEqual({
        id: "icloud-finance:ev-2",
        date: "2026-11-27",
        endDate: "2026-11-27",
        title: "원천세 신고",
        description: null,
      });
    });
  });

  describe("dedupeFinanceEventsAgainstCrm & mergeUpcomingWithFinanceEvents", () => {
    it("같은 날 CRM 정산 일정과 제목이 겹치면 제외하고, 다른 날·다른 일정은 유지한다", () => {
      const financeEvents = [
        { id: "f-1", date: "2026-11-25", endDate: "2026-11-25", title: "브랜드A 정산 입금", description: null },
        { id: "f-2", date: "2026-11-25", endDate: "2026-11-25", title: "부가세 납부", description: null },
        { id: "f-3", date: "2026-11-28", endDate: "2026-11-28", title: "브랜드A 정산 입금", description: null },
      ];
      const crmEvents = [
        { date: "2026-11-25T00:00:00+09:00", type: "입금 예정", label: "브랜드A" },
      ];

      const deduped = dedupeFinanceEventsAgainstCrm(financeEvents, crmEvents);
      expect(deduped.map((e) => e.id)).toEqual(["f-2", "f-3"]);

      const merged = mergeUpcomingWithFinanceEvents(crmEvents, financeEvents);
      expect(merged).toHaveLength(3);
      expect(merged.map((e) => `${e.type}:${e.label}`)).toEqual([
        "입금 예정:브랜드A",
        "회계 일정:부가세 납부",
        "회계 일정:브랜드A 정산 입금",
      ]);
    });
  });

  describe("fetchIcloudFinanceEvents", () => {
    it("환경변수 미설정 또는 네트워크 오류 시 빈 배열로 fail-soft 한다", async () => {
      expect(await fetchIcloudFinanceEvents("2026-11-01", "2026-11-30", { envUrl: "" })).toEqual([]);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const failingFetch = vi.fn().mockRejectedValue(new Error("boom"));
      const res = await fetchIcloudFinanceEvents("2026-11-01", "2026-11-30", {
        envUrl: "webcal://caldav.example.com/secret-token-should-not-log",
        fetchImpl: failingFetch as unknown as typeof fetch,
      });
      expect(res).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.flat().join(" ")).not.toContain("secret-token-should-not-log");
      warnSpy.mockRestore();
    });

    it("TTL 내 재호출은 캐시를 재사용한다", async () => {
      const ics = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:c-1",
        "DTSTART;VALUE=DATE:20261125",
        "SUMMARY:급여 이체",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
      const fetchImpl = vi.fn().mockResolvedValue(new Response(ics, { status: 200 }));

      const first = await fetchIcloudFinanceEvents("2026-11-01", "2026-11-30", {
        envUrl: "webcal://caldav.example.com/feed.ics",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowMs: 1_000_000,
      });
      const second = await fetchIcloudFinanceEvents("2026-11-01", "2026-11-30", {
        envUrl: "webcal://caldav.example.com/feed.ics",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowMs: 1_060_000,
      });

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});
