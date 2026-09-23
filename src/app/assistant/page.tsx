import { redirect } from "next/navigation";

/**
 * CRM 자체 채팅은 은퇴했다(PR 3) — 기안 승인·조회 결과는 결재함이 소유한다.
 *
 * 경로를 지우지 않고 리다이렉트로 남기는 이유: 북마크·옛 딥링크가 404 로 떨어지지 않게
 * 하는 것과, `/assistant` 가 `RESERVED_PORTAL_SLUGS`(`src/lib/portal-slug.ts`)에 들어
 * 있어서다 — 라우트가 사라져도 그 예약은 유지돼야 셀러 포털이 이 슬러그를 가져가지 않는다.
 * 선례는 `src/app/settings/page.tsx`.
 */
export default function AssistantPage() {
  redirect("/approvals");
}
