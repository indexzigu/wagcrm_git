import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 구 네이비/골드/블루 팔레트 잔존 차단 (Apple UI 갱신 번들 0). 스캔 루트 = src/.
const RESIDUE = /accent-gold|hero-navy|#0A3D62|#08314E|#E7A567|#F2C79C|#0284C7|to-blue-800|shadow-blue-900|rgba\(\s*10,\s*61,\s*98|rgba\(\s*8,\s*49,\s*78|rgba\(\s*212,\s*175,\s*55/i;
const SELF = "brand-token-residue.contract.test.ts";

export function scanForResidue(content: string): string[] {
  const hits: string[] = [];
  content.split("\n").forEach((line, i) => {
    if (RESIDUE.test(line)) hits.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|css)$/.test(name) && name !== SELF) acc.push(full);
  }
  return acc;
}

describe("brand token residue", () => {
  it("스캐너 양성 프로브: 옛 토큰/hex 가 든 내용에서 잡는다", () => {
    expect(scanForResidue("a\nclassName=\"text-accent-gold\"\nb")).toHaveLength(1);
    expect(scanForResidue("color: #e7a567;")).toHaveLength(1);
    expect(scanForResidue("background: rgba(10, 61, 98, 0.07);")).toHaveLength(1);
    expect(scanForResidue("x: rgba(8,49,78,.5)")).toHaveLength(1);
    expect(scanForResidue("x: rgba( 212,175,55,.2)")).toHaveLength(1);
  });
  it("스캐너 음성 프로브: 새 토큰은 잡지 않는다", () => {
    expect(scanForResidue("bg-accent-achieve text-primary #0F5F67")).toHaveLength(0);
    expect(scanForResidue("rgba(15,95,103,0.07)")).toHaveLength(0);
  });
  it("src/ 전수에 옛 팔레트 잔존 0건", () => {
    const root = path.join(process.cwd(), "src");
    const found: string[] = [];
    for (const f of walk(root)) {
      for (const h of scanForResidue(readFileSync(f, "utf8"))) found.push(`${path.relative(process.cwd(), f)}:${h}`);
    }
    expect(found, `잔존 ${found.length}건\n${found.join("\n")}`).toEqual([]);
  });
});
