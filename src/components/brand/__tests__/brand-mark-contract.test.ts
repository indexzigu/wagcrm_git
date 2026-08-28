import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 브랜드 마크 SSOT 계약.
 *
 * 앱 안의 마크(`BrandMark`)와 OS 가 읽는 아이콘(`src/app/icon.svg`, `public/icon-*.png`)은
 * **같은 도형**이어야 한다. 둘은 생성 경로가 달라서(전자는 수기 TSX, 후자는 브랜드 킷
 * 스크립트 산출물) 한쪽만 고치면 조용히 갈라진다 — 화면은 새 로고인데 탭 아이콘은 옛것,
 * 또는 그 반대가 된다. 아래 첫 테스트가 그 갈라짐을 직접 잡는다.
 */
const SRC = join(process.cwd(), "src");
const MARK_FILE = join(SRC, "components/brand/brand-mark.tsx");
const ICON_SVG = join(SRC, "app/icon.svg");

/** 말풍선 path 의 `d` 를 통째로 뽑는다. 공백 차이는 정규화한다. */
function bubblePath(source: string): string | null {
  const m = source.match(/d="(M28 20[^"]+)"/);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("브랜드 마크 SSOT 계약", () => {
  const markSource = readFileSync(MARK_FILE, "utf8");

  it("BrandMark 의 도형이 파비콘(icon.svg)과 일치한다", () => {
    const inComponent = bubblePath(markSource);
    const inIcon = bubblePath(readFileSync(ICON_SVG, "utf8"));
    expect(inComponent, "BrandMark 에서 말풍선 path 를 찾지 못했다").toBeTruthy();
    expect(inIcon, "icon.svg 에서 말풍선 path 를 찾지 못했다").toBeTruthy();
    expect(
      inComponent,
      "앱 마크와 파비콘의 도형이 다르다 — 브랜드 킷에서 재생성한 뒤 양쪽에 함께 반영할 것",
    ).toBe(inIcon);
  });

  it("마크는 단색이다 — 말풍선·막대 모두 currentColor", () => {
    expect(markSource).toContain('stroke="currentColor"');
    expect(markSource).toContain('fill="currentColor"');
    // 색을 박으면 표면별 대비 대응(P8 §5)이 무너진다. 색은 부모의 text-* 가 정한다.
    const hardcoded = markSource.match(/(?:fill|stroke)="#[0-9A-Fa-f]{3,8}"/g);
    expect(
      hardcoded ?? [],
      "마크에 색을 하드코딩하지 말 것 — 부모가 text-* 로 정한다",
    ).toEqual([]);
  });

  it("말풍선 도형은 BrandMark 밖에서 다시 그리지 않는다", () => {
    const duplicated = collectSourceFiles(SRC)
      .filter((f) => f !== MARK_FILE && !f.includes("__tests__"))
      .filter((f) => bubblePath(readFileSync(f, "utf8")) !== null);
    expect(
      duplicated.map((f) => f.replace(`${process.cwd()}/`, "")),
      "도형을 복제하지 말고 <BrandMark /> 를 임포트할 것 — 아이콘과 갈라진다",
    ).toEqual([]);
  });
});
