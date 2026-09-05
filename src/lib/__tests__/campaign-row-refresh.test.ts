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
import { refreshCampaignRows } from "../campaign-row-refresh";

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

});
