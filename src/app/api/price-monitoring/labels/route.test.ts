import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  resolveRootDealId: vi.fn(),
  resolveRootDealIds: vi.fn(),
  findMatchContext: vi.fn(),
  findByRootDealIds: vi.fn(),
  findBrandAliases: vi.fn(),
  accuracy: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));
const reevaluateMock = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api-auth", () => ({ requireAuth: () => authMock() }));
vi.mock("@/lib/price-monitor/reevaluate-snapshots", () => ({
  reevaluateLatestSnapshots: (...args: unknown[]) => reevaluateMock(...args),
}));
vi.mock("@/repositories/priceMatchLabelRepository", () => ({
  priceMatchLabelRepository: repo,
  isOwnerMatchLabelValue: (v: unknown) => v === "SAME" || v === "DIFFERENT",
}));

import { DELETE, GET, POST } from "./route";

function jsonRequest(method: string, body: unknown) {
  return new Request("http://localhost/api/price-monitoring/labels", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/price-monitoring/labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ authenticated: true, context: {} });
    repo.resolveRootDealId.mockImplementation(async (id: string) => (id === "missing" ? null : "root-1"));
    repo.resolveRootDealIds.mockImplementation(
      async (ids: string[]) => new Map(ids.filter((id) => id !== "missing").map((id) => [id, "root-1"])),
    );
    repo.findMatchContext.mockImplementation(async (id: string) =>
      id === "missing" ? null : { rootDealId: "root-1", brandName: "비비랩", unit: "박스", modelName: null, aliasesText: "뉴트리원" },
    );
    repo.findByRootDealIds.mockResolvedValue(new Map([["root-1", [{ nameKey: "k", urlKey: null, label: "SAME" }]]]));
    repo.findBrandAliases.mockResolvedValue(new Map([["root-1", "제조사A\n제조사B"]]));
    repo.accuracy.mockResolvedValue({ total: 3, agreed: 2 });
    repo.upsert.mockResolvedValue({});
    repo.remove.mockResolvedValue(1);
    reevaluateMock.mockResolvedValue({ reevaluated: 2, skipped: 0 });
  });

  it("rejects unauthenticated requests", async () => {
    authMock.mockResolvedValue({ authenticated: false, response: new Response(null, { status: 401 }) });
    const res = await POST(jsonRequest("POST", {}));
    expect(res.status).toBe(401);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it("GET maps option deals to their root and returns labels, aliases and accuracy", async () => {
    const res = await GET(new Request("http://localhost/api/price-monitoring/labels?dealIds=opt-1,opt-2,opt-1"));
    const body = await res.json();
    expect(body.roots).toEqual({ "opt-1": "root-1", "opt-2": "root-1" });
    // one batched lookup, not one query per deal
    expect(repo.resolveRootDealIds).toHaveBeenCalledTimes(1);
    expect(repo.resolveRootDealIds).toHaveBeenCalledWith(["opt-1", "opt-2"]);
    expect(repo.resolveRootDealId).not.toHaveBeenCalled();
    expect(body.labels["root-1"]).toHaveLength(1);
    expect(body.aliases["root-1"]).toEqual(["제조사A", "제조사B"]);
    expect(body.accuracy).toEqual({ total: 3, agreed: 2 });
  });

  it("POST stores the label on the root deal with derived keys, then re-evaluates", async () => {
    const res = await POST(
      jsonRequest("POST", {
        dealId: "opt-1",
        label: "DIFFERENT",
        searchQuery: "비비랩 올리브레몬 듀얼 올레샷 2박스",
        candidate: { channel: "kakao", mall: "메디 트리", productName: "순 유기농 올레샷", url: "https://gift.example.com/p/1?x=1" },
      }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "root-1",
        nameKey: "메디트리|순유기농올레샷",
        urlKey: "gift.example.com/p/1",
        label: "DIFFERENT",
        // server re-judges: another company's product -> the system already said "different"
        systemSaidSame: false,
        cause: null,
        searchQuery: "비비랩 올리브레몬 듀얼 올레샷 2박스",
      }),
    );
    expect(reevaluateMock).toHaveBeenCalledWith("root-1");
    expect(body.reevaluateError).toBeNull();
  });

  it("POST records why a different product was listed, judged by the server not the client", async () => {
    await POST(
      jsonRequest("POST", {
        dealId: "opt-1",
        label: "DIFFERENT",
        searchQuery: "비비랩 올리브레몬 듀얼 올레샷 2박스",
        systemSaidSame: false, // ignored: the server decides
        candidate: { mall: "어떤몰", productName: "비비랩 올리브레몬 듀얼 올레샷 스틱" },
      }),
    );
    const saved = repo.upsert.mock.calls[0][0];
    expect(saved).toMatchObject({ systemSaidSame: true, cause: "SHARED_WORDS" });
    const evidence = JSON.parse(saved.evidence);
    expect(evidence).toMatchObject({ brandMatch: "match", brandFoundIn: "productName", extraWords: ["스틱"] });
    expect(evidence.identities).toEqual(["비비랩", "뉴트리원"]);
    expect(evidence.seen).toBeNull();
    expect(evidence.rules).toBe(2);
    expect(evidence.queryEdited).toBeNull(); // no default query sent
  });

  it("POST records whether the owner edited the default search query", async () => {
    const send = (searchQuery: string) =>
      POST(
        jsonRequest("POST", {
          dealId: "opt-1",
          label: "SAME",
          searchQuery,
          defaultQuery: "비비랩 올리브레몬 듀얼 올레샷 2박스",
          candidate: { mall: "어떤몰", productName: "비비랩 올리브레몬 듀얼 올레샷 2박스" },
        }),
      );
    await send("비비랩  올리브레몬 듀얼 올레샷 2박스"); // spacing only
    await send("비비랩 올레샷");
    expect(JSON.parse(repo.upsert.mock.calls[0][0].evidence).queryEdited).toBe(false);
    expect(JSON.parse(repo.upsert.mock.calls[1][0].evidence).queryEdited).toBe(true);
  });

  it("POST keeps what the owner saw as a reference value, without trusting it for the judgment", async () => {
    await POST(
      jsonRequest("POST", {
        dealId: "opt-1",
        label: "DIFFERENT",
        searchQuery: "비비랩 올리브레몬 듀얼 올레샷 2박스",
        candidate: { mall: "어떤몰", productName: "비비랩 올리브레몬 듀얼 올레샷 스틱" },
        seen: { matchScore: 12, excludeReason: "x".repeat(41), ownerLabel: "SAME", extra: "dropped" },
      }),
    );
    const evidence = JSON.parse(repo.upsert.mock.calls[0][0].evidence);
    expect(evidence.seen).toEqual({ matchScore: 12, excludeReason: null, ownerLabel: "SAME" });
    expect(evidence.matchScore).toBe(100);
  });

  it("POST requires a search query to judge against", async () => {
    const res = await POST(jsonRequest("POST", { dealId: "opt-1", label: "SAME", candidate: { productName: "x" } }));
    expect(res.status).toBe(400);
  });

  it("POST validates the label value and candidate", async () => {
    const res = await POST(jsonRequest("POST", { dealId: "opt-1", label: "MAYBE", searchQuery: "q", candidate: { productName: "x" } }));
    expect(res.status).toBe(400);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it("POST returns 404 for an unknown deal", async () => {
    const res = await POST(jsonRequest("POST", { dealId: "missing", label: "SAME", searchQuery: "q", candidate: { productName: "x" } }));
    expect(res.status).toBe(404);
  });

  it("surfaces a re-evaluation failure instead of hiding it (label is still saved)", async () => {
    reevaluateMock.mockRejectedValue(new Error("db down"));
    const res = await POST(jsonRequest("POST", { dealId: "opt-1", label: "SAME", searchQuery: "q", candidate: { productName: "x" } }));
    const body = await res.json();
    expect(repo.upsert).toHaveBeenCalled();
    expect(body.reevaluateError).toBe("db down");
  });

  it("DELETE removes by root deal and name key, then re-evaluates", async () => {
    const res = await DELETE(jsonRequest("DELETE", { dealId: "opt-1", nameKey: "k" }));
    expect(res.status).toBe(200);
    expect(repo.remove).toHaveBeenCalledWith("root-1", "k");
    expect(reevaluateMock).toHaveBeenCalledWith("root-1");
  });
});
