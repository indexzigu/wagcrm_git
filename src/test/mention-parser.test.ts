/**
 * Property-based tests for mention-parser module.
 * Feature: multi-user-collaboration
 *
 * Property 1: Mention parser extracts valid usernames
 * Property 2: Mention resolution returns only valid user IDs
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { parseMentions, resolveMentions } from "../lib/mention-parser";
import type { CrmUser } from "../lib/user-registry";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Any character allowed in a username per the spec regex: [a-zA-Z0-9_-] */
const usernameCharArb = fc.mapToConstant(
  { num: 26, build: (i) => String.fromCharCode(97 + i) }, // a-z
  { num: 26, build: (i) => String.fromCharCode(65 + i) }, // A-Z
  { num: 10, build: (i) => String.fromCharCode(48 + i) }, // 0-9
  { num: 1, build: () => "_" },
  { num: 1, build: () => "-" },
);

/**
 * Valid username per the spec regex: [a-zA-Z0-9_-]{1,50}
 *
 * No positional constraint on hyphens — leading and TRAILING hyphens are
 * allowed. Earlier this generator was pinned to word characters at both ends
 * because the parser used a `\b` boundary that mis-parsed trailing hyphens
 * (capturing only the pre-hyphen prefix). The parser now uses a negative
 * lookahead over the full allowed character set, so the generator no longer
 * needs to avoid that boundary — a name like "foo-" is parsed intact.
 */
const validUsernameArb = fc
  .stringOf(usernameCharArb, { minLength: 1, maxLength: 50 })
  .filter((s) => s.length >= 1 && s.length <= 50);

/** A string that is NOT a valid username character (used as separator) */
const separatorArb = fc.constantFrom(" ", "\n", "\t", ".", ",", "!", "?", "(", ")", "[", "]");

/** Builds a content string with a known set of @mentions embedded */
const contentWithMentionsArb = fc
  .array(validUsernameArb, { minLength: 1, maxLength: 10 })
  .chain((usernames) => {
    // Build a string that embeds each username as @username followed by a word boundary
    const mentionParts = usernames.map((u) => `@${u}`);
    // Interleave with separators to ensure word boundaries
    const contentArb = fc
      .array(separatorArb, { minLength: usernames.length + 1, maxLength: usernames.length + 5 })
      .map((seps) => {
        let result = seps[0];
        for (let i = 0; i < mentionParts.length; i++) {
          result += mentionParts[i] + (seps[i + 1] ?? " ");
        }
        return result;
      });
    return contentArb.map((content) => ({ content, usernames }));
  });

/** Generates an array of CrmUsers with unique IDs */
const crmUserListArb = fc
  .array(
    fc.record({
      id: fc.uuid(),
      email: fc.emailAddress(),
      displayName: validUsernameArb,
      role: fc.constantFrom("admin" as const, "operator" as const),
    }),
    { minLength: 0, maxLength: 20 },
  );

// ---------------------------------------------------------------------------
// Property 1: Mention parser extracts valid usernames
// Feature: multi-user-collaboration, Property 1: Mention parser extracts valid usernames
// Validates: Requirements 5.1, 5.4
// ---------------------------------------------------------------------------

