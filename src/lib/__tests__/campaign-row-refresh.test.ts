/**
 * 캠페인 행 재조회 SSOT 의 계약 (T-099).
 *
 * 이 동작은 화면마다 손으로 복사돼 있었고 **사본이 갖춘 조각이 서로 달랐다** — 정산 쪽은
 * 모양 검증과 실패 통지를 둘 다 갖췄는데, 그룹 섹션과 대시보드 합류 후처리는 검증이 없고
 * 실패도 삼켰다. 여기 고정하는 것은 「갖춘 쪽을 기준으로 끌어올린」 그 조각들이다.
 * (사본 전수 목록과 이번에 흡수하지 않은 자리는 모듈 docstring 참조.)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { CampaignRow } from "../crm-types";
import {
  collectGroupSiblingIds,
  createGroupSiblingRefresher,
  refreshCampaignRows,
} from "../campaign-row-refresh";

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refreshCampaignRows", () => {
  it("읽은 행을 하나씩 흘려보내고 실패 0을 돌려준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => ok({ id: String(url).replace("/api/campaigns/", "") })),
    );
    const seen: string[] = [];

    const failed = await refreshCampaignRows(["a", "b"], (row) => seen.push(row.id));

    expect(failed).toBe(0);
    expect(seen).toEqual(["a", "b"]);
  });

  it("같은 id 가 겹쳐 들어와도 한 번만 읽는다", async () => {
    // 호출부가 「제외 전 멤버 전원 + 현재 캠페인」처럼 겹칠 수 있는 목록을 만든다.
    const fetchMock = vi.fn((url: unknown) =>
      ok({ id: String(url).replace("/api/campaigns/", "") }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const seen: string[] = [];

    await refreshCampaignRows(["a", "b", "a"], (row) => seen.push(row.id));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["a", "b"]);
  });

  it("200 이어도 캠페인 행 모양이 아니면 흘려보내지 않고 실패로 센다", async () => {
    // 🪤 캐스팅만 하던 사본들은 오류 JSON(200)을 **빈 행으로 목록에 꽂았다.**
    vi.stubGlobal("fetch", vi.fn(() => ok({ error: "nope" })));
    const seen: CampaignRow[] = [];

    const failed = await refreshCampaignRows(["a"], (row) => seen.push(row));

    expect(failed).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it("HTTP 실패·네트워크 실패는 던지지 않고 개수로 돌려준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) =>
        String(url).endsWith("/a")
          ? Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
          : Promise.reject(new Error("network")),
      ),
    );
    const seen: CampaignRow[] = [];

    // 쓰기는 이미 끝났으므로 던지면 호출부가 「저장 실패」로 오보고하게 된다.
    const failed = await refreshCampaignRows(["a", "b"], (row) => seen.push(row));

    expect(failed).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("행들을 한 틱 안에서 흘려보낸다 — 소비처가 그 동기성에 기대 재조회를 접는다", async () => {
    // 사유·협상 상대는 모듈 docstring 의 ⛔ 항목이 정본이다(여기서 다시 적지 않는다).
    // 계측: 첫 행에서 마이크로태스크를 걸고 그것이 **마지막 행보다 뒤에** 도는지 본다.
    // 🪤 무장을 `order.length === 0` 으로 하지 말 것 — 훗날 첫 행을 실패로 바꾸는 픽스처가
    //    오면 첫 간극이 **조용히** 무검사가 된다. 고정 id 로 무장하면 그때 기대 배열이
    //    어긋나 시끄럽게 실패한다.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => ok({ id: String(url).replace("/api/campaigns/", "") })),
    );
    const order: string[] = [];

    await refreshCampaignRows(["a", "b", "c"], (row) => {
      if (row.id === "a") queueMicrotask(() => order.push("microtask"));
      order.push(row.id);
    });

    expect(order).toEqual(["a", "b", "c", "microtask"]);
  });

});

describe("그룹 형제 재조회 — 저장한 1건만 돌아오는 응답을 메운다", () => {
  const ROWS = [
    { id: "a", groupId: "g1" },
    { id: "b", groupId: "g1" },
    { id: "c", groupId: "g1" },
    { id: "x", groupId: "g2" },
    { id: "solo", groupId: null },
  ];
  const flush = async () => {
    // microtask 판정 → fetch → Promise.all → 흘려보내기까지 비운다.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  const stubFetch = () => {
    const fetchMock = vi.fn((url: unknown) =>
      ok({ id: String(url).replace("/api/campaigns/", ""), groupId: "g1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("collectGroupSiblingIds — 같은 그룹이면서 함께 오지 않은 행만 고른다", () => {
    expect(collectGroupSiblingIds(ROWS, [{ id: "a", groupId: "g1" }])).toEqual(["b", "c"]);
    expect(collectGroupSiblingIds(ROWS, [{ id: "solo", groupId: null }])).toEqual([]);
    // 멤버십 팬아웃 — 전원이 이미 왔으면 다시 읽을 것이 없다.
    expect(
      collectGroupSiblingIds(ROWS, [
        { id: "a", groupId: "g1" },
        { id: "b", groupId: "g1" },
        { id: "c", groupId: "g1" },
      ]),
    ).toEqual([]);
  });

  it("그룹 소속 1건이 저장되면 나머지 멤버 전원을 다시 읽어 꽂는다", async () => {
    const fetchMock = stubFetch();
    const applied: string[] = [];
    const notify = createGroupSiblingRefresher({
      getRows: () => ROWS,
      applyRow: (row) => applied.push(row.id),
      onFailed: vi.fn(),
    });

    notify({ id: "a", groupId: "g1" });
    await flush();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/campaigns/b",
      "/api/campaigns/c",
    ]);
    expect(applied).toEqual(["b", "c"]);
  });

  it("무그룹 저장·한 틱 팬아웃(전원 도착)은 조회를 만들지 않는다", async () => {
    const fetchMock = stubFetch();
    const notify = createGroupSiblingRefresher({
      getRows: () => ROWS,
      applyRow: vi.fn(),
      onFailed: vi.fn(),
    });

    notify({ id: "solo", groupId: null });
    await flush();
    for (const id of ["a", "b", "c"]) notify({ id, groupId: "g1" });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("다시 읽지 못한 건수를 표면에 알린다 — 삼키지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false })));
    const onFailed = vi.fn();
    const notify = createGroupSiblingRefresher({
      getRows: () => ROWS,
      applyRow: vi.fn(),
      onFailed,
    });

    notify({ id: "a", groupId: "g1" });
    await flush();

    expect(onFailed).toHaveBeenCalledWith(2);
  });
});
