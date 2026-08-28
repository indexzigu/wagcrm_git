"use client";

import * as React from "react";
import { isClientDemoMode } from "@/lib/demo-mode";
import { parseRole, ROLE_COOKIE, type UserRole } from "@/lib/auth-roles";

function readRoleCookie(): UserRole | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${ROLE_COOKIE}=([^;]*)`),
  );
  return match ? parseRole(decodeURIComponent(match[1])) : null;
}

/**
 * 화면 표시용 역할. 미들웨어가 매 요청에 심는 `wag_crm_role` 쿠키를 읽는다.
 *
 * ⚠️ **권한 경계가 아니다** — 이 값이 무엇이든 실제 접근은 미들웨어가 Supabase 세션으로
 * 다시 판정한다(`src/lib/supabase/middleware.ts` 역할 게이트). 여기서 하는 일은 "어차피
 * 눌러도 막히는 메뉴를 애초에 안 보여주는 것"뿐이다.
 *
 * 🪤 **초기값이 `null`("아직 모름") 인 것은 의도다.** 쿠키를 `useState` 초기화에서 읽으면
 * 서버 렌더(document 없음)와 클라이언트 첫 렌더(쿠키 있음)가 어긋나 하이드레이션 불일치가
 * 난다. 그래서 첫 렌더는 양쪽 모두 `null` 로 맞추고 마운트 후 확정한다.
 *
 * 소비처는 `null` 을 각자 해석한다 — **메뉴 표시는 낙관적으로**(`role === "operator"` 일
 * 때만 숨김 → admin 에게 깜빡임 없음), **네트워크 조회는 비관적으로**(`role === "admin"`
 * 일 때만 발사). 종전처럼 초기값을 `"admin"` 으로 두면 operator 의 첫 프레임이 차단된
 * 조회 API 를 실제로 쏘고 전부 403 을 받는다(데이터는 안 새지만 매 로드마다 실패 로그가
 * 쌓인다 — 리뷰 지적 2026-08-06).
 */
export function useUserRole(): UserRole | null {
  const [role, setRole] = React.useState<UserRole | null>(null);

  React.useEffect(() => {
    // 데모 배포에는 Supabase 세션도 역할 쿠키도 없다 — 열람 전용 admin 으로 고정한다.
    if (isClientDemoMode()) {
      setRole("admin");
      return;
    }
    // 쿠키가 없으면(미들웨어를 못 거친 경로·dev 우회) admin 으로 본다 — 서버가 진짜 경계다.
    setRole(readRoleCookie() ?? "admin");
  }, []);

  return role;
}
