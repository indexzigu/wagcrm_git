// mock 수집 모드의 프로덕션 쓰기 차단 계약 테스트 (2026-07-30).
//
// 배경(서술만 있고 가드가 없어 재발한 사고): mock 은 **출처만 가짜고 저장 경로는 실제**다.
// 팔로워 수집기의 mock 분기는 no-op 이 아니라 난수를 만들어 `SellersHistory` 스냅샷과
// `Seller.currentFollowers` 에 쓴다. 이 레포 `.env` 의 `DATABASE_URL` 은 프로덕션
// Supabase 이므로(AGENTS.md P0) 로컬에서 `INSTAGRAM_COLLECT_MODE=mock` 을 켜고 수집기나
// dev 서버를 돌리면 가짜 팔로워가 프로덕션 셀러 추이에 적립된다 — `source="MOCK"` 행이
// 실제로 프로덕션에 남아 오너 승인 후 삭제됐다(건수는 docs/agents/dev-qa.md). 이 위험은
// `docs/agents/data-contracts.md` 의 Collection Cost Guard 에 **서술로만** 있었고
// 코드 가드가 없어 재발했다. 그래서 두 층으로 고정한다:
//   ① 호출부 게이트  — `mockCollectBlockedReason`(수집기는 skip + 사유, 라우트는 에러 응답)
//   ② 쓰기 차단선   — `recordSellerMetricsSnapshot` 이 MOCK 라벨 + 원격 DB 조합을 거부
// 음성 대조군(원격 DB 라도 실수집 라벨은 통과 / sqlite 면 mock 도 통과)을 함께 둔다 —
// 가드가 "전부 막기"로 퇴화하면 로컬 예행이 불가능해지고, 통과만 검증하면 공허해진다.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 원격 DB 대역. ⚠️ 자격증명을 넣지 않는다 — 이 레포는 PUBLIC 이고 commit-guard 가
// URL 내장 자격증명을 차단한다(자리표시자여도). 호스트 토큰만으로 "문구에 URL 이
// 새지 않는가"를 검증한다.
const REMOTE_URL = "postgresql://db.internal.invalid:5432/appdb";
const LOCAL_URL = "file:./dev.db";

// ---------------------------------------------------------------------------
// prisma 만 목킹한다 — seller-history(쓰기 차단선)는 **실물**을 태워야 계약이 성립한다.
// ---------------------------------------------------------------------------
const sellerFindMany = vi.fn();
const sellerFindUnique = vi.fn();
const sellerUpdate = vi.fn();
const historyFindUnique = vi.fn();
const historyFindFirst = vi.fn();
const historyUpsert = vi.fn();
const bioHistoryCreate = vi.fn();
const apiCallCreate = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    seller: {
      findMany: (...a: unknown[]) => sellerFindMany(...a),
      findUnique: (...a: unknown[]) => sellerFindUnique(...a),
      update: (...a: unknown[]) => sellerUpdate(...a),
    },
    sellersHistory: {
      findUnique: (...a: unknown[]) => historyFindUnique(...a),
      findFirst: (...a: unknown[]) => historyFindFirst(...a),
      upsert: (...a: unknown[]) => historyUpsert(...a),
    },
    sellerProfileBioHistory: { create: (...a: unknown[]) => bioHistoryCreate(...a) },
    apiCallLog: { create: (...a: unknown[]) => apiCallCreate(...a) },
  }),
}));
// 프로필 이미지 Blob 미러링은 외부 호출이라 목킹(입력을 그대로 통과).
vi.mock("@/lib/seller-profile-image", () => ({
  mirrorSellerProfileImage: (_id: string, url?: string | null) => Promise.resolve(url),
}));
// 인스타 mock 분기는 외부 호출이 없어야 한다 — 스크래퍼가 실제로 나가면 그것부터 회귀다.
const proxyFetchMock = vi.fn();
vi.mock("@/lib/order-converter/fetch-client", () => ({
  proxyFetch: (...a: unknown[]) => proxyFetchMock(...a),
}));

