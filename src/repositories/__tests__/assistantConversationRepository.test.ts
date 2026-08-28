/**
 * assistantConversationRepository 단위 테스트 (Phase 5 청사진 §5).
 *
 * 검증 대상:
 * - Json 직렬화 왕복(SQLite 문자열 / Postgres 객체) — ActionProposal과 동일한
 *   이원화 패턴(serializeJsonField/deserializeJsonField) 재사용 확인.
 * - §1-2 64KB 캡: 초과 시 각 toolCall의 data 필드 제거(toolName·args·ok·error·evidence
 *   유지) + toolCallsTruncated=true, 미만 시 원본 유지.
 * - create/list/findWithMessages/appendTurns의 Prisma 호출 계약(mock 레벨).
 *
 * getPrisma()를 모킹해 실제 DB 없이 저장소 로직만 검증한다(CASCADE 실동작은
 * 별도 realdb 테스트에서 로컬 SQLite로 확인).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// §5-3: 대화 검색 — containsSearch를 실제 구현 그대로 사용해 where 절 형태를 검증한다
// (모킹하지 않는다 — Postgres insensitive / SQLite plain 이원화는 이미 검증된 순수 함수).
import { containsSearch } from "@/lib/prisma-search";

const findUniqueMock = vi.fn();
const createConversationMock = vi.fn();
const findManyConversationMock = vi.fn();
const deleteManyConversationMock = vi.fn();
const updateManyConversationMock = vi.fn();
const countMessageMock = vi.fn();
const createMessageMock = vi.fn();
const findManyMessageMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    assistantConversation: {
      create: (...args: unknown[]) => createConversationMock(...args),
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      findMany: (...args: unknown[]) => findManyConversationMock(...args),
      deleteMany: (...args: unknown[]) => deleteManyConversationMock(...args),
      updateMany: (...args: unknown[]) => updateManyConversationMock(...args),
    },
    assistantChatMessage: {
      create: (...args: unknown[]) => createMessageMock(...args),
      findMany: (...args: unknown[]) => findManyMessageMock(...args),
      count: (...args: unknown[]) => countMessageMock(...args),
    },
    $transaction: (...args: unknown[]) => transactionMock(...args),
  }),
}));

async function loadRepository() {
  vi.resetModules();
  return await import("../assistantConversationRepository");
}

describe("assistantConversationRepository — Json 직렬화 왕복", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  const sampleToolCalls = [
    {
      toolName: "get_settlement_report",
      args: { month: "2026-07" },
      ok: true,
      data: { total: 1000 },
      error: null,
      evidence: { dataSources: ["SalesCampaign"], query: { month: "2026-07" } },
    },
  ];

  it("SQLite(file: DATABASE_URL)에서는 JSON 문자열로 직렬화하고 역직렬화로 원복된다", async () => {
    process.env.DATABASE_URL = "file:./dev.db";
    const { serializeToolCalls, deserializeToolCalls } = await loadRepository();

    const serialized = serializeToolCalls(sampleToolCalls);
    expect(typeof serialized.value).toBe("string");

    const roundTripped = deserializeToolCalls(serialized.value);
    expect(roundTripped).toEqual(sampleToolCalls);
  });

  it("Postgres(postgresql:// DATABASE_URL)에서는 객체를 그대로 유지한다", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    const { serializeToolCalls, deserializeToolCalls } = await loadRepository();

    const serialized = serializeToolCalls(sampleToolCalls);
    expect(serialized.value).toBe(sampleToolCalls);

    const roundTripped = deserializeToolCalls(serialized.value);
    expect(roundTripped).toEqual(sampleToolCalls);
  });

  it("toolCalls가 null/undefined면 직렬화·역직렬화 모두 null을 반환한다", async () => {
    process.env.DATABASE_URL = "file:./dev.db";
    const { serializeToolCalls, deserializeToolCalls } = await loadRepository();

    expect(serializeToolCalls(null).value).toBeNull();
    expect(serializeToolCalls(undefined).value).toBeNull();
    expect(deserializeToolCalls(null)).toBeNull();
    expect(deserializeToolCalls(undefined)).toBeNull();
  });
});

describe("assistantConversationRepository — §1-2 64KB 캡", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
  });

  it("직렬화 길이가 64KB 미만이면 원본 toolCalls를 그대로 유지하고 truncated=false다", async () => {
    const { serializeToolCalls } = await loadRepository();

    const smallToolCalls = [
      {
        toolName: "get_settlement_report",
        args: { month: "2026-07" },
        ok: true,
        data: { total: 1000 },
        error: null,
        evidence: { dataSources: ["SalesCampaign"], query: {} },
      },
    ];

    const { value, truncated } = serializeToolCalls(smallToolCalls);
    expect(truncated).toBe(false);
    expect(value).toEqual(smallToolCalls);
  });

  it("직렬화 길이가 64KB를 초과하면 각 toolCall의 data 필드를 제거하고 truncated=true다 (toolName·args·ok·error·evidence는 유지)", async () => {
    const { serializeToolCalls } = await loadRepository();

    // data 필드에 64KB를 훌쩍 넘는 대량 문자열을 채워 캡을 강제로 초과시킨다.
    const hugeData = { blob: "x".repeat(100_000) };
    const bigToolCalls = [
      {
        toolName: "get_order_snapshot",
        args: { campaignId: "camp-1" },
        ok: true,
        data: hugeData,
        error: null,
        evidence: { dataSources: ["OrderCampaign"], query: { campaignId: "camp-1" } },
      },
    ];

    const { value, truncated } = serializeToolCalls(bigToolCalls);
    expect(truncated).toBe(true);

    const parsed = value as Array<Record<string, unknown>>;
    expect(parsed[0].data).toBeNull();
    expect(parsed[0].toolName).toBe("get_order_snapshot");
    expect(parsed[0].args).toEqual({ campaignId: "camp-1" });
    expect(parsed[0].ok).toBe(true);
    expect(parsed[0].error).toBeNull();
    expect(parsed[0].evidence).toEqual({ dataSources: ["OrderCampaign"], query: { campaignId: "camp-1" } });
  });

  it("toolCalls가 빈 배열이면 truncated=false, value는 빈 배열이다", async () => {
    const { serializeToolCalls } = await loadRepository();
    const { value, truncated } = serializeToolCalls([]);
    expect(truncated).toBe(false);
    expect(value).toEqual([]);
  });
});

describe("AssistantConversationRepository — CRUD 계약 (mock)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
  });

  it("create: createdBy·title로 신규 대화를 생성한다", async () => {
    const { AssistantConversationRepository } = await loadRepository();
    createConversationMock.mockResolvedValue({ id: "conv-1", createdBy: "user-1", title: "제목" });

    const result = await AssistantConversationRepository.create({
      createdBy: "user-1",
      title: "제목",
    });

    expect(createConversationMock).toHaveBeenCalledWith({
      data: { createdBy: "user-1", title: "제목" },
    });
    expect(result.id).toBe("conv-1");
  });

  it("list: createdBy로 스코프하고 최근 30개, updatedAt desc, 메시지수(_count)를 포함한다", async () => {
    const { AssistantConversationRepository } = await loadRepository();
    findManyConversationMock.mockResolvedValue([
      { id: "conv-1", title: "t1", updatedAt: new Date(), _count: { messages: 4 } },
    ]);

    const result = await AssistantConversationRepository.list("user-1");

    expect(findManyConversationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdBy: "user-1" },
        orderBy: { updatedAt: "desc" },
        take: 30,
      })
    );
    const callArgs = findManyConversationMock.mock.calls[0][0];
    expect(callArgs.include ?? callArgs.select).toBeDefined();
    expect(result).toHaveLength(1);
  });

  // §5-3: query 없으면 현 동작(where에 createdBy만, OR 없음) — 하위호환.
  it("list: query 인자를 생략하면 where에 OR 필터가 추가되지 않는다(하위호환)", async () => {
    const { AssistantConversationRepository } = await loadRepository();
    findManyConversationMock.mockResolvedValue([]);

    await AssistantConversationRepository.list("user-1");

    const callArgs = findManyConversationMock.mock.calls[0][0];
    expect(callArgs.where).toEqual({ createdBy: "user-1" });
  });

  // §5-3: query가 트림 후 비어있지 않으면 title/본문 OR 검색을 where에 추가한다.
  it("list: query가 있으면 createdBy 스코프를 유지하면서 title/messages.some(text) OR 검색을 where에 추가한다", async () => {
    const { AssistantConversationRepository } = await loadRepository();
    findManyConversationMock.mockResolvedValue([]);

    await AssistantConversationRepository.list("user-1", "정산");

    expect(findManyConversationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdBy: "user-1",
          OR: [
            { title: containsSearch("정산") },
            { messages: { some: { text: containsSearch("정산") } } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: 30,
      })
    );
  });

  // §5-3: query가 공백만 있으면(트림 후 빈 문자열) 필터를 걸지 않는다(현 동작과 동일).
  it("list: query가 공백만 있으면(트림 후 빈 문자열) OR 필터를 추가하지 않는다", async () => {
    const { AssistantConversationRepository } = await loadRepository();
    findManyConversationMock.mockResolvedValue([]);

    await AssistantConversationRepository.list("user-1", "   ");

    const callArgs = findManyConversationMock.mock.calls[0][0];
    expect(callArgs.where).toEqual({ createdBy: "user-1" });
  });

  it("findWithMessages: id로 대화+메시지(asc)를 조회하고 createdBy를 포함해 소유 검증에 쓸 수 있게 한다", async () => {
    const { AssistantConversationRepository } = await loadRepository();
    findUniqueMock.mockResolvedValue({
      id: "conv-1",
      createdBy: "user-1",
      title: "t",
      messages: [{ id: "m1", role: "user", text: "hi", createdAt: new Date() }],
    });

    const result = await AssistantConversationRepository.findWithMessages("conv-1");

    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conv-1" },
      })
    );
    const callArgs = findUniqueMock.mock.calls[0][0];
    expect(callArgs.include?.messages?.orderBy).toEqual({ createdAt: "asc" });
    expect(result?.createdBy).toBe("user-1");
  });

  it("findWithMessages: 존재하지 않으면 null을 반환한다", async () => {
    const { AssistantConversationRepository } = await loadRepository();
    findUniqueMock.mockResolvedValue(null);

    const result = await AssistantConversationRepository.findWithMessages("no-such-id");
    expect(result).toBeNull();
  });

  it("appendTurns: user 턴과 model 턴을 하나의 트랜잭션으로 생성하고 대화 updatedAt을 갱신한다", async () => {
    const { AssistantConversationRepository } = await loadRepository();

    transactionMock.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      const tx = {
        assistantChatMessage: { create: createMessageMock },
        assistantConversation: { update: vi.fn().mockResolvedValue({}) },
      };
      return callback(tx);
    });
    createMessageMock.mockResolvedValue({ id: "msg-1" });

    await AssistantConversationRepository.appendTurns("conv-1", {
      userText: "질문",
      modelText: "답변",
      toolCalls: [],
      actionProposalIds: ["ap-1"],
    });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    // user 턴 + model 턴 = 2회 create
    expect(createMessageMock).toHaveBeenCalledTimes(2);
    const userCall = createMessageMock.mock.calls[0][0];
    const modelCall = createMessageMock.mock.calls[1][0];
    expect(userCall.data.role).toBe("user");
    expect(userCall.data.text).toBe("질문");
    expect(modelCall.data.role).toBe("model");
    expect(modelCall.data.text).toBe("답변");
    expect(modelCall.data.actionProposalIds).toEqual(["ap-1"]);
  });

  // §5-1: 대화 삭제 — 소유 스코프 원자 삭제(deleteMany의 count로 판정, 레이스-세이프).
  it("deleteOwned: id·createdBy 둘 다 조건으로 deleteMany를 호출하고 count>0이면 deleted:true를 반환한다", async () => {
    const { AssistantConversationRepository } = await loadRepository();
    deleteManyConversationMock.mockResolvedValue({ count: 1 });

    const result = await AssistantConversationRepository.deleteOwned("conv-1", "user-1");

    expect(deleteManyConversationMock).toHaveBeenCalledWith({
      where: { id: "conv-1", createdBy: "user-1" },
    });
    expect(result).toEqual({ deleted: true });
  });

  it("deleteOwned: count===0이면(타인 소유·부재) deleted:false를 반환한다", async () => {
    const { AssistantConversationRepository } = await loadRepository();
    deleteManyConversationMock.mockResolvedValue({ count: 0 });

    const result = await AssistantConversationRepository.deleteOwned("conv-2", "user-1");

    expect(result).toEqual({ deleted: false });
  });

  // §5-2: 대화 이름 바꾸기 — deleteOwned와 동일한 소유 스코프 원자 패턴(updateMany count 판정).
  it("renameOwned: id·createdBy 둘 다 조건으로 updateMany를 호출하고 count>0이면 renamed:true를 반환한다", async () => {
    const { AssistantConversationRepository } = await loadRepository();
    updateManyConversationMock.mockResolvedValue({ count: 1 });

    const result = await AssistantConversationRepository.renameOwned("conv-1", "user-1", "새 제목");

    expect(updateManyConversationMock).toHaveBeenCalledWith({
      where: { id: "conv-1", createdBy: "user-1" },
      data: { title: "새 제목" },
    });
    expect(result).toEqual({ renamed: true });
  });

  it("renameOwned: count===0이면(타인 소유·부재) renamed:false를 반환한다", async () => {
    const { AssistantConversationRepository } = await loadRepository();
    updateManyConversationMock.mockResolvedValue({ count: 0 });

    const result = await AssistantConversationRepository.renameOwned("conv-2", "user-1", "새 제목");

    expect(result).toEqual({ renamed: false });
  });
});

describe("AssistantConversationRepository — 실 SQLite CASCADE 회귀", () => {
  it("대화를 삭제하면 연결된 메시지도 함께 삭제된다 (onDelete: Cascade)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const REPO_ROOT = process.cwd();
    const tmpDir = mkdtempSync(join(tmpdir(), "wag-crm-assistant-cascade-"));
    const dbPath = join(tmpDir, "test.db");

    try {
      execFileSync(
        "npx",
        ["prisma", "db", "push", "--schema", "prisma/schema.sqlite.prisma", "--skip-generate", "--accept-data-loss"],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
          stdio: "pipe",
        }
      );

      const generatedClientPath = join(REPO_ROOT, "prisma", "generated", "prisma-sqlite", "index.js");
      const { PrismaClient } = await import(/* @vite-ignore */ generatedClientPath);
      const realPrisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

      try {
        const conversation = await realPrisma.assistantConversation.create({
          data: { createdBy: "user-cascade", title: "CASCADE 테스트" },
        });
        await realPrisma.assistantChatMessage.create({
          data: {
            conversationId: conversation.id,
            role: "user",
            text: "질문",
          },
        });
        await realPrisma.assistantChatMessage.create({
          data: {
            conversationId: conversation.id,
            role: "model",
            text: "답변",
          },
        });

        const beforeCount = await realPrisma.assistantChatMessage.count({
          where: { conversationId: conversation.id },
        });
        expect(beforeCount).toBe(2);

        await realPrisma.assistantConversation.delete({ where: { id: conversation.id } });

        const afterCount = await realPrisma.assistantChatMessage.count({
          where: { conversationId: conversation.id },
        });
        expect(afterCount).toBe(0);
      } finally {
        await realPrisma.$disconnect();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30000);

  // §5-1: deleteOwned(deleteMany 소유 스코프 경로)로 삭제해도 CASCADE로 메시지가 함께 정리된다.
  it("deleteOwned로 삭제하면(소유 스코프 deleteMany) 연결된 메시지도 CASCADE로 함께 삭제된다", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const REPO_ROOT = process.cwd();
    const tmpDir = mkdtempSync(join(tmpdir(), "wag-crm-assistant-delete-owned-"));
    const dbPath = join(tmpDir, "test.db");

    try {
      execFileSync(
        "npx",
        ["prisma", "db", "push", "--schema", "prisma/schema.sqlite.prisma", "--skip-generate", "--accept-data-loss"],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
          stdio: "pipe",
        }
      );

      const generatedClientPath = join(REPO_ROOT, "prisma", "generated", "prisma-sqlite", "index.js");
      const { PrismaClient } = await import(/* @vite-ignore */ generatedClientPath);
      const realPrisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

      vi.doMock("@/lib/prisma", () => ({ getPrisma: () => realPrisma }));
      vi.resetModules();
      const { AssistantConversationRepository } = await import("../assistantConversationRepository");

      try {
        const conversation = await realPrisma.assistantConversation.create({
          data: { createdBy: "user-owner", title: "삭제 대상" },
        });
        await realPrisma.assistantChatMessage.create({
          data: { conversationId: conversation.id, role: "user", text: "질문" },
        });
        await realPrisma.assistantChatMessage.create({
          data: { conversationId: conversation.id, role: "model", text: "답변" },
        });

        // 타인 소유로 삭제 시도 — 삭제되지 않아야 한다(레이스/소유 불일치 세이프가드).
        const otherResult = await AssistantConversationRepository.deleteOwned(conversation.id, "other-user");
        expect(otherResult).toEqual({ deleted: false });

        const stillThere = await realPrisma.assistantConversation.findUnique({ where: { id: conversation.id } });
        expect(stillThere).not.toBeNull();

        // 본인 소유로 삭제 — 성공하고 메시지도 CASCADE로 정리된다.
        const ownerResult = await AssistantConversationRepository.deleteOwned(conversation.id, "user-owner");
        expect(ownerResult).toEqual({ deleted: true });

        const conversationAfter = await realPrisma.assistantConversation.findUnique({ where: { id: conversation.id } });
        expect(conversationAfter).toBeNull();

        const messagesAfter = await realPrisma.assistantChatMessage.count({
          where: { conversationId: conversation.id },
        });
        expect(messagesAfter).toBe(0);
      } finally {
        await realPrisma.$disconnect();
        vi.doUnmock("@/lib/prisma");
        vi.resetModules();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30000);
});

