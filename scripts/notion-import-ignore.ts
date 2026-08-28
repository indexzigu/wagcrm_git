const IGNORED_SOURCE_KEYS = new Set<string>(["sellers:메리"]);

export function isIgnoredSourceKey(sourceKey: string | undefined) {
  return IGNORED_SOURCE_KEYS.has((sourceKey ?? "").trim());
}

export function filterIgnoredRows<T extends { sourceKey: string }>(rows: T[]) {
  return rows.filter((row) => !isIgnoredSourceKey(row.sourceKey));
}
