import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SystemRadarCard } from "../system-radar-card";
import { KNOWN_JOBS } from "@/lib/cron-jobs";

/**
 * 레이더 지연 표시 회귀 — "초록인데 안 돈다"를 화면에서 실제로 막는지 본다.
 *
 * 순수 판정은 `cron-staleness.test.ts` 가 고정한다. 여기서 보는 것은 **배선**이다:
 * 판정이 맞아도 행이 여전히 초록이면 오너에게는 아무것도 안 바뀐 것이다(로컬 레인 전환으로
 * 생긴 무음 실패의 실체가 정확히 그 형태다 — 상태값은 SUCCESS 인데 실행이 없다).
 */

const DAY = 24 * 60 * 60 * 1000;
const dailyJob = KNOWN_JOBS.find((j) => j.cycle === "매일")!;

function mockRadar(lastRunAt: string, status = "SUCCESS") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/system/radar")) {
        // 실제 라우트 계약과 같은 봉투다({success, data}) — 형태가 어긋나면 컴포넌트가
        // 조용히 빈 상태를 그려서 테스트가 "지연 없음"을 통과시킨다(공허 통과).
        return new Response(
          JSON.stringify({
            success: true,
            data: [{ jobKey: dailyJob.key, status, lastRunAt, lastErrorMessage: null }],
            collectHealth: null,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }),
  );
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("시스템 레이더 — 지연 표시", () => {
  it("한 회차를 거르면 '지연'을 표면에 드러낸다(초록인 채 시각만 낡지 않는다)", async () => {
    vi.setSystemTime(new Date("2026-08-04T00:00:00Z"));
    mockRadar(new Date(Date.now() - 3 * DAY).toISOString(), "SUCCESS");

    render(<SystemRadarCard />);

    // 상태값은 SUCCESS 인데도 지연이 드러나야 한다 — 이게 이 테스트의 전부다.
    await waitFor(() => expect(screen.getAllByText("지연").length).toBeGreaterThan(0));
  });

  it("정상 주기 안이면 지연을 띄우지 않는다(오탐 금지 — 매일 빨강이면 신호를 잃는다)", async () => {
    vi.setSystemTime(new Date("2026-08-04T00:00:00Z"));
    mockRadar(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), "SUCCESS");

    render(<SystemRadarCard />);

    await waitFor(() => expect(screen.getByText(dailyJob.name)).toBeInTheDocument());
    // 범례의 "실행 중 · 지연" 은 상시 노출이므로 정확 일치로만 센다.
    expect(screen.queryByText("지연")).toBeNull();
  });
});
