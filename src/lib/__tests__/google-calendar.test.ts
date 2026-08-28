import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prisma", () => ({
  getPrisma: vi.fn(),
}));
vi.mock("../asset-storage", () => ({
  decryptSecret: vi.fn(),
  encryptSecret: vi.fn(),
}));

import { getPrisma } from "../prisma";
import {
  getFinanceCalendarId,
  isValidCalendarId,
  setFinanceCalendarId,
} from "../google-calendar";

function makeFakePrisma(row: { metadata?: string | null } | null) {
  return {
    storageIntegration: {
      findUnique: vi.fn().mockResolvedValue(row),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isValidCalendarId", () => {
  it("이메일 형태의 캘린더 ID 만 통과시킨다", () => {
    expect(isValidCalendarId("example@group.calendar.google.com")).toBe(true);
    expect(isValidCalendarId("user@gmail.com")).toBe(true);
    expect(isValidCalendarId("primary")).toBe(false); // 별칭은 저장 값이 아니다(미설정=primary)
    expect(isValidCalendarId("")).toBe(false);
    expect(isValidCalendarId("has space@example.com")).toBe(false);
    expect(isValidCalendarId(`${"a".repeat(320)}@x.com`)).toBe(false); // 길이 상한
  });
});

describe("getFinanceCalendarId", () => {
  it("metadata JSON 의 financeCalendarId 를 돌려준다", async () => {
    vi.mocked(getPrisma).mockReturnValue(
      makeFakePrisma({
        metadata: JSON.stringify({ financeCalendarId: "test@group.calendar.google.com" }),
      }) as never,
    );
    expect(await getFinanceCalendarId()).toBe("test@group.calendar.google.com");
  });

  it("행 없음·metadata 없음·형식 불량은 전부 null(=primary 폴백)", async () => {
    for (const row of [
      null,
      { metadata: null },
      { metadata: "{broken" },
      { metadata: JSON.stringify({ financeCalendarId: "not a calendar id" }) },
      { metadata: JSON.stringify({ other: 1 }) },
    ]) {
      vi.mocked(getPrisma).mockReturnValue(makeFakePrisma(row) as never);
      expect(await getFinanceCalendarId()).toBeNull();
    }
  });
});

describe("setFinanceCalendarId", () => {
  it("기존 metadata 의 다른 키를 보존한 채 값을 넣는다", async () => {
    const prisma = makeFakePrisma({ metadata: JSON.stringify({ keep: "me" }) });
    vi.mocked(getPrisma).mockReturnValue(prisma as never);

    await setFinanceCalendarId("test@group.calendar.google.com");

    const arg = prisma.storageIntegration.upsert.mock.calls[0][0];
    expect(JSON.parse(arg.update.metadata)).toEqual({
      keep: "me",
      financeCalendarId: "test@group.calendar.google.com",
    });
  });

  it("null 이면 키를 제거하고, 남는 키가 없으면 metadata 를 null 로 비운다", async () => {
    const prisma = makeFakePrisma({
      metadata: JSON.stringify({ financeCalendarId: "test@group.calendar.google.com" }),
    });
    vi.mocked(getPrisma).mockReturnValue(prisma as never);

    await setFinanceCalendarId(null);

    const arg = prisma.storageIntegration.upsert.mock.calls[0][0];
    expect(arg.update.metadata).toBeNull();
  });
});
