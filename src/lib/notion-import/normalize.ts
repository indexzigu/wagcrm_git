import { createHash } from "node:crypto";

export type ImportedTable =
  | "partners"
  | "sellers"
  | "deals"
  | "campaigns";

export function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function toNullableString(value: unknown) {
  if (value == null) return null;
  const normalized = normalizeWhitespace(String(value));
  return normalized.length > 0 ? normalized : null;
}

export function normalizeKey(value: unknown) {
  const normalized = toNullableString(value);
  if (!normalized) return "";
  return normalized.toLowerCase().replace(/\s+/g, "");
}

export function parseCurrency(value: unknown) {
  const normalized = toNullableString(value);
  if (!normalized) return null;

  const compact = normalized.replace(/[,\s]/g, "");
  const signless = compact.replace(/[^\d.-]/g, "");
  if (!signless) return null;

  const parsed = Number(signless);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePercent(value: unknown) {
  const normalized = toNullableString(value);
  if (!normalized) return null;

  const parsed = parseCurrency(normalized.replace(/%/g, ""));
  if (parsed == null) return null;

  return normalized.includes("%") ? parsed : parsed <= 1 ? parsed * 100 : parsed;
}

export function parseFollowerCount(value: unknown) {
  const normalized = toNullableString(value);
  if (!normalized) return null;

  const parsed = parseCurrency(normalized);
  if (parsed == null) return null;

  if (normalized.includes("만") || parsed < 1000) {
    return Math.round(parsed * 10000);
  }
  return Math.round(parsed);
}

export function parseDate(value: unknown) {
  const normalized = toNullableString(value);
  if (!normalized) return null;

  const slashMatch = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slashMatch) {
    const [, year, month, day] = slashMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const koreanMatch = normalized.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (koreanMatch) {
    const [, year, month, day] = koreanMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const isoLike = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!isoLike) return null;

  const [, year, month, day] = isoLike;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function extractRelationTitles(value: unknown) {
  const normalized = toNullableString(value);
  if (!normalized) return [];

  return normalized
    .split(",")
    .map((entry) => entry.replace(/\s*\(https?:\/\/[^)]+\)\s*/g, "").trim())
    .filter(Boolean);
}

export function extractInstagramHandle(value: unknown) {
  const normalized = toNullableString(value);
  if (!normalized) return null;

  const match = normalized.match(/instagram\.com\/([^/?#]+)/i);
  if (!match) return null;

  return match[1].replace(/^@/, "").toLowerCase();
}

export function buildSourceKey(table: ImportedTable, parts: Array<unknown>) {
  const joined = parts.map((part) => normalizeKey(part)).filter(Boolean).join("::");
  return `${table}:${joined}`;
}

export function hashPayload(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
