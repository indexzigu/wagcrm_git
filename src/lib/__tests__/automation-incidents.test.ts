/**
 * 자동화 작업 사고 → 화면 표시(「오늘 처리할 일」 줄 · 「자동화 작업 상태」 설명창 「이상 기록」) 계약.
 * 판정 문구(원인 낱말)는 `incidentCauseLabel` 하나를 쓴다 — 여기서는 묶기·정렬·시각 표기만 본다.
 */
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_INCIDENT_FIELDS,
  INCIDENT_STATUS_LABELS,
  incidentDetailLines,
  incidentTimeText,
  summarizeWaitingJobs,
  type AutomationIncident,
} from "../automation-incidents";
import { KNOWN_JOBS } from "../cron-jobs";

const [jobA, jobB] = KNOWN_JOBS;

function incident(overrides: Partial<AutomationIncident> = {}): AutomationIncident {
  return {
    id: "i-1",
    jobKey: jobA.key,
    kind: "A",
    errorKind: "auth",
    status: "waiting_owner",
    ownerAction: "연동 설정에서 다시 로그인해 주세요.",
    firstSeenAt: "2026-10-17T00:30:00.000Z",
    normalizedAt: null,
    occurrences: 1,
    cause: null,
    causeConfidence: null,
    ...overrides,
  };
}

describe("AUTOMATION_INCIDENT_FIELDS", () => {
  it("화면이 받는 칸은 이 11개뿐이다 — 원문 메시지(lastMessage)는 내려보내지 않는다", () => {
    expect([...AUTOMATION_INCIDENT_FIELDS]).toEqual([
      "id",
      "jobKey",
      "kind",
      "errorKind",
      "status",
      "ownerAction",
      "firstSeenAt",
      "normalizedAt",
      "occurrences",
      "cause",
      "causeConfidence",
    ]);
    expect(AUTOMATION_INCIDENT_FIELDS).not.toContain("lastMessage");
  });
});

describe("INCIDENT_STATUS_LABELS", () => {
  it("상태 낱말은 붙여 쓴 한 낱말이다", () => {
    expect(INCIDENT_STATUS_LABELS).toEqual({ waiting_owner: "조치대기", open: "재확인중", resolved: "정상화" });
  });
});

describe("summarizeWaitingJobs", () => {
  it("조치대기가 없으면 null", () => {
    expect(summarizeWaitingJobs([])).toBeNull();
    expect(summarizeWaitingJobs([incident({ status: "open" })])).toBeNull();
  });

  it("작업 1개면 「작업 이름 · 원인」", () => {
    expect(summarizeWaitingJobs([incident()])).toEqual({ jobCount: 1, detail: `${jobA.name} · 인증 실패` });
  });

  it("작업 2개·사고 3건 → 작업 수 2, 가장 오래된 작업 이름 + 「외 1건」", () => {
    const out = summarizeWaitingJobs([
      incident({ id: "a1", jobKey: jobA.key, firstSeenAt: "2026-10-17T05:00:00.000Z" }),
      incident({ id: "b1", jobKey: jobB.key, firstSeenAt: "2026-10-16T05:00:00.000Z", kind: "B", errorKind: null }),
      incident({ id: "a2", jobKey: jobA.key, firstSeenAt: "2026-10-18T05:00:00.000Z", errorKind: "config" }),
    ]);
    expect(out).toEqual({ jobCount: 2, detail: `${jobB.name} 외 1건` });
  });

  it("한 작업에 사고가 여럿이면 그 작업의 가장 오래된 사고 원인을 쓴다", () => {
    const out = summarizeWaitingJobs([
      incident({ id: "a2", firstSeenAt: "2026-10-18T05:00:00.000Z", errorKind: "config" }),
      incident({ id: "a1", firstSeenAt: "2026-10-17T05:00:00.000Z", errorKind: "proxy_quota" }),
    ]);
    expect(out).toEqual({ jobCount: 1, detail: `${jobA.name} · 프록시 한도 소진` });
  });

  it("플레이북 원인이 있으면 원인 칸에 확신과 함께 그 원인을 쓴다", () => {
    expect(
      summarizeWaitingJobs([incident({ cause: "인스타그램 접근 토큰 만료", causeConfidence: "확정" })])?.detail,
    ).toBe(`${jobA.name} · 확정 인스타그램 접근 토큰 만료`);
  });

  it("목록에 없는 작업은 「알 수 없음」으로 — 영문 작업 키를 화면에 내지 않는다", () => {
    expect(summarizeWaitingJobs([incident({ jobKey: "retired-job" })])?.detail).toBe("알 수 없음 · 인증 실패");
  });
});

