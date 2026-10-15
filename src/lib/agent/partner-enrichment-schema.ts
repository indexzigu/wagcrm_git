import { newPartnerInputSchema } from "@/lib/agent-worker/contracts";
import type { PartnerEnrichmentField } from "@/lib/agent/partner-enrichment";

/**
 * 계산서 보강 값의 모양(서버 전용) — 칸마다 **거래처 입력 계약과 같은 검사**를 쓴다.
 * 여기서 길이·형식을 다시 적으면 실행 시점 검증과 갈려, 승인은 됐는데 실행이 실패하는 기안이 생긴다.
 *
 * 소비처 둘: 승인(`approve-proposal.ts` — 통째로 검사) · 조회 라우트(칸마다 검사해 저장할 수 없는
 * 값을 미리 「저장 불가」로 표시한다. 안 그러면 주소 한 칸이 길어서 승인 전체가 막힌다).
 */
export const partnerEnrichmentSchema = newPartnerInputSchema
  .pick({
    businessNumber: true,
    ceoName: true,
    businessType: true,
    businessItem: true,
    address: true,
    representativeEmail: true,
  })
  .strict();

/** 한 칸의 값이 계약을 통과하는가. */
export function isAcceptableEnrichmentValue(field: PartnerEnrichmentField, value: string): boolean {
  return partnerEnrichmentSchema.shape[field].safeParse(value).success;
}
