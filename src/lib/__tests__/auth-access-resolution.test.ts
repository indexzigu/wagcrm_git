/**
 * 접근 판정(`resolveAccess`)의 갈래를 고정한다.
 * ⚠️ 상태·역할은 반드시 app_metadata 에서만 읽는다 — user_metadata 는 사용자 본인이
 * 쓸 수 있어 권한 상승 구멍이 된다.
 * ⚠️ 이메일로 통과시키는 바닥은 없다(2026-10-06) — 오너 잠김 방지는 `account-mutation.ts` 의
 * 마지막 관리자 보호가 맡는다.
 */
import { describe, expect, it } from "vitest";
import { resolveAccess } from "@/lib/auth-allowlist";

describe("resolveAccess", () => {
  it("status 가 없으면 대기다", () => {
    const decision = resolveAccess({});
    expect(decision.approved).toBe(false);
    expect(decision.status).toBe("pending");
  });

  it("metadata 자체가 없어도 대기다(fail-closed)", () => {
    expect(resolveAccess(null)).toEqual({ approved: false, status: "pending", role: "operator" });
    expect(resolveAccess(undefined).approved).toBe(false);
  });

  it("status 가 rejected 면 차단이다 — admin 역할이어도", () => {
    const decision = resolveAccess({ status: "rejected", role: "admin" });
    expect(decision.approved).toBe(false);
    expect(decision.status).toBe("rejected");
  });

  it("approved 면 통과하고 역할은 app_metadata.role 을 따른다", () => {
    expect(resolveAccess({ status: "approved", role: "operator" })).toEqual({
      approved: true,
      status: "approved",
      role: "operator",
    });
    expect(resolveAccess({ status: "approved", role: "admin" })).toEqual({
      approved: true,
      status: "approved",
      role: "admin",
    });
  });

  it("approved 인데 role 이 없으면 operator 로 떨어진다(fail-closed)", () => {
    const decision = resolveAccess({ status: "approved" });
    expect(decision.role).toBe("operator");
  });

  it("중첩된 user_metadata 안의 승인 값은 읽지 않는다", () => {
    const decision = resolveAccess(
      { user_metadata: { status: "approved", role: "admin" } } as Record<string, unknown>,
    );
    expect(decision.approved).toBe(false);
    expect(decision.status).toBe("pending");
  });
});
