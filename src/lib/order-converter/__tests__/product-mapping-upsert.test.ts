import { describe, expect, it } from "vitest";
import type { ProductMappingRowInput } from "@/lib/agent-worker/contracts";
import { planProductMappingUpsert, type ExistingMappingRow } from "../product-mapping-upsert";

const existing = (patch: Partial<ExistingMappingRow> = {}): ExistingMappingRow => ({
  id: "pm-1",
  optionName: "샘플 상품 A 3개",
  productName: "샘플 상품 A",
  brandCode: "TC000101",
  price: 15000,
  ...patch,
});

const newRow = (patch: Partial<ProductMappingRowInput> = {}): ProductMappingRowInput => ({
  optionName: "샘플 상품 A 3개",
  brandCode: "TC000102",
  price: 20000,
  expectedBrandCode: null,
  expectedPrice: null,
  ...patch,
});

const updateRow = (patch: Partial<ProductMappingRowInput> = {}): ProductMappingRowInput =>
  newRow({ expectedBrandCode: "TC000101", expectedPrice: 15000, ...patch });

describe("planProductMappingUpsert", () => {
  it("① refuses when the same normalized option already has 2+ rows (even for a new row)", () => {
    const plan = planProductMappingUpsert(
      [existing(), existing({ id: "pm-2", optionName: " 샘플 상품 A  3개" })],
      [updateRow()],
    );
    expect(plan).toEqual({
      ok: false,
      reason: "「샘플 상품 A 3개」 매핑이 이미 2줄 있습니다. CRM 화면에서 중복을 먼저 정리하세요.",
    });
  });

  it("② refuses an update row when nothing exists now", () => {
    expect(planProductMappingUpsert([], [updateRow()])).toEqual({
      ok: false,
      reason: "「샘플 상품 A 3개」 매핑이 지금 없습니다(기안은 고칠 줄로 올라옴).",
    });
  });

  it("③ refuses a new row when one already exists", () => {
    expect(planProductMappingUpsert([existing()], [newRow()])).toEqual({
      ok: false,
      reason: "「샘플 상품 A 3개」 매핑이 이미 있습니다(기안은 새 줄로 올라옴).",
    });
  });

  it("④ refuses when the current brandCode/price differ from what the proposal saw", () => {
    expect(planProductMappingUpsert([existing({ price: 14000 })], [updateRow()])).toEqual({
      ok: false,
      reason: "「샘플 상품 A 3개」 지금 값(TC000101/14,000원)이 기안 때(TC000101/15,000원)와 다릅니다.",
    });
  });

  it("④ treats an empty current brandCode as a value (\"\" must match \"\", not null)", () => {
    const plan = planProductMappingUpsert(
      [existing({ brandCode: "" })],
      [updateRow({ expectedBrandCode: "", expectedPrice: 15000 })],
    );
    expect(plan).toMatchObject({ ok: true, updates: [{ id: "pm-1" }] });
  });

  it("⑤ counts a row whose new values equal the current ones as unchanged", () => {
    const plan = planProductMappingUpsert(
      [existing()],
      [updateRow({ brandCode: "TC000101", price: 15000, productName: "샘플 상품 A" })],
    );
    expect(plan).toEqual({ ok: true, creates: [], updates: [], unchanged: 1 });
  });

  it("⑤ a different productName is a change even when code and price are the same", () => {
    const row = updateRow({ brandCode: "TC000101", price: 15000, productName: "샘플 상품 A 기본" });
    expect(planProductMappingUpsert([existing()], [row])).toEqual({
      ok: true,
      creates: [],
      updates: [{ id: "pm-1", row }],
      unchanged: 0,
    });
  });

  it("⑥ plans a create for a new row and an update for a changed row", () => {
    const create = newRow({ optionName: "샘플 상품 B 1개" });
    const update = updateRow();
    expect(planProductMappingUpsert([existing()], [create, update])).toEqual({
      ok: true,
      creates: [create],
      updates: [{ id: "pm-1", row: update }],
      unchanged: 0,
    });
  });

  it("matches existing row despite extra inner spaces", () => {
    const row = updateRow();
    const plan = planProductMappingUpsert([existing({ optionName: "샘플 상품 A  3개" })], [row]);
    expect(plan).toEqual({ ok: true, creates: [], updates: [{ id: "pm-1", row }], unchanged: 0 });
  });

  it("matches an existing NFD-decomposed option name against an NFC proposal row (update, not create)", () => {
    const row = updateRow({ optionName: "샘플 상품 B 1개".normalize("NFC") });
    const stored = existing({ optionName: "샘플 상품 B 1개".normalize("NFD") });
    expect(stored.optionName).not.toBe(row.optionName);
    const plan = planProductMappingUpsert([stored], [row]);
    expect(plan).toEqual({ ok: true, creates: [], updates: [{ id: "pm-1", row }], unchanged: 0 });
  });

  it("counts a mix exactly (new 1 · changed 1 · unchanged 1) and ignores unrelated existing rows", () => {
    const rows = [
      newRow({ optionName: "샘플 상품 B 1개" }),
      updateRow(),
      updateRow({ optionName: "샘플 상품 C 2개", brandCode: "TC0099", price: 8000, expectedBrandCode: "TC0099", expectedPrice: 8000 }),
    ];
    const plan = planProductMappingUpsert(
      [
        existing(),
        existing({ id: "pm-3", optionName: "샘플 상품 C 2개", brandCode: "TC0099", price: 8000 }),
        existing({ id: "pm-9", optionName: "샘플 상품 D 1개" }),
      ],
      rows,
    );
    expect(plan).toMatchObject({ ok: true, unchanged: 1 });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.creates).toHaveLength(1);
    expect(plan.updates).toEqual([{ id: "pm-1", row: rows[1] }]);
  });

  it("fails the whole plan when any one row is refused", () => {
    const plan = planProductMappingUpsert([existing()], [newRow({ optionName: "샘플 상품 B 1개" }), newRow()]);
    expect(plan.ok).toBe(false);
  });
});
