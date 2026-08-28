import { describe, it, expect } from "vitest";
import { parseBulkSellerLines, BULK_SELLER_MAX } from "./bulk-seller-parse";

describe("parseBulkSellerLines", () => {
  it("parses instagram URL into snsType/handle/channelUrl", () => {
    const [e] = parseBulkSellerLines("https://instagram.com/foo_bar");
    expect(e.status).toBe("ok");
    expect(e.snsType).toBe("INSTAGRAM");
    expect(e.snsHandle).toBe("foo_bar");
    expect(e.channelUrl).toBe("https://www.instagram.com/foo_bar");
  });

  it("parses schemeless domain by prepending https", () => {
    const [e] = parseBulkSellerLines("youtube.com/@chan");
    expect(e.status).toBe("ok");
    expect(e.snsType).toBe("YOUTUBE");
    expect(e.snsHandle).toBe("chan");
  });

  it("treats a bare token as an instagram handle and strips a leading @", () => {
    const [e] = parseBulkSellerLines("@someone");
    expect(e.status).toBe("ok");
    expect(e.snsType).toBe("INSTAGRAM");
    expect(e.snsHandle).toBe("someone");
    expect(e.channelUrl).toBe("https://www.instagram.com/someone");
  });

  it("splits on newlines, spaces, and commas", () => {
    const entries = parseBulkSellerLines("a\nb c,d");
    expect(entries.map((e) => e.snsHandle)).toEqual(["a", "b", "c", "d"]);
  });

  it("marks the second same-handle occurrence as duplicate (case-insensitive)", () => {
    const entries = parseBulkSellerLines(
      "foo\nhttps://instagram.com/FOO"
    );
    expect(entries[0].status).toBe("ok");
    expect(entries[1].status).toBe("duplicate");
  });

  it("does not treat different SNS types with same handle as duplicates", () => {
    const entries = parseBulkSellerLines(
      "instagram.com/same\nx.com/same"
    );
    expect(entries[0].status).toBe("ok");
    expect(entries[1].status).toBe("ok");
  });

  it("marks unsupported URLs and illegal handles as invalid", () => {
    const entries = parseBulkSellerLines("https://tiktok.com/@x\nbad!handle");
    expect(entries[0].status).toBe("invalid");
    expect(entries[1].status).toBe("invalid");
  });

  it("ignores empty lines and surrounding whitespace", () => {
    expect(parseBulkSellerLines("\n\n   \n")).toHaveLength(0);
  });

  it("keeps all rows in preview even beyond the batch cap (cap enforced at creation)", () => {
    const many = Array.from({ length: BULK_SELLER_MAX + 5 }, (_, i) => `user_${i}`).join("\n");
    const entries = parseBulkSellerLines(many);
    expect(entries).toHaveLength(BULK_SELLER_MAX + 5);
    expect(entries.every((e) => e.status === "ok")).toBe(true);
  });
});
