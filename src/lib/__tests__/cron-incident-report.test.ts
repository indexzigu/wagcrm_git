import { describe, it, expect } from "vitest";
import {
  digestWindow,
  formatDigest,
  formatImmediate,
  formatRecovery,
  incidentCauseLabel,
  type DigestIncident,
  type ReportIncident,
} from "@/lib/cron-incident-report";
import { ownerActionFor } from "@/lib/cron-incident-escalation";

// 기준 시각: KST 2026-10-18 09:30
const NOW = new Date("2026-10-18T00:30:00Z");

function incident(over: Partial<ReportIncident> = {}): ReportIncident {
  return {
    id: "inc1",
    jobKey: "naver-settlement-sync",
    kind: "A",
    errorKind: "network",
    firstSeenAt: new Date("2026-10-17T18:00:00Z"), // KST 10-18 03:00
    ownerAction: "외부 서비스 상태를 확인해 주세요.",
    prNumber: null,
    normalizedAt: null,
    normalizedEvidence: null,
    actions: null,
    ...over,
  };
}

const digestItem = (over: Partial<DigestIncident> = {}): DigestIncident => ({
  ...incident(over),
  jobName: "네이버 정산 동기화",
  ...over,
});

describe("incidentCauseLabel", () => {
  it.each([
    ["network", "네트워크 끊김"],
    ["timeout", "시간 초과"],
    ["upstream_5xx", "외부 서버 오류"],
    ["proxy_quota", "프록시 한도 소진"],
    ["auth", "인증 실패"],
    ["rate_limit", "호출 한도 초과"],
    ["config", "설정·접속 오류"],
    ["app_down", "서버 응답 없음"],
    ["unknown", "원인 불명"],
  ] as const)("A/%s → %s", (errorKind, label) => {
    expect(incidentCauseLabel("A", errorKind)).toBe(label);
  });

  it("B 는 오류 종류와 무관하게 「결과 0건」", () => {
    expect(incidentCauseLabel("B", null)).toBe("결과 0건");
    expect(incidentCauseLabel("B", "network")).toBe("결과 0건");
  });

  it("오류 종류가 없으면 「원인 불명」", () => {
    expect(incidentCauseLabel("A", null)).toBe("원인 불명");
  });
});

describe("formatImmediate", () => {
  it("A 는 원인과 조치 두 줄", () => {
    expect(formatImmediate(incident(), "네이버 정산 동기화")).toEqual({
      key: "incident-inc1",
      icon: "🙋",
      title: "네이버 정산 동기화 조치대기",
      detail: "원인: 네트워크 끊김\n조치: 외부 서비스 상태를 확인해 주세요.",
      ackField: "alertedAt",
      incidentIds: ["inc1"],
    });
  });

  it("B 는 조치 한 줄", () => {
    const msg = formatImmediate(incident({ kind: "B", errorKind: null, ownerAction: "로그를 봐 주세요." }), "작업");
    expect(msg.detail).toBe("조치: 로그를 봐 주세요.");
  });

  it("PR 번호가 있으면 끝에 붙인다", () => {
    const msg = formatImmediate(incident({ prNumber: 42 }), "작업");
    expect(msg.detail).toBe("원인: 네트워크 끊김\n조치: 외부 서비스 상태를 확인해 주세요.\nPR #42");
  });

  it("조치 문구가 비어 있으면 승격 규칙의 문구로 채운다", () => {
    const msg = formatImmediate(incident({ ownerAction: null, errorKind: "auth" }), "작업");
    expect(msg.detail).toBe(`원인: 인증 실패\n조치: ${ownerActionFor({ kind: "A", errorKind: "auth" })}`);
  });
});

describe("formatRecovery", () => {
  it("오늘(KST) 정상화면 HH:mm, 실행 시각은 정상화 증거의 runAt", () => {
    const msg = formatRecovery(
      incident({
        normalizedAt: new Date("2026-10-18T00:10:00Z"),
        normalizedEvidence: { runAt: "2026-10-18T00:05:00.000Z" },
      }),
      "네이버 정산 동기화",
      NOW,
    );
    expect(msg).toEqual({
      key: "incident-inc1-ok",
      icon: "✅",
      title: "네이버 정산 동기화 정상화",
      detail: "09:05 실행부터 정상입니다.",
      ackField: "recoveryAlertedAt",
      incidentIds: ["inc1"],
    });
  });

  it("다른 날이면 MM-DD HH:mm", () => {
    const msg = formatRecovery(
      incident({ normalizedAt: new Date("2026-10-17T10:00:00Z"), normalizedEvidence: null }),
      "작업",
      NOW,
    );
    expect(msg.detail).toBe("10-17 19:00 실행부터 정상입니다.");
  });

  it("KST 자정 경계: UTC 로는 같은 날이어도 KST 로 하루 앞이면 날짜를 붙인다", () => {
    // UTC 10-17 14:59 = KST 10-17 23:59, NOW 는 KST 10-18
    const msg = formatRecovery(incident({ normalizedAt: new Date("2026-10-17T14:59:00Z") }), "작업", NOW);
    expect(msg.detail).toBe("10-17 23:59 실행부터 정상입니다.");
  });
});

