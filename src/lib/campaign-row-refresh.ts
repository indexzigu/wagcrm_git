import type { CampaignRow } from "./crm-types";

/**
 * 쓰기 직후 **캠페인 행을 다시 읽어 화면에 되꽂는** 동작의 SSOT(클라이언트 전용, 순수 fetch).
 *
 * ⚠️ **왜 SSOT 인가** — 상위 콜백(`onCampaignUpdated` → `replaceCampaignRow`)은 **행 하나를
 * 교체하는** 계약이라 목록이 스스로 따라오지 않는다. 그래서 쓰기를 한 화면마다 "무엇을 다시
 * 읽을지"를 각자 정해 왔고, 그 사본이 셋으로 갈렸다(그룹 묶기·그룹 제외·정산 수취 결정).
 * 갈린 자리에서 실제로 결함이 나왔다 — 한 곳만 응답 모양을 검증하고(`"id" in body`) 나머지
 * 둘은 검증 없이 `as CampaignRow` 로 캐스팅해, 서버가 오류 JSON 을 200 으로 돌려주면 **빈 행이
 * 상위 목록에 그대로 꽂혔다.**
 *
 * ⛔ **문구는 이 모듈이 갖지 않는다.** 실패를 어떻게 말할지는 표면이 정한다 — 목록 배지가
 * 낡는 것("새로고침해 주세요")과 패널 칸이 빈 채로 남는 것은 사용자가 취할 행동이 다르다.
 * 여기서 통일하면 두 표면 중 한쪽 문구가 반드시 틀려진다. 목록 표면끼리 공유하는 문구는
 * `LIST_REFRESH_FAILED_MESSAGE` 가 소유한다.
 *
 * ⛔ **실패를 삼키지 말 것** — 쓰기는 이미 끝났으므로 이건 「실패」가 아니라 「화면이 낡았다」다.
 * 조용히 두면 호출부가 고치려던 증상(배지·칸이 거짓말하는 상태)이 다른 이유로 그대로 재현된다.
 * 그래서 이 함수는 실패를 던지지 않고 **개수로 돌려주며**, 호출부가 반드시 그 수를 본다.
 */

/** 캠페인 1건을 다시 읽는다. 실패·모양 불일치는 전부 `null`(호출부가 개수로 센다). */
async function fetchCampaignRow(campaignId: string): Promise<CampaignRow | null> {
  try {
    const res = await fetch(`/api/campaigns/${campaignId}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    // 🪤 캐스팅만 하면 오류 JSON(200)이 빈 행으로 목록에 꽂힌다 — 최소 형태를 확인한다.
    if (!body || typeof body !== "object" || !("id" in body)) return null;
    return body as CampaignRow;
  } catch {
    return null;
  }
}

/**
 * 여러 캠페인 행을 다시 읽어 `onRow` 로 하나씩 흘려보낸다.
 *
 * 반환값은 **다시 읽지 못한 건수**다. 0 이 아니면 호출부가 사용자에게 알린다.
 * 같은 id 가 여러 번 들어와도 한 번만 읽는다(호출부가 「해체 전 멤버 + 현재 캠페인」처럼
 * 겹칠 수 있는 목록을 만들기 때문이다).
 */
export async function refreshCampaignRows(
  campaignIds: string[],
  onRow: (row: CampaignRow) => void,
): Promise<number> {
  const unique = [...new Set(campaignIds)];
  const rows = await Promise.all(unique.map(fetchCampaignRow));
  let failed = 0;
  for (const row of rows) {
    if (row) onRow(row);
    else failed += 1;
  }
  return failed;
}

/**
 * 목록(칸반 보드) 행이 못 따라왔을 때의 공통 문구.
 *
 * 그룹 묶기·그룹 제외가 **같은 표면·같은 질문**이라 문구를 공유한다 — 종전에는 동사만 다른
 * 두 문장이 손으로 복사돼 있어 한쪽을 다듬으면 다른 쪽이 조용히 갈렸다.
 * ⚠️ 정산 패널의 「화면 갱신 실패」는 여기 넣지 않는다(위 ⛔ 참조 — 표면이 다르다).
 */
export const LIST_REFRESH_FAILED_MESSAGE =
  "작업은 끝났지만 목록 갱신이 일부 실패했습니다. 새로고침해 주세요.";
