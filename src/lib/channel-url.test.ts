import { describe, expect, it } from "vitest";
import { parseChannelUrl } from "./channel-url";

describe("parseChannelUrl", () => {
  it("parses instagram channel handle", () => {
    expect(parseChannelUrl("https://www.instagram.com/test_user/")).toEqual({
      snsType: "INSTAGRAM",
      snsHandle: "test_user",
    });
  });

  it("parses youtube @handle", () => {
    expect(parseChannelUrl("https://youtube.com/@creator")).toEqual({
      snsType: "YOUTUBE",
      snsHandle: "creator",
    });
  });

  it("parses youtube /channel path", () => {
    expect(
      parseChannelUrl("https://www.youtube.com/channel/UC1234567890"),
    ).toEqual({
      snsType: "YOUTUBE",
      snsHandle: "UC1234567890",
    });
  });

  it("parses X (Twitter) handle", () => {
    expect(parseChannelUrl("https://x.com/test_x_user")).toEqual({
      snsType: "X",
      snsHandle: "test_x_user",
    });
    expect(parseChannelUrl("https://twitter.com/test_twitter_user")).toEqual({
      snsType: "X",
      snsHandle: "test_twitter_user",
    });
  });

  it("returns null for unsupported host", () => {
    expect(parseChannelUrl("https://example.com/channel")).toBeNull();
  });

  it("returns null for invalid URL", () => {
    expect(parseChannelUrl("not-a-url")).toBeNull();
  });
});
