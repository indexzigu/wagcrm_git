/**
 * Search filter utility for case-insensitive partial matching across multiple fields.
 *
 * Korean-aware in two ways:
 *  1. Unicode normalization — the query and every target field are normalized to
 *     NFC before comparison, so Hangul stored/typed in decomposed form (NFD, e.g.
 *     from macOS or certain paste sources) still matches composed form (NFC) and
 *     vice versa. Plain `String.includes` silently misses across normalization forms.
 *  2. Choseong (초성) search — when the query is composed entirely of Hangul lead
 *     consonants (e.g. "ㅅㅇ"), it is matched against the choseong sequence of each
 *     field, so "ㅅㅇ" finds "서연" and "ㄱㅁ" finds "김민수". Normal (mixed or
 *     syllable) queries fall back to NFC substring matching.
 *
 * Choseong search is intentionally client-side only: a SQL LIKE cannot derive
 * choseong, so server-backed search (see src/app/api/search/*) applies NFC/NFD
 * normalization only. A denormalized choseong column would be needed to push
 * choseong search to the database — deliberately out of scope here.
 *
 * Requirements: 3.2, 11.2
 */

// The 19 modern Hangul lead consonants (choseong), as COMPATIBILITY jamo
// (U+3131–U+314E) — the exact characters a Korean IME emits for a standalone
// consonant, and what `toChoseong` below produces. Keep these as compatibility
// jamo; the choseong unit tests fail loudly if the encoding drifts.
const CHOSEONG = [
  "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ",
  "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
];
const CHOSEONG_SET = new Set(CHOSEONG);

const HANGUL_SYLLABLE_FIRST = 0xac00; // '가'
const HANGUL_SYLLABLE_LAST = 0xd7a3; // '힣'
const CHOSEONG_DIVISOR = 588; // 21 jungseong × 28 jongseong per choseong block

/**
 * Extracts the choseong (lead-consonant) sequence from a string. Complete Hangul
 * syllables contribute their choseong; characters that are already choseong jamo
 * are kept; everything else (spaces, latin, digits, vowels) is dropped so it does
 * not interrupt a consonant run. The input should be NFC-normalized so decomposed
 * syllables are recomposed into the AC00–D7A3 range first.
 */
function toChoseong(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code >= HANGUL_SYLLABLE_FIRST && code <= HANGUL_SYLLABLE_LAST) {
      out += CHOSEONG[Math.floor((code - HANGUL_SYLLABLE_FIRST) / CHOSEONG_DIVISOR)];
    } else if (CHOSEONG_SET.has(ch)) {
      out += ch;
    }
  }
  return out;
}

/** True when every non-space character in the query is a Hangul lead consonant. */
function isChoseongQuery(value: string): boolean {
  let sawConsonant = false;
  for (const ch of value) {
    if (ch === " ") continue;
    if (!CHOSEONG_SET.has(ch)) return false;
    sawConsonant = true;
  }
  return sawConsonant;
}

/**
 * Filters items by performing a case-insensitive partial match against multiple
 * searchable fields extracted from each item. See the module doc for Korean
 * normalization and choseong-search behavior.
 *
 * @param items - The array of items to filter
 * @param searchText - The search query string
 * @param getSearchableFields - Extracts searchable string fields from an item
 * @returns A new array containing only items that match the search text
 *
 * @example
 * ```ts
 * const sellers = [{ name: "서연", snsHandle: "@seoyeon" }];
 * filterBySearchText(sellers, "ㅅㅇ", (s) => [s.name, s.snsHandle]);
 * // → [{ name: "서연", ... }]  (choseong match)
 * ```
 */
export function filterBySearchText<T>(
  items: T[],
  searchText: string,
  getSearchableFields: (item: T) => string[],
): T[] {
  // Return all items when search text is empty or whitespace-only
  const trimmed = searchText.trim();
  if (trimmed === "") {
    return items;
  }

  const choseongMode = isChoseongQuery(trimmed);
  // Drop spaces so a spaced consonant query ("ㄱ ㅁ") still matches "김민수".
  const choseongQuery = choseongMode ? trimmed.replace(/\s+/g, "") : "";
  const normalizedSearch = trimmed.normalize("NFC").toLowerCase();

  return items.filter((item) => {
    const fields = getSearchableFields(item);
    return fields.some((field) => {
      if (field == null) return false;
      const normalizedField = field.normalize("NFC");
      if (choseongMode) {
        return toChoseong(normalizedField).includes(choseongQuery);
      }
      return normalizedField.toLowerCase().includes(normalizedSearch);
    });
  });
}