import { mockCollectBlockedReason } from "@/lib/collect-mode";
import { collectInstagramFollowers, INSTAGRAM_SNAPSHOT_SOURCE } from "@/lib/collectors/instagram-collector";
import { collectYouTubeSubscribers, YOUTUBE_SNAPSHOT_SOURCE } from "@/lib/collectors/youtube-collector";
import { recordSellerMetricsSnapshot } from "@/lib/seller-history";

const IG_CONFIG = {
  appId: "app",
  appSecret: "secret",
  accessToken: "token",
  igBusinessAccountId: "ig-biz",
};

/** 저장된 스냅샷의 출처 라벨 목록(upsert create 페이로드 기준) */
function upsertedSources(): string[] {
  return historyUpsert.mock.calls.map((c) => (c[0] as { create: { source: string } }).create.source);
}

beforeEach(() => {
  for (const m of [
    sellerFindMany,
    sellerFindUnique,
    sellerUpdate,
    historyFindUnique,
    historyFindFirst,
    historyUpsert,
    bioHistoryCreate,
    apiCallCreate,
    proxyFetchMock,
  ]) {
    m.mockReset();
  }
  sellerFindMany.mockResolvedValue([
    { id: "s1", snsHandle: "handle", currentFollowers: 1000, currentPostsCount: 10 },
  ]);
  sellerFindUnique.mockResolvedValue({ profileBio: null });
  sellerUpdate.mockResolvedValue({});
  historyFindUnique.mockResolvedValue(null); // 오늘 스냅샷 없음
  historyFindFirst.mockResolvedValue(null); // 최근 수집 이력 없음
  historyUpsert.mockResolvedValue({});
  apiCallCreate.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe("mockCollectBlockedReason — mock × 원격 DB 판정", () => {
  it("mock + 원격 DB 면 사유를 돌려준다(플랫폼별 env 키를 문구에 담는다)", () => {
    vi.stubEnv("DATABASE_URL", REMOTE_URL);
    expect(mockCollectBlockedReason("INSTAGRAM", "mock")).toContain("INSTAGRAM_COLLECT_MODE");
    expect(mockCollectBlockedReason("YOUTUBE", "mock")).toContain("YOUTUBE_COLLECT_MODE");
    expect(mockCollectBlockedReason("X", "mock")).toContain("X_COLLECT_MODE");
  });

  it("사유 문구에 DATABASE_URL 값을 담지 않는다 (자격증명 노출 — P0)", () => {
    vi.stubEnv("DATABASE_URL", REMOTE_URL);
    const reason = mockCollectBlockedReason("INSTAGRAM", "mock");
    expect(reason).not.toBeNull(); // 사유가 없으면 아래 단언이 공허하게 통과한다
    expect(String(reason)).not.toContain("db.internal.invalid");
    expect(String(reason)).not.toContain(REMOTE_URL);
  });

  // --- 음성 대조군: 가드가 "전부 막기"로 퇴화하면 로컬 예행·실수집이 죽는다 ---
  it("sqlite DB 면 mock 을 허용한다(로컬 예행 경로 보존)", () => {
    vi.stubEnv("DATABASE_URL", LOCAL_URL);
    expect(mockCollectBlockedReason("INSTAGRAM", "mock")).toBeNull();
  });

  it("DEMO_MODE=1(목업 sqlite)도 허용한다", () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("DEMO_MODE", "1");
    expect(mockCollectBlockedReason("INSTAGRAM", "mock")).toBeNull();
  });

  it("mock 이 아닌 모드는 원격 DB 에서도 막지 않는다(프로덕션 수집이 이 경로다)", () => {
    vi.stubEnv("DATABASE_URL", REMOTE_URL);
    for (const mode of ["api", "apify", "instagram", "youtube", null]) {
      expect(mockCollectBlockedReason("INSTAGRAM", mode)).toBeNull();
    }
  });

  it("DATABASE_URL 미설정·빈값은 원격으로 보지 않는다(Prisma 가 붙지도 못하는 상태)", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(mockCollectBlockedReason("INSTAGRAM", "mock")).toBeNull();
  });
});