describe("incidentTimeText", () => {
  it("조치대기·재확인중은 「MM-DD HH:mm 시작」(KST), 2회 이상이면 「N회 발생」을 붙인다", () => {
    expect(incidentTimeText(incident())).toBe("10-17 09:30 시작");
    expect(incidentTimeText(incident({ status: "open", occurrences: 3 }))).toBe("10-17 09:30 시작 · 3회 발생");
  });

  it("정상화는 「MM-DD HH:mm 시작 · HH:mm 정상화」", () => {
    expect(
      incidentTimeText(incident({ status: "resolved", normalizedAt: "2026-10-17T03:05:00.000Z", occurrences: 4 })),
    ).toBe("10-17 09:30 시작 · 12:05 정상화");
  });

  it("정상화가 시작과 다른 날(KST)이면 정상화에도 날짜를 붙인다", () => {
    // 10-17 23:50 KST 시작 → 10-18 00:20 KST 정상화(UTC 로는 같은 날이지만 KST 로는 날이 넘어간다)
    expect(
      incidentTimeText(
        incident({ status: "resolved", firstSeenAt: "2026-10-17T14:50:00.000Z", normalizedAt: "2026-10-17T15:20:00.000Z" }),
      ),
    ).toBe("10-17 23:50 시작 · 10-18 00:20 정상화");
  });
});

describe("incidentDetailLines", () => {
  const waitingOld = incident({ id: "w-old", firstSeenAt: "2026-10-10T00:00:00.000Z" });
  const waitingNew = incident({ id: "w-new", firstSeenAt: "2026-10-12T00:00:00.000Z" });
  const open = incident({ id: "o", status: "open", firstSeenAt: "2026-10-11T00:00:00.000Z" });
  const resolvedOld = incident({ id: "r-old", status: "resolved", normalizedAt: "2026-10-13T00:00:00.000Z" });
  const resolvedNew = incident({ id: "r-new", status: "resolved", normalizedAt: "2026-10-15T00:00:00.000Z" });

  it("정렬: 조치대기(오래된 순) → 재확인중 → 정상화(최근 순)", () => {
    const { shown, hiddenCount } = incidentDetailLines([resolvedOld, open, waitingNew]);
    expect(shown.map((i) => i.id)).toEqual(["w-new", "o", "r-old"]);
    expect(hiddenCount).toBe(0);
    expect(incidentDetailLines([resolvedOld, resolvedNew]).shown.map((i) => i.id)).toEqual(["r-new", "r-old"]);
  });

  it("최대 3줄 — 넘치면 숨긴 수를 돌려준다", () => {
    const { shown, hiddenCount } = incidentDetailLines([resolvedOld, resolvedNew, open, waitingOld]);
    expect(shown.map((i) => i.id)).toEqual(["w-old", "o", "r-new"]);
    expect(hiddenCount).toBe(1);
  });

  it("조치대기는 3줄을 넘어도 자르지 않는다", () => {
    const waiting = [1, 2, 3, 4].map((n) => incident({ id: `w${n}`, firstSeenAt: `2026-10-1${n}T00:00:00.000Z` }));
    const { shown, hiddenCount } = incidentDetailLines([open, ...waiting]);
    expect(shown.map((i) => i.id)).toEqual(["w1", "w2", "w3", "w4"]);
    expect(hiddenCount).toBe(1);
  });
});
