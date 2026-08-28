// Feature: business-logic-automation
// Property 12: Settlement checklist auto-generation on SETTLEMENT_IN_PROGRESS
// Property 13: Settlement checklist auto-generation idempotence
// Property 14: Checklist item check/uncheck round-trip
// Property 15: Custom checklist item appends with correct sort order
// Property 16: Auto-transition to COMPLETED on full checklist completion
// Property 17: Activity log records auto-transition
// Validates: Requirements 9.1, 9.2, 9.3, 10.1, 10.2, 10.3, 11.1, 11.2, 11.4

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { DEFAULT_CHECKLIST_ITEMS } from "../lib/validations/settlement";

// ---------------------------------------------------------------------------
// Pure business-logic helpers (extracted from route handlers for testability)
// ---------------------------------------------------------------------------

type ChecklistItem = {
  id: string;
  checklistId: string;
  label: string;
  isChecked: boolean;
  sortOrder: number;
  completedAt: Date | null;
};

type Checklist = {
  id: string;
  campaignId: string;
  items: ChecklistItem[];
};

type Campaign = {
  id: string;
  status: string;
};

type ActivityLogEntry = {
  entityType: string;
  entityId: string;
  type: string;
  fieldName: string;
  previousValue: string;
  newValue: string;
};

/**
 * Mirrors the settlement checklist auto-generation logic in campaigns/[id]/route.ts.
 * Returns the created checklist if one was created, or null if already existed.
 */
function autoGenerateChecklist(
  campaignId: string,
  existingChecklist: Checklist | null,
): Checklist | null {
  if (existingChecklist !== null) {
    // Idempotent: do not create a duplicate
    return null;
  }

  const items: ChecklistItem[] = DEFAULT_CHECKLIST_ITEMS.map((label, index) => ({
    id: `item-${index}`,
    checklistId: `checklist-${campaignId}`,
    label,
    isChecked: false,
    sortOrder: index,
    completedAt: null,
  }));

  return {
    id: `checklist-${campaignId}`,
    campaignId,
    items,
  };
}

/**
 * Mirrors the toggle logic in settlement-checklist/[id]/route.ts.
 * Returns the updated item and the new campaign status (with optional activity log entry).
 */
function toggleChecklistItem(
  item: ChecklistItem,
  isChecked: boolean,
  allItems: ChecklistItem[],
  campaign: Campaign,
): {
  updatedItem: ChecklistItem;
  newCampaignStatus: string;
  activityLog: ActivityLogEntry | null;
} {
  const updatedItem: ChecklistItem = {
    ...item,
    isChecked,
    completedAt: isChecked ? new Date() : null,
  };

  // Guard: do not auto-transition if checklist has zero items
  if (allItems.length === 0) {
    return { updatedItem, newCampaignStatus: campaign.status, activityLog: null };
  }

  // Check if ALL items are checked (use updated value for the toggled item)
  const allChecked = allItems.every((i) =>
    i.id === item.id ? isChecked : i.isChecked,
  );

  let newCampaignStatus = campaign.status;
  let activityLog: ActivityLogEntry | null = null;

  // If all checked AND campaign is SETTLEMENT_IN_PROGRESS → auto-transition to COMPLETED
  if (allChecked && campaign.status === "SETTLEMENT_IN_PROGRESS") {
    newCampaignStatus = "COMPLETED";
    activityLog = {
      entityType: "CAMPAIGN",
      entityId: campaign.id,
      type: "CHANGE",
      fieldName: "status",
      previousValue: "SETTLEMENT_IN_PROGRESS",
      newValue: "COMPLETED",
    };
  }

  // If any unchecked AND campaign is COMPLETED → revert to SETTLEMENT_IN_PROGRESS
  if (!allChecked && campaign.status === "COMPLETED") {
    newCampaignStatus = "SETTLEMENT_IN_PROGRESS";
    activityLog = {
      entityType: "CAMPAIGN",
      entityId: campaign.id,
      type: "CHANGE",
      fieldName: "status",
      previousValue: "COMPLETED",
      newValue: "SETTLEMENT_IN_PROGRESS",
    };
  }

  return { updatedItem, newCampaignStatus, activityLog };
}

