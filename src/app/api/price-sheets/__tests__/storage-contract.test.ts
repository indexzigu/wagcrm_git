import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 재발 방지 계약: 가격표 원본 저장이 provider(storeRawObject/readAssetBytes)를 우회해
 * 무조건적 로컬 파일시스템 쓰기로 회귀하지 않는다.
 * Vercel 서버리스는 /var/task가 읽기 전용이라 prod 업로드가 ENOENT로 전멸했던 실사고
 * (mkdir '/var/task/.asset-storage')의 가드다. 로컬 폴백은 storeRawObject 내부에서
 * isSupabaseStorageConfigured() 게이트 뒤에만 존재해야 한다.
 */
describe("price-sheets storage contract", () => {
  const uploadRoute = readFileSync(
    join(process.cwd(), "src/app/api/price-sheets/route.ts"),
    "utf8",
  );
  const extractRoute = readFileSync(
    join(process.cwd(), "src/app/api/price-sheets/[id]/extract/route.ts"),
    "utf8",
  );

  it("계약 앵커가 실재한다 (빈 파일/경로 이동으로 공허 통과 방지)", () => {
    expect(uploadRoute).toContain("saveOriginalFile");
    expect(extractRoute).toContain("readAssetBytes");
  });

  it("업로드 라우트는 storeRawObject를 경유하고 fs에 직접 쓰지 않는다", () => {
    expect(uploadRoute).toContain("storeRawObject");
    expect(uploadRoute).not.toMatch(/from "node:fs/);
    expect(uploadRoute).not.toContain("localAssetPath");
  });

  it("추출 라우트는 readAssetBytes를 경유하고 로컬 전용 읽기를 쓰지 않는다", () => {
    expect(extractRoute).not.toContain("readLocalAsset");
    expect(extractRoute).not.toMatch(/from "node:fs/);
  });
});
