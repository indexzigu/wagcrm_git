/**
 * 셀러 감사 로그 정합 계약 — `updateSeller` 와 `PATCH /api/sellers/[id]` 는 같은 것을 남긴다.
 *
 * `fitLevel`(적합성)은 4개 평가 필드로 **자동 재계산**된다(SSOT: `src/lib/seller-fit.ts`).
 * 두 소비처가 같은 규칙을 쓰는데 **감사 로그 동작만 갈려 있었다**:
 *
 * - 라우트는 재계산 결과를 `data` 에 대입하고 감사 루프도 `data` 를 돈다 → 기록된다.
 * - 서비스는 재계산 결과를 **`patchData`** 에 대입하는데 감사 루프는 **원본 `data`** 를
 *   돌았다 → 자동 재계산으로 바뀐 값이 **기록되지 않았다**. `channelUrl` 에서 파생되는
 *   `snsType`·`snsHandle`·`name` 도 같은 이유로 함께 누락됐다(원인 1개, 필드 4개).
 *
 * **왜 기록이 필요한가:** `ActivityLog.previousValue` 는 "이 값이 자동 재계산 결과인가
 * 사람이 직접 고른 것인가"를 사후에 가르는 유일한 수단이다. 기록이 빠지는 경로가 하나라도
 * 있으면 그 판별이 통째로 불가능해진다.
 *
 * 단위 테스트로는 미래의 리팩터를 못 막으므로(대상이 코드 구조라) **소스 스캔**으로
 * 「재계산 대입 대상 == 감사 루프 대상」을 두 파일 모두에 고정한다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const findUniqueMock = vi.fn();
const updateMock = vi.fn();
const recordChangeMock = vi.fn();

vi.mock("@/repositories/sellerRepository", () => ({
  sellerRepository: {
    findUnique: (...args: unknown[]) => findUniqueMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

// `getCompareValue`·`FIELD_LABELS` 는 실물을 쓴다 — 이 계약이 검증하는 것이 바로
// "비교가 성립하는가"라서 비교 헬퍼를 가짜로 바꾸면 테스트가 늘 통과한다.
vi.mock("@/lib/activity-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/activity-log")>();
  return {
    ...actual,
    recordActivityChange: (...args: unknown[]) => recordChangeMock(...args),
    recordActivityCreate: vi.fn().mockResolvedValue(undefined),
    recordActivityDelete: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/seller-history", () => ({
  recordSellerFollowersSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/asset-storage", () => ({
  googleDriveProvider: { createFolderForEntity: vi.fn().mockResolvedValue(null) },
}));

vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({}) }));

import { sellerService } from "../sellerService";

// FIELD_LABELS 가 붙이는 한글 라벨 — 감사 로그의 fieldName 은 이 라벨로 저장된다.
const FIELD_SNS_TYPE = "SNS 유형";
const FIELD_SNS_HANDLE = "SNS 핸들";

/** 4개 평가 필드가 전부 미입력인 셀러 — 개별 테스트가 필요한 값만 덮어쓴다. */
function seedSeller(over: Record<string, unknown> = {}) {
  findUniqueMock.mockResolvedValue({
    id: "seller-1",
    name: "handle-1",
    snsType: "INSTAGRAM",
    snsHandle: "handle-1",
    channelUrl: null,
    currentFollowers: 1000,
    fitLevel: null,
    collaborationScore: null,
    adResponseScore: null,
    commentResponseScore: null,
    activityFrequency: null,
    ...over,
  });
}

/** 감사 로그 호출을 (필드, 이전값, 새값) 로 축약. */
function auditedChanges(): Array<{ field: string; prev: unknown; next: unknown }> {
  return recordChangeMock.mock.calls.map((c) => ({
    field: c[2] as string,
    prev: c[3],
    next: c[4],
  }));
}

beforeEach(() => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
  recordChangeMock.mockReset();
  updateMock.mockResolvedValue({ id: "seller-1" });
  recordChangeMock.mockResolvedValue(undefined);
});

