import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { FIELD_LABELS } from "@/lib/field-labels";
import { updateDealSchema } from "@/lib/validations/deal";
import { updatePartnerSchema } from "@/lib/validations/partner";
import { updateSellerSchema } from "@/lib/validations/seller";

/**
 * **활동 기록 칸 이름 커버리지** — 수정 스키마의 모든 칸이 `FIELD_LABELS` 에 있어야 한다.
 *
 * 서비스 4곳(`dealService`·`partnerService`·`sellerPatchService`·`sellerService`)은 바뀐 칸을
 * `FIELD_LABELS[key] || key` 로 활동 기록에 **저장**한다. 표에 없으면 `supplyPrice` 같은 영문
 * 칸 이름이 저장돼 캠페인·딜 타임라인에 그대로 보였다(2026-10-15 실측 34칸). 저장 시점이라
 * 「—」로 덮을 수 없으므로(어느 칸이 바뀌었는지 잃는다) 표 등록을 이 테스트로 강제한다.
 * 실패하면: 새 칸을 `src/lib/field-labels.ts` 에 화면 이름과 함께 등록한다.
 */
/**
 * 이 표를 거치지 않고 전용 감사 함수가 기록하는 칸. 주민등록번호는 `buildResidentNumberAuditEntry` 가
 * 값 없이 기록하고, 그 낱말은 `resident-number-exposure.contract.test.ts` 의 허용 파일 밖에 쓰지 않는다.
 */
const OWN_AUDIT_PATH = new Set(["residentNumber"]);

function keysOf(schema: z.ZodObject<z.ZodRawShape>): string[] {
  return Object.keys(schema.shape);
}

describe("FIELD_LABELS 커버리지", () => {
  it.each([
    ["딜", keysOf(updateDealSchema)],
    ["거래처", keysOf(updatePartnerSchema)],
    ["셀러", keysOf(updateSellerSchema)],
  ])("%s 수정 스키마의 모든 칸에 화면 이름이 있다", (_name, keys) => {
    expect(keys.length).toBeGreaterThan(5); // 0칸이면 늘 초록이다
    expect(keys.filter((k) => !Object.hasOwn(FIELD_LABELS, k) && !OWN_AUDIT_PATH.has(k))).toEqual([]);
  });
});