describe("크론 수집기 — mock + 원격 DB 면 스냅샷을 쓰지 않는다", () => {
  it("instagram: 저장 0건 + 사유를 errors 에 남기고 skip(throw 하지 않는다)", async () => {
    vi.stubEnv("DATABASE_URL", REMOTE_URL);
    vi.stubEnv("INSTAGRAM_COLLECT_MODE", "mock");

    const res = await collectInstagramFollowers(IG_CONFIG);

    expect(historyUpsert).not.toHaveBeenCalled();
    expect(sellerUpdate).not.toHaveBeenCalled();
    expect(res.successCount).toBe(0);
    expect(res.errors.map((e) => e.error).join("\n")).toContain("INSTAGRAM_COLLECT_MODE=mock");
    expect(proxyFetchMock).not.toHaveBeenCalled();
  });

  it("youtube: 저장 0건 + 사유를 errors 에 남기고 skip", async () => {
    vi.stubEnv("DATABASE_URL", REMOTE_URL);
    vi.stubEnv("YOUTUBE_COLLECT_MODE", "mock");

    const res = await collectYouTubeSubscribers({ apiKey: "key" });

    expect(historyUpsert).not.toHaveBeenCalled();
    expect(sellerUpdate).not.toHaveBeenCalled();
    expect(res.successCount).toBe(0);
    expect(res.errors.map((e) => e.error).join("\n")).toContain("YOUTUBE_COLLECT_MODE=mock");
  });

  // --- 음성 대조군: 같은 mock 이 sqlite 에서는 여전히 저장돼야 한다 ---
  it("sqlite 면 instagram mock 이 MOCK 라벨로 저장된다(가드가 mock 자체를 죽이지 않는다)", async () => {
    vi.stubEnv("DATABASE_URL", LOCAL_URL);
    vi.stubEnv("INSTAGRAM_COLLECT_MODE", "mock");

    const res = await collectInstagramFollowers(IG_CONFIG);

    expect(res.successCount).toBe(1);
    expect(upsertedSources()).toEqual(["MOCK"]);
  });

  it("sqlite 면 youtube mock 이 MOCK 라벨로 저장된다(인스타와 같은 문자열)", async () => {
    vi.stubEnv("DATABASE_URL", LOCAL_URL);
    vi.stubEnv("YOUTUBE_COLLECT_MODE", "mock");

    const res = await collectYouTubeSubscribers({ apiKey: "key" });

    expect(res.successCount).toBe(1);
    expect(upsertedSources()).toEqual([YOUTUBE_SNAPSHOT_SOURCE.MOCK]);
    expect(YOUTUBE_SNAPSHOT_SOURCE.MOCK).toBe(INSTAGRAM_SNAPSHOT_SOURCE.MOCK);
  });
});

describe("쓰기 차단선 — recordSellerMetricsSnapshot 은 MOCK 라벨을 원격 DB 에 쓰지 않는다", () => {
  // 호출부 게이트를 우회하는 새 writer 가 생겨도 여기서 막힌다(구조적 차단).
  // `MOCK_API` 는 은퇴한 라벨이지만 남겨둔다 — 접두사 매칭이 `MOCK_*` 변형까지 덮는다는
  // 계약 자체를 고정하는 케이스다(정확 일치로 좁히면 이 방어가 조용히 사라진다).
  it.each(["MOCK", "MOCK_API"])("source=%s 는 원격 DB 에서 거부된다", async (source) => {
    vi.stubEnv("DATABASE_URL", REMOTE_URL);

    await expect(recordSellerMetricsSnapshot("s1", 1234, source)).rejects.toThrow(/mock 출처/);
    expect(historyUpsert).not.toHaveBeenCalled();
    expect(sellerUpdate).not.toHaveBeenCalled();
  });

  it("실수집 라벨은 원격 DB 에서 그대로 저장된다(음성 대조군)", async () => {
    vi.stubEnv("DATABASE_URL", REMOTE_URL);

    await recordSellerMetricsSnapshot("s1", 1234, "INSTAGRAM_SCRAPER");

    expect(upsertedSources()).toEqual(["INSTAGRAM_SCRAPER"]);
    expect(sellerUpdate).toHaveBeenCalled();
  });

  it("sqlite 면 MOCK 라벨도 저장된다(음성 대조군)", async () => {
    vi.stubEnv("DATABASE_URL", LOCAL_URL);

    await recordSellerMetricsSnapshot("s1", 1234, "MOCK");

    expect(upsertedSources()).toEqual(["MOCK"]);
  });
});

