/**
 * 중복 입구·죽은 라우트 정리 계약 (애플 UI 개편 묶음 1, Task A4).
 *
 * 입구는 하나여야 한다 — 가격표는 `/assets/price-sheets`, 채널 수수료는 설정 > 운영 정책,
 * 업무 처리는 `/pipeline`, 데스크톱 일정은 `/calendar`. 소스를 텍스트로 훑는 계약이라
 * 되살아난 옛 입구를 컴파일 없이 잡는다.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");

function read(rel: string) {
  return readFileSync(path.join(SRC, rel), "utf8");
}

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const THIS_FILE = path.join(SRC, "app/__tests__/dead-routes.contract.test.ts");
const sources = walk(SRC).filter((f) => f !== THIS_FILE);

function filesContaining(needle: string) {
  return sources.filter((f) => readFileSync(f, "utf8").includes(needle)).map((f) => path.relative(SRC, f));
}

describe("죽은 라우트 · 중복 입구 정리", () => {
  it("양성 대조 — 스캐너가 소스를 실제로 읽는다", () => {
    expect(filesContaining("CrmShell").length).toBeGreaterThan(10);
  });

  it("/pipeline/tasks 는 /pipeline 으로 리다이렉트만 한다", () => {
    const text = read("app/pipeline/tasks/page.tsx");
    expect(text).toContain('redirect("/pipeline")');
    expect(text).not.toContain("CrmDashboard");
  });

  it("/schedule 데스크톱 분기는 /calendar 로 리다이렉트하고 영어 안내 문장이 없다", () => {
    const text = read("app/schedule/page.tsx");
    expect(text).toContain('redirect("/calendar")');
    expect(text).not.toContain("Desktop users should use");
    // 모바일 분기는 그대로다.
    expect(text).toContain("MobileCalendarHome");
  });

  it("/admin/channel-fees 디렉터리가 없다 — 입구는 설정 > 운영 정책", () => {
    expect(existsSync(path.join(SRC, "app/admin/channel-fees"))).toBe(false);
    expect(existsSync(path.join(SRC, "components/crm/channel-fees-client.tsx"))).toBe(false);
  });

  it("enableReportView 문자열이 src 에 없다", () => {
    expect(filesContaining("enableReportView")).toEqual([]);
  });

  it("mobilePipelineMode 문자열이 src 에 없다", () => {
    expect(filesContaining("mobilePipelineMode")).toEqual([]);
  });

  it("결재함은 가격표 업로드 카드를 import 하지 않는다 — 입구는 /assets/price-sheets 하나", () => {
    const text = read("app/approvals/page.tsx");
    expect(text).not.toContain("PriceSheetIngestCard");
    expect(text).not.toContain("price-sheet-ingest-card");
  });

  it("정산 CSV 내보내기가 src 에 없다", () => {
    expect(filesContaining("handleExportCsv")).toEqual([]);
    // 다른 기능(리뷰 임포트 안내 주석)의 같은 낱말은 대상이 아니다 — 정산 화면 파일만 본다.
    expect(read("app/settlement/settlement-page-client.tsx")).not.toContain("CSV 내보내기");
  });
});
