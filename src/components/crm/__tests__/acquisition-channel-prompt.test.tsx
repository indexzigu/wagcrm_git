// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AcquisitionChannelPrompt } from "../acquisition-channel-prompt";
import { acquisitionChannelLabels } from "@/lib/crm-types";
import { ACQUISITION_CHANNELS } from "@/lib/validations/seller";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AcquisitionChannelPrompt", () => {
  it("칩 라벨은 acquisitionChannelLabels 에서 온다", () => {
    render(<AcquisitionChannelPrompt sellerId="s1" onDone={() => {}} />);
    expect(screen.getByText("유입 경로")).toBeTruthy();
    for (const value of ACQUISITION_CHANNELS) {
      expect(screen.getByRole("button", { name: acquisitionChannelLabels[value] })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "나중에" })).toBeTruthy();
  });

  it("나중에: 네트워크 호출 없이 닫는다", () => {
    const onDone = vi.fn();
    render(<AcquisitionChannelPrompt sellerId="s1" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "나중에" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("칩 선택: acquisitionChannel 만 PATCH 하고 성공하면 닫는다", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const onDone = vi.fn();
    render(<AcquisitionChannelPrompt sellerId="s1" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: acquisitionChannelLabels.COLD }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/sellers/s1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ acquisitionChannel: "COLD" });
  });

  it("저장 성공은 onSaved 로 알리고, 저장 중에는 칩을 막는다", async () => {
    let resolve!: (v: { ok: boolean }) => void;
    fetchMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    const onSaved = vi.fn();
    const onDone = vi.fn();
    render(<AcquisitionChannelPrompt sellerId="s1" onDone={onDone} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: acquisitionChannelLabels.COLD }));
    expect(screen.getByRole("button", { name: acquisitionChannelLabels.INBOUND })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: acquisitionChannelLabels.INBOUND }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve({ ok: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("COLD"));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("저장 실패: 오류를 보이고 닫지 않는다", async () => {
    fetchMock.mockResolvedValue({ ok: false });
    const onDone = vi.fn();
    render(<AcquisitionChannelPrompt sellerId="s1" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: acquisitionChannelLabels.INBOUND }));
    await screen.findByRole("alert");
    expect(onDone).not.toHaveBeenCalled();
  });
});