// ---------------------------------------------------------------------------
// 소스 스캔 — 미래 호출부까지 덮는 유일한 수단(선례: instagram-scrape-callers·
// product-order-range-type). 새 수집 표면이 게이트 없이 mock 을 실행하면 여기서 깨진다.
// ---------------------------------------------------------------------------
const SRC_DIR = join(process.cwd(), "src");

/** mock 을 **무조건** 거부하므로 DB 게이트가 불필요한 파일(사유와 함께 등재) */
const GATE_EXEMPT = new Map([
  [
    "src/lib/collectors/instagram-engagement-collector.ts",
    "mock 이면 DB 를 보지 않고 항상 skip(ER 수집은 mock 경로 자체가 없다)",
  ],
  [
    "src/lib/collectors/campaign-engagement-collector.ts",
    "mock 이면 DB 를 보지 않고 항상 skip(위와 동일 게이트)",
  ],
]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("소스 스캔 — resolveCollectMode 호출부는 mock DB 게이트를 지나야 한다", () => {
  const callers = listSourceFiles(SRC_DIR)
    .map((f) => ({ rel: relative(process.cwd(), f), source: readFileSync(f, "utf8") }))
    .filter(({ rel, source }) => rel !== "src/lib/collect-mode.ts" && /resolveCollectMode\s*\(/.test(source));

  it("스캐너가 실제로 호출부를 찾았다(공허 통과 방지)", () => {
    // 현행 5곳: 수집기 4종 + 채널정보 라우트. 줄어들면 스캐너나 경로가 바뀐 것이다.
    expect(callers.map((c) => c.rel).sort()).toEqual([
      "src/app/api/sellers/[id]/channel-info/route.ts",
      "src/lib/collectors/campaign-engagement-collector.ts",
      "src/lib/collectors/instagram-collector.ts",
      "src/lib/collectors/instagram-engagement-collector.ts",
      "src/lib/collectors/youtube-collector.ts",
    ]);
  });

  it("면제 목록 밖의 호출부는 전부 mockCollectBlockedReason 을 부른다", () => {
    const violations = callers
      .filter(({ rel }) => !GATE_EXEMPT.has(rel))
      .filter(({ source }) => !/mockCollectBlockedReason\s*\(/.test(source))
      .map(({ rel }) => rel);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("면제 파일은 mock 을 무조건 거부한다(면제가 조용한 구멍이 되지 않게)", () => {
    for (const [rel, why] of GATE_EXEMPT) {
      const source = readFileSync(join(process.cwd(), rel), "utf8");
      // `if (mode === "mock") { ...skip... }` — DB 조건 없이 끊는 게이트가 있어야 면제가 성립한다.
      expect(/mode\s*===\s*"mock"[\s\S]{0,200}?return result;/.test(source), `${rel}: ${why}`).toBe(true);
    }
  });

  it("채널정보 라우트는 플랫폼 3종 모두를 게이트에 통과시킨다", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/api/sellers/[id]/channel-info/route.ts"),
      "utf8",
    );
    for (const platform of ["INSTAGRAM", "YOUTUBE", "X"]) {
      expect(source, platform).toContain(`mockCollectBlockedReason("${platform}"`);
    }
  });
});
