import { ApprovalDetail } from "@/components/crm/approvals/approval-detail";

/**
 * 결재함 상세 — 기안 한 건 또는 봇 조회 결과 한 건 (Plan 2 Task 5).
 *
 * ⚠️ `export const dynamic` 을 붙이지 말 것 — `cacheComponents` 를 켠 Next 16 에서는
 * 그 지시자와 함께 쓸 수 없다(허브 `page.tsx` 와 같은 제약).
 *
 * 기안 id 는 빌드 타임에 알 수 없다. cacheComponents 모드는 `generateStaticParams` 가
 * 최소 1건을 돌려줘야 빌드 검증을 할 수 있으므로(빈 배열이면 EmptyGenerateStaticParamsError)
 * 자리표시자 하나만 두고 실제 트래픽은 전부 on-demand 로 그린다
 * (선례: `src/app/assets/price-sheets/[id]/page.tsx`).
 */
export async function generateStaticParams() {
  return [{ id: "__build_placeholder__" }];
}

export default async function ApprovalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ApprovalDetail id={id} />;
}