describe("parseMentions — Property 1: Mention parser extracts valid usernames", () => {
  it("extracts all @username patterns embedded in a string", () => {
    /**
     * **Validates: Requirements 5.1, 5.4**
     *
     * For any string containing embedded @username patterns (where username
     * matches [a-zA-Z0-9_-]{1,50}), parseMentions SHALL return exactly the
     * set of valid usernames present in the string, without the @ prefix.
     */
    fc.assert(
      fc.property(contentWithMentionsArb, ({ content, usernames }) => {
        const result = parseMentions(content);
        const uniqueUsernames = [...new Set(usernames)];

        // Every username we embedded must appear in the result
        for (const username of uniqueUsernames) {
          expect(result).toContain(username);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("returns usernames without the @ prefix", () => {
    /**
     * **Validates: Requirements 5.1**
     *
     * Extracted usernames must not include the @ character.
     */
    fc.assert(
      fc.property(contentWithMentionsArb, ({ content }) => {
        const result = parseMentions(content);
        for (const username of result) {
          expect(username).not.toMatch(/^@/);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("returns deduplicated usernames", () => {
    /**
     * **Validates: Requirements 5.1**
     *
     * When the same @username appears multiple times, parseMentions SHALL
     * return it only once. We join with a space to ensure \b word boundary.
     */
    fc.assert(
      fc.property(validUsernameArb, fc.integer({ min: 2, max: 5 }), (username, count) => {
        // Each mention is followed by a space to ensure \b word boundary
        const content = Array(count).fill(`@${username} `).join(" ");
        const result = parseMentions(content);
        const occurrences = result.filter((u) => u === username);
        expect(occurrences).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });

  it("returns only usernames matching [a-zA-Z0-9_-]{1,50}", () => {
    /**
     * **Validates: Requirements 5.4**
     *
     * Every extracted username must conform to the allowed character set
     * and length constraint.
     */
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (content) => {
        const result = parseMentions(content);
        const validPattern = /^[a-zA-Z0-9_-]{1,50}$/;
        for (const username of result) {
          expect(username).toMatch(validPattern);
        }
      }),
      { numRuns: 100 },
    );
  });

  // ---------------------------------------------------------------------------
  // Regression: trailing-hyphen boundary (the \b backtrack bug)
  //
  // The old /@([a-zA-Z0-9_-]{1,50})\b/ regex captured only "foo" from "@foo-",
  // because \b (defined against \w, which excludes '-') backtracked off the
  // trailing hyphen. That silently retargeted the mention to a different user.
  // ---------------------------------------------------------------------------

  it("captures a trailing hyphen instead of backtracking to the prefix", () => {
    expect(parseMentions("@foo- hello")).toEqual(["foo-"]);
    expect(parseMentions("@foo-")).toEqual(["foo-"]);
    expect(parseMentions("hi @foo-, welcome")).toEqual(["foo-"]);
    expect(parseMentions("@a-b-c-")).toEqual(["a-b-c-"]);
  });

  it("does not conflate a trailing-hyphen name with its bare prefix", () => {
    // "@foo-" must NOT parse to "foo" — that is exactly the notification-misdelivery bug.
    expect(parseMentions("@foo-")).not.toContain("foo");
  });

  it("captures a trailing underscore (word char, but same boundary family)", () => {
    expect(parseMentions("@foo_ done")).toEqual(["foo_"]);
  });

  it("stops the mention at the first non-username character", () => {
    expect(parseMentions("@foo-bar.baz")).toEqual(["foo-bar"]);
    expect(parseMentions("@foo!@bar")).toEqual(["foo", "bar"]);
  });

  it("refuses an over-length run rather than capturing a wrong 50-char prefix", () => {
    // 51 word chars followed by a hyphen: the old \b regex would have matched the
    // 50-char prefix (boundary sat between a word char and '-'); the lookahead
    // parser refuses the whole run because it exceeds [1,50].
    const over = "a".repeat(51);
    expect(parseMentions(`@${over}- rest`)).toEqual([]);
  });

  it("returns empty array for strings with no @mentions", () => {
    /**
     * **Validates: Requirements 5.1**
     *
     * Strings without any @ character produce no mentions.
     */
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }).filter((s) => !s.includes("@")),
        (content) => {
          expect(parseMentions(content)).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Mention resolution returns only valid user IDs
// Feature: multi-user-collaboration, Property 2: Mention resolution returns only valid user IDs
// Validates: Requirements 5.2, 5.3
// ---------------------------------------------------------------------------

describe("resolveMentions — Property 2: Mention resolution returns only valid user IDs", () => {
  it("returns only IDs that exist in the user list", () => {
    /**
     * **Validates: Requirements 5.2, 5.3**
     *
     * For any list of extracted usernames and any user registry,
     * resolveMentions SHALL return user IDs only for usernames that match
     * an existing CRM_User.
     */
    fc.assert(
      fc.property(
        fc.array(validUsernameArb, { minLength: 0, maxLength: 10 }),
        crmUserListArb,
        (usernames, userList) => {
          const result = resolveMentions(usernames, userList);
          const validIds = new Set(userList.map((u) => u.id));

          for (const id of result) {
            expect(validIds.has(id)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("excludes IDs for usernames that do not match any user", () => {
    /**
     * **Validates: Requirements 5.3**
     *
     * Unresolved usernames are silently ignored — their IDs do not appear
     * in the result.
     */
    fc.assert(
      fc.property(
        fc.array(validUsernameArb, { minLength: 1, maxLength: 10 }),
        crmUserListArb,
        (usernames, userList) => {
          const result = resolveMentions(usernames, userList);

          // For each returned ID, there must be a user in the list whose
          // displayName or email prefix matches one of the input usernames
          for (const id of result) {
            const user = userList.find((u) => u.id === id);
            expect(user).toBeDefined();

            const lowerNames = usernames.map((u) => u.toLowerCase());
            const displayNameMatch = lowerNames.includes(user!.displayName.toLowerCase());
            const emailPrefixMatch = lowerNames.includes(user!.email.split("@")[0].toLowerCase());
            expect(displayNameMatch || emailPrefixMatch).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("resolves a known username to the correct user ID", () => {
    /**
     * **Validates: Requirements 5.2**
     *
     * When a username exactly matches a CrmUser's displayName (case-insensitive),
     * that user's ID is included in the result.
     */
    fc.assert(
      fc.property(
        validUsernameArb,
        fc.uuid(),
        fc.emailAddress(),
        fc.constantFrom("admin" as const, "operator" as const),
        crmUserListArb,
        (username, userId, email, role, otherUsers) => {
          const targetUser: CrmUser = {
            id: userId,
            email,
            displayName: username,
            role,
          };
          // Combine target user with other users (filter out any accidental ID collision)
          const userList = [targetUser, ...otherUsers.filter((u) => u.id !== userId)];

          const result = resolveMentions([username], userList);
          expect(result).toContain(userId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns deduplicated user IDs even when multiple usernames resolve to the same user", () => {
    /**
     * **Validates: Requirements 5.2**
     *
     * If both displayName and email prefix match the same user, the user's ID
     * appears only once in the result.
     */
    fc.assert(
      fc.property(
        validUsernameArb,
        fc.uuid(),
        fc.constantFrom("admin" as const, "operator" as const),
        (username, userId, role) => {
          // Construct a user where displayName and email prefix are the same username
          const user: CrmUser = {
            id: userId,
            email: `${username}@example.com`,
            displayName: username,
            role,
          };
          // Pass the same username twice
          const result = resolveMentions([username, username], [user]);
          const occurrences = result.filter((id) => id === userId);
          expect(occurrences).toHaveLength(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns empty array when user list is empty", () => {
    /**
     * **Validates: Requirements 5.3**
     *
     * With no users to resolve against, all mentions are unresolved.
     */
    fc.assert(
      fc.property(
        fc.array(validUsernameArb, { minLength: 0, maxLength: 10 }),
        (usernames) => {
          expect(resolveMentions(usernames, [])).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns empty array when username list is empty", () => {
    /**
     * **Validates: Requirements 5.2**
     *
     * With no usernames to resolve, the result is always empty.
     */
    fc.assert(
      fc.property(crmUserListArb, (userList) => {
        expect(resolveMentions([], userList)).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
