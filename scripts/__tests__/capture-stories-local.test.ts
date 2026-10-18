import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 로컬 러너가 상태 기록과 함께 사고 장부(1단계)에도 이어지는지 — 호출 계약만 고정한다.
const recordSystemTaskRun = vi.fn();
const recordFailureIncident = vi.fn();
const settleIncidentsAfterSuccess = vi.fn();
const captureActiveCampaignStories = vi.fn();

vi.mock("../../src/lib/prisma", () => ({ getPrisma: () => ({}) }));
vi.mock("../../src/lib/system-task-status", () => ({
  recordSystemTaskRun: (...a: unknown[]) => recordSystemTaskRun(...a),
  recordFailureIncident: (...a: unknown[]) => recordFailureIncident(...a),
  settleIncidentsAfterSuccess: (...a: unknown[]) => settleIncidentsAfterSuccess(...a),
}));
vi.mock("../../src/lib/story-capture", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/story-capture")>(
    "../../src/lib/story-capture",
  );
  return {
    ...actual,
    captureActiveCampaignStories: (...a: unknown[]) => captureActiveCampaignStories(...a),
  };
});

const baseResult = {
  activeSellers: 2,
  handles: ["a", "b"],
  handlesFailed: 0,
  storiesSeen: 3,
  storiesNew: 3,
  thumbnailsRehosted: 0,
  errors: [] as string[],
};

async function runMain() {
  vi.resetModules();
  await import("../capture-stories-local");
  // main() 은 import 시 시작된다 — 마이크로태스크를 비운다.
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  recordSystemTaskRun.mockReset().mockResolvedValue(undefined);
  recordFailureIncident.mockReset().mockResolvedValue(undefined);
  settleIncidentsAfterSuccess.mockReset().mockResolvedValue(undefined);
  captureActiveCampaignStories.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("capture-stories-local 사고 장부 연결", () => {
  it("성공이면 targets·produced 와 함께 정상화 판정을 부른다", async () => {
    captureActiveCampaignStories.mockResolvedValue(baseResult);
    await runMain();
    expect(settleIncidentsAfterSuccess).toHaveBeenCalledTimes(1);
    const [jobKey, body, runAt] = settleIncidentsAfterSuccess.mock.calls[0];
    expect(jobKey).toBe("capture-stories");
    expect(body).toEqual({ targets: 2, produced: 3 });
    expect(runAt).toBeInstanceOf(Date);
    expect(recordFailureIncident).not.toHaveBeenCalled();
  });

  it("실행 중 오류면 사고 A 를 올린다", async () => {
    captureActiveCampaignStories.mockRejectedValue(new Error("boom"));
    await runMain();
    expect(recordFailureIncident).toHaveBeenCalledTimes(1);
    expect(recordFailureIncident.mock.calls[0][0]).toBe("capture-stories");
    expect(recordFailureIncident.mock.calls[0][1]).toBe("boom");
    expect(settleIncidentsAfterSuccess).not.toHaveBeenCalled();
  });

  it("전원 실패 선언이어도 사고 A 를 올린다", async () => {
    captureActiveCampaignStories.mockResolvedValue({ ...baseResult, handlesFailed: 2, storiesNew: 0 });
    await runMain();
    expect(recordFailureIncident).toHaveBeenCalledTimes(1);
    expect(settleIncidentsAfterSuccess).not.toHaveBeenCalled();
  });

  it("성공 기록에 산출 수를 넘겨 마지막 산출 시각이 남게 한다", async () => {
    captureActiveCampaignStories.mockResolvedValue(baseResult);
    await runMain();
    const success = recordSystemTaskRun.mock.calls.find((c) => c[1] === "SUCCESS");
    expect(success?.[5]).toEqual({ produced: 3 });
  });

  it("산출 0 도 그대로 넘긴다(0 이면 시각을 안 남기는 판정은 recordSystemTaskRun 몫)", async () => {
    captureActiveCampaignStories.mockResolvedValue({ ...baseResult, storiesNew: 0 });
    await runMain();
    const success = recordSystemTaskRun.mock.calls.find((c) => c[1] === "SUCCESS");
    expect(success?.[5]).toEqual({ produced: 0 });
  });
});
