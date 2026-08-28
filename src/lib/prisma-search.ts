import { isSqliteDatabaseUrl } from "@/lib/prisma-client";

type InsensitiveMode = "insensitive";

/**
 * Returns the distinct Unicode normalization forms (NFC, and NFD when it differs)
 * of a search term. Hangul can be stored composed (NFC) or decomposed (NFD);
 * querying a single form silently misses rows stored in the other. Map each form
 * through `containsSearch` and OR the results so both match.
 *
 * @example
 *   where: { OR: normalizedForms(q).map((f) => ({ name: containsSearch(f) })) }
 */
export function normalizedForms(value: string): string[] {
  const nfc = value.normalize("NFC");
  const nfd = value.normalize("NFD");
  return nfc === nfd ? [nfc] : [nfc, nfd];
}

export function containsSearch(value: string): {
  contains: string;
  mode?: InsensitiveMode;
} {
  return isSqliteDatabaseUrl()
    ? { contains: value }
    : { contains: value, mode: "insensitive" };
}

export function equalsSearch(value: string): {
  equals: string;
  mode?: InsensitiveMode;
} {
  return isSqliteDatabaseUrl()
    ? { equals: value }
    : { equals: value, mode: "insensitive" };
}