describe("updateSeller — 자동 재계산된 fitLevel 도 감사 로그에 남는다", () => {
  it("평가 점수 변경으로 fitLevel 이 재계산되면 그 변경이 기록된다", async () => {
    seedSeller({ fitLevel: "비추천" });

    await sellerService.updateSeller(
      "seller-1",
      {
        collaborationScore: "3.홍보+활성",
        adResponseScore: "3.10개이상",
        commentResponseScore: "3.10개이상",
        activityFrequency: "3.매일",
      },
      "AI 분석 자동반영",
    );

    // 재계산 결과가 DB 에 쓰였다는 것이 전제 — 그 전제가 깨지면 아래 단언은 무의미하다.
    expect(updateMock.mock.calls[0][0].data.fitLevel).toBe("추천");

    expect(auditedChanges()).toContainEqual({
      field: "fitLevel",
      prev: "비추천",
      next: "추천",
    });
  });

  it("재계산 결과가 현재값과 같으면 기록하지 않는다 — 감사 로그 볼륨 가드", async () => {
    seedSeller({ fitLevel: "추천" });

    await sellerService.updateSeller(
      "seller-1",
      {
        collaborationScore: "3.홍보+활성",
        adResponseScore: "3.10개이상",
        commentResponseScore: "3.10개이상",
        activityFrequency: "3.매일",
      },
      "AI 분석 자동반영",
    );

    expect(auditedChanges().map((c) => c.field)).not.toContain("fitLevel");
  });

  it("평가 4필드가 전부 미입력이면 fitLevel 을 건드리지도 기록하지도 않는다 (미입력 ≠ 낙제)", async () => {
    seedSeller({ fitLevel: "보류" });

    await sellerService.updateSeller(
      "seller-1",
      { collaborationScore: null, adResponseScore: null },
      "AI 분석 자동반영",
    );

    expect(updateMock.mock.calls[0][0].data.fitLevel).toBeUndefined();
    expect(auditedChanges().map((c) => c.field)).not.toContain("fitLevel");
  });

  it("수동 지정 fitLevel 은 재계산을 우회하고 그대로 기록된다 (기존 동작 회귀 가드)", async () => {
    seedSeller({ fitLevel: "비추천" });

    await sellerService.updateSeller(
      "seller-1",
      { fitLevel: "추천", collaborationScore: "0.비노출" },
      "owner@example.com",
    );

    expect(updateMock.mock.calls[0][0].data.fitLevel).toBe("추천");
    expect(auditedChanges()).toContainEqual({
      field: "fitLevel",
      prev: "비추천",
      next: "추천",
    });
  });
});

describe("updateSeller — channelUrl 파생값도 같은 이유로 기록된다", () => {
  it("channelUrl 에서 자동 파싱된 snsType·snsHandle 변경이 기록된다", async () => {
    // 이름이 핸들과 같으면 서비스가 name 도 파생값으로 덮는다 — 그 변경도 감사 대상이다.
    seedSeller({ snsType: "YOUTUBE", snsHandle: "old-handle", name: "old-handle" });

    await sellerService.updateSeller(
      "seller-1",
      { channelUrl: "https://www.instagram.com/new_handle/" },
      "owner@example.com",
    );

    const fields = auditedChanges().map((c) => c.field);
    expect(fields).toContain(FIELD_SNS_TYPE);
    expect(fields).toContain(FIELD_SNS_HANDLE);
  });

  it("감사 로그의 새값은 정규화된 저장값과 일치한다 (@ 접두사 제거 후)", async () => {
    seedSeller({ snsHandle: "old-handle" });

    await sellerService.updateSeller("seller-1", { snsHandle: "@new_handle" }, "owner@example.com");

    expect(updateMock.mock.calls[0][0].data.snsHandle).toBe("new_handle");
    expect(auditedChanges()).toContainEqual({
      field: FIELD_SNS_HANDLE,
      prev: "old-handle",
      next: "new_handle",
    });
  });
});

// ---------------------------------------------------------------------------
// 소스 스캔 — 두 경로가 다시 갈리는 것을 막는다
// ---------------------------------------------------------------------------

const repoRoot = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

/** `X.fitLevel = calculatedFitLevel` 의 X 를 뽑는다. */
function recomputeTarget(src: string): string | null {
  return src.match(/(\w+)\.fitLevel\s*=\s*calculatedFitLevel/)?.[1] ?? null;
}

/** `for (const key of Object.keys(Y))` 의 Y 를 뽑는다. */
function auditLoopTarget(src: string): string | null {
  return src.match(/for\s*\(\s*const\s+key\s+of\s+Object\.keys\(\s*(\w+)\s*\)\s*\)/)?.[1] ?? null;
}

describe("계약: fitLevel 재계산 대입 대상 == 감사 루프 대상", () => {
  const cases: Array<[string, string]> = [
    ["서비스", "src/services/sellerService.ts"],
    ["라우트", "src/app/api/sellers/[id]/route.ts"],
  ];

  for (const [label, rel] of cases) {
    it(`${label}(${rel}) — 재계산 결과가 감사 루프가 도는 객체에 들어간다`, () => {
      const src = read(rel);
      const assigned = recomputeTarget(src);
      const audited = auditLoopTarget(src);

      // 양성 대조군 — 패턴이 안 잡히면 스캔이 고장 난 것이지 통과가 아니다.
      expect(assigned, `${rel}: fitLevel 재계산 대입부를 찾지 못했다`).toBeTruthy();
      expect(audited, `${rel}: 감사 루프를 찾지 못했다`).toBeTruthy();

      expect(assigned).toBe(audited);
    });
  }

  it("서비스는 감사한 객체를 그대로 저장한다 — 저장본과 감사본이 갈리면 같은 결함이 재발한다", () => {
    const src = read("src/services/sellerService.ts");
    const audited = auditLoopTarget(src);

    expect(audited).toBeTruthy();
    expect(src).toContain(`data: ${audited} as any`);
  });
});
