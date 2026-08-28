import { connection } from "next/server";

import { InflowReportClient } from "@/components/crm/inflow-report-client";
import { getInflowReport } from "@/lib/inflow-report";
import { getPrisma } from "@/lib/prisma";

/**
 * 유입 리포트 — **동적 표면이다(`use cache` 금지).**
 *
 * 클릭은 Cloudflare Worker 가 PostgREST 로 Supabase 에 직접 쓴다. 즉 이 앱에는 그 쓰기를
 * 아는 코드가 없어서 **캐시 태그를 깰 주체가 존재하지 않는다.** 여기에 `use cache` 를 걸면
 * 운영자가 방금 들어온 유입을 보지 못한 채 낡은 숫자를 신선한 것으로 읽게 되고, 되돌릴
 * 방법도 없다(태그 무효화가 영원히 안 일어난다).
 *
 * 등록은 `CRM_DYNAMIC_SURFACES`(`src/lib/cache-policy.ts`)에 있다.
 *
 * ⚠️ `export const dynamic = "force-dynamic"` 를 쓰지 않는다 — 이 레포는 Next 16
 * `cacheComponents` 가 켜져 있어 그 라우트 세그먼트 설정이 **빌드 에러**다
 * ("Route segment config \"dynamic\" is not compatible with nextConfig.cacheComponents").
 * 그 모드에서는 `"use cache"` 가 없는 것이 곧 동적이므로, 캐시를 **안 거는 것** 자체가
 * 선언이다. 되살리지 말 것.
 */

export default async function InflowReportPage() {
  // `cacheComponents` 아래에서는 서버 컴포넌트가 **요청 데이터를 먼저 읽기 전에**
  // `new Date()` 를 쓸 수 없다("used `new Date()` before accessing … Request data").
  // 이 리포트는 "판매 기간 안인가" · "7일 안에 만료되는가" 를 현재 시각으로 판정하므로
  // 요청 시점이 필요하다 — `connection()` 이 그 선언이다.
  //
  // ⚠️ P6 이 경계하는 "ISR 표면에 connection() 을 뿌리는 것" 과 다른 경우다. 저건 캐시를
  // 버리는 행위지만, 이 페이지는 애초에 캐시를 걸 수 없는 표면이라
  // (`CRM_DYNAMIC_SURFACES` 등록 — Worker 가 DB 에 직접 써서 태그를 깰 주체가 없다)
  // 잃을 캐시가 없다.
  await connection();

  const report = await getInflowReport(getPrisma());

  return <InflowReportClient report={report} />;
}