// §5-3: 대화 검색 — 실 SQLite로 시드 후 title 매칭·본문(messages.some) 매칭·무매칭·query
// 없음(전체) 4가지를 검증한다(기존 CASCADE 실DB 테스트와 동일한 패턴 — vi.doMock으로
// getPrisma를 실 PrismaClient로 대체).
describe("AssistantConversationRepository — list 검색 (§5-3, 실 SQLite)", () => {
  it("query가 title에 매칭되면 해당 대화만 반환하고, 본문(messages.text)에 매칭되면 해당 대화도 함께 반환하며, 무매칭이면 빈 배열, query 없으면 전체를 반환한다", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const REPO_ROOT = process.cwd();
    const tmpDir = mkdtempSync(join(tmpdir(), "wag-crm-assistant-search-"));
    const dbPath = join(tmpDir, "test.db");
    // containsSearch(§5-3)가 isSqliteDatabaseUrl()로 SQLite/Postgres를 분기하므로, 이
    // 테스트 프로세스의 DATABASE_URL도 실제 SQLite 경로로 맞춰야 plain contains(모드 없음)가
    // 선택된다(이전 describe 블록이 postgresql:// 문자열을 남겨둔 채 종료할 수 있어 leak 방지).
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${dbPath}`;

    try {
      execFileSync(
        "npx",
        ["prisma", "db", "push", "--schema", "prisma/schema.sqlite.prisma", "--skip-generate", "--accept-data-loss"],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
          stdio: "pipe",
        }
      );

      const generatedClientPath = join(REPO_ROOT, "prisma", "generated", "prisma-sqlite", "index.js");
      const { PrismaClient } = await import(/* @vite-ignore */ generatedClientPath);
      const realPrisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

      vi.doMock("@/lib/prisma", () => ({ getPrisma: () => realPrisma }));
      vi.resetModules();
      const { AssistantConversationRepository } = await import("../assistantConversationRepository");

      try {
        // conv-title: title에 "정산" 포함, 본문에는 없음.
        const convTitle = await realPrisma.assistantConversation.create({
          data: { createdBy: "user-search", title: "이번 달 정산 현황" },
        });
        await realPrisma.assistantChatMessage.create({
          data: { conversationId: convTitle.id, role: "user", text: "안녕하세요" },
        });

        // conv-body: title에는 없고, 본문(user 메시지)에 "정산" 포함.
        const convBody = await realPrisma.assistantConversation.create({
          data: { createdBy: "user-search", title: "파이프라인 문의" },
        });
        await realPrisma.assistantChatMessage.create({
          data: { conversationId: convBody.id, role: "user", text: "정산 관련해서 궁금한 게 있어요" },
        });

        // conv-nomatch: title/본문 모두 무관.
        const convNoMatch = await realPrisma.assistantConversation.create({
          data: { createdBy: "user-search", title: "날씨 이야기" },
        });
        await realPrisma.assistantChatMessage.create({
          data: { conversationId: convNoMatch.id, role: "user", text: "오늘 날씨 어때요" },
        });

        // 타인 소유 — 검색 결과에 절대 섞이면 안 된다(소유 스코프 유지).
        const convOther = await realPrisma.assistantConversation.create({
          data: { createdBy: "other-user", title: "정산 문의(타인)" },
        });
        await realPrisma.assistantChatMessage.create({
          data: { conversationId: convOther.id, role: "user", text: "정산해주세요" },
        });

        // 1) title 매칭
        const titleMatch = await AssistantConversationRepository.list("user-search", "정산 현황");
        expect(titleMatch.map((c) => c.id)).toEqual([convTitle.id]);

        // 2) 본문 매칭(messages.some)
        const bodyMatch = await AssistantConversationRepository.list("user-search", "궁금한");
        expect(bodyMatch.map((c) => c.id)).toEqual([convBody.id]);

        // 3) 무매칭 — 빈 배열
        const noMatch = await AssistantConversationRepository.list("user-search", "존재하지않는검색어");
        expect(noMatch).toEqual([]);

        // 4) query 없으면 본인 소유 전체(타인 제외)를 최근순으로 반환
        const all = await AssistantConversationRepository.list("user-search");
        expect(all.map((c) => c.id).sort()).toEqual(
          [convTitle.id, convBody.id, convNoMatch.id].sort()
        );
      } finally {
        await realPrisma.$disconnect();
        vi.doUnmock("@/lib/prisma");
        vi.resetModules();
      }
    } finally {
      process.env.DATABASE_URL = originalDatabaseUrl;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30000);
});

// database-review Major 반영: 본문 텍스트 상한 (clampMessageText)
import { clampMessageText } from "../assistantConversationRepository";

describe("clampMessageText — 본문 길이 상한 (database-review Major)", () => {
  it("상한 이하 텍스트는 원본 그대로 반환한다", () => {
    const text = "정상적인 대화 본문";
    expect(clampMessageText(text)).toBe(text);
  });

  it("100K자 초과 텍스트는 절단하고 마커를 붙인다", () => {
    const long = "가".repeat(100_001);
    const clamped = clampMessageText(long);
    expect(clamped.length).toBeLessThan(long.length + 50);
    expect(clamped.startsWith("가".repeat(1000))).toBe(true);
    expect(clamped).toMatch(/잘렸습니다/);
  });

  it("정확히 100K자는 절단하지 않는다(경계)", () => {
    const exact = "a".repeat(100_000);
    expect(clampMessageText(exact)).toBe(exact);
  });
});
