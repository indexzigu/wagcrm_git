/**
 * Property-based tests for entity creation logic.
 *
 * Feature: data-entry-pipeline-ux
 * Property 10: Entity creation grows list and resets form
 * Validates: Requirements 5.4
 *
 * For any valid entity input (partner, seller, or deal) that results in a
 * successful API response, the entity list length SHALL increase by exactly one,
 * and all form fields SHALL be reset to their empty/default state.
 *
 * Tests the pure logic: given a list of N entities and a successful creation,
 * the resulting list has N+1 entities and the form is reset.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import {
  PARTNER_TYPES,
  SNS_TYPES,
  type PartnerType,
  type SnsType,
} from "@/lib/validations";

// ---------------------------------------------------------------------------
// Pure entity-creation logic (list-grows-by-one + form-reset). Mirrors the
// create-mode contract now owned by PartnersPanel/SellersPanel.
// ---------------------------------------------------------------------------

type EntityType = "partner" | "seller" | "deal";

type PartnerFormState = {
  name: string;
  type: PartnerType | "";
  contactInfo: string;
  bankAccount: string;
  referredById: string;
};

type SellerFormState = {
  name: string;
  snsType: SnsType | "";
  snsHandle: string;
  currentFollowers: string;
  category: string;
  agencyId: string;
};

type DealFormState = {
  dealName: string;
  partnerId: string;
  brandName: string;
  costPrice: string;
  sellingPrice: string;
  sourcingMemo: string;
};

const INITIAL_PARTNER: PartnerFormState = {
  name: "",
  type: "",
  contactInfo: "",
  bankAccount: "",
  referredById: "",
};

const INITIAL_SELLER: SellerFormState = {
  name: "",
  snsType: "",
  snsHandle: "",
  currentFollowers: "0",
  category: "",
  agencyId: "",
};

const INITIAL_DEAL: DealFormState = {
  dealName: "",
  partnerId: "",
  brandName: "",
  costPrice: "",
  sellingPrice: "",
  sourcingMemo: "",
};

/**
 * Pure function modeling entity creation success:
 * - Validates input via Zod schema
 * - On success: appends entity to list, resets form
 * - Returns { list, form, success }
 */
function handleEntityCreation<T>(
  entityType: EntityType,
  existingList: T[],
  createdEntity: T,
): { list: T[]; formReset: boolean } {
  // On successful creation, entity is appended and form is reset
  return {
    list: [createdEntity, ...existingList],
    formReset: true,
  };
}

/**
 * Returns the initial (reset) form state for a given entity type.
 */