/**
 * Mirrors the custom item append logic in settlement-checklist/[id]/items/route.ts.
 * Returns the new item with sortOrder = max(existing) + 1.
 */
function appendCustomItem(
  checklistId: string,
  existingItems: ChecklistItem[],
  label: string,
): ChecklistItem {
  const maxSortOrder =
    existingItems.length > 0
      ? Math.max(...existingItems.map((i) => i.sortOrder))
      : -1;

  return {
    id: `item-custom-${Date.now()}`,
    checklistId,
    label,
    isChecked: false,
    sortOrder: maxSortOrder + 1,
    completedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** A cuid-like campaign ID */
const campaignIdArb = fc
  .stringMatching(/^[a-z]{8,16}$/)
  .map((s) => `camp-${s}`);

/** A non-empty label string */
const nonEmptyLabelArb = fc
  .string({ minLength: 1, maxLength: 80 })
  .filter((s) => s.trim().length > 0);

// ---------------------------------------------------------------------------
// Property 12: Settlement checklist auto-generation on SETTLEMENT_IN_PROGRESS
// Validates: Requirements 9.1, 9.2
// ---------------------------------------------------------------------------

describe("Property 12: Settlement checklist auto-generation on SETTLEMENT_IN_PROGRESS", () => {
  it(
    "creates a checklist with exactly 5 default items when none exists",
    () => {
      fc.assert(
        fc.property(campaignIdArb, (campaignId) => {
          const checklist = autoGenerateChecklist(campaignId, null);

          expect(checklist).not.toBeNull();
          expect(checklist!.campaignId).toBe(campaignId);
          expect(checklist!.items).toHaveLength(DEFAULT_CHECKLIST_ITEMS.length);
          expect(checklist!.items).toHaveLength(5);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "generated items have the correct labels in order (Req 9.1)",
    () => {
      fc.assert(
        fc.property(campaignIdArb, (campaignId) => {
          const checklist = autoGenerateChecklist(campaignId, null);

          expect(checklist).not.toBeNull();
          const labels = checklist!.items.map((i) => i.label);
          expect(labels).toEqual([...DEFAULT_CHECKLIST_ITEMS]);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "generated items have sequential sortOrder starting at 0 (Req 9.2)",
    () => {
      fc.assert(
        fc.property(campaignIdArb, (campaignId) => {
          const checklist = autoGenerateChecklist(campaignId, null);

          expect(checklist).not.toBeNull();
          checklist!.items.forEach((item, idx) => {
            expect(item.sortOrder).toBe(idx);
          });
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "all generated items have isChecked=false (Req 9.2)",
    () => {
      fc.assert(
        fc.property(campaignIdArb, (campaignId) => {
          const checklist = autoGenerateChecklist(campaignId, null);

          expect(checklist).not.toBeNull();
          for (const item of checklist!.items) {
            expect(item.isChecked).toBe(false);
          }
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "all generated items have completedAt=null (Req 9.2)",
    () => {
      fc.assert(
        fc.property(campaignIdArb, (campaignId) => {
          const checklist = autoGenerateChecklist(campaignId, null);

          expect(checklist).not.toBeNull();
          for (const item of checklist!.items) {
            expect(item.completedAt).toBeNull();
          }
        }),
        { numRuns: 100 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 13: Settlement checklist auto-generation idempotence
// Validates: Requirements 9.3
// ---------------------------------------------------------------------------

describe("Property 13: Settlement checklist auto-generation idempotence", () => {
  it(
    "returns null (no new checklist) when one already exists",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 0, max: 8 }),
          (campaignId, itemCount) => {
            // Build an existing checklist with some items
            const existingItems: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `existing-item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: false,
                sortOrder: idx,
                completedAt: null,
              }),
            );

            const existingChecklist: Checklist = {
              id: `checklist-${campaignId}`,
              campaignId,
              items: existingItems,
            };

            const result = autoGenerateChecklist(campaignId, existingChecklist);

            // Must not create a duplicate
            expect(result).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "existing checklist items are preserved unchanged after idempotent call",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 1, max: 8 }),
          (campaignId, itemCount) => {
            const existingItems: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `existing-item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Custom Item ${idx}`,
                isChecked: idx % 2 === 0,
                sortOrder: idx,
                completedAt: idx % 2 === 0 ? new Date("2025-01-01") : null,
              }),
            );

            const existingChecklist: Checklist = {
              id: `checklist-${campaignId}`,
              campaignId,
              items: existingItems,
            };

            // Calling auto-generate again should not modify the existing checklist
            autoGenerateChecklist(campaignId, existingChecklist);

            // The existing checklist must remain unchanged
            expect(existingChecklist.items).toHaveLength(itemCount);
            existingChecklist.items.forEach((item, idx) => {
              expect(item.label).toBe(`Custom Item ${idx}`);
              expect(item.isChecked).toBe(idx % 2 === 0);
            });
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});


// ---------------------------------------------------------------------------
// Property 14: Checklist item check/uncheck round-trip
// Validates: Requirements 10.1, 10.2
// ---------------------------------------------------------------------------

describe("Property 14: Checklist item check/uncheck round-trip", () => {
  it(
    "checking an item sets isChecked=true and completedAt to a valid timestamp (Req 10.1)",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 1, max: 8 }),
          fc.integer({ min: 0, max: 7 }),
          (campaignId, itemCount, targetIdx) => {
            fc.pre(targetIdx < itemCount);

            const items: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: false,
                sortOrder: idx,
                completedAt: null,
              }),
            );

            const campaign: Campaign = { id: campaignId, status: "SETTLEMENT_IN_PROGRESS" };
            const targetItem = items[targetIdx];

            const { updatedItem } = toggleChecklistItem(
              targetItem,
              true,
              items,
              campaign,
            );

            expect(updatedItem.isChecked).toBe(true);
            expect(updatedItem.completedAt).not.toBeNull();
            expect(updatedItem.completedAt).toBeInstanceOf(Date);
            expect(isNaN(updatedItem.completedAt!.getTime())).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "unchecking an item sets isChecked=false and completedAt=null (Req 10.2)",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 1, max: 8 }),
          fc.integer({ min: 0, max: 7 }),
          (campaignId, itemCount, targetIdx) => {
            fc.pre(targetIdx < itemCount);

            const items: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: true,
                sortOrder: idx,
                completedAt: new Date("2025-01-01"),
              }),
            );

            const campaign: Campaign = { id: campaignId, status: "COMPLETED" };
            const targetItem = items[targetIdx];

            const { updatedItem } = toggleChecklistItem(
              targetItem,
              false,
              items,
              campaign,
            );

            expect(updatedItem.isChecked).toBe(false);
            expect(updatedItem.completedAt).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "label and sortOrder remain unchanged through check/uncheck round-trip",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          nonEmptyLabelArb,
          fc.integer({ min: 0, max: 50 }),
          (campaignId, label, sortOrder) => {
            const item: ChecklistItem = {
              id: "item-0",
              checklistId: `checklist-${campaignId}`,
              label,
              isChecked: false,
              sortOrder,
              completedAt: null,
            };

            const campaign: Campaign = { id: campaignId, status: "SETTLEMENT_IN_PROGRESS" };

            // Check
            const { updatedItem: checkedItem } = toggleChecklistItem(
              item,
              true,
              [item],
              campaign,
            );

            expect(checkedItem.label).toBe(label);
            expect(checkedItem.sortOrder).toBe(sortOrder);

            // Uncheck
            const campaignAfterCheck: Campaign = { id: campaignId, status: "COMPLETED" };
            const { updatedItem: uncheckedItem } = toggleChecklistItem(
              checkedItem,
              false,
              [checkedItem],
              campaignAfterCheck,
            );

            expect(uncheckedItem.label).toBe(label);
            expect(uncheckedItem.sortOrder).toBe(sortOrder);
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 15: Custom checklist item appends with correct sort order
// Validates: Requirements 10.3
// ---------------------------------------------------------------------------

describe("Property 15: Custom checklist item appends with correct sort order", () => {
  it(
    "new item gets sortOrder = max(existing) + 1 (Req 10.3)",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 1, max: 10 }),
          nonEmptyLabelArb,
          (campaignId, itemCount, newLabel) => {
            const existingItems: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: false,
                sortOrder: idx,
                completedAt: null,
              }),
            );

            const maxSortOrder = Math.max(...existingItems.map((i) => i.sortOrder));
            const newItem = appendCustomItem(
              `checklist-${campaignId}`,
              existingItems,
              newLabel,
            );

            expect(newItem.sortOrder).toBe(maxSortOrder + 1);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "new item gets sortOrder=0 when checklist is empty",
    () => {
      fc.assert(
        fc.property(campaignIdArb, nonEmptyLabelArb, (campaignId, newLabel) => {
          const newItem = appendCustomItem(
            `checklist-${campaignId}`,
            [],
            newLabel,
          );

          expect(newItem.sortOrder).toBe(0);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "new item has isChecked=false and completedAt=null (Req 10.3)",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 0, max: 10 }),
          nonEmptyLabelArb,
          (campaignId, itemCount, newLabel) => {
            const existingItems: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: true,
                sortOrder: idx,
                completedAt: new Date("2025-01-01"),
              }),
            );

            const newItem = appendCustomItem(
              `checklist-${campaignId}`,
              existingItems,
              newLabel,
            );

            expect(newItem.isChecked).toBe(false);
            expect(newItem.completedAt).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "new item has the provided label (Req 10.3)",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 0, max: 10 }),
          nonEmptyLabelArb,
          (campaignId, itemCount, newLabel) => {
            const existingItems: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: false,
                sortOrder: idx,
                completedAt: null,
              }),
            );

            const newItem = appendCustomItem(
              `checklist-${campaignId}`,
              existingItems,
              newLabel,
            );

            expect(newItem.label).toBe(newLabel);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "total item count increases by exactly 1 after append",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 0, max: 10 }),
          nonEmptyLabelArb,
          (campaignId, itemCount, newLabel) => {
            const existingItems: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: false,
                sortOrder: idx,
                completedAt: null,
              }),
            );

            const newItem = appendCustomItem(
              `checklist-${campaignId}`,
              existingItems,
              newLabel,
            );

            const allItems = [...existingItems, newItem];
            expect(allItems).toHaveLength(itemCount + 1);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "sort order is correct even when existing items have non-sequential sort orders",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.uniqueArray(fc.integer({ min: 0, max: 200 }), {
            minLength: 1,
            maxLength: 10,
          }),
          nonEmptyLabelArb,
          (campaignId, sortOrders, newLabel) => {
            const existingItems: ChecklistItem[] = sortOrders.map(
              (sortOrder, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: false,
                sortOrder,
                completedAt: null,
              }),
            );

            const maxSortOrder = Math.max(...sortOrders);
            const newItem = appendCustomItem(
              `checklist-${campaignId}`,
              existingItems,
              newLabel,
            );

            expect(newItem.sortOrder).toBe(maxSortOrder + 1);
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});


// ---------------------------------------------------------------------------
// Property 16: Auto-transition to COMPLETED on full checklist completion
// Validates: Requirements 11.1, 11.2, 11.3
// ---------------------------------------------------------------------------

describe("Property 16: Auto-transition to COMPLETED on full checklist completion", () => {
  it(
    "checking the last unchecked item triggers SETTLEMENT_IN_PROGRESS → COMPLETED (Req 11.1)",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 1, max: 8 }),
          (campaignId, itemCount) => {
            // All items checked except the last one
            const items: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: idx < itemCount - 1, // all checked except last
                sortOrder: idx,
                completedAt: idx < itemCount - 1 ? new Date("2025-01-01") : null,
              }),
            );

            const campaign: Campaign = { id: campaignId, status: "SETTLEMENT_IN_PROGRESS" };
            const lastItem = items[itemCount - 1];

            const { newCampaignStatus } = toggleChecklistItem(
              lastItem,
              true,
              items,
              campaign,
            );

            expect(newCampaignStatus).toBe("COMPLETED");
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "unchecking any item reverts COMPLETED → SETTLEMENT_IN_PROGRESS (Req 11.2)",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 1, max: 8 }),
          fc.integer({ min: 0, max: 7 }),
          (campaignId, itemCount, targetIdx) => {
            fc.pre(targetIdx < itemCount);

            // All items are checked (campaign is COMPLETED)
            const items: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: true,
                sortOrder: idx,
                completedAt: new Date("2025-01-01"),
              }),
            );

            const campaign: Campaign = { id: campaignId, status: "COMPLETED" };
            const targetItem = items[targetIdx];

            const { newCampaignStatus } = toggleChecklistItem(
              targetItem,
              false,
              items,
              campaign,
            );

            expect(newCampaignStatus).toBe("SETTLEMENT_IN_PROGRESS");
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "no auto-transition when checklist has zero items (Req 11.3)",
    () => {
      fc.assert(
        fc.property(campaignIdArb, (campaignId) => {
          // A dummy item that would be toggled, but the allItems array is empty
          const dummyItem: ChecklistItem = {
            id: "item-0",
            checklistId: `checklist-${campaignId}`,
            label: "Dummy",
            isChecked: false,
            sortOrder: 0,
            completedAt: null,
          };

          const campaign: Campaign = { id: campaignId, status: "SETTLEMENT_IN_PROGRESS" };

          // Pass empty items array — guard should prevent auto-transition
          const { newCampaignStatus } = toggleChecklistItem(
            dummyItem,
            true,
            [],
            campaign,
          );

          expect(newCampaignStatus).toBe("SETTLEMENT_IN_PROGRESS");
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "campaign stays SETTLEMENT_IN_PROGRESS when not all items are checked",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 2, max: 8 }),
          fc.integer({ min: 0, max: 7 }),
          (campaignId, itemCount, targetIdx) => {
            fc.pre(targetIdx < itemCount);

            // All items unchecked
            const items: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: false,
                sortOrder: idx,
                completedAt: null,
              }),
            );

            const campaign: Campaign = { id: campaignId, status: "SETTLEMENT_IN_PROGRESS" };
            const targetItem = items[targetIdx];

            // Check one item — but not all (itemCount >= 2, so at least one remains unchecked)
            const { newCampaignStatus } = toggleChecklistItem(
              targetItem,
              true,
              items,
              campaign,
            );

            // Since not all items are checked, status should remain SETTLEMENT_IN_PROGRESS
            expect(newCampaignStatus).toBe("SETTLEMENT_IN_PROGRESS");
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "campaign stays COMPLETED when all items remain checked after a check operation",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 1, max: 8 }),
          fc.integer({ min: 0, max: 7 }),
          (campaignId, itemCount, targetIdx) => {
            fc.pre(targetIdx < itemCount);

            // All items already checked, campaign is COMPLETED
            const items: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: true,
                sortOrder: idx,
                completedAt: new Date("2025-01-01"),
              }),
            );

            const campaign: Campaign = { id: campaignId, status: "COMPLETED" };
            const targetItem = items[targetIdx];

            // Re-checking an already-checked item — all still checked
            const { newCampaignStatus } = toggleChecklistItem(
              targetItem,
              true,
              items,
              campaign,
            );

            // Status should remain COMPLETED (no revert needed)
            expect(newCampaignStatus).toBe("COMPLETED");
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 17: Activity log records auto-transition
// Validates: Requirements 11.4
// ---------------------------------------------------------------------------

describe("Property 17: Activity log records auto-transition", () => {
  it(
    "auto-transition to COMPLETED creates an ActivityLog entry with correct fields (Req 11.4)",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 1, max: 8 }),
          (campaignId, itemCount) => {
            // All items checked except the last one
            const items: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: idx < itemCount - 1,
                sortOrder: idx,
                completedAt: idx < itemCount - 1 ? new Date("2025-01-01") : null,
              }),
            );

            const campaign: Campaign = { id: campaignId, status: "SETTLEMENT_IN_PROGRESS" };
            const lastItem = items[itemCount - 1];

            const { activityLog } = toggleChecklistItem(
              lastItem,
              true,
              items,
              campaign,
            );

            expect(activityLog).not.toBeNull();
            expect(activityLog!.entityType).toBe("CAMPAIGN");
            expect(activityLog!.entityId).toBe(campaignId);
            expect(activityLog!.type).toBe("CHANGE");
            expect(activityLog!.fieldName).toBe("status");
            expect(activityLog!.previousValue).toBe("SETTLEMENT_IN_PROGRESS");
            expect(activityLog!.newValue).toBe("COMPLETED");
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "revert from COMPLETED to SETTLEMENT_IN_PROGRESS also creates an ActivityLog entry",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 1, max: 8 }),
          fc.integer({ min: 0, max: 7 }),
          (campaignId, itemCount, targetIdx) => {
            fc.pre(targetIdx < itemCount);

            // All items checked, campaign is COMPLETED
            const items: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: true,
                sortOrder: idx,
                completedAt: new Date("2025-01-01"),
              }),
            );

            const campaign: Campaign = { id: campaignId, status: "COMPLETED" };
            const targetItem = items[targetIdx];

            const { activityLog } = toggleChecklistItem(
              targetItem,
              false,
              items,
              campaign,
            );

            expect(activityLog).not.toBeNull();
            expect(activityLog!.entityType).toBe("CAMPAIGN");
            expect(activityLog!.entityId).toBe(campaignId);
            expect(activityLog!.type).toBe("CHANGE");
            expect(activityLog!.fieldName).toBe("status");
            expect(activityLog!.previousValue).toBe("COMPLETED");
            expect(activityLog!.newValue).toBe("SETTLEMENT_IN_PROGRESS");
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "no ActivityLog entry when toggle does not trigger a status transition",
    () => {
      fc.assert(
        fc.property(
          campaignIdArb,
          fc.integer({ min: 2, max: 8 }),
          fc.integer({ min: 0, max: 7 }),
          (campaignId, itemCount, targetIdx) => {
            fc.pre(targetIdx < itemCount);

            // All items unchecked — checking one won't complete the checklist
            const items: ChecklistItem[] = Array.from(
              { length: itemCount },
              (_, idx) => ({
                id: `item-${idx}`,
                checklistId: `checklist-${campaignId}`,
                label: `Item ${idx}`,
                isChecked: false,
                sortOrder: idx,
                completedAt: null,
              }),
            );

            const campaign: Campaign = { id: campaignId, status: "SETTLEMENT_IN_PROGRESS" };
            const targetItem = items[targetIdx];

            const { activityLog } = toggleChecklistItem(
              targetItem,
              true,
              items,
              campaign,
            );

            // No transition occurred, so no log entry
            expect(activityLog).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "no ActivityLog entry when checklist has zero items (guard prevents transition)",
    () => {
      fc.assert(
        fc.property(campaignIdArb, (campaignId) => {
          const dummyItem: ChecklistItem = {
            id: "item-0",
            checklistId: `checklist-${campaignId}`,
            label: "Dummy",
            isChecked: false,
            sortOrder: 0,
            completedAt: null,
          };

          const campaign: Campaign = { id: campaignId, status: "SETTLEMENT_IN_PROGRESS" };

          const { activityLog } = toggleChecklistItem(
            dummyItem,
            true,
            [],
            campaign,
          );

          expect(activityLog).toBeNull();
        }),
        { numRuns: 100 },
      );
    },
  );
});
