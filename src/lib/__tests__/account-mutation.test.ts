import { describe, expect, it } from "vitest";
import { planMutation } from "@/lib/account-mutation";
import { DEFAULT_ADMIN_EMAILS } from "@/lib/auth-allowlist";

const OWNER_EMAIL = DEFAULT_ADMIN_EMAILS[0];
const NOW = "2026-08-08T00:00:00.000Z";

const base = {
  targetEmail: "staff@example.com",
  targetId: "target-1",
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

  it("오너 바닥 계정은 변경할 수 없다", () => {
    const verdict = planMutation({
      ...base,
      targetEmail: OWNER_EMAIL,
      request: { status: "rejected" },
    });
    expect(verdict).toEqual({ ok: false, reason: "오너 계정은 변경할 수 없습니다" });
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
