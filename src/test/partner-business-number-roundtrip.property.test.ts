/**
 * Property-based integration test for business number round-trip.
 *
 * Feature: partner-seller-ux-revamp, Property 2: 사업자번호 저장 라운드트립
 *
 * For any 유효한 10자리 숫자 사업자번호에 대해, 거래처에 저장한 후 다시 조회하면
 * 동일한 값이 반환되어야 한다.
 *
 * **Validates: Requirements 2.4, 2.5**
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
const mockFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    partner: {
      findUnique: mockFindUnique,
      update: mockUpdate,
      findMany: mockFindMany,
    },
    activityLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  }),
}));

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: vi.fn().mockResolvedValue({
    userId: "dev-user",
    email: "dev@wag-crm.local",
    role: "admin",
  }),
}));

// Import route handlers after mock setup
import { PATCH } from "@/app/api/partners/[id]/route";
import { GET } from "@/app/api/partners/route";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generates exactly 10-digit numeric strings (always valid business numbers) */
const validBusinessNumberArb = fc.stringOf(
  fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"),
  { minLength: 10, maxLength: 10 },
);

/** Generates a random partner ID */
const partnerIdArb = fc.uuid();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a mock Request object with JSON body */
function createPatchRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/partners/test-id", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Builds a fake partner record */
function buildPartnerRecord(id: string, businessNumber: string | null) {
  return {
    id,
    name: "테스트 거래처",
    type: "BRAND",
    contactInfo: null,
    bankAccount: null,
    businessNumber,
    companyStatus: null,
    companyRole: null,
    lastContactAt: null,
    notes: null,
    referredById: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
  };
}

// ---------------------------------------------------------------------------
// Property 2: 사업자번호 저장 라운드트립
// Validates: Requirements 2.4, 2.5
// ---------------------------------------------------------------------------

describe("Feature: partner-seller-ux-revamp, Property 2: 사업자번호 저장 라운드트립", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("유효한 10자리 사업자번호를 PATCH로 저장하면 동일한 값이 저장된다", async () => {
    await fc.assert(
      fc.asyncProperty(
        validBusinessNumberArb,
        partnerIdArb,
        async (businessNumber, partnerId) => {
          mockFindUnique.mockClear();
          mockUpdate.mockClear();

          // Setup: partner exists with no business number
          const existingPartner = buildPartnerRecord(partnerId, null);
          mockFindUnique.mockResolvedValue(existingPartner);

          // Setup: update returns the partner with the new business number
          const updatedPartner = buildPartnerRecord(partnerId, businessNumber);
          mockUpdate.mockResolvedValue(updatedPartner);

          // Act: PATCH to save business number
          const request = createPatchRequest({ businessNumber });
          const context = { params: Promise.resolve({ id: partnerId }) };
          const response = await PATCH(request, context);
          const responseData = await response.json();

          // Assert: response is successful
          expect(response.status).toBe(200);

          // Assert: the saved business number matches the input
          expect(responseData.businessNumber).toBe(businessNumber);

          // Assert: Prisma update was called with the correct value
          expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: partnerId },
            data: expect.objectContaining({ businessNumber }),
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("저장된 사업자번호를 GET으로 조회하면 동일한 값이 반환된다", async () => {
    await fc.assert(
      fc.asyncProperty(
        validBusinessNumberArb,
        partnerIdArb,
        async (businessNumber, partnerId) => {
          mockFindMany.mockClear();

          // Setup: partner has the business number saved
          const partnerWithBN = {
            id: partnerId,
            name: "테스트 거래처",
            type: "BRAND",
            contactInfo: null,
            bankAccount: null,
            businessNumber,
            referredById: null,
            referredBy: null,
            _count: { deals: 0 },
            createdAt: new Date("2025-01-01"),
            updatedAt: new Date("2025-01-01"),
          };
          mockFindMany.mockResolvedValue([partnerWithBN]);

          // Act: GET partners list
          const request = new Request("http://localhost:3000/api/partners", {
            method: "GET",
          }) as unknown as import("next/server").NextRequest;

          // We need to add nextUrl property for NextRequest
          Object.defineProperty(request, "nextUrl", {
            value: new URL("http://localhost:3000/api/partners"),
            writable: false,
          });

          const response = await GET(
            request as unknown as Parameters<typeof GET>[0],
          );
          const responseData = await response.json();

          // Assert: the retrieved business number matches what was saved
          expect(responseData.partners).toHaveLength(1);
          expect(responseData.partners[0].businessNumber).toBe(businessNumber);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("PATCH 저장 후 조회 시 라운드트립이 보장된다 (end-to-end simulation)", async () => {
    await fc.assert(
      fc.asyncProperty(
        validBusinessNumberArb,
        partnerIdArb,
        async (businessNumber, partnerId) => {
          mockFindUnique.mockClear();
          mockUpdate.mockClear();
          mockFindMany.mockClear();

          // --- Phase 1: Save via PATCH ---

          // Existing partner without business number
          const existingPartner = buildPartnerRecord(partnerId, null);
          mockFindUnique.mockResolvedValue(existingPartner);

          // After update, partner has the business number
          const updatedPartner = buildPartnerRecord(partnerId, businessNumber);
          mockUpdate.mockResolvedValue(updatedPartner);

          const patchRequest = createPatchRequest({ businessNumber });
          const context = { params: Promise.resolve({ id: partnerId }) };
          const patchResponse = await PATCH(patchRequest, context);

          expect(patchResponse.status).toBe(200);
          const savedData = await patchResponse.json();

          // --- Phase 2: Retrieve via GET ---

          // Simulate DB state after save
          mockFindMany.mockResolvedValue([
            {
              id: partnerId,
              name: "테스트 거래처",
              type: "BRAND",
              contactInfo: null,
              bankAccount: null,
              businessNumber: savedData.businessNumber,
              referredById: null,
              referredBy: null,
              _count: { deals: 0 },
              createdAt: new Date("2025-01-01"),
              updatedAt: new Date("2025-01-01"),
            },
          ]);

          const getRequest = new Request(
            "http://localhost:3000/api/partners",
            { method: "GET" },
          ) as unknown as import("next/server").NextRequest;

          Object.defineProperty(getRequest, "nextUrl", {
            value: new URL("http://localhost:3000/api/partners"),
            writable: false,
          });

          const getResponse = await GET(
            getRequest as unknown as Parameters<typeof GET>[0],
          );
          const retrievedData = await getResponse.json();

          // --- Assert: Round-trip preserves the value ---
          expect(retrievedData.partners[0].businessNumber).toBe(businessNumber);
          expect(retrievedData.partners[0].businessNumber).toBe(
            savedData.businessNumber,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
