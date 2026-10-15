/**
 * 상품 매핑 등록·수정 기안(`upsert_product_mappings`)의 **계획 함수** — DB 를 읽지도 쓰지도 않는다.
 * 승인 실행기(`src/lib/agent/write-actions/upsert-product-mappings.ts`)가 지금 줄을 읽어 넘기고,
 * 테스트가 같은 함수를 직접 부른다.
 *
 * 줄 대조 키는 계약의 `normalizeMappingOptionName`(NFC + 앞뒤 공백 제거 + 안쪽 연속 공백 1칸)이다.
 * 한 줄이라도 걸리면 기안 전체가 실패한다(일부만 반영하지 않는다).
 */
import { normalizeMappingOptionName, type ProductMappingRowInput } from "@/lib/agent-worker/contracts";

export type ExistingMappingRow = {
  id: string;
  optionName: string;
  productName: string;
  brandCode: string;
  price: number;
};

export type MappingUpsertPlan =
  | {
      ok: true;
      creates: ProductMappingRowInput[];
      updates: Array<{ id: string; row: ProductMappingRowInput }>;
      unchanged: number;
    }
  | { ok: false; reason: string };

function describeValue(brandCode: string, price: number): string {
  return `${brandCode === "" ? "빈 코드" : brandCode}/${price.toLocaleString("ko-KR")}원`;
}

export function planProductMappingUpsert(
  existing: ExistingMappingRow[],
  rows: ProductMappingRowInput[],
): MappingUpsertPlan {
  const byOption = new Map<string, ExistingMappingRow[]>();
  for (const current of existing) {
    const key = normalizeMappingOptionName(current.optionName);
    byOption.set(key, [...(byOption.get(key) ?? []), current]);
  }

  const creates: ProductMappingRowInput[] = [];
  const updates: Array<{ id: string; row: ProductMappingRowInput }> = [];
  let unchanged = 0;

  for (const row of rows) {
    const key = normalizeMappingOptionName(row.optionName);
    const matches = byOption.get(key) ?? [];

    // ① 같은 옵션명 줄이 이미 둘 이상 — 어느 줄을 고칠지 정할 수 없다.
    if (matches.length >= 2) {
      return {
        ok: false,
        reason: `「${key}」 매핑이 이미 ${matches.length}줄 있습니다. CRM 화면에서 중복을 먼저 정리하세요.`,
      };
    }

    const isNewRow = row.expectedBrandCode === null || row.expectedPrice === null;

    if (matches.length === 0) {
      // ② 고칠 줄로 올라왔는데 지금 없다.
      if (!isNewRow) {
        return { ok: false, reason: `「${key}」 매핑이 지금 없습니다(기안은 고칠 줄로 올라옴).` };
      }
      creates.push(row);
      continue;
    }

    const current = matches[0];
    // ③ 새 줄로 올라왔는데 이미 있다.
    if (isNewRow) {
      return { ok: false, reason: `「${key}」 매핑이 이미 있습니다(기안은 새 줄로 올라옴).` };
    }

    // ④ 지금 값이 기안 때 본 값과 다르다(낙관적 동시성).
    if (current.brandCode !== row.expectedBrandCode || current.price !== row.expectedPrice) {
      return {
        ok: false,
        reason:
          `「${key}」 지금 값(${describeValue(current.brandCode, current.price)})이 ` +
          `기안 때(${describeValue(row.expectedBrandCode ?? "", row.expectedPrice ?? 0)})와 다릅니다.`,
      };
    }

    // ⑤ 바꿀 값이 지금과 같다 — 쓰지 않는다.
    const sameProductName = row.productName === undefined || row.productName === current.productName;
    if (current.brandCode === row.brandCode && current.price === row.price && sameProductName) {
      unchanged += 1;
      continue;
    }

    // ⑥
    updates.push({ id: current.id, row });
  }

  return { ok: true, creates, updates, unchanged };
}
