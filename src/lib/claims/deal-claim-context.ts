/**
 * 딜 클레임 컨텍스트 — 게이트·생성기에 **무엇을 넣을지**를 한 곳에서 결정한다.
 *
 * 판정 자체는 `claim-gate.ts`의 순수 함수가 한다. 이 파일은 그 입력을 만든다:
 * 카테고리 상속 · 부모 클레임 상속 · 승인분 선별.
 *
 * ⚠️ **서버 전용이다**(Prisma 접근). 클라이언트에서 쓰지 말 것 — 판정이 필요하면
 * `checkText`에 규칙을 주입해서 쓴다(`claim-checker-panel.tsx` 선례).
 *
 * ── 왜 뽑았나 (실사고 2건) ────────────────────────────────────────────────
 * 상속 규약(C1 §4)이 `/api/deals/[id]/claims` 라우트에 **인라인으로만** 있었다.
 * 그래서 C3 M1 이 게이트를 붙일 때 같은 규약을 손으로 다시 썼고, **두 군데가
 * 실제로 어긋났다**(2026-07-30 실측):
 *
 * | | claims 라우트(정본) | content-guide 라우트(어긋남) |
 * | --- | --- | --- |
 * | 클레임 | `dealId: { in: [자기, 부모] }` = **합집합** | `parentDealId ?? id` = **부모로 치환** |
 * | 카테고리 | `deal.category ?? parent.category` = 자기 우선 | `parent.category ?? deal.category` = **부모 우선** |
 *
 * 결과: ①옵션 딜의 **자기 전용 금지 표현이 생성 게이트에서 무시**됐다(브랜드가
 * 옵션에만 건 제약이 조용히 풀린다) ②옵션에 카테고리를 지정해도 부모 것으로
 * 덮여 **엉뚱한 카테고리 규칙이 적용**됐다.
 *
 * 금지 표현 정규식이 규칙마다 어미 열거가 어긋나 검출이 갈렸던 것과 **같은
 * 종류의 표류**다 — 규약을 문서가 아니라 함수로 고정한다. 새 호출부는 반드시
 * 이 함수를 쓰고, `dealId: { in: ... }` 를 손으로 다시 쓰지 않는다.
 */
import { getPrisma } from "@/lib/prisma";
import type { DealClaimInput } from "./claim-gate";

/**
 * DB에서 읽는 `DealClaim` 행.
 *
 * 게이트는 `kind`·`text`·`status`만 쓰지만 **관리 화면(`deal-claims-section`)이
 * 같은 응답을 소비**하므로 그쪽이 렌더에 쓰는 필드까지 담는다. 여기서 필드를
 * 빼면 화면에서 검토 기한·출처가 조용히 사라진다 — 이 함수를 쓰는 곳이
 * 게이트만이 아니라는 점을 기억할 것.
 */
export interface DealClaimRow {
  id: string;
  dealId: string;
  kind: "APPROVED_CLAIM" | "BANNED_PHRASE" | "REQUIRED_DISCLOSURE";
  text: string;
  status: "PROPOSED" | "APPROVED" | "REJECTED" | "EXPIRED";
  evidence: string | null;
  evidenceType: "MEASURED" | "USER_PROVIDED" | "NEEDS_SOURCE";
  reviewBy: Date | null;
  approvedAt: Date | null;
  rejectedNote: string | null;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** 부모 딜에서 물려받은 행이면 true — 옵션 화면에서 편집 혼동을 막는다. */
  inherited: boolean;
}

export interface DealClaimContext {
  /** 게이트에 넘길 카테고리. 옵션 딜은 자기 값 우선, 없으면 부모 값. */
  category: string | null;
  /** 딜 자신 + 부모 상속분(모든 status — 관리 화면이 검토 대기도 보여야 한다). */
  claims: DealClaimRow[];
}

/**
 * 카테고리 상속 — **옵션 딜에 따로 지정돼 있으면 그쪽이 우선**, 없으면 부모 값.
 *
 * ⚠️ 순서를 뒤집지 말 것. 부모 우선으로 쓰면 옵션에 지정한 카테고리가 무시돼
 * 엉뚱한 카테고리 규칙이 적용된다(content-guide 라우트에서 실제로 발생).
 */
export function resolveClaimCategory(
  dealCategory: string | null,
  parentCategory: string | null,
): string | null {
  return dealCategory ?? parentCategory ?? null;
}

/**
 * 딜(+부모)의 클레임과 카테고리를 읽는다. 딜이 없으면 null.
 *
 * ⚠️ 상속은 **합집합이다(부모로 치환이 아니다)** — 옵션에 걸린 고유 제약과
 * 본품에 걸린 제약이 **둘 다** 살아야 한다. C2 오퍼 진단이 `parentDealId ?? id`
 * 로 부모만 보는 것과 다르다: 오퍼는 본품 단위로 성립하지만 표현 제약은
 * 누적된다. **두 규약을 통일하려 들지 말 것.**
 */
export async function loadDealClaimContext(
  dealId: string,
): Promise<DealClaimContext | null> {
  const prisma = getPrisma();

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { id: true, category: true, parentDealId: true },
  });
  if (!deal) return null;

  const parent = deal.parentDealId
    ? await prisma.deal.findUnique({
        where: { id: deal.parentDealId },
        select: { id: true, category: true },
      })
    : null;

  const rows = await prisma.dealClaim.findMany({
    where: { dealId: { in: parent ? [deal.id, parent.id] : [deal.id] } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      dealId: true,
      kind: true,
      text: true,
      status: true,
      evidence: true,
      evidenceType: true,
      reviewBy: true,
      approvedAt: true,
      rejectedNote: true,
      source: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    category: resolveClaimCategory(deal.category, parent?.category ?? null),
    claims: rows.map((row) => ({ ...row, inherited: row.dealId !== deal.id })),
  };
}

/**
 * 게이트(`checkText`)에 넘길 클레임 — **승인분만.**
 *
 * 검토 대기(PROPOSED)·거절(REJECTED)·만료(EXPIRED)가 검사에 반영되면 승인
 * 규율(C1 §2-3)이 무의미해진다. 특히 PROPOSED 를 넣으면 AI 가 추출한 미검수
 * 표현이 곧 "승인된 소구점"처럼 취급된다(C1 M3 가 막은 함정).
 */
export function toGateClaims(claims: DealClaimRow[]): DealClaimInput[] {
  return claims
    .filter((claim) => claim.status === "APPROVED")
    .map((claim) => ({ id: claim.id, kind: claim.kind, text: claim.text }));
}

/** 프롬프트 주입용으로 kind 별로 가른 승인 클레임. */
export interface PromptClaims {
  approved: DealClaimRow[];
  banned: DealClaimRow[];
  disclosures: DealClaimRow[];
}

/**
 * 프롬프트에 넣을 승인 클레임을 kind 별로 가른다(C3 §4-1).
 * `toGateClaims`와 같은 승인 필터를 쓴다 — 프롬프트와 게이트가 서로 다른
 * 집합을 보면 "주입했는데 위반으로 잡히는" 모순이 생긴다.
 */
export function selectPromptClaims(claims: DealClaimRow[]): PromptClaims {
  const approvedOnly = claims.filter((claim) => claim.status === "APPROVED");
  return {
    approved: approvedOnly.filter((c) => c.kind === "APPROVED_CLAIM"),
    banned: approvedOnly.filter((c) => c.kind === "BANNED_PHRASE"),
    disclosures: approvedOnly.filter((c) => c.kind === "REQUIRED_DISCLOSURE"),
  };
}
