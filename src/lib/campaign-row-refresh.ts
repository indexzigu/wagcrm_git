import type { CampaignRow } from "./crm-types";

/**
 * 쓰기 직후 **캠페인 행을 다시 읽어 화면에 되꽂는** 동작의 SSOT(클라이언트 전용, 순수 fetch).
 *
 * ⚠️ **왜 SSOT 인가** — 상위 콜백(`onCampaignUpdated` → `replaceCampaignRow`)은 **행 하나를
 * 교체하는** 계약이라 목록이 스스로 따라오지 않는다. 그래서 쓰기를 한 화면마다 "무엇을 다시
 * 읽을지"를 각자 정해 왔고, 사본이 갈리면서 **갖춘 조각이 서로 달라졌다.** 이 모듈이 흡수한
 * 셋의 실제 상태는 이랬다:
 *   · `campaign-group-section` 의 로컬 헬퍼(묶기·합류·제외가 공유) — 모양 검증 없음,
 *     실패 통지는 셋 중 둘에만 있었다(합류는 반환값을 통째로 버렸다).
 *   · `crm-dashboard` 의 합류 후처리 — 모양 검증 없음, 실패를 조용히 삼켰다.
 *   · `settlement-section` 의 수취 결정 후처리 — **이쪽은 둘 다 갖추고 있었다.**
 *     그래서 "빠진 조각"을 채운 게 아니라, 갖춘 쪽을 기준으로 나머지를 끌어올린 것이다.
 *
 * ⚠️ **이 목록은 전수가 아니다.** 같은 모양(단건 GET → 캐스팅 → 콜백)이 다른 화면에도 남아
 * 있다 — 예: `campaign-side-panel` 의 `refreshCampaignSnapshot`(실패 시 로컬 병합으로
 * 폴백하는 **다른 계약**이라 이번에 흡수하지 않았다), `crm-dashboard` 의 딥링크 로더.
 * 새로 흡수할 때 이 목록을 「전부」로 읽지 말 것.
 *
 * ℹ️ 모양 가드가 막는 것은 **미확인 가정**이다 — 지금 이 라우트가 오류를 200 으로 돌려주는
 * 경로는 확인되지 않았다(404·500 으로 낸다). 다만 캐스팅은 그런 응답이 생기는 날 **빈 행을
 * 목록에 꽂는** 형태로 조용히 실패하므로, 값싼 쪽으로 기울여 둔다.
 *
 * **그룹 멤버십이 바뀌면 「바뀐 행 전부」를 넘긴다.** 무엇이 바뀌는가는 갈리지만 누가
 * 바뀌는가는 같다 — 제외는 **제외 전 멤버 전원**(해체면 전원의 소속이, 존속이면 남은
 * 형제의 `groupMemberCount` 가 바뀐다), 합류는 응답이 싣는 **합류 후 멤버 전원**(기존
 * 멤버들의 숫자가 하나 는다).
 * ⚠️ **이 규칙은 `CAMPAIGN_DETAIL_INCLUDE` 가 `group._count` 를 실어야 성립한다**(T-100).
 * 그전에는 단건 조회 응답에 그 값이 없어서, 형제를 다시 읽으면 배지 숫자가 고쳐지는 게
 * 아니라 **사라졌다** — 그래서 일부러 형제를 빼고 있었다. ⛔ 둘을 갈라서 되돌리지 말 것.
 *
 * **문구는 표면이 정한다.** 실패를 어떻게 말할지는 목록 배지가 낡는 것("새로고침해 주세요")과
 * 패널 칸이 빈 채로 남는 것이 사용자가 취할 행동이 달라서다 — 하나로 통일하면 한쪽이 반드시
 * 틀려진다. ⛔ 그러니 **아래 상수를 「모든 실패 문구」로 넓히지 말 것**: 이 모듈이 소유하는
 * 것은 **목록 표면끼리 공유하는 한 문장**뿐이고, 정산 패널 같은 다른 표면은 자기 문구를
 * 그대로 갖는다.
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
    // 🪤 캐스팅만 하면 캠페인 행이 아닌 200 응답이 빈 행으로 목록에 꽂힌다 — 최소 형태 확인.
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
 * 보드 행을 다루는 자리 **넷**(묶기·합류·제외, 그리고 토스트 합류의 대시보드 후처리)이
 * **같은 표면·같은 질문**이라 문구를 공유한다 — 종전에는 동사만 다른 문장이 손으로 복사돼
 * 있어 한쪽을 다듬으면 다른 쪽이 조용히 갈렸다.
 * ⚠️ 정산 패널의 「화면 갱신 실패」는 여기 넣지 않는다(위 참조 — 표면이 다르다).
 */
export const LIST_REFRESH_FAILED_MESSAGE =
  "작업은 끝났지만 목록 갱신이 일부 실패했습니다. 새로고침해 주세요.";
