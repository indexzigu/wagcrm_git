export type InstagramProfileMetrics = {
  followersCount?: number;
  postsCount?: number;
  profileBio?: string | null;
  profilePicUrl?: string | null;
  profileExternalUrls?: string[];
  name?: string;
  username?: string;
};

function pickNumber(input: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value.replace(/,/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function pickString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function collectUrls(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const url = pickString(record, ["url", "href", "link", "expandedUrl"]);
      return url ? [url] : [];
    }
    return [];
  });
}

export function encodeExternalUrls(urls?: string[] | null): string | null {
  const normalized = [...new Set((urls ?? []).map((url) => url.trim()).filter(Boolean))];
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

export function decodeExternalUrls(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    }
  } catch {
    return value
      .split(/\s*,\s*/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Normalizes Apify/Meta Instagram profile payloads into fields WAG CRM stores.
 */
export function normalizeInstagramProfileMetrics(raw: unknown): InstagramProfileMetrics {
  if (!raw || typeof raw !== "object") return {};
  const item = raw as Record<string, unknown>;
  const businessDiscovery =
    item.business_discovery && typeof item.business_discovery === "object"
      ? (item.business_discovery as Record<string, unknown>)
      : null;
  const source = businessDiscovery ?? item;

  const externalUrls = [
    ...collectUrls(source.externalUrls),
    ...collectUrls(source.externalUrl),
    ...collectUrls(source.external_url),
    ...collectUrls(source.website),
    ...collectUrls(source.url),
  ];

  return {
    followersCount: pickNumber(source, ["followersCount", "followers_count", "followers"]),
    postsCount: pickNumber(source, ["postsCount", "posts_count", "media_count", "mediaCount", "totalPostsCount"]),
    profileBio: pickString(source, ["biography", "bio", "profileBio"]),
    profilePicUrl: pickString(source, ["profilePicUrl", "profilePicUrlHD", "profilePictureUrl", "profile_picture_url"]),
    profileExternalUrls: [...new Set(externalUrls)],
    name: pickString(source, ["fullName", "name"]),
    username: pickString(source, ["username", "userName"]),
  };
}
