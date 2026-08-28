import { ClaimCheckerPanel } from "@/components/crm/claim-checker-panel";
import { CrmShell } from "@/components/crm/crm-shell";
import { getPrisma } from "@/lib/prisma";

/**
 * 표현 검사 (C1 M2) — 셀러에게 나가는 자료·셀러가 제출한 콘텐츠를
 * 발행 전에 법령 위반 소지로 훑는 화면.
 *
 * 규칙(17건 내외)은 서버에서 한 번 읽어 클라이언트로 넘긴다 — `checkText`가
 * 순수 함수라 타이핑하는 동안 왕복 없이 즉시 판정된다. 규칙 수가 수백 건으로
 * 늘면 그때 서버 판정으로 옮긴다.
 *
 * ⚠️ `export const dynamic`은 쓰지 않는다 — `nextConfig.cacheComponents`가
 * 켜져 있어 라우트 세그먼트 config와 비호환이다(빌드가 아니라 컴파일에서 막힌다).
 */
export default async function ClaimCheckPage() {
  const prisma = getPrisma();
  const [rows, deals] = await Promise.all([
    prisma.bannedPhraseRule.findMany({
      where: { active: true },
      orderBy: [{ category: "asc" }, { phrase: "asc" }],
      select: {
        id: true,
        phrase: true,
        pattern: true,
        category: true,
        severity: true,
        legalBasis: true,
        note: true,
      },
    }),
    // 딜을 고르면 그 딜의 승인 소구점·전용 금지·필수 고지까지 함께 검사한다.
    // 종료된 딜(ARCHIVED/DROPPED)은 검사 대상이 아니라 목록에서 뺀다.
    prisma.deal.findMany({
      where: { status: { notIn: ["ARCHIVED", "DROPPED"] } },
      orderBy: [{ updatedAt: "desc" }],
      select: { id: true, dealName: true, brandName: true, category: true },
    }),
  ]);

  // CrmShell 로 감싸는 이유는 헤더 통일만이 아니다 — 데스크톱 CRM 전 페이지의
  // 실제 세로 스크롤러가 이 셸 내부 div(`[scrollbar-gutter:stable]`)라,
  // 벗어나면 위반 목록이 길어질 때 스크롤바 등장으로 폭이 튄다(P8 Layout Stability).
  return (
    <CrmShell
      title="표현 검사"
      description="셀러에게 보낼 자료나 셀러가 올린 초안을 발행 전에 훑습니다. 판정은 참고용 안내이며 법률 자문이 아닙니다. 최종 판단은 담당자가 합니다."
    >
      <ClaimCheckerPanel rules={rows} deals={deals} />
    </CrmShell>
  );
}
