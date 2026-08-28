export type ParsedChannelInfo = {
  snsType: "INSTAGRAM" | "YOUTUBE" | "X";
  snsHandle: string;
};

/**
 * Parse a channel URL and extract minimal seller identifiers.
 * Supports Instagram and YouTube-style channel URLs.
 */
export function parseChannelUrl(url: string): ParsedChannelInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname.includes("instagram.com")) {
    const pathSegments = parsed.pathname
      .split("/")
      .filter((segment) => segment.length > 0);
    const firstSegment = pathSegments[0];
    if (!firstSegment) return null;
    const snsHandle = firstSegment.replace(/^@/, "");
    if (!snsHandle) return null;

    return {
      snsType: "INSTAGRAM",
      snsHandle,
    };
  }

  if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) {
    const pathSegments = parsed.pathname
      .split("/")
      .filter((segment) => segment.length > 0);

    let snsHandle: string | undefined;
    const firstSegment = pathSegments[0];

    if (firstSegment) {
      if (firstSegment.startsWith("@")) {
        snsHandle = firstSegment.slice(1);
      } else if (firstSegment === "channel" && pathSegments[1]) {
        snsHandle = pathSegments[1];
      } else if (firstSegment === "c" && pathSegments[1]) {
        snsHandle = pathSegments[1];
      } else if (firstSegment === "user" && pathSegments[1]) {
        snsHandle = pathSegments[1];
      } else {
        snsHandle = firstSegment;
      }
    }

    if (!snsHandle) return null;

    return {
      snsType: "YOUTUBE",
      snsHandle,
    };
  }

  if (hostname.includes("x.com") || hostname.includes("twitter.com")) {
    const pathSegments = parsed.pathname
      .split("/")
      .filter((segment) => segment.length > 0);
    const firstSegment = pathSegments[0];
    if (!firstSegment) return null;
    const snsHandle = firstSegment.replace(/^@/, "");
    if (!snsHandle) return null;

    return {
      snsType: "X",
      snsHandle,
    };
  }

  return null;
}
