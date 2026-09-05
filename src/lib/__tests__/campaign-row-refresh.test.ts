/**
 * 캠페인 행 재조회 SSOT 의 계약 (T-099).
 *
 * 이 동작은 종전에 네 곳(그룹 묶기·합류·제외, 정산 수취 결정)에 손으로 복사돼 있었고,
 * 사본마다 **한 조각씩 빠져 있었다** — 한 곳만 응답 모양을 검증했고, 두 곳은 실패를 아예
 * 통지하지 않았다. 여기 고정하는 것은 그 빠진 조각들이다.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { CampaignRow } from "../crm-types";
import { refreshCampaignRows, LIST_REFRESH_FAILED_MESSAGE } from "../campaign-row-refresh";

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

  it("목록 표면의 실패 문구는 한 곳이 소유한다", () => {
    // 종전에는 동사만 다른 문장이 두 곳에 복사돼 있어 한쪽을 다듬으면 조용히 갈렸다.
    expect(LIST_REFRESH_FAILED_MESSAGE).toContain("새로고침");
  });
});