describe("digestWindow", () => {
  it("KST 오늘 08:00 이후면 전날 08:00 ~ 오늘 08:00", () => {
    const { start, end } = digestWindow(NOW);
    expect(start.toISOString()).toBe("2026-10-16T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-17T23:00:00.000Z");
  });

  it("KST 08:00 전이면 한 칸 앞 창(아직 오지 않은 08:00 을 끝으로 잡지 않는다)", () => {
    const { start, end } = digestWindow(new Date("2026-10-17T22:00:00Z")); // KST 10-18 07:00
    expect(start.toISOString()).toBe("2026-10-15T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-16T23:00:00.000Z");
  });
});

describe("formatDigest", () => {
  const resolvedOne = digestItem({
    id: "r1",
    normalizedAt: new Date("2026-10-17T21:15:00Z"), // KST 06:15
  });

  it("정상화·조치대기가 모두 0이면 null(막은 건만으로는 보내지 않는다)", () => {
    expect(formatDigest([], [], 3, NOW)).toBeNull();
    expect(formatDigest([], [], 0, NOW)).toBeNull();
  });

  it("정상화 줄 · 조치대기 줄 · 막은 건 꼬리", () => {
    const waiting = digestItem({ id: "w1", kind: "B", errorKind: null, jobName: "스토리 수집" });
    const msg = formatDigest([resolvedOne], [waiting], 2, NOW);
    expect(msg).toEqual({
      key: "digest-incident",
      icon: "📋",
      title: "지난 24시간 자동화 작업",
      detail: [
        "정상화 1건",
        "10-18 03:00 네이버 정산 동기화 · 네트워크 끊김 · 정상화 06:15",
        "조치대기 1건",
        "스토리 수집 · 결과 0건",
        "알림 직전에 정상화돼 보내지 않은 건 2건",
      ].join("\n"),
      ackField: "digestedAt",
      incidentIds: ["r1"],
    });
  });

  it("actions 마지막 항목이 있으면 정상화 앞에 조치를 넣는다", () => {
    const withAction = digestItem({
      id: "r2",
      normalizedAt: new Date("2026-10-17T21:15:00Z"),
      actions: [
        { at: "2026-10-17T19:00:00Z", what: "처음 조치" },
        { at: "2026-10-17T20:00:00Z", what: "다시 시도" },
      ],
    });
    const msg = formatDigest([withAction], [], 0, NOW);
    expect(msg?.detail).toBe(
      "정상화 1건\n10-18 03:00 네이버 정산 동기화 · 네트워크 끊김 · 다시 시도 · 정상화 06:15",
    );
  });

  it("조치대기가 7일을 넘으면 (N일째)", () => {
    const old = digestItem({ id: "w2", firstSeenAt: new Date("2026-10-09T00:30:00Z") }); // 9일 전
    const recent = digestItem({ id: "w3", firstSeenAt: new Date("2026-10-11T00:30:00Z") }); // 7일 전
    const msg = formatDigest([], [old, recent], 0, NOW);
    expect(msg?.detail).toBe(
      "조치대기 2건\n네이버 정산 동기화 · 네트워크 끊김 (9일째)\n네이버 정산 동기화 · 네트워크 끊김",
    );
  });

  it("C 사고는 줄로 싣지 않는다", () => {
    const c = digestItem({ id: "c1", kind: "C", errorKind: null, normalizedAt: new Date("2026-10-17T21:15:00Z") });
    expect(formatDigest([c], [], 0, NOW)).toBeNull();
  });

  it("15줄을 넘으면 앞 15줄 + 외 N건, 확인 표시는 정상화 사고 전부", () => {
    const resolved = Array.from({ length: 12 }, (_, n) =>
      digestItem({ id: `r${n}`, normalizedAt: new Date("2026-10-17T21:15:00Z") }),
    );
    const waiting = Array.from({ length: 6 }, (_, n) => digestItem({ id: `w${n}` }));
    const msg = formatDigest(resolved, waiting, 0, NOW)!;
    const lines = msg.detail.split("\n");
    const itemLines = lines.filter((l) => l.includes(" · "));
    expect(itemLines).toHaveLength(15);
    expect(lines).toContain("정상화 12건");
    expect(lines).toContain("조치대기 6건");
    expect(lines[lines.length - 1]).toBe("외 3건");
    expect(msg.incidentIds).toEqual(resolved.map((r) => r.id));
  });

  it("긴 줄표를 쓰지 않는다", () => {
    const msg = formatDigest([resolvedOne], [digestItem({ id: "w1" })], 1, NOW)!;
    expect(msg.detail).not.toContain("—");
    expect(msg.title).not.toContain("—");
  });
});
