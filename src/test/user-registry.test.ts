// Feature: multi-user-collaboration, Property 12: User autocomplete filter correctness

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { filterUsers, type CrmUser } from "../lib/user-registry";

// Arbitrary for a valid CrmUser
const crmUserArb = fc.record<CrmUser>({
  id: fc.uuid(),
  email: fc.emailAddress(),
  displayName: fc.string({ minLength: 1, maxLength: 50 }),
  role: fc.constantFrom("admin" as const, "operator" as const),
});

describe("filterUsers", () => {
  /**
   * Property 12: User autocomplete filter correctness
   * Validates: Requirements 11.2
   *
   * For any user list and query string, filterUsers SHALL return only users
   * whose displayName or email contains the query as a case-insensitive
   * substring, and SHALL exclude all users that do not match.
   */
  it("Property 12: every returned user matches the query (case-insensitive)", () => {
    fc.assert(
      fc.property(
        fc.array(crmUserArb, { minLength: 0, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (users, query) => {
          const result = filterUsers(users, query);
          fc.pre(query.trim().length > 0);
          const lowerQuery = query.toLowerCase();

          // Every returned user must match the query
          for (const user of result) {
            const matchesDisplayName = user.displayName
              .toLowerCase()
              .includes(lowerQuery);
            const matchesEmail = user.email.toLowerCase().includes(lowerQuery);
            expect(matchesDisplayName || matchesEmail).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 12: every matching user is included in the result", () => {
    fc.assert(
      fc.property(
        fc.array(crmUserArb, { minLength: 0, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (users, query) => {
          const result = filterUsers(users, query);
          fc.pre(query.trim().length > 0);
          const lowerQuery = query.toLowerCase();
          const resultIds = new Set(result.map((u) => u.id));

          // Every user that matches must be in the result
          for (const user of users) {
            const matchesDisplayName = user.displayName
              .toLowerCase()
              .includes(lowerQuery);
            const matchesEmail = user.email.toLowerCase().includes(lowerQuery);
            if (matchesDisplayName || matchesEmail) {
              expect(resultIds.has(user.id)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 12: empty query returns empty array", () => {
    fc.assert(
      fc.property(fc.array(crmUserArb, { minLength: 0, maxLength: 20 }), (users) => {
        expect(filterUsers(users, "")).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 12: whitespace-only query returns empty array", () => {
    fc.assert(
      fc.property(
        fc.array(crmUserArb, { minLength: 0, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 10 }).map((s) => s.replace(/\S/g, " ")),
        (users, whitespaceQuery) => {
          // Ensure the query is actually whitespace-only
          fc.pre(whitespaceQuery.trim() === "");
          expect(filterUsers(users, whitespaceQuery)).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Example-based tests for concrete correctness
  it("matches displayName case-insensitively", () => {
    const users: CrmUser[] = [
      { id: "1", email: "alice@example.com", displayName: "Alice Kim", role: "admin" },
      { id: "2", email: "bob@example.com", displayName: "Bob Lee", role: "operator" },
    ];
    expect(filterUsers(users, "alice")).toEqual([users[0]]);
    expect(filterUsers(users, "ALICE")).toEqual([users[0]]);
    expect(filterUsers(users, "Ali")).toEqual([users[0]]);
  });

  it("matches email case-insensitively", () => {
    const users: CrmUser[] = [
      { id: "1", email: "alice@example.com", displayName: "Alice", role: "admin" },
      { id: "2", email: "bob@example.com", displayName: "Bob", role: "operator" },
    ];
    expect(filterUsers(users, "ALICE@EXAMPLE")).toEqual([users[0]]);
    expect(filterUsers(users, "example.com")).toEqual([users[0], users[1]]);
  });

  it("returns empty array when no users match", () => {
    const users: CrmUser[] = [
      { id: "1", email: "alice@example.com", displayName: "Alice", role: "admin" },
    ];
    expect(filterUsers(users, "zzznomatch")).toEqual([]);
  });

  it("returns empty array for empty user list", () => {
    expect(filterUsers([], "alice")).toEqual([]);
  });
});