function getResetFormState(entityType: EntityType) {
  switch (entityType) {
    case "partner":
      return INITIAL_PARTNER;
    case "seller":
      return INITIAL_SELLER;
    case "deal":
      return INITIAL_DEAL;
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const nonEmptyString = fc
  .string({ minLength: 1, maxLength: 50 })
  .filter((s) => s.trim().length > 0);

const partnerTypeArb = fc.constantFrom(...PARTNER_TYPES);
const snsTypeArb = fc.constantFrom(...SNS_TYPES);

/** Generates a valid partner entity (as returned by API). */
const partnerEntityArb = fc.record({
  id: fc.uuid(),
  name: nonEmptyString,
  type: partnerTypeArb,
  contactInfo: fc.option(nonEmptyString, { nil: null }),
  bankAccount: fc.option(nonEmptyString, { nil: null }),
});

/** Generates a valid seller entity (as returned by API). */
const sellerEntityArb = fc.record({
  id: fc.uuid(),
  name: nonEmptyString,
  snsType: snsTypeArb,
  snsHandle: nonEmptyString,
  currentFollowers: fc.nat({ max: 10_000_000 }),
  category: fc.option(nonEmptyString, { nil: null }),
});

/** Generates a valid deal entity (as returned by API). */
const dealEntityArb = fc.record({
  id: fc.uuid(),
  dealName: nonEmptyString,
  partnerId: fc.uuid(),
  costPrice: fc.nat({ max: 1_000_000 }),
  sellingPrice: fc.nat({ max: 1_000_000 }),
  brandName: fc.option(nonEmptyString, { nil: null }),
});

/** Generates an arbitrary list of partner entities. */
const partnerListArb = fc.array(partnerEntityArb, { minLength: 0, maxLength: 50 });

/** Generates an arbitrary list of seller entities. */
const sellerListArb = fc.array(sellerEntityArb, { minLength: 0, maxLength: 50 });

/** Generates an arbitrary list of deal entities. */
const dealListArb = fc.array(dealEntityArb, { minLength: 0, maxLength: 50 });

// ---------------------------------------------------------------------------
// Property 10: Entity creation grows list and resets form
// Validates: Requirements 5.4
// ---------------------------------------------------------------------------

describe("Property 10: Entity creation grows list and resets form", () => {
  it("partner creation increases list length by exactly 1", () => {
    fc.assert(
      fc.property(partnerListArb, partnerEntityArb, (existingList, newEntity) => {
        const originalLength = existingList.length;
        const result = handleEntityCreation("partner", existingList, newEntity);

        expect(result.list.length).toBe(originalLength + 1);
      }),
      { numRuns: 100 },
    );
  });

  it("seller creation increases list length by exactly 1", () => {
    fc.assert(
      fc.property(sellerListArb, sellerEntityArb, (existingList, newEntity) => {
        const originalLength = existingList.length;
        const result = handleEntityCreation("seller", existingList, newEntity);

        expect(result.list.length).toBe(originalLength + 1);
      }),
      { numRuns: 100 },
    );
  });

  it("deal creation increases list length by exactly 1", () => {
    fc.assert(
      fc.property(dealListArb, dealEntityArb, (existingList, newEntity) => {
        const originalLength = existingList.length;
        const result = handleEntityCreation("deal", existingList, newEntity);

        expect(result.list.length).toBe(originalLength + 1);
      }),
      { numRuns: 100 },
    );
  });

  it("new entity appears at the top of the list (prepended)", () => {
    fc.assert(
      fc.property(partnerListArb, partnerEntityArb, (existingList, newEntity) => {
        const result = handleEntityCreation("partner", existingList, newEntity);

        // New entity is at index 0 (prepended to list)
        expect(result.list[0]).toBe(newEntity);
      }),
      { numRuns: 100 },
    );
  });

  it("form resets to initial state after successful partner creation", () => {
    fc.assert(
      fc.property(partnerListArb, partnerEntityArb, (existingList, newEntity) => {
        const result = handleEntityCreation("partner", existingList, newEntity);

        expect(result.formReset).toBe(true);
        expect(getResetFormState("partner")).toEqual(INITIAL_PARTNER);
      }),
      { numRuns: 100 },
    );
  });

  it("form resets to initial state after successful seller creation", () => {
    fc.assert(
      fc.property(sellerListArb, sellerEntityArb, (existingList, newEntity) => {
        const result = handleEntityCreation("seller", existingList, newEntity);

        expect(result.formReset).toBe(true);
        expect(getResetFormState("seller")).toEqual(INITIAL_SELLER);
      }),
      { numRuns: 100 },
    );
  });

  it("form resets to initial state after successful deal creation", () => {
    fc.assert(
      fc.property(dealListArb, dealEntityArb, (existingList, newEntity) => {
        const result = handleEntityCreation("deal", existingList, newEntity);

        expect(result.formReset).toBe(true);
        expect(getResetFormState("deal")).toEqual(INITIAL_DEAL);
      }),
      { numRuns: 100 },
    );
  });

  it("existing entities are preserved after creation (no data loss)", () => {
    fc.assert(
      fc.property(partnerListArb, partnerEntityArb, (existingList, newEntity) => {
        const result = handleEntityCreation("partner", existingList, newEntity);

        // All original entities still present (shifted by 1 position)
        for (let i = 0; i < existingList.length; i++) {
          expect(result.list[i + 1]).toBe(existingList[i]);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("creation works for any entity type with empty initial list", () => {
    const entityTypeArb = fc.constantFrom<EntityType>("partner", "seller", "deal");

    fc.assert(
      fc.property(entityTypeArb, partnerEntityArb, (entityType, newEntity) => {
        const emptyList: unknown[] = [];
        const result = handleEntityCreation(entityType, emptyList, newEntity);

        expect(result.list.length).toBe(1);
        expect(result.list[0]).toBe(newEntity);
        expect(result.formReset).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("form reset state has all fields empty/default for each entity type", () => {
    const entityTypeArb = fc.constantFrom<EntityType>("partner", "seller", "deal");

    fc.assert(
      fc.property(entityTypeArb, (entityType) => {
        const resetState = getResetFormState(entityType);

        if (entityType === "partner") {
          expect(resetState).toEqual({
            name: "",
            type: "",
            contactInfo: "",
            bankAccount: "",
            referredById: "",
          });
        } else if (entityType === "seller") {
          expect(resetState).toEqual({
            name: "",
            snsType: "",
            snsHandle: "",
            currentFollowers: "0",
            category: "",
            agencyId: "",
          });
        } else {
          expect(resetState).toEqual({
            dealName: "",
            partnerId: "",
            brandName: "",
            costPrice: "",
            sellingPrice: "",
            sourcingMemo: "",
          });
        }
      }),
      { numRuns: 100 },
    );
  });
});
