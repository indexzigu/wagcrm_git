// 셀러 포털 슬러그의 DB 존재 여부만 확인한다 — proxy(미들웨어) 전용.
//
// `portal-gate.ts` 의 `resolvePortalSeller` 를 재사용하지 않는 이유: 그 파일은 최상단에서
// `next/headers` 의 `cookies()` 를 import 한다(다른 export가 쓴다). `next/headers` 는
// Server Component·Route Handler 전용 API라 proxy 에서 import 하면 빌드가 막힌다. 이 파일은
// Prisma 조회 하나만 하는 최소 모듈이라 proxy 에 안전하게 들여올 수 있다.
//
// ⚠️ `portal-slug.ts`·`bot-scan-paths.ts` 와 달리 이 파일은 **Node 전용**이다(Prisma) —
// 클라이언트 컴포넌트가 저 두 파일을 직접 import 하므로(예: 셀러 상세 화면의 슬러그 미리보기)
// 그 파일들의 "edge/클라이언트 안전" 계약을 지키려고 이 조회 로직을 분리했다. proxy 자체는
// Next.js 16 부터 Node.js 런타임이 기본이라(`proxy.ts` 에 `runtime` 오버라이드 없음) 이 모듈을
// 그쪽에서 import 하는 것 자체는 안전하다.
import { getPrisma } from "@/lib/prisma";

/**
 * 포맷은 유효하지만 실재하는 셀러인지 — 값은 돌려주지 않고 존재 여부만 답한다(최소 정보,
 * 이 조회가 잘못 로그에 찍혀도 셀러 데이터가 새지 않는다).
 *
 * DB 조회가 실패하면(일시적 커넥션 문제 등) 던지지 않고 `null` 을 돌려준다 — 호출부는 이걸
 * "모른다"로 받아 **통과시켜야 한다**(fail-open). proxy 는 이 앱의 거의 모든 요청이 지나는
 * 지점이라, 여기서 fail-closed 로 만들면 DB 일시 장애 한 번이 전체 셀러 포털을 통째로
 * 404 시킨다 — 지금 없애려는 "무증상 낭비"보다 훨씬 큰 사고다.
 */
export async function portalSlugExists(slug: string): Promise<boolean | null> {
  try {
    const seller = await getPrisma().seller.findUnique({
      where: { portalSlug: slug },
      select: { id: true },
    });
    return seller !== null;
  } catch (error) {
    console.warn("[portal-slug-existence] 조회 실패 — 통과시킵니다(fail-open).", error);
    return null;
  }
}
