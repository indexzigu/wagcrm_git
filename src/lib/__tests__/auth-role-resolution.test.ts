/**
 * 실효 역할 해석(`resolveUserRole`) — 이 프로젝트에서 가장 되돌리기 쉬운 지점이다.
 * 종전 기본값이 `"admin"` 이라, 허가목록에 이메일 하나를 추가하는 것이 곧 전체 권한
 * 부여였다. 여기 단언들은 그 기본값이 되살아나는지를 감시한다.
 *
 * ⚠️ 첫 인자는 **`app_metadata.role`**(service_role 만 쓸 수 있는 필드)이다.
 * `user_metadata` 를 넘기는 호출부가 생기면 사용자가 스스로 admin 이 된다 —
 * 호출부 감시는 `middleware-role-gate.test.ts` 의 자기 승격 차단 단언이 담당한다.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_EMAILS, resolveUserRole } from "@/lib/auth-allowlist";

const OWNER_EMAIL = DEFAULT_ADMIN_EMAILS[0];
const STAFF_EMAIL = "staff@example.com";


describe("resolveUserRole — 기본값", () => {
  it("역할 미지정 오너 계정은 admin 을 유지한다 (기존 접근 무손실)", () => {
    // 오너 계정에는 Supabase app_metadata.role 이 없다. 여기가 깨지면 오너가 잠긴다.
    expect(resolveUserRole(undefined, OWNER_EMAIL)).toBe("admin");
    expect(resolveUserRole(null, OWNER_EMAIL)).toBe("admin");
  });

  it("대소문자·공백이 달라도 오너는 admin 이다", () => {
    expect(resolveUserRole(undefined, `  ${OWNER_EMAIL.toUpperCase()} `)).toBe("admin");
  });

  it("역할 미지정 신규 계정은 operator 다 (fail-closed)", () => {
    // ⛔ 여기가 "admin" 으로 바뀌면 직원 이메일을 허가목록에 넣는 순간 전체 권한이 나간다.
    expect(resolveUserRole(undefined, STAFF_EMAIL)).toBe("operator");
  });

  it("이메일이 없는 세션도 operator 다", () => {
    expect(resolveUserRole(undefined, null)).toBe("operator");
    expect(resolveUserRole(undefined, "")).toBe("operator");
  });
});

describe("resolveUserRole — 명시 지정과 이상값", () => {
  it("app_metadata.role 이 유효하면 그것이 이긴다", () => {
    expect(resolveUserRole("operator", OWNER_EMAIL)).toBe("operator");
    expect(resolveUserRole("admin", STAFF_EMAIL)).toBe("admin");
  });

  it("알 수 없는 역할 값은 무시하고 이메일 기준으로 다시 판정한다", () => {
    expect(resolveUserRole("superuser", STAFF_EMAIL)).toBe("operator");
    expect(resolveUserRole("Admin", STAFF_EMAIL)).toBe("operator");
    expect(resolveUserRole({ role: "admin" }, STAFF_EMAIL)).toBe("operator");
    expect(resolveUserRole("superuser", OWNER_EMAIL)).toBe("admin");
  });
});

