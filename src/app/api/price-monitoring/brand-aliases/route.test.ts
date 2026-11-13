import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  resolveRootDealId: vi.fn(),
  saveBrandAliases: vi.fn(),
}));
const reevaluateMock = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api-auth", () => ({ requireAuth: () => authMock() }));
vi.mock("@/lib/price-monitor/reevaluate-snapshots", () => ({
  reevaluateLatestSnapshots: (...args: unknown[]) => reevaluateMock(...args),
}));
vi.mock("@/repositories/priceMatchLabelRepository", () => ({ priceMatchLabelRepository: repo }));

import { PUT } from "./route";

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/price-monitoring/brand-aliases", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("/api/price-monitoring/brand-aliases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ authenticated: true, context: {} });
    repo.resolveRootDealId.mockImplementation(async (id: string) => (id === "missing" ? null : "root-1"));
    repo.saveBrandAliases.mockResolvedValue(undefined);
    reevaluateMock.mockResolvedValue({ reevaluated: 1, skipped: 0 });
  });

  it("rejects unauthenticated requests", async () => {
    authMock.mockResolvedValue({ authenticated: false, response: new Response(null, { status: 401 }) });
    const res = await put({ dealId: "opt-1", aliases: ["a"] });
    expect(res.status).toBe(401);
    expect(repo.saveBrandAliases).not.toHaveBeenCalled();
  });

  it("saves trimmed, de-duplicated names on the root deal and re-evaluates", async () => {
    const res = await put({ dealId: "opt-1", aliases: [" 제조사A ", "제조사A", "제조사B, 공식몰"] });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(repo.saveBrandAliases).toHaveBeenCalledWith("root-1", "제조사A\n제조사B\n공식몰");
    expect(reevaluateMock).toHaveBeenCalledWith("root-1");
    expect(body).toMatchObject({ rootDealId: "root-1", aliases: ["제조사A", "제조사B", "공식몰"], reevaluateError: null });
  });

  it("clears names when the list is empty", async () => {
    await put({ dealId: "opt-1", aliases: [] });
    expect(repo.saveBrandAliases).toHaveBeenCalledWith("root-1", null);
  });

  it("rejects malformed bodies, too many names and unknown deals", async () => {
    expect((await put({ dealId: "opt-1" })).status).toBe(400);
    expect((await put({ dealId: "", aliases: [] })).status).toBe(400);
    expect((await put({ dealId: "opt-1", aliases: Array.from({ length: 21 }, (_, i) => `n${i}`) })).status).toBe(400);
    expect((await put({ dealId: "opt-1", aliases: ["x".repeat(41)] })).status).toBe(400);
    expect((await put({ dealId: "missing", aliases: ["a"] })).status).toBe(404);
    expect(repo.saveBrandAliases).not.toHaveBeenCalled();
  });

  it("reports a re-evaluation failure instead of hiding it", async () => {
    reevaluateMock.mockRejectedValue(new Error("db down"));
    const res = await put({ dealId: "opt-1", aliases: ["a1"] });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(repo.saveBrandAliases).toHaveBeenCalled();
    expect(body.reevaluateError).toBe("db down");
  });
});
