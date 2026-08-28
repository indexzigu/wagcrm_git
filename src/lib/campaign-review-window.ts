// campaign-review-window — "이 캠페인이 아직 미분류 콘텐츠를 검토시킬 자격이 있는가"의 순수 판정.
//
// 배경(오너 2026-07-31): 콘텐츠 수집은 **셀러 단위**다 — 한 셀러에게 수집창(시작−7일~마감+1일)이
// 열린 캠페인이 하나라도 있으면 그 셀러의 피드·스토리가 매일 갱신된다. 그래서 이미 끝난 캠페인의
// 상세 화면도 최신 수집 타임스탬프를 달고, 그 캠페인 기간에 걸렸던 미분류 후보가 무기한 검토를
// 요구한 채 남는다(운영 관찰: 마감된 캠페인이 열흘 넘게 후보 수십 장을 계속 노출한 사례).
//
// 수집창이 닫히면 그 캠페인의 후보 집합은 **더 늘지 않는다**(창 판정은 게시시각 기준이라 늦게
// 수집돼도 기간 밖 게시물은 후보가 되지 않는다). 즉 남은 미분류분은 유한하고 정적인 잔여물이라,
// 유예 기간이 지나면 판단 가치가 사라진다(P2 Decision-Value Priority).
//
// ⚠️ 숨김은 **표시 정책**이지 삭제가 아니다. 소비처는 반드시 되살리는 경로를 남겨야 한다
// (라우트의 includeClosed 파라미터) — 뒤늦게 올라온 홍보 게시물을 등록할 길이 막히면 회귀다.
// 이미 홍보로 확정된 것(Asset 등록 게시물 · CAMPAIGN 분류 스토리)은 이 판정과 무관하게 항상 보인다.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 마감 후 며칠까지 미분류 콘텐츠를 검토 대상으로 노출할지.
 *
 * 수집창 트레일(마감 +1일, `STORY_CAPTURE_TRAIL_DAYS`·`SuggestOptions.trailDays`)보다 길다 —
 * 창이 닫힌 뒤에도 담당자가 밀린 후보를 훑을 시간이 필요하기 때문이다. 두 값을 같게 맞추면
 * 마감 다음 날 후보가 통째로 사라져 검토 기회 자체가 없어진다.
 */
export const CONTENT_REVIEW_TRAIL_DAYS = 7;

/**
 * 아직 미분류 콘텐츠(게시물 후보·미분류 스토리)를 검토 대상으로 보여줄 시점인지.
 *
 * 마감일이 없으면 **열린 것으로 본다** — 닫을 근거가 없는데 닫으면 기간 미입력 캠페인의 콘텐츠가
 * 조용히 사라진다(P0 무음 실패 금지의 표시 계층 판본).
 */
export function isContentReviewOpen(
  endDate: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!endDate) return true;
  const end = endDate instanceof Date ? endDate.getTime() : new Date(endDate).getTime();
  if (!Number.isFinite(end)) return true; // 파싱 불가 = 판정 불가 → 열어둔다
  return now.getTime() <= end + CONTENT_REVIEW_TRAIL_DAYS * DAY_MS;
}
