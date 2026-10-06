import { describe, expect, it } from "vitest";
import { planMutation } from "@/lib/account-mutation";
const NOW = "2026-08-08T00:00:00.000Z";

const base = {
  targetId: "target-1",
  approvedAdminIds: ["actor-1", "admin-2"] as readonly string[],
  actorEmail: "admin@example.com",
  actorId: "actor-1",
  nowIso: NOW,
};

describe("planMutation", () => {
  it("승인은 status 와 role 과 부여 기록을 함께 쓴다", () => {
    const verdict = planMutation({ ...base, request: { status: "approved", role: "operator" } });
    expect(verdict).toEqual({
      ok: true,
      metadata: {
        status: "approved",
        role: "operator",
        grantedBy: "admin@example.com",
        grantedAt: NOW,
      },
    });
  });

  it("마지막 관리자는 강등할 수 없다", () => {
    const verdict = planMutation({
      ...base,
      approvedAdminIds: ["target-1"],
      request: { role: "operator" },
    });
    expect(verdict).toEqual({ ok: false, reason: "마지막 관리자는 내리거나 거절할 수 없습니다" });
  });

  it("마지막 관리자는 거절할 수 없다", () => {
    const verdict = planMutation({
      ...base,
      approvedAdminIds: ["target-1"],
      request: { status: "rejected" },
    });
    expect(verdict).toEqual({ ok: false, reason: "마지막 관리자는 내리거나 거절할 수 없습니다" });
  });

  it("마지막 관리자를 승인 상태로 두며 operator 로 바꾸는 요청도 막는다", () => {
    const verdict = planMutation({
      ...base,
      approvedAdminIds: ["target-1"],
      request: { status: "approved", role: "operator" },
    });
    expect(verdict).toEqual({ ok: false, reason: "마지막 관리자는 내리거나 거절할 수 없습니다" });
  });

  it("관리자가 둘 이상이면 다른 관리자를 강등할 수 있다", () => {
    const verdict = planMutation({
      ...base,
      approvedAdminIds: ["target-1", "actor-1"],
      request: { role: "operator" },
    });
    expect(verdict.ok).toBe(true);
  });

  it("마지막 관리자라도 admin 유지 요청은 막지 않는다", () => {
    const verdict = planMutation({
      ...base,
      approvedAdminIds: ["target-1"],
      request: { status: "approved", role: "admin" },
    });
    expect(verdict.ok).toBe(true);
  });

  it("자기 자신은 강등할 수 없다", () => {
    const verdict = planMutation({
      ...base,
      targetId: "actor-1",
      request: { role: "operator" },
    });
    expect(verdict).toEqual({ ok: false, reason: "자기 자신의 권한은 변경할 수 없습니다" });
  });

  it("자기 자신의 접근 회수도 막는다", () => {
    const verdict = planMutation({
      ...base,
      targetId: "actor-1",
      request: { status: "rejected" },
    });
    expect(verdict.ok).toBe(false);
  });

  it("승인 시 역할이 없으면 거부한다 — 역할 없는 승인 상태를 만들지 않는다", () => {
    const verdict = planMutation({ ...base, request: { status: "approved" } });
    expect(verdict).toEqual({ ok: false, reason: "승인하려면 역할을 함께 지정해야 합니다" });
  });

  it("알 수 없는 값은 거부한다", () => {
    expect(planMutation({ ...base, request: { role: "superuser" as never } }).ok).toBe(false);
    expect(planMutation({ ...base, request: { status: "pending" as never } }).ok).toBe(false);
  });

  it("빈 요청은 거부한다", () => {
    expect(planMutation({ ...base, request: {} }).ok).toBe(false);
  });
});
