import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `@/lib/toast` 계약 — 오류 토스트만 닫을 때까지 유지하고, 나머지는 sonner 그대로다.
 * (sonner 2.0.7 은 종류별 기본 수명이 없어 래퍼가 정책을 소유한다 — interfaces 점검 #10.)
 */

const sonner = vi.hoisted(() => {
  const base = vi.fn();
  return {
    toast: Object.assign(base, {
      error: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      dismiss: vi.fn(),
    }),
  };
});

vi.mock("sonner", () => sonner);

import { ERROR_TOAST_DURATION, notify, toast } from "../toast";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("toast.error — 닫을 때까지 유지", () => {
  it("수명을 무한으로 넘긴다", () => {
    toast.error("저장하지 못했습니다.");
    expect(sonner.toast.error).toHaveBeenCalledWith("저장하지 못했습니다.", {
      id: "error:저장하지 못했습니다.",
      duration: Number.POSITIVE_INFINITY,
    });
    expect(ERROR_TOAST_DURATION).toBe(Number.POSITIVE_INFINITY);
  });

  it("같은 문구의 오류는 같은 id 로 보내 한 장으로 합친다 — 닫아야 할 토스트가 쌓이지 않게", () => {
    toast.error("저장하지 못했습니다.");
    toast.error("저장하지 못했습니다.");
    toast.error("다른 오류");
    const ids = vi.mocked(sonner.toast.error).mock.calls.map(([, data]) => (data as { id?: string }).id);
    expect(ids).toEqual(["error:저장하지 못했습니다.", "error:저장하지 못했습니다.", "error:다른 오류"]);
  });

  it("호출부가 수명을 줘도 정책이 이긴다 — 다른 옵션은 그대로 통과한다", () => {
    toast.error("충돌", { duration: 3000, description: "다시 시도하세요.", id: "t1" });
    // 호출부가 준 id(로딩 토스트 교체 등)는 합치기용 id 보다 우선한다.
    expect(sonner.toast.error).toHaveBeenCalledWith("충돌", {
      duration: Number.POSITIVE_INFINITY,
      description: "다시 시도하세요.",
      id: "t1",
    });
  });
});

describe("나머지 호출은 sonner 로 그대로 넘어간다", () => {
  it("success·warning·dismiss·기본 호출의 인자를 바꾸지 않는다", () => {
    toast.success("저장했습니다.");
    toast.warning("확인 필요", { duration: 12_000 });
    toast.dismiss("t1");
    toast("분석을 시작합니다");

    expect(sonner.toast.success).toHaveBeenCalledWith("저장했습니다.");
    expect(sonner.toast.warning).toHaveBeenCalledWith("확인 필요", { duration: 12_000 });
    expect(sonner.toast.dismiss).toHaveBeenCalledWith("t1");
    expect(sonner.toast).toHaveBeenCalledWith("분석을 시작합니다");
  });

  it("목을 나중에 갈아 끼워도 호출 시점의 sonner 를 쓴다", () => {
    const original = sonner.toast.success;
    const replaced = vi.fn();
    sonner.toast.success = replaced;
    try {
      toast.success("저장했습니다.");
      expect(replaced).toHaveBeenCalledWith("저장했습니다.");
    } finally {
      sonner.toast.success = original;
    }
  });
});

describe("notify — 종류 문자열 어댑터(주문 변환 모달 계약)", () => {
  it("error 는 유지되는 오류 토스트로, success·info 는 각 종류로 보낸다", () => {
    notify("발송 실패", "error");
    notify("발송 완료", "success");
    notify("확인 중");

    expect(sonner.toast.error).toHaveBeenCalledWith("발송 실패", {
      id: "error:발송 실패",
      duration: Number.POSITIVE_INFINITY,
    });
    expect(sonner.toast.success).toHaveBeenCalledWith("발송 완료");
    expect(sonner.toast.info).toHaveBeenCalledWith("확인 중");
  });
});
