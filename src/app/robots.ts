import type { MetadataRoute } from "next";

/**
 * robots.txt — 전면 크롤 금지.
 *
 * 이 앱에 검색엔진에 실려서 좋은 표면은 하나도 없다: 운영자 전용 CRM이고, 공개로 도달
 * 가능한 셀러 표면(`/<slug>` 포털 · `/p/[token]`)조차 **색인되면 안 되는 셀러 데이터**다
 * (슬러그는 공개 취급이지만 비밀번호 게이트가 접근 자격이며, 검색결과 노출은 그 전제를 깬다).
 *
 * 지금까지 이 파일이 없었고 `/robots.txt`마저 인증 미들웨어에 막혀 307이었다 — 크롤러가
 * "긁지 마라"를 **읽을 수조차 없는** 상태였다. 그 결과 공개 도메인이 무제한 스캔 대상이 됐고,
 * 미인증 요청은 전부 `/login` 렌더 + Supabase 세션조회를 유발해 서버리스 CPU와 DB egress를
 * 태웠다(관측상 미인증 요청이 전체 호출의 대부분). 같은 PR에서 미들웨어 제외를 함께 넣어야
 * 이 파일이 실제로 크롤러에게 도달한다.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        disallow: "/",
      },
    ],
  };
}
