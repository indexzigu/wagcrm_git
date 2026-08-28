/**
 * Mention Parser — extracts and resolves @username patterns from comment content.
 * Pure utility module with no external dependencies.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4
 */

export type { CrmUser } from "./user-registry";
import type { CrmUser } from "./user-registry";

/**
 * Extracts @username patterns from content.
 * Regex: /@([a-zA-Z0-9_-]{1,50})(?![a-zA-Z0-9_-])/g
 *
 * A trailing negative lookahead (not `\b`) marks the mention boundary. `\b` is
 * defined against `\w` (= [a-zA-Z0-9_]), which excludes `-`. So with `\b` a name
 * ending in a hyphen — e.g. displayName "foo-" mentioned as "@foo-" — would
 * backtrack and capture only the "foo" prefix, silently retargeting the mention
 * to a different user named "foo" (bypassing self-mention exclusion). The
 * lookahead treats every allowed username character, hyphen included, as part of
 * the boundary so the full run is captured or, if it exceeds the 50-char cap,
 * refused outright rather than truncated to a wrong prefix.
 * Returns deduplicated array of usernames (without @ prefix).
 */
export function parseMentions(content: string): string[] {
  const regex = /@([a-zA-Z0-9_-]{1,50})(?![a-zA-Z0-9_-])/g;
  const usernames = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    usernames.add(match[1]);
  }

  return Array.from(usernames);
}

/**
 * Resolves extracted usernames against a user list.
 * Matches by displayName (case-insensitive) or email prefix (part before @).
 * Returns array of user IDs for matched users.
 * Unresolved usernames are silently ignored.
 */
export function resolveMentions(
  usernames: string[],
  userList: CrmUser[],
): string[] {
  const resolvedIds: string[] = [];

  for (const username of usernames) {
    const lowerUsername = username.toLowerCase();
    const exactDisplayMatches = userList.filter(
      (user) => user.displayName === username,
    );

    if (exactDisplayMatches.length > 0) {
      for (const user of exactDisplayMatches) {
        if (!resolvedIds.includes(user.id)) {
          resolvedIds.push(user.id);
        }
      }
      continue;
    }

    const insensitiveDisplayMatches = userList.filter(
      (user) => user.displayName.toLowerCase() === lowerUsername,
    );
    if (insensitiveDisplayMatches.length > 0) {
      for (const user of insensitiveDisplayMatches) {
        if (!resolvedIds.includes(user.id)) {
          resolvedIds.push(user.id);
        }
      }
      continue;
    }

    const emailPrefixMatches = userList.filter(
      (user) => user.email.split("@")[0].toLowerCase() === lowerUsername,
    );
    for (const user of emailPrefixMatches) {
      if (!resolvedIds.includes(user.id)) {
        resolvedIds.push(user.id);
      }
    }
  }

  return resolvedIds;
}
