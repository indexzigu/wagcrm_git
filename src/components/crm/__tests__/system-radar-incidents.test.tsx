// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SystemRadarCard } from "../system-radar-card";
import { KNOWN_JOBS } from "@/lib/cron-jobs";
import type { AutomationIncident } from "@/lib/automation-incidents";

/**
 * 「자동화 작업 상태」 — 크론 자가 복구 2단계 화면 계약.
 * 작업 행: 오너 조치를 기다리는 사고가 있으면 「조치대기」(실패가 이긴다). 범례에 「조치대기」.
 * 설명창: 「작동 로그」 위에 「이상 기록」 — 조치대기 → 재확인중 → 정상화, 최대 3줄(조치대기는 자르지 않음).
 */

const job = KNOWN_JOBS.find((j) => j.cycle === "매일")!;
const HOUR = 60 * 60 * 1000;

function incident(overrides: Partial<AutomationIncident> = {}): AutomationIncident {
  return {
    id: "i-1",
    jobKey: job.key,
    kind: "A",
    errorKind: "auth",
    status: "waiting_owner",
    ownerAction: "연동 설정에서 다시 로그인해 주세요.",
    firstSeenAt: "2026-10-17T00:30:00.000Z",
    normalizedAt: null,
    occurrences: 1,
    ...overrides,
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function mockApis({
  status = "SUCCESS",
  waiting = [] as AutomationIncident[],
  byJob = [] as AutomationIncident[],
  waitingFails = false,
  byJobFails = false,
  lastRunAt = new Date(Date.now() - HOUR).toISOString(),
} = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/system/radar")) {
      return json({
        success: true,
        data: [{ jobKey: job.key, status, lastRunAt, lastErrorMessage: status === "ERROR" ? "boom" : null }],
        collectHealth: null,
      });
    }
    if (url.includes("/api/system/incidents?status=waiting_owner")) {
      return waitingFails ? new Response("{}", { status: 500 }) : json({ incidents: waiting });
    }
    if (url.includes("/api/system/incidents?jobKey=")) {
      return byJobFails ? new Response("{}", { status: 500 }) : json({ incidents: byJob });
    }
    if (url.includes("/api/system/cron-run")) return json({ ok: true });
    if (url.includes("/api/system/task-log")) return json({ success: true, data: [] });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function rowButton() {
  return screen.getByText(job.name).closest("button")!;
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("자동화 작업 상태 — 조치대기 행", () => {
  it("조치대기 사고가 있는 작업은 caution 점 + 글자 「조치대기」", async () => {
    vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
    mockApis({ waiting: [incident()] });
    render(<SystemRadarCard />);
    await waitFor(() => expect(within(rowButton()).getByText("조치대기")).toBeInTheDocument());
    const word = within(rowButton()).getByText("조치대기");
    expect(word.className).toContain("text-[var(--status-caution-text)]");
    expect(rowButton().querySelector('[aria-hidden].rounded-full')!.className).toContain("bg-[var(--status-caution)]");
  });

  it("실패가 점·첫 낱말을 가져가도 조치대기는 둘째 낱말로 남는다(합치지 않는다)", async () => {
    vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
    mockApis({ status: "ERROR", waiting: [incident()] });
    render(<SystemRadarCard />);
    await waitFor(() => expect(within(rowButton()).getByText("실패")).toBeInTheDocument());
    expect(rowButton().querySelector('[aria-hidden].rounded-full')!.className).toContain("bg-[var(--status-urgent)]");
    const waitingWord = await within(rowButton()).findByText("조치대기");
    expect(waitingWord.className).toContain("text-[var(--status-caution-text)]");
    expect(within(rowButton()).queryByText(/실패 · 조치대기/)).toBeNull();
    expect(waitingWord.parentElement!.className).toContain("flex-wrap");
  });

  it("조치대기 행이 지연이기도 하면 「지연」을 둘째 낱말로 남기고 상세 첫 줄의 지연 사유도 그대로다", async () => {
    // 첫 알림 뒤 작업이 아예 멈춘 경우 — 조치대기만 보이면 「아직 실패 중」으로 읽혀 멈춘 사실이 가려진다.
    vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
    mockApis({ waiting: [incident()], lastRunAt: new Date(Date.now() - 3 * 24 * HOUR).toISOString() });
    render(<SystemRadarCard />);
    await waitFor(() => expect(within(rowButton()).getByText("조치대기")).toBeInTheDocument());
    const lateWord = within(rowButton()).getByText("지연");
    // 실패 행의 둘째 낱말 「조치대기」와 같은 꼴 — 한 낱말 · 같은 크기 · 주의색 글자, 합치지 않는다.
    expect(lateWord.className).toBe("shrink-0 text-[10.5px] font-medium text-[var(--status-caution-text)]");
    expect(within(rowButton()).queryByText(/조치대기 · 지연/)).toBeNull();
    fireEvent.click(rowButton());
    expect(await screen.findByText(/지연 사유/)).toBeInTheDocument();
  });

  it("조치대기지만 늦지 않았으면 「지연」을 붙이지 않는다", async () => {
    vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
    mockApis({ waiting: [incident()] });
    render(<SystemRadarCard />);
    await waitFor(() => expect(within(rowButton()).getByText("조치대기")).toBeInTheDocument());
    expect(within(rowButton()).queryByText("지연")).toBeNull();
  });

  it("실패이면서 늦어도 「지연」은 붙이지 않는다 — 실패가 지연을 이긴다(지연은 그 실패의 결과)", async () => {
    vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
    mockApis({ status: "ERROR", waiting: [incident()], lastRunAt: new Date(Date.now() - 3 * 24 * HOUR).toISOString() });
    render(<SystemRadarCard />);
    await waitFor(() => expect(within(rowButton()).getByText("실패")).toBeInTheDocument());
    await within(rowButton()).findByText("조치대기");
    expect(within(rowButton()).queryByText("지연")).toBeNull();
  });

  it("수동 실행 뒤 조치대기 목록도 다시 받는다", async () => {
    vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
    const fetchMock = mockApis({ waiting: [incident()] });
    render(<SystemRadarCard />);
    await waitFor(() => expect(within(rowButton()).getByText("조치대기")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: `${job.name} 지금 실행` }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("status=waiting_owner"))).toHaveLength(2),
    );
  });

  it("조치대기 목록은 카드가 한 번만 받는다", async () => {
    vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
    const fetchMock = mockApis({ waiting: [incident()] });
    render(<SystemRadarCard />);
    await waitFor(() => expect(within(rowButton()).getByText("조치대기")).toBeInTheDocument());
    const calls = fetchMock.mock.calls.filter(([u]) => String(u).includes("status=waiting_owner"));
    expect(calls).toHaveLength(1);
  });

  it("범례에 「조치대기」가 따로 있다", async () => {
    vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
    mockApis();
    render(<SystemRadarCard />);
    await waitFor(() => expect(screen.getByText(job.name)).toBeInTheDocument());
    expect(screen.getByText("조치대기", { selector: "span.text-\\[10px\\]" })).toBeInTheDocument();
    expect(screen.getByText("실행중 · 지연")).toBeInTheDocument();
  });

  it("조치대기 목록을 못 받으면 그 사실을 알린다(정상으로 위장하지 않는다)", async () => {
    vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApis({ waitingFails: true });
    render(<SystemRadarCard />);
    expect(await screen.findByText("조치대기 작업을 불러오지 못해 일부 작업이 정상으로 보일 수 있습니다. 페이지를 새로 고쳐 주세요.")).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe("자동화 작업 상태 — 설명창 「이상 기록」", () => {
  async function openDetail(byJob: AutomationIncident[]) {
    vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
    mockApis({ byJob });
    render(<SystemRadarCard />);
    await waitFor(() => expect(screen.getByText(job.name)).toBeInTheDocument());
    fireEvent.click(rowButton());
    return screen.findByRole("region", { name: "이상 기록" });
  }

  it("「작동 로그」 위에 있고, 줄은 「상태 · 원인」 + 조치대기만 조치 문장 + 시각", async () => {
    const section = await openDetail([
      incident({ id: "r", status: "resolved", normalizedAt: "2026-10-17T03:05:00.000Z", ownerAction: "보이면 안 됨" }),
      incident({ id: "o", status: "open", errorKind: "timeout", occurrences: 3, ownerAction: "이것도 보이면 안 됨" }),
      incident({ id: "w" }),
    ]);
    const logHeading = screen.getByText("작동 로그");
    expect(section.compareDocumentPosition(logHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const items = within(section).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("p")!.textContent)).toEqual([
      "조치대기 · 인증 실패",
      "재확인중 · 시간 초과",
      "정상화 · 인증 실패",
    ]);
    expect(within(items[0]).getByText("연동 설정에서 다시 로그인해 주세요.")).toBeInTheDocument();
    expect(within(section).queryByText("보이면 안 됨")).toBeNull();
    expect(within(section).queryByText("이것도 보이면 안 됨")).toBeNull();
    expect(within(items[0]).getByText("10-17 09:30 시작")).toBeInTheDocument();
    expect(within(items[1]).getByText("10-17 09:30 시작 · 3회 발생")).toBeInTheDocument();
    expect(within(items[2]).getByText("10-17 09:30 시작 · 12:05 정상화")).toBeInTheDocument();
  });

  it("조치대기 제목만 주의색 굵은 글자 — 재확인중·정상화는 무채색, 위험색은 쓰지 않는다", async () => {
    const section = await openDetail([
      incident({ id: "w" }),
      incident({ id: "o", status: "open" }),
      incident({ id: "r", status: "resolved", normalizedAt: "2026-10-17T03:05:00.000Z" }),
    ]);
    const titles = within(section).getAllByRole("listitem").map((li) => li.querySelector("p")!);
    expect(titles[0].className).toContain("text-[var(--status-caution-text)]");
    expect(titles[0].className).toContain("font-medium");
    expect(titles[1].className).not.toContain("status-");
    expect(titles[2].className).not.toContain("status-");
    expect(section.innerHTML).not.toContain("status-urgent");
  });

  it("최대 3줄 — 넘치면 「외 N건」", async () => {
    const section = await openDetail([
      incident({ id: "w" }),
      incident({ id: "o", status: "open" }),
      ...[1, 2, 3].map((n) =>
        incident({ id: `r${n}`, status: "resolved", normalizedAt: `2026-10-1${n}T03:05:00.000Z` }),
      ),
    ]);
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);
    expect(within(section).getByText("외 2건")).toBeInTheDocument();
  });

  it("이상 기록 목록은 높이를 묶고 키보드로 스크롤할 수 있다", async () => {
    const section = await openDetail([incident({ id: "w" })]);
    const list = within(section).getByRole("list");
    expect(list).toHaveAttribute("tabindex", "0");
    expect(list.className).toContain("max-h-[168px]");
    expect(list.className).toContain("overflow-y-auto");
  });

  it("이상 기록을 못 받으면 다시 여는 방법까지 말한다", async () => {
    vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApis({ byJobFails: true });
    render(<SystemRadarCard />);
    await waitFor(() => expect(screen.getByText(job.name)).toBeInTheDocument());
    fireEvent.click(rowButton());
    expect(await screen.findByText("이상 기록을 불러오지 못했습니다. 창을 닫았다가 다시 열어 주세요.")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("사고 기록이 없으면 섹션을 그리지 않는다", async () => {
    vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
    mockApis({ byJob: [] });
    render(<SystemRadarCard />);
    await waitFor(() => expect(screen.getByText(job.name)).toBeInTheDocument());
    fireEvent.click(rowButton());
    expect(await screen.findByText("작동 로그")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("region", { name: "이상 기록" })).toBeNull());
  });
});
