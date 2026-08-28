import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MOBILE_DIR = join(process.cwd(), "src/components/mobile");

function listMobileSourceFiles(): string[] {
  return readdirSync(MOBILE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(tsx|ts)$/.test(entry.name))
    .map((entry) => join(MOBILE_DIR, entry.name));
}

describe("mobile CRM breakpoint contract", () => {
  it("scans every file in src/components/mobile", () => {
    expect(listMobileSourceFiles().length).toBeGreaterThanOrEqual(10);
  });

  it("does not hide UA-gated mobile views with desktop breakpoints", () => {
    for (const file of listMobileSourceFiles()) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("md:hidden");
      expect(source, file).not.toContain("hidden md:");
    }
  });
});
